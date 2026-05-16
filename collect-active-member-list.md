# Plan — `collectActiveMemberList`

Source spec: `agent_prompts/clarifications.md` § "collectActiveMemberList".

> **Status: this document's selector-based "scrape the rendered admin
> page" plan is SUPERSEDED.** The current production module fetches
> members directly from MN's REST API (`GET /api/web/v1/spaces/4747401/members/all`)
> with `?include_email=true&page=N&per_page=100&sort=last_visit_at&sort_order=desc`
> via an in-page `fetch(url, { credentials: 'include' })`. The session
> cookie comes from a one-time visit to the rendered admin page at
> the top of the run; no token plumbing is required. Pagination is
> 1-indexed; termination is `break decision OR empty page OR
> rows<per_page OR MAX_PAGES=1000`. The 30-day / 1-year filter logic
> and `data/active-members.csv` output (header `NAME,MEMBER ID,JOINED,
> LAST ACTIVE`, dates `Apr 19, 2025`-style, RFC-4180 quoted) are
> unchanged. If MN ever restructures the API URL the constant lives
> at the top of `src/tasks/collectActiveMemberList.ts`.
>
> The selector / scroll / list-shape detection content below is
> retained for archival reference only (it documents why the
> DOM-scraping approach was tried and why it failed: MN's lazy-loader
> caps programmatic scroll at ~50 rows even with the viewport
> pinned). New work should not be done against this plan; update the
> production module + `agent_prompts/clarifications.md` instead.

## Purpose

Scrape the global admin members page (`https://emergent-commons.mn.co/admin/members/all`),
sort by **Last Active (descending)**, walk the infinite-scroll list from the most-recently
active member downward, and write an `active-members.csv` file (header
`NAME,MEMBER ID,JOINED,LAST ACTIVE`) for the operator to download via a
token-protected endpoint.

Per-row filter logic (final, see clarifications.md §collectActiveMemberList lines 199–200):

- `memberJoinDate < 1 year ago` (i.e. the member joined less than a year before "today") →
  **skip this row, continue** the walk. The intent is "members with ≥ 1 year of tenure".
- `memberLastActiveDate > 30 days ago` → **break out of the loop and discard this row**.
  Because the list is sorted by Last Active DESC, every row after the breaking row is
  guaranteed to also fail the cutoff, so stopping is correct.

The CSV is written to `data/active-members.csv` (NOT `public/`, see Q4 below — the file
contains member PII and must not be served by the static-file middleware).

## Files to add / change

| Path | Change |
|---|---|
| `src/tasks/collectActiveMemberList.ts` | **NEW** — Puppeteer task module (mirrors `addSpaceMember.ts` shape) |
| `src/server.ts` | **EDIT** — register `POST /run/collect-active-member-list`, `GET /downloads/active-members.csv`, and `GET /downloads/active-members-link` |
| `public/index.html` | **EDIT** — new "Members" tab with the run button + dynamic, token-protected download link |
| `test/collectActiveMemberList.test.ts` | **NEW** — unit tests with a mocked `Page` |
| `.env.example` | **EDIT** — add `ACTIVE_MEMBER_LIST_TOKEN` placeholder + comment |
| `deploy.md` | **EDIT** — document the new token env var and the `/downloads/...` endpoint |

No new dependencies. CSV writing uses `node:fs/promises`; no library needed for the
small, well-controlled value space (member-name commas/quotes are escaped per RFC 4180).
The token comparison uses `node:crypto.timingSafeEqual` (already in core).

`data/` is already in the project-wide `.gitignore`, so no new ignore entries are
needed.

## Module shape — `src/tasks/collectActiveMemberList.ts`

Follow the exact conventions from `src/tasks/addSpaceMember.ts`:

- `// === CSS SELECTORS — UPDATE THESE IF MN CHANGES ITS DOM ===` block at top.
- `// === URLS ===`, `// === TIMING CONSTANTS ===`, `// === TEXT FRAGMENTS ===` blocks.
- `LogLevel = 'light' | 'debug'` with a default driven by an env var
  (`COLLECT_MEMBERS_LOG_LEVEL`).
- Exported types `CollectActiveMemberListArgs` and `CollectActiveMemberListResult`.
- A primitives section (`waitForSelector`, `waitForVisible`, `domClick`) — copy from
  `addSpaceMember.ts` rather than inventing new ones; if duplication grows past three
  call sites total we can extract a shared `src/utils/page.ts` later, but not in this
  change.
- Step functions (`detectListShape`, `sortByLastActive`, `scrollUntilStable`,
  `extractRow`, `writeCsv`) each ending with a postcondition assertion.
- `dumpFailureDiagnostics(...)` in the outer `catch`, identical pattern to
  `addSpaceMember.ts`.

### Public API

```ts
export type CollectActiveMemberListArgs = {
  page: Page;
  log: LogFn;
  abortSignal: { aborted: boolean };
  sleep?: (ms: number) => Promise<void>;
  logLevel?: LogLevel;
  /** Override for tests — defaults to `<repoRoot>/data/active-members.csv`. */
  outputPath?: string;
  /** Override for tests — defaults to `new Date()`. */
  now?: Date;
};

export type CollectActiveMemberListResult = {
  success: boolean;
  written: number;       // rows in the CSV (excluding the header)
  skipped: number;       // rows discarded by the join-date < 1 year filter
  scanned: number;       // rows examined before the break (= written + skipped + 1 if break fired)
  outputPath?: string;   // absolute path of the written file
  error?: string;
};
```

`skipped` and `scanned` are populated for the run-log email and admin debugging — the
operator wants to know "did the walk stop early because of the 30-day cutoff, or because
it really hit the bottom of the list?", and the difference between `scanned` and
`written + skipped` answers that.

### Selector constants (transcribed from clarifications.md)

```ts
const SEL_READY = 'body.pace-done #community-app';
const SEL_TABLE_MEMBERS = '.all-members-list-items';
const SEL_MEMBER_ROW = '[data-member-item]';
const SEL_NAME_TH = "[title='Member Name']";
const SEL_JOINED_TH = "[title='Joined Network']";
const SEL_ACTIVE_TH = "[title='Last Active']";
const SEL_NAME_LI = ":has(+ [title='Name']) a";
const SEL_JOINED_LI = ":has(+ [title='Joined Network'])";
const SEL_ACTIVE_LI = ":has(+ [title='Last Active'])";
const SEL_SORTED_BY_DROPDOWN = '.sorted-by-region a.mighty-drop-down-toggle';
const SEL_SORTED_BY_LAST_ACTIVE = '#menu-list-item-last_visit_at_desc';
```

> **Note about `SEL_NAME_LI`** — clarifications.md uses `[title='Name']` for the LI form,
> but `[title='Member Name']` for the TH form. We will use the constants verbatim, then
> verify against the live DOM during the first run; if MN actually emits `Member Name`
> in both forms, update the constant rather than inventing a fork.

### Process (matches clarifications.md §collectActiveMemberList)

1. `page.goto(MEMBERS_URL, { waitUntil: 'domcontentloaded' })`.
2. `loginIfNeeded(page, log)` — same login plumbing every other task uses.
3. `waitForSelector(SEL_READY, 60_000)` then `waitForSelector(SEL_TABLE_MEMBERS, 60_000)`.
4. **Detect list shape** — read `tagName` of the `SEL_TABLE_MEMBERS` element:
   - `'TABLE'` → table mode. Compute `colIndexName/Joined/Active` by walking the
     `thead th[title]` siblings (1-based index of the matching `[title=...]`).
   - `'UL'` → list mode. No column indices needed; `:has(+ [title=...])` selectors are
     row-relative.
   - Anything else → fail loudly with a self-describing error so the next run captures
     a diagnostic dump.
5. **Sort by Last Active**:
   - `domClick(SEL_SORTED_BY_DROPDOWN)`.
   - `waitForVisible(SEL_SORTED_BY_LAST_ACTIVE, WAIT_SHORT_MS)`.
   - `domClick(SEL_SORTED_BY_LAST_ACTIVE)`.
   - Wait for the table/list to re-render. We can't trust a "first row changed" signal
     because the page may already have been sorted. We wait for the dropdown menu to
     close (selector goes absent) AND sleep `ANIMATION_SETTLE_MS` to let the rerender
     settle.
6. **Scroll until stable** — copy the `scrollUntilStable` pattern from
   `removeSpaceMembers.ts`, but scroll the **window/document** (or the
   `SEL_TABLE_MEMBERS` container if the global members page has its own scroll
   container — confirm during first headed run). Reuse `SCROLL_LOAD_MS = 3000` and
   `SCROLL_MAX_RETRIES = 5`. Increase `SCROLL_MAX_RETRIES` if the active member set is
   large (~thousands of rows); we won't tune until we have a real measurement.
7. **Walk rows** — `page.$$(SEL_MEMBER_ROW)` after scrolling completes (we don't
   stream during scroll to keep the loop simple). For each row, in DOM order:
   - Check `abortSignal.aborted` between rows; if set, exit cleanly without writing
     a partial CSV (see "Risks" below).
   - Read `fullMemberName` via `textContent.trim()` of the appropriate name selector.
   - Read `memberId` from the `href` of that anchor (parse `/u/<id>` or `/users/<id>`,
     whichever the live DOM uses; both styles appear in the codebase).
   - Read `memberJoinDate` (text) and `memberLastActiveDate` (text).
   - Parse both with `parseAbsoluteDate(text, now)` (see "Date parsing" below). An
     unparseable string is logged loudly and treated as **break and discard** so we
     never emit a CSV with garbage dates.
   - **Filter logic** (final, per clarifications.md 199–200):
     - If `memberJoinDate >= now - 1 year` → **skip this row, continue** (joined too
       recently; doesn't qualify as "tenured active member"). Increment `skipped`.
     - Else if `memberLastActiveDate < now - 30 days` → **break out of the loop and
       discard this row** (because the list is sorted by Last Active DESC, every row
       after this is also past the 30-day cutoff). Increment `scanned` for the
       breaking row but do not push it.
     - Else push `{ name, memberId, joined, lastActive }` into the result buffer.
8. **Write CSV** — `fs.writeFile(outputPath, header + rows.map(toCsvRow).join('\n'))`.
   - `outputPath` defaults to `path.join(process.cwd(), 'data', 'active-members.csv')`.
   - Header: `NAME,MEMBER ID,JOINED,LAST ACTIVE\n`.
   - `toCsvRow` quotes any field that contains `,`, `"`, `\n`, or `\r`, doubling
     embedded `"`. This is RFC-4180-shaped output that Excel and Numbers both open
     correctly.
   - Use `\n` line endings (matches the existing repo style; the `data/diagnostics`
     JSON files use the same).
   - Write with `mode: 0o600` so the file is operator-only on disk (defence in depth
     beyond the HTTP token; matches the posture for `data/ec-admin.db`).
9. Return `{ success: true, written: rows.length, skipped, scanned, outputPath }`.

### Date parsing

Per Q3, MN only renders **absolute dates** like `"Apr 19, 2026"` in these columns; no
relative buckets. The parser is therefore a tiny helper:

```ts
type ParsedDate =
  | { kind: 'parsed'; date: Date }
  | { kind: 'unparseable'; raw: string };

function parseAbsoluteDate(raw: string, now: Date): ParsedDate;
```

Implementation:

- Trim whitespace and try `new Date(trimmed)`.
- If `isNaN(date.getTime())` or the parser produced a date more than ~12 hours in the
  future of `now` (sanity guard against locale ambiguity), return
  `{ kind: 'unparseable', raw: trimmed }`.
- Otherwise return `{ kind: 'parsed', date }`.

Cutoff comparisons:

- "1 year ago" = `now` minus 365 days at exact-ms resolution. Inclusive on the
  recent side: a row whose `joined` is *exactly* 1 year old is kept (qualifies for
  "tenured").
- "30 days ago" = `now` minus 30 days. Inclusive on the recent side: a row whose
  `lastActive` is *exactly* 30 days old is kept (still active).

> If the live MN page later starts emitting relative strings (e.g. "yesterday"), the
> parser will mark them unparseable and the run will halt with a loud log line — the
> operator can then update clarifications.md and this module in the same patch.

## HTTP wiring — `src/server.ts`

Three new endpoints. The first runs the scrape through the existing scheduler; the
other two gate access to the resulting CSV behind a token from `.env`.

### `POST /run/collect-active-member-list`

Mirror the `/run/add-space-member` endpoint:

```ts
app.post('/run/collect-active-member-list', async (req, res) => {
  const body = req.body as Record<string, unknown>;
  const headless = parseHeadless(body);
  if (!headless.ok) { res.status(400).json({ error: headless.error }); return; }

  await runExclusiveBrowserTask(res, {
    name: 'collectActiveMemberList',
    headless: headless.value,
    run: async (ctx) =>
      deps.collectActiveMemberList({
        page: ctx.page,
        log: ctx.log,
        abortSignal: ctx.abortSignal,
        sleep: ctx.sleep,
      }),
    summarize: (r) =>
      r.success
        ? `wrote ${r.written} rows (skipped ${r.skipped}, scanned ${r.scanned}) to ${r.outputPath}`
        : `failed — ${r.error ?? 'unknown error'}`,
  });
});
```

Add to `CreateAppDeps`:

```ts
collectActiveMemberList: typeof defaultCollectActiveMemberList;
```

Wire `defaultCollectActiveMemberList` in the `if (isMainModule)` entry-point block,
exactly as `defaultAddSpaceMember` is wired today.

The endpoint goes through the existing `runExclusiveBrowserTask` → `scheduler.runNow`
plumbing, so it gets **for free**: browser lifecycle in `finally`, the exclusive
browser-lock semantics (HTTP 409 if another task is mid-flight), live WebSocket log
streaming, the `sendRunLogEmail` notification at the end of the run, and abort plumbing.

### `GET /downloads/active-members-link`

Returns the tokenised download URL the UI should use for its download anchor. Returns
`{ url: '/downloads/active-members.csv?token=…', exists: boolean, mtime: string|null }`,
or 404 if `ACTIVE_MEMBER_LIST_TOKEN` is unset (so the UI can show a helpful "set the
token in .env" message instead of a broken link).

The token is **not** embedded in the static HTML — the UI fetches it on demand. This
is a small but real win versus baking the token into `index.html`: anyone with browser
DevTools-level access already has full admin powers, but a static-token-in-HTML would
also leak via View Source caches, screen-share recordings, and so on.

```ts
app.get('/downloads/active-members-link', (_req, res) => {
  const token = process.env.ACTIVE_MEMBER_LIST_TOKEN?.trim();
  if (!token) {
    res.status(404).json({
      error: 'ACTIVE_MEMBER_LIST_TOKEN is not set on this server.',
    });
    return;
  }
  let exists = false;
  let mtime: string | null = null;
  try {
    const stat = fs.statSync(activeMembersCsvPath());
    exists = true;
    mtime = stat.mtime.toISOString();
  } catch { /* file not yet generated */ }
  res.status(200).json({
    url: `/downloads/active-members.csv?token=${encodeURIComponent(token)}`,
    exists,
    mtime,
  });
});
```

### `GET /downloads/active-members.csv`

Token-gated streaming of the CSV file:

```ts
app.get('/downloads/active-members.csv', (req, res) => {
  const expected = process.env.ACTIVE_MEMBER_LIST_TOKEN?.trim();
  if (!expected) { res.status(404).end(); return; }
  const provided = typeof req.query.token === 'string' ? req.query.token : '';
  if (!tokensMatch(expected, provided)) { res.status(403).end(); return; }

  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition',
    'attachment; filename="active-members.csv"');
  res.setHeader('Cache-Control', 'no-store');
  res.sendFile(activeMembersCsvPath(), (err) => {
    if (err && !res.headersSent) res.status(404).end();
  });
});
```

`tokensMatch` does a constant-time compare via `crypto.timingSafeEqual` after first
checking that both sides are equal length (timingSafeEqual throws on mismatched
lengths):

```ts
function tokensMatch(expected: string, provided: string): boolean {
  if (expected.length !== provided.length) return false;
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(provided, 'utf8');
  return crypto.timingSafeEqual(a, b);
}
```

`activeMembersCsvPath()` is a single-source-of-truth helper (also used by the task
module) that returns `path.join(process.cwd(), 'data', 'active-members.csv')` unless
overridden by `ACTIVE_MEMBER_LIST_PATH` for tests/diagnostics.

## UI — `public/index.html`

Add a fourth tab labelled **Members** that contains:

- A short paragraph explaining what the export does, that it overwrites the previous
  file, and that the download link is token-gated (no anonymous access).
- One button: **Generate active-members.csv**. Reuses the global `chk-headless`
  checkbox. Click → `runTask('members', '/run/collect-active-member-list', { headless })`.
- A **Download CSV** anchor whose `href` is populated dynamically:
  - On tab activation and after every successful run, the UI does
    `GET /downloads/active-members-link`.
  - 200 → set `a.href = body.url`, show "last generated: {body.mtime}" (or "(not
    generated yet)" if `exists: false`), enable the link.
  - 404 → render a helpful message: "Set `ACTIVE_MEMBER_LIST_TOKEN` in `.env` to
    enable downloads." Disable the link.
  - 5xx → show the error in the result panel.
- Run status flows through the existing WebSocket `done`/`error` plumbing, identical
  to `addSpaceMember` etc. — `setTaskRunning('members')` covers the "Abort" inline
  button and the running-dot indicator on the tab.

The `setTaskRunning` and `syncTabRunningDots` helpers already accept an arbitrary
section identifier; extend the running-section enum from `'remove' | 'add' | null` to
`'remove' | 'add' | 'members' | null` and add `actionsMembers` + `btnAbortMembers`
references in the same shape as the existing tabs.

## Tests — `test/collectActiveMemberList.test.ts`

Mirror `test/addSpaceMember.test.ts`'s mocked-`Page` style. Covers task module, pure
helpers, and the new endpoints.

### Task module (mocked Page)

1. **happy path / table mode** — `evaluate` returns `'TABLE'` for shape detection,
   column indices for the 3 column lookups, then a row set where the first 2 rows
   pass the filters and the 3rd row has a `lastActive` ~100 days ago. Expect:
   - `fs.writeFile` called once with header + 2 rows.
   - Result `{ success: true, written: 2, skipped: 0, scanned: 3 }`.
2. **happy path / list mode** — `evaluate` returns `'UL'`; same semantics, exercising
   the LI selector branch.
3. **skip-and-continue on recent joiner** — a row whose `joined` is 6 months ago is
   skipped, the walk continues, and a later row that *does* qualify still ends up in
   the CSV. Result `skipped: 1, written: 1`.
4. **break on inactive** — first row passes, second row's `lastActive` is 91 days
   ago. Expect the CSV contains only the first row and `scanned === 2`.
5. **stop on unparseable date** — a row whose `lastActive` text is gibberish triggers
   the discard-and-break branch; the log message names the offending value.
6. **already aborted before goto** → returns abort result without launching the
   browser side, identical to `addSpaceMember`'s short-circuit test.
7. **abort mid-iteration** → the loop exits cleanly and the partial CSV is **not**
   written (it would lie about its completeness). Result is
   `success: true, error: 'Aborted by user'`.
8. **no rows match** → empty CSV (header only) is still written and `written: 0` is
   returned, so a download link still resolves to a real (header-only) file.
9. **diagnostics dump on thrown error** → mock `dumpFailureDiagnostics` and assert it
   ran with `reason: 'collect-active-member-list-failed'` when an inner step throws.

### Pure helpers

10. **`toCsvRow`** — commas, double-quotes, embedded newlines, leading/trailing
    spaces, and a clean baseline. No `Page` mock needed.
11. **`parseAbsoluteDate`** — `"Apr 19, 2026"`, `"2026-04-19"`, `"April 19, 2026"`,
    whitespace, an obviously-future date (sanity guard), an empty string, and a
    nonsense input.
12. **filter logic** — cutoff edge cases (exactly 30 days old still passes, exactly
    31 days old breaks; exactly 1 year tenure still passes, 364 days skips).

### Server endpoints

13. **`POST /run/collect-active-member-list`** — the deps-injected stub returns a
    canned result; assert the response body shape and that the runtime threads
    through `parseHeadless`.
14. **`GET /downloads/active-members-link`** — token unset returns 404; token set
    and file absent returns `{ exists: false, mtime: null, url: ...?token=... }`;
    file present returns `exists: true` and an ISO mtime.
15. **`GET /downloads/active-members.csv`** — token unset → 404; wrong token → 403;
    correct token but file missing → 404; correct token + file present → 200 with
    `Content-Type: text/csv` and `Content-Disposition: attachment`.

Tests use the existing `supertest` setup (see `test/server.test.ts`). Token-compare
tests should hit `tokensMatch` directly *and* through the route, so any future swap
of the comparison primitive can't accidentally make wrong tokens succeed.

Run with `npm test`; vitest is already configured.

## Implementation order

1. Pure helpers (no Puppeteer): `parseAbsoluteDate`, `toCsvRow`, `tokensMatch`,
   `activeMembersCsvPath()`. Land alongside their unit tests so the cutoff math and
   token compare are locked down before any browser code touches them.
2. `src/tasks/collectActiveMemberList.ts` skeleton — selectors, types, validation,
   abort-shortcircuit. Mocked-Page tests pass at this point for the trivial branches.
3. Step functions in order: `detectListShape`, `sortByLastActive`, `scrollUntilStable`,
   `extractRow`, `writeCsv`. Add a focused mocked-Page test as each step lands.
4. Server endpoints + entry-point wiring (all three endpoints land together so the UI
   can ship in step 5 without follow-up patches). `test/server.test.ts`-style smoke
   tests for each endpoint with the deps-injected stub.
5. UI tab + button + dynamic download-link panel.
6. `.env.example` + `deploy.md` updates documenting `ACTIVE_MEMBER_LIST_TOKEN` and
   the `/downloads/...` endpoints.
7. Manual headed run against the live MN admin page (small scroll budget, then abort)
   to confirm the selectors. Update constants if MN's live DOM disagrees with
   clarifications.md, and update clarifications.md to match what we see.
8. Manual headless run with the full scroll budget. Inspect the produced CSV; sanity
   check row counts vs the visible "Last Active" sort.

## Risks and corner cases

- **Infinite-scroll budget** — if MN renders 5–10k members the `scrollUntilStable` loop
  may take many minutes. We're inside `runExclusiveBrowserTask`, so it blocks every
  other task that hits the scheduler during the run. Mitigations: (a) set a hard upper
  bound on row count or wall-clock time, surfacing partial results with a clear
  warning; (b) honour `abortSignal` during scroll, not just during the row walk; (c)
  the sort-by-last-active means we can stop scrolling once the last loaded row's
  `lastActive` is past 30 days — early termination short-circuits long tails. We'll
  add the early-termination optimisation in step 3 of the implementation order.
- **Date parser failure modes** — MN locales other than the bot's could shift the
  date format. The parser fails loudly rather than emitting wrong dates; the operator
  sees a `[date-parse] unparseable: "…"` log line and the run halts with no CSV
  overwrite. Existing CSV (if any) is left untouched.
- **PII at rest** — `data/active-members.csv` is gitignored (the whole `data/` dir is)
  and written `mode: 0o600`. The HTTP token gates the download endpoint with a
  constant-time compare. There is no `public/active-members.csv` shortcut path, so
  even a misconfigured `express.static` cannot leak the file.
- **Token rotation** — operator changes `ACTIVE_MEMBER_LIST_TOKEN` in `.env`,
  restarts the server, and the next `GET /downloads/active-members-link` returns the
  new URL. Old links 403. We document this in `deploy.md`.
- **Re-runs overwrite silently** — fine for now; if an operator needs history they can
  archive manually. We will not roll our own rotating filename until there's demand.

## Resolved questions (was Q1–Q5)

- **Q1 — Filter semantics.** Resolved per clarifications.md 199–200 (the file's
  current text, not the earlier draft): `joined < 1 year ago` → skip-but-continue;
  `lastActive > 30 days ago` → break-and-stop. Net intent: "active members with ≥ 1
  year of tenure".
- **Q2 — Output destination.** **Override:** the CSV lands in `data/`, not `public/`,
  because the file holds PII and the `data/` directory is already gitignored and
  outside the static-served tree. The clarifications.md instruction "in the public
  directory" is the operator-perspective phrasing — what they actually want is "make
  it downloadable from the admin UI", which the new `/downloads/...` endpoints provide
  without exposing the raw filesystem path.
- **Q3 — Date strings.** All absolute (`"Apr 19, 2026"`); no relative buckets. Parser
  is one `new Date()` call plus a sanity guard.
- **Q4 — Access control.** Token-gated via `ACTIVE_MEMBER_LIST_TOKEN` env var. The
  token lives only in `.env` server-side; the UI fetches it on demand.
- **Q5 — Schedule.** Manual only. The new "Members" tab is the single trigger; no
  cron.
