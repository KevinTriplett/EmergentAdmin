import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { Page } from 'puppeteer';
import { loginIfNeeded, type LogFn } from '../auth.js';
import { dumpFailureDiagnostics } from '../utils/diagnostics.js';
import { activeMembersCsvPath } from '../utils/activeMemberList.js';

// === SELECTORS — UPDATE IF MN CHANGES ITS DOM ===
/* The task no longer extracts data from the DOM; it talks directly
 * to MN's `/api/web/v1/spaces/<id>/members/all` JSON endpoint. We
 * still navigate to the rendered admin page once at the top of the
 * run because that's what populates the session cookie that the
 * subsequent in-page `fetch(..., { credentials: 'include' })` reuses.
 * SEL_READY is the same "app shell mounted" marker every other task
 * uses; once it's present the cookie jar is set up and we can hit
 * the API. */
const SEL_READY = 'body.pace-done #community-app';

// === URLS — FIX HERE IF MN RESTRUCTURES ===
/* Admin "All members" rendered page. Visited solely to warm the
 * session cookie used by the API call below. The query string still
 * carries the sort pre-set so a human watching a headed run lands on
 * the same view they'd expect. */
const MEMBERS_URL =
  'https://emergent-commons.mn.co/admin/members/all?sort=last_visit_at&sort_order=desc';

/* Internal MN REST endpoint for the all-members listing.
 *
 * The path embeds the network-wide "members" space id (4747401). MN's
 * UI builds this path by reading the same id from `<community>` JSON
 * embedded in the page; we hard-code it here because (a) the id is
 * stable for the life of the network and (b) plumbing it out of the
 * DOM would re-introduce exactly the scraping fragility this redesign
 * was meant to retire. **If MN ever restructures the API URL — new
 * path, new domain, new versioning prefix — fix it HERE and nowhere
 * else.**
 *
 * `include_email=true` is honoured by MN even though we don't emit an
 * EMAIL column in the CSV (operator picked option B). Including it
 * costs nothing on the wire and means a future change to add the
 * column is a one-line edit, not a second fetch path.
 *
 * `sort=last_visit_at&sort_order=desc` produces the same descending
 * "Last Active" order the admin UI uses; combined with the
 * break-on-inactive walk it lets us stop paginating as soon as we
 * cross the 90-day cutoff instead of pulling every page in the
 * network. */
const API_URL_BASE =
  'https://emergent-commons.mn.co/api/web/v1/spaces/4747401/members/all';

// === TIMING CONSTANTS ===
const WAIT_READY_MS = 60_000;

// === FILTER WINDOWS ===
const ONE_DAY_MS = 86_400_000;
const ACTIVE_MIN_DAYS = 30 * ONE_DAY_MS;
const JOIN_MIN_DAYS = 365 * ONE_DAY_MS;

// === PAGINATION ===
/* `per_page=100` was probed against the live API and is honoured. We
 * use the maximum so the typical run is a single round-trip; the
 * hard MAX_PAGES bound is purely a runaway-loop safety net. */
const PER_PAGE = 100;
const MAX_PAGES = 1000;

// === EXCLUDED MEMBERS ===
/* Members the API returns that we never want in the CSV. The
 * Commons Keeper Admin (this scraper's own bot account) is excluded
 * because it logs in to scrape and updates its own
 * `network_last_visit_at` on every run; without this filter it would
 * always appear at the very top of the descending-by-Last-Active
 * sort and clutter the operator's review.
 *
 * `kind:'skip', reason:'excluded'` — counts toward `skipped`, never
 * triggers a break. */
const EXCLUDED_MEMBER_IDS: ReadonlySet<number> = new Set([
  39358139, // Commons Keeper Admin
  12314607  // Purpose Project
]);

// === VIEWPORT ===
/* The new code only fetches JSON, so the viewport doesn't affect
 * data extraction. We still pin it for parity with addSpaceMember /
 * removeSpaceMembers (they share the same headed-debug muscle
 * memory: 1600x1024 = MN's "table mode" rendering). */
const VIEWPORT_WIDTH = 1600;
const VIEWPORT_HEIGHT = 1024;

// === LOG LEVEL ===
export type LogLevel = 'light' | 'debug';
const DEFAULT_LOG_LEVEL: LogLevel =
  process.env.COLLECT_MEMBERS_LOG_LEVEL === 'debug' ? 'debug' : 'light';

// === MESSAGES ===
const ABORTED_BY_USER = 'Aborted by user';

const msg = {
  navigating: (url: string) => `Navigating to ${url}…`,
  fetchingPage: (page: number) => `Fetching members API page ${page}…`,
  pageReceived: (page: number, count: number) =>
    `API page ${page} returned ${count} member(s).`,
  recentJoinerSkip: (label: string) =>
    `Skipping ${label}: joined < 1 year ago (not yet a tenured active member).`,
  excludedSkip: (id: number) =>
    `Skipping member id ${id}: excluded (admin / bot account).`,
  inactiveBreak: (label: string) =>
    `Stopping at ${label}: last active > 90 days ago. Discarding this row and stopping (rest of list is sorted to be even less active).`,
  neverVisitedBreak: (label: string) =>
    `Stopping at ${label}: never visited (network_last_visit_at = null). Discarding this row and stopping.`,
  sortViolation: (page: number) =>
    `WARNING: API page ${page} is not sorted descending by last_visit_at; MN may have silently changed the sort contract.`,
  abortedByUser: () => ABORTED_BY_USER,
  wrote: (count: number, outputPath: string) =>
    `Wrote ${count} active member row(s) to ${outputPath}.`,
} as const;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export type CollectActiveMemberListArgs = {
  page: Page;
  log: LogFn;
  abortSignal: { aborted: boolean };
  sleep?: (ms: number) => Promise<void>;
  logLevel?: LogLevel;
  /** Override for tests — defaults to `<cwd>/data/active-members.csv`. */
  outputPath?: string;
  /** Override for tests — defaults to `new Date()`. */
  now?: Date;
};

export type CollectActiveMemberListResult = {
  success: boolean;
  /** Rows actually written to the CSV (excluding the header). */
  written: number;
  /** Rows discarded by a non-break filter (recent-joiner OR excluded id). */
  skipped: number;
  /** Rows that survived classification (= written + skipped). The
   * row that triggers a break is examined but does NOT count toward
   * `scanned`. */
  scanned: number;
  /** Absolute path of the written file. Only set on success. */
  outputPath?: string;
  error?: string;
};

// ---------------------------------------------------------------------------
// Wire types — the shape of one element in MN's all-members response.
// The response IS the array; there is no envelope. Only fields we
// actually map are typed strictly; the API ships many more we ignore.
// ---------------------------------------------------------------------------

type ApiMember = {
  user: {
    id: number;
    name: string;
    network_last_visit_at: string | null;
    membership: { created_at: string };
  };
};

type FetchResult =
  | { ok: true; json: ApiMember[] }
  | { ok: false; status: number };

type Member = {
  memberId: number;
  name: string;
  joined: Date;
  lastActive: Date | null;
};

// ---------------------------------------------------------------------------
// Pure helpers (exported for unit tests)
// ---------------------------------------------------------------------------

/**
 * Truncate a `Date` to UTC midnight of the same calendar day. Used
 * by the cutoff math so "exactly N days ago" comparisons work at
 * day-level resolution rather than ms-level — the cutoffs are
 * specified in calendar-day language, so a row whose Last Active is
 * *the same date* as the 90-day cutoff is "still active" by intent.
 */
function utcDayStart(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

/* Format a UTC date for the CSV. "Apr 19, 2025" is what MN's UI
 * renders, so producing the same shape means an operator scanning
 * the CSV against the live page sees identical strings. The output
 * contains a literal comma; `toCsvRow` quotes it per RFC 4180. */
const MONTH_ABBR = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
];

function formatCsvDate(d: Date): string {
  return `${MONTH_ABBR[d.getUTCMonth()]} ${d.getUTCDate()}, ${d.getUTCFullYear()}`;
}

/**
 * Format a single CSV row per RFC 4180. Fields containing `,`, `"`,
 * `\n`, or `\r` are wrapped in double quotes; embedded `"` is doubled.
 * No leading/trailing whitespace is stripped (the caller already
 * `.trim()`'d the upstream values, but we don't quietly fix anything
 * the caller chose to keep).
 */
export function toCsvRow(fields: readonly string[]): string {
  return fields.map(escapeField).join(',');
}

function escapeField(value: string): string {
  if (/[,"\r\n]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

// ---------------------------------------------------------------------------
// API plumbing
// ---------------------------------------------------------------------------

function buildApiUrl(pageNumber: number, perPage: number): string {
  const params = new URLSearchParams({
    include_email: 'true',
    page: String(pageNumber),
    per_page: String(perPage),
    sort: 'last_visit_at',
    sort_order: 'desc',
  });
  return `${API_URL_BASE}?${params.toString()}`;
}

/**
 * Fetch one page of members through the live page's session cookies.
 *
 * The evaluate body is intentionally minimal:
 *   - one anonymous async arrow passed inline (NOT a const-bound
 *     arrow — esbuild's `keepNames` would `__name`-wrap the binding
 *     and the wrapper is undefined in the page; see
 *     `agent_prompts/system_prompt.md` §11);
 *   - no nested function declarations, no helper consts;
 *   - all branches return a plain JSON-serialisable shape that
 *     Puppeteer can ferry across the bridge.
 *
 * On non-2xx the wrapper returns `{ ok: false, status }` and the
 * caller decides whether to throw. We avoid throwing inside the
 * page context so a 500 surfaces with a clean error path on the
 * Node side instead of a serialised browser stack trace.
 */
async function fetchMembersPage(
  page: Page,
  pageNumber: number,
  perPage: number,
): Promise<FetchResult> {
  const url = buildApiUrl(pageNumber, perPage);
  return page.evaluate(async (u) => {
    const r = await fetch(u, { credentials: 'include' });
    if (!r.ok) return { ok: false, status: r.status };
    const json = await r.json();
    return { ok: true, json };
  }, url) as Promise<FetchResult>;
}

function toMember(api: ApiMember): Member {
  return {
    memberId: api.user.id,
    name: api.user.name,
    joined: new Date(api.user.membership.created_at),
    lastActive:
      api.user.network_last_visit_at !== null
        ? new Date(api.user.network_last_visit_at)
        : null,
  };
}

// ---------------------------------------------------------------------------
// Filter / classify
// ---------------------------------------------------------------------------

type Decision =
  | { kind: 'keep'; member: Member }
  | { kind: 'skip'; member: Member; reason: 'recent-joiner' | 'excluded' }
  | { kind: 'break'; member: Member; reason: 'inactive' | 'never-visited' };

function classifyMember(member: Member, now: Date): Decision {
  /* Excluded check first: an excluded id must always count as `skip`,
   * even if other rules would have produced `break` (e.g. a
   * never-visited bot row would otherwise stop pagination
   * prematurely on its own self-update). */
  if (EXCLUDED_MEMBER_IDS.has(member.memberId)) {
    return { kind: 'skip', member, reason: 'excluded' };
  }

  /* Anchor both sides at UTC day boundaries so a parsed date that's
   * exactly N calendar days ago compares as N days ago, not "N days
   * + (now's time-of-day)". Without this, a row whose Last Active is
   * the literal calendar date "90 days before today" gets classified
   * as 90 days + a few hours ago and is wrongly broken on. */
  const todayUtc = utcDayStart(now);
  const oneYearAgo = new Date(todayUtc.getTime() - JOIN_MIN_DAYS);
  const ninetyDaysAgo = new Date(todayUtc.getTime() - ACTIVE_MIN_DAYS);
  const joinedDay = utcDayStart(member.joined);

  /* `joinedDay > oneYearAgo` ⇒ joined LESS THAN 1 year ago ⇒ recent
   * joiner ⇒ skip-but-continue. Inclusive on the recent side: a
   * member whose `joined` is exactly 365 days old is kept (qualifies
   * for "≥1y tenure"). */
  if (joinedDay.getTime() > oneYearAgo.getTime()) {
    return { kind: 'skip', member, reason: 'recent-joiner' };
  }

  /* A null `network_last_visit_at` means the member has never visited
   * the network. Per the spec: discard the trigger row and stop
   * pagination — every subsequent never-visited row would also
   * fail the active filter. */
  if (member.lastActive === null) {
    return { kind: 'break', member, reason: 'never-visited' };
  }

  /* `lastActiveDay < ninetyDaysAgo` ⇒ inactive > 90 days ⇒ break.
   * Inclusive on the recent side: exactly 90 days old still passes. */
  const lastActiveDay = utcDayStart(member.lastActive);
  if (lastActiveDay.getTime() < ninetyDaysAgo.getTime()) {
    return { kind: 'break', member, reason: 'inactive' };
  }

  return { kind: 'keep', member };
}

/**
 * Walk a single page's rows in order; assert the page is sorted
 * descending by `lastActive`. Returns true on the first violation
 * found; null `lastActive` values are skipped (incomparable). The
 * walk is read-only — the caller logs at most once per page so a
 * silent contract change at MN produces visible noise without
 * spamming the run log. */
function isPageSortViolated(members: readonly Member[]): boolean {
  for (let i = 1; i < members.length; i++) {
    const prev = members[i - 1].lastActive;
    const cur = members[i].lastActive;
    if (prev !== null && cur !== null && prev.getTime() < cur.getTime()) {
      return true;
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// CSV write
// ---------------------------------------------------------------------------

async function writeCsv(members: readonly Member[], outputPath: string): Promise<void> {
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  const header = toCsvRow(['NAME', 'MEMBER ID', 'JOINED', 'LAST ACTIVE']);
  const body = members
    .map((m) => toCsvRow([
      m.name,
      String(m.memberId),
      formatCsvDate(m.joined),
      m.lastActive !== null ? formatCsvDate(m.lastActive) : '',
    ]))
    .join('\n');
  const content = body.length === 0 ? `${header}\n` : `${header}\n${body}\n`;
  /* mode: 0o600 — operator-only on disk, defence in depth beyond the
   * HTTP token gate. Matches the posture for `data/ec-admin.db`. */
  await fs.writeFile(outputPath, content, { mode: 0o600 });
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

async function logAbortAndReturn(
  log: LogFn,
  partial: { written: number; skipped: number; scanned: number },
): Promise<CollectActiveMemberListResult> {
  await log(ABORTED_BY_USER);
  return {
    success: true,
    written: partial.written,
    skipped: partial.skipped,
    scanned: partial.scanned,
    error: ABORTED_BY_USER,
  };
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

export async function collectActiveMemberList({
  page,
  log,
  abortSignal,
  sleep: sleepArg,
  logLevel = DEFAULT_LOG_LEVEL,
  outputPath: outputPathArg,
  now: nowArg,
}: CollectActiveMemberListArgs): Promise<CollectActiveMemberListResult> {
  const sleep = sleepArg ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  /* `sleep` is no longer used by the API path (the old code threaded
   * it into `scrollUntilCutoffOrStable`). Keep it on the args so
   * existing scheduler wiring still compiles, but discard at use
   * site so unused-var lints stay quiet. */
  void sleep;

  const now = nowArg ?? new Date();
  const outputPath = outputPathArg ?? activeMembersCsvPath();
  /* `logLevel` is currently unused beyond defaulting; reserved for
   * parity with addSpaceMember.ts and for future verbose
   * diagnostics. */
  void logLevel;

  if (abortSignal.aborted) {
    return logAbortAndReturn(log, { written: 0, skipped: 0, scanned: 0 });
  }

  try {
    await log(msg.navigating(MEMBERS_URL));
    /* Pin the viewport BEFORE goto for parity with the other browser
     * tasks; the data path itself doesn't care about viewport because
     * it bypasses the rendered list entirely. */
    await page.setViewport({ width: VIEWPORT_WIDTH, height: VIEWPORT_HEIGHT });

    /* `domcontentloaded` not `networkidle2`: MN holds open background
     * channels that keep network activity above the threshold
     * indefinitely; see the rationale in addSpaceMember.ts. The
     * post-goto SEL_READY wait is the real "interactive, cookies
     * set" signal. */
    await page.goto(MEMBERS_URL, { waitUntil: 'domcontentloaded' });
    await loginIfNeeded(page, log);
    await page.waitForSelector(SEL_READY, { timeout: WAIT_READY_MS });

    if (abortSignal.aborted) {
      return logAbortAndReturn(log, { written: 0, skipped: 0, scanned: 0 });
    }

    const kept: Member[] = [];
    let skipped = 0;
    let scanned = 0;

    pageLoop: for (let pageNumber = 1; pageNumber <= MAX_PAGES; pageNumber++) {
      if (abortSignal.aborted) {
        return logAbortAndReturn(log, { written: kept.length, skipped, scanned });
      }

      await log(msg.fetchingPage(pageNumber));
      const fetchResult = await fetchMembersPage(page, pageNumber, PER_PAGE);
      if (!fetchResult.ok) {
        throw new Error(
          `Failed to fetch members API page ${pageNumber}: HTTP ${fetchResult.status}`,
        );
      }
      const apiMembers = fetchResult.json;
      await log(msg.pageReceived(pageNumber, apiMembers.length));

      if (apiMembers.length === 0) {
        break;
      }

      const members = apiMembers.map(toMember);

      /* Sort sanity check: MN's API is documented to honour
       * `sort=last_visit_at&sort_order=desc`, but a silent contract
       * change would corrupt our break-on-inactive logic without
       * surfacing visibly. Probe each page once and log loudly on
       * a violation; the run continues either way. */
      if (isPageSortViolated(members)) {
        await log(msg.sortViolation(pageNumber));
      }

      for (const member of members) {
        if (abortSignal.aborted) {
          return logAbortAndReturn(log, { written: kept.length, skipped, scanned });
        }
        const decision = classifyMember(member, now);
        if (decision.kind === 'keep') {
          scanned += 1;
          kept.push(member);
          continue;
        }
        if (decision.kind === 'skip') {
          scanned += 1;
          skipped += 1;
          if (decision.reason === 'excluded') {
            await log(msg.excludedSkip(member.memberId));
          } else {
            await log(msg.recentJoinerSkip(member.name || String(member.memberId)));
          }
          continue;
        }
        /* decision.kind === 'break' — the trigger row is examined
         * but does NOT count toward `scanned` (per the spec). */
        if (decision.reason === 'never-visited') {
          await log(msg.neverVisitedBreak(member.name || String(member.memberId)));
        } else {
          await log(msg.inactiveBreak(member.name || String(member.memberId)));
        }
        break pageLoop;
      }

      if (apiMembers.length < PER_PAGE) {
        /* Short page = end of the listing. Stop before fetching a
         * page that we already know will be empty. */
        break;
      }
    }

    await writeCsv(kept, outputPath);
    await log(msg.wrote(kept.length, outputPath));

    return {
      success: true,
      written: kept.length,
      skipped,
      scanned,
      outputPath,
    };
  } catch (err) {
    /* Diagnostics-first: capture the page state before we throw away
     * the page. The dumper is non-throwing by design (see
     * `src/utils/diagnostics.ts`), so it can never mask the real
     * error message we return to the caller. */
    await dumpFailureDiagnostics(
      page,
      { reason: 'collect-active-member-list-failed', error: err },
      log,
    );
    const message = err instanceof Error ? err.message : String(err);
    await log(`ERROR: ${message}`);
    return {
      success: false,
      written: 0,
      skipped: 0,
      scanned: 0,
      error: message,
    };
  }
}
