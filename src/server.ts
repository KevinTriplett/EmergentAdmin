import 'dotenv/config';
import express from 'express';
import type { Request, Response } from 'express';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { WebSocketServer, WebSocket } from 'ws';
import type { Page } from 'puppeteer';
import { launchBrowser as defaultLaunchBrowser } from './utils/browser.js';
import {
  removeSpaceMembers as defaultRemoveSpaceMembers,
  SPACE_IDS,
  NOT_IN_SPACE,
} from './tasks/removeSpaceMembers.js';
import { addSpaceMember as defaultAddSpaceMember } from './tasks/addSpaceMember.js';
import { collectActiveMemberList as defaultCollectActiveMemberList } from './tasks/collectActiveMemberList.js';
import {
  activeMembersCsvPath,
  tokensMatch,
} from './utils/activeMemberList.js';
import { sendDirectEmail, sendRunLogEmail as defaultSendRunLogEmail } from './email.js';
import {
  createTaskScheduler,
  TaskConflictError,
  type SchedulerJob,
  type TaskScheduler,
} from './scheduler/taskScheduler.js';
import {
  openAgreementsStore,
  type AgreementsStore,
} from './state/agreementsStore.js';
import {
  createImapPoller,
  openImapConnection,
  type ImapPoller,
  type PollResult,
} from './ingestion/imapPoller.js';
import { AGREEMENT_ARTICLES, REQUIRED_AGREEMENT_COUNT, type AgreementArticle } from './config/agreements.js';
import { buildAddToAllSpacesJob, ALREADY_A_MEMBER } from './tasks/addToAllSpacesJob.js';
import { enqueueCommonsMembershipRepairJobs } from './tasks/membershipReconcile.js';
import {
  buildChangeOfHeartAuditJob,
  type ChangeOfHeartAuditDeps,
} from './tasks/changeOfHeartAuditJob.js';
import cron from 'node-cron';
import {
  approveLead,
  buildHarvestLeadsJob,
  declineLead,
  buildDeclineStaleLeadsJob,
  GREETER_EMAILS,
  openLeadsStore,
  type LeadsStore,
} from './tasks/leads.js';

const publicDir = path.join(process.cwd(), 'public');
const DEFAULT_USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36';

/**
 * Hardcoded safety kill switch for the bulk-removal endpoints.
 *
 * When `true` (the default), POST /run/remove-space-members and
 * POST /run/remove-all-space-members short-circuit before any
 * payload validation, browser launch, or scheduler interaction and
 * respond with HTTP 403 + a self-describing JSON body.
 *
 * This is a deliberately code-level constant (not an env var) so
 * re-enabling the bulk paths requires a reviewed source change and
 * a redeploy — not a runtime flag flip — which is the right level
 * of friction for "delete every non-admin member from a Commons
 * space" or "delete every non-admin member from every space".
 *
 * To re-enable:
 *   1. Set `BULK_REMOVE_DISABLED = false` here in src/server.ts.
 *   2. Run the test suite (`npm test`) and verify the disabled
 *      endpoint tests are updated to reflect the new state.
 *   3. Commit, deploy, restart the service.
 *
 * The single-member remove endpoints (`/run/remove-space-member`
 * and `/run/remove-space-member-all-spaces`) are NOT gated by this
 * switch — targeted removals respect operator intent and are still
 * needed for ordinary moderation (e.g. deleting a single account).
 */
const BULK_REMOVE_DISABLED = true;

/**
 * Standard error body returned by the disabled bulk-remove
 * endpoints. Centralised so both endpoints emit the same shape and
 * tests can assert against the constant rather than a literal.
 */
const BULK_REMOVE_DISABLED_BODY = Object.freeze({
  error: 'Bulk member removal is disabled.',
  detail:
    'POST /run/remove-space-members and POST /run/remove-all-space-members are intentionally disabled as a safety guard. ' +
    'Use POST /run/remove-space-member or POST /run/remove-space-member-all-spaces (with fullMemberName + memberId) ' +
    'to remove a specific member instead. To re-enable bulk removal, set BULK_REMOVE_DISABLED = false in src/server.ts and redeploy.',
});

/**
 * Generic cron-env-var resolver.
 *
 *   undefined / empty / whitespace -> defaultExpr  (null = "default off")
 *   off | disabled | false | no | 0 (any case)
 *                                  -> null         (explicit opt-out)
 *   anything else                  -> raw verbatim (treated as a cron expr)
 *
 * Both `AGREEMENTS_AUDIT_CRON` (default-on) and `RECONCILE_COMMONS_CRON`
 * (default-off, opt-in) use this. Sharing it keeps the off-sentinel set in
 * one place — the original reconcile resolver was a one-line truthy check,
 * which crashed the server on startup when an operator set the env var to
 * the literal string "off" and node-cron tried to parse it as a cron expr.
 *
 * NOTE: These constants and the resolver MUST stay above
 * `createAppWithScheduler`. The entry-point block (`if (isMainModule)`)
 * calls `createAppWithScheduler`, which calls these resolvers during
 * top-level module execution. Function declarations are hoisted but `const`
 * initializations are not — placing them below would put the consts in the
 * TDZ at call time and crash on `npm start`.
 */
const DEFAULT_AUDIT_CRON = '0 3 * * *';
const CRON_OFF_VALUES = new Set(['off', 'disabled', 'false', 'no', '0']);

function resolveCronExpr(raw: string | undefined, defaultExpr: string | null): string | null {
  const trimmed = raw?.trim();
  if (trimmed === undefined || trimmed === '') return defaultExpr;
  if (CRON_OFF_VALUES.has(trimmed.toLowerCase())) return null;
  return trimmed;
}

export function resolveAuditCronExpr(raw: string | undefined): string | null {
  return resolveCronExpr(raw, DEFAULT_AUDIT_CRON);
}

export function resolveReconcileCronExpr(raw: string | undefined): string | null {
  return resolveCronExpr(raw, null);
}

/**
 * Schedule a cron task with a friendly error message instead of a crash if
 * the expression is malformed. node-cron throws synchronously inside
 * `schedule(...)` for invalid patterns; without this guard a typo in the
 * env var ("evry day at 3am") tears down the whole server on startup.
 */
function safeCronSchedule(
  label: string,
  expr: string,
  fn: () => void,
): ReturnType<typeof cron.schedule> | undefined {
  try {
    return cron.schedule(expr, fn);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(
      `[cron] Failed to schedule ${label} with expression "${expr}": ${message}. ` +
        `The server will continue running without this cron.`,
    );
    return undefined;
  }
}

export type BrowserHandle = {
  newPage: () => Promise<Page>;
  close: () => Promise<void>;
};

export type CreateAppDeps = {
  launchBrowser: (headless: boolean) => Promise<BrowserHandle>;
  removeSpaceMembers: typeof defaultRemoveSpaceMembers;
  addSpaceMember: typeof defaultAddSpaceMember;
  /**
   * Optional so existing tests that omit it don't break. At runtime the real
   * `collectActiveMemberList` is wired by the entry-point block.
   */
  collectActiveMemberList?: typeof defaultCollectActiveMemberList;
  /**
   * Optional so existing tests that omit it don't break. At runtime the real
   * `sendRunLogEmail` is used by default; it no-ops outside of production.
   */
  sendRunLogEmail?: typeof defaultSendRunLogEmail;
  leadsStore?: LeadsStore;
  sendLeadEmail?: (message: { from: string; to: string; subject: string; text: string }) => Promise<void>;
  /**
   * Optional agreements store. When provided, persists agreement state and
   * registers Stage 4c `POST /run/reconcile-commons-membership` + Stage 4d
   * agreements status endpoints when the store exists. Optional IMAP hooks
   * enable `POST /run/poll-agreements-mailbox`.
   */
  agreementsStore?: AgreementsStore;
  /** Manual IMAP inbox poll (production wires `ImapPoller.pollOnce`). */
  agreementsImapPollOnce?: () => Promise<PollResult>;
  /** Live IMAP poller telemetry for `/status/agreements`. */
  agreementsImapSnapshot?: () => AgreementsImapRuntimeSnapshot;
  /**
   * Stage 4e: override the change-of-heart audit's page scraper. Production
   * leaves this undefined — the audit job uses its built-in
   * goto+login+expand+scrape against the live MN post page. Tests inject a
   * stub returning canned `ScrapedComment[]` per articleId.
   */
  auditAgreementsLoadAndScrape?: ChangeOfHeartAuditDeps['loadAndScrapeArticleComments'];
  /**
   * Stage 4e: override the article list the audit walks. Production uses
   * `AGREEMENT_ARTICLES`; tests pass synthetic articles to keep the
   * orchestration hermetic.
   */
  auditAgreementsArticles?: readonly AgreementArticle[];
};

/** Mutable slice of-process state for `/status/agreements` (filled by poll wire-up). */
export type AgreementsImapRuntimeSnapshot = {
  watcherEnabled: boolean;
  pollIntervalMs: number;
  lastPollCompletedAt: string | null;
  lastPollResult: PollResult | null;
};

export type CreateAppResult = {
  server: http.Server;
  scheduler: TaskScheduler;
};

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function requireStringField(
  body: Record<string, unknown>,
  name: string,
): { ok: true; value: string } | { ok: false; error: string } {
  const raw = body[name];
  if (typeof raw !== 'string' || !raw.trim()) {
    return { ok: false, error: `${name} is required` };
  }
  return { ok: true, value: raw.trim() };
}

function parseHeadless(body: Record<string, unknown>): { ok: true; value: boolean } | { ok: false; error: string } {
  if (typeof body.headless === 'undefined') return { ok: true, value: true };
  if (typeof body.headless !== 'boolean') return { ok: false, error: 'headless must be a boolean' };
  return { ok: true, value: body.headless };
}

function parseDryRun(body: Record<string, unknown>): { ok: true; value: boolean } | { ok: false; error: string } {
  if (typeof body.dryRun === 'undefined') return { ok: true, value: true };
  if (typeof body.dryRun !== 'boolean') return { ok: false, error: 'dryRun must be a boolean' };
  return { ok: true, value: body.dryRun };
}

/**
 * Stage 4g: optional `force` flag on `/run/add-space-member-all-spaces`.
 * When true, the all-spaces job ignores the per-(member, space) attempt
 * ledger's verified-`'present'` rows and re-attempts every space — the
 * intended manual override for "the member explicitly asked to be put
 * back into the space they left". Defaults to false so a casual click
 * never violates the consent guarantee.
 */
function parseForce(body: Record<string, unknown>): { ok: true; value: boolean } | { ok: false; error: string } {
  if (typeof body.force === 'undefined') return { ok: true, value: false };
  if (typeof body.force !== 'boolean') return { ok: false, error: 'force must be a boolean' };
  return { ok: true, value: body.force };
}

/** Express + scheduler; IMAP lifecycle is owned by the process entrypoint. */
export function createAppWithScheduler(deps: CreateAppDeps): CreateAppResult {
  const clients = new Set<WebSocket>();
  const sendRunLogEmail = deps.sendRunLogEmail ?? defaultSendRunLogEmail;

  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '32kb' }));
  app.use(express.static(publicDir));

  function broadcast(payload: object): void {
    const raw = JSON.stringify(payload);
    for (const ws of clients) {
      if (ws.readyState === WebSocket.OPEN) ws.send(raw);
    }
  }

  const scheduler: TaskScheduler = createTaskScheduler({
    launchBrowser: deps.launchBrowser,
    broadcast,
    sendRunLogEmail,
    sleep: defaultSleep,
    userAgent: DEFAULT_USER_AGENT,
    extraHttpHeaders: { 'Accept-Language': 'en-US,en;q=0.9' },
  });

  /**
   * Thin HTTP adapter around `scheduler.runNow`: preserves the old response
   * semantics (200 on success, 409 on conflict, 500 on error) plus the
   * WebSocket log broadcast. The scheduler owns the browser lifecycle, log
   * capture, and the fire-and-forget admin email.
   */
  async function runExclusiveBrowserTask<T>(
    res: Response,
    job: SchedulerJob<T>,
  ): Promise<void> {
    try {
      const result = await scheduler.runNow(job);
      res.status(200).json(result);
    } catch (err) {
      if (err instanceof TaskConflictError) {
        res.status(409).json({ error: err.message });
        return;
      }
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: message });
    }
  }

  // ---------------------------------------------------------------------------
  // /run/remove-space-members
  // ---------------------------------------------------------------------------

  app.post('/run/remove-space-members', async (req: Request, res: Response) => {
    /* Safety kill switch — see BULK_REMOVE_DISABLED at the top of
     * this file. Returned BEFORE any payload validation, browser
     * launch, or scheduler interaction so a stray request can't
     * tie up the exclusive task lock or leak a Chromium process. */
    if (BULK_REMOVE_DISABLED) {
      res.status(403).json(BULK_REMOVE_DISABLED_BODY);
      return;
    }

    const body = req.body as Record<string, unknown>;
    const space = requireStringField(body, 'fullSpaceName');
    if (!space.ok) { res.status(400).json({ error: space.error }); return; }
    const headless = parseHeadless(body);
    if (!headless.ok) { res.status(400).json({ error: headless.error }); return; }
    const dryRun = parseDryRun(body);
    if (!dryRun.ok) { res.status(400).json({ error: dryRun.error }); return; }

    await runExclusiveBrowserTask(res, {
      name: `removeSpaceMembers on "${space.value}"${dryRun.value ? ' (dry run)' : ''}`,
      headless: headless.value,
      run: async (ctx) =>
        deps.removeSpaceMembers({
          page: ctx.page,
          fullSpaceName: space.value,
          dryRun: dryRun.value,
          log: ctx.log,
          abortSignal: ctx.abortSignal,
          sleep: ctx.sleep,
        }),
      summarize: (r) =>
        r.success
          ? `${r.removed ?? 0} removed`
          : `failed — ${r.error ?? 'unknown error'}`,
    });
  });

  // ---------------------------------------------------------------------------
  // /run/remove-all-space-members
  // ---------------------------------------------------------------------------

  app.post('/run/remove-all-space-members', async (req: Request, res: Response) => {
    /* Safety kill switch — see BULK_REMOVE_DISABLED at the top of
     * this file. The all-spaces variant is the most destructive
     * endpoint in the system; returning early protects against
     * accidental clicks even more strongly than the single-space
     * bulk endpoint. */
    if (BULK_REMOVE_DISABLED) {
      res.status(403).json(BULK_REMOVE_DISABLED_BODY);
      return;
    }

    const body = req.body as Record<string, unknown>;
    const headless = parseHeadless(body);
    if (!headless.ok) { res.status(400).json({ error: headless.error }); return; }
    const dryRun = parseDryRun(body);
    if (!dryRun.ok) { res.status(400).json({ error: dryRun.error }); return; }

    await runExclusiveBrowserTask(res, {
      name: `removeSpaceMembers on ALL spaces${dryRun.value ? ' (dry run)' : ''}`,
      headless: headless.value,
      run: async (ctx) => {
        const spaceNames = Object.keys(SPACE_IDS);
        const results: Array<{ space: string; success: boolean; removed: number; error?: string }> = [];

        for (const spaceName of spaceNames) {
          if (ctx.abortSignal.aborted) {
            ctx.log(`Abort requested — skipping remaining spaces.`);
            break;
          }
          ctx.log(`\n═══ Processing space: ${spaceName} ═══`);
          const result = await deps.removeSpaceMembers({
            page: ctx.page,
            fullSpaceName: spaceName,
            dryRun: dryRun.value,
            log: ctx.log,
            abortSignal: ctx.abortSignal,
            sleep: ctx.sleep,
          });
          results.push({ space: spaceName, ...result });
          if (result.success) ctx.log(`✓ ${spaceName}: ${result.removed} removed.`);
          else ctx.log(`✗ ${spaceName}: ${result.error ?? 'unknown error'}`);
        }

        const totalRemoved = results.reduce((sum, r) => sum + r.removed, 0);
        return { totalRemoved, spaces: results };
      },
      summarize: (r) => `${r.totalRemoved} removed across ${r.spaces.length} spaces`,
    });
  });

  // ---------------------------------------------------------------------------
  // /run/remove-space-member (specific member, single space)
  // ---------------------------------------------------------------------------

  /* Targeted removal mirrors the Add side: caller supplies
   * fullMemberName + memberId + fullSpaceName, the underlying task is
   * the same `removeSpaceMembers` (now with optional target fields)
   * but short-circuited to one row. NOT_IN_SPACE in the response is
   * surfaced to the operator as a no-op success rather than a
   * failure, since that's the consent-respecting interpretation. */
  app.post('/run/remove-space-member', async (req: Request, res: Response) => {
    const body = req.body as Record<string, unknown>;
    const fullMemberName = requireStringField(body, 'fullMemberName');
    if (!fullMemberName.ok) { res.status(400).json({ error: fullMemberName.error }); return; }
    const memberId = requireStringField(body, 'memberId');
    if (!memberId.ok) { res.status(400).json({ error: memberId.error }); return; }
    const fullSpaceName = requireStringField(body, 'fullSpaceName');
    if (!fullSpaceName.ok) { res.status(400).json({ error: fullSpaceName.error }); return; }
    const headless = parseHeadless(body);
    if (!headless.ok) { res.status(400).json({ error: headless.error }); return; }
    const dryRun = parseDryRun(body);
    if (!dryRun.ok) { res.status(400).json({ error: dryRun.error }); return; }

    await runExclusiveBrowserTask(res, {
      name: `removeSpaceMember "${fullMemberName.value}" from "${fullSpaceName.value}"${dryRun.value ? ' (dry run)' : ''}`,
      headless: headless.value,
      run: async (ctx) =>
        deps.removeSpaceMembers({
          page: ctx.page,
          fullSpaceName: fullSpaceName.value,
          dryRun: dryRun.value,
          log: ctx.log,
          abortSignal: ctx.abortSignal,
          sleep: ctx.sleep,
          targetMemberId: memberId.value,
          targetMemberName: fullMemberName.value,
        }),
      summarize: (r) => {
        if (!r.success) return `failed — ${r.error ?? 'unknown error'}`;
        if (r.error === NOT_IN_SPACE) return 'not in space (no-op)';
        return r.removed === 1 ? 'removed' : 'no-op';
      },
    });
  });

  // ---------------------------------------------------------------------------
  // /run/remove-space-member-all-spaces (specific member, every space)
  // ---------------------------------------------------------------------------

  /* Mirrors `/run/remove-all-space-members` but for a single member.
   * Each space is processed sequentially in the same browser tab; a
   * NOT_IN_SPACE result for any one space is counted as a "skipped"
   * (member already absent), not a failure, since the operator's
   * intent — "this member should be in zero Commons spaces" — is
   * still satisfied per-space. */
  app.post('/run/remove-space-member-all-spaces', async (req: Request, res: Response) => {
    const body = req.body as Record<string, unknown>;
    const fullMemberName = requireStringField(body, 'fullMemberName');
    if (!fullMemberName.ok) { res.status(400).json({ error: fullMemberName.error }); return; }
    const memberId = requireStringField(body, 'memberId');
    if (!memberId.ok) { res.status(400).json({ error: memberId.error }); return; }
    const headless = parseHeadless(body);
    if (!headless.ok) { res.status(400).json({ error: headless.error }); return; }
    const dryRun = parseDryRun(body);
    if (!dryRun.ok) { res.status(400).json({ error: dryRun.error }); return; }

    await runExclusiveBrowserTask(res, {
      name: `removeSpaceMember "${fullMemberName.value}" from ALL spaces${dryRun.value ? ' (dry run)' : ''}`,
      headless: headless.value,
      run: async (ctx) => {
        const spaceNames = Object.keys(SPACE_IDS);
        const results: Array<{
          space: string;
          success: boolean;
          removed: number;
          error?: string;
          skipped?: boolean;
        }> = [];

        for (const spaceName of spaceNames) {
          if (ctx.abortSignal.aborted) {
            ctx.log(`Abort requested — skipping remaining spaces.`);
            break;
          }
          ctx.log(`\n═══ Processing space: ${spaceName} ═══`);
          const result = await deps.removeSpaceMembers({
            page: ctx.page,
            fullSpaceName: spaceName,
            dryRun: dryRun.value,
            log: ctx.log,
            abortSignal: ctx.abortSignal,
            sleep: ctx.sleep,
            targetMemberId: memberId.value,
            targetMemberName: fullMemberName.value,
          });
          const skipped = result.success && result.error === NOT_IN_SPACE;
          results.push({ space: spaceName, ...result, skipped });
          if (skipped) ctx.log(`• ${spaceName}: not in space (skipped).`);
          else if (result.success) ctx.log(`✓ ${spaceName}: ${result.removed} removed.`);
          else ctx.log(`✗ ${spaceName}: ${result.error ?? 'unknown error'}`);
        }

        const totalRemoved = results.reduce((sum, r) => sum + r.removed, 0);
        const skippedCount = results.filter((r) => r.skipped).length;
        const failureCount = results.filter((r) => !r.success).length;

        /* Stage 4f extension: when a LIVE all-spaces remove ends with
         * every space in the desired "not-a-member" state (no
         * failures; skipped NOT_IN_SPACE rows count as success since
         * the intent — "this member should be in zero Commons
         * spaces" — is still met), roll back the store invariants
         * the add-job had established. Without this the dashboard's
         * "Added to Commons, now anomaly, need to DM" queue would
         * keep showing the member forever (the SQL filters on
         * `commons_added_at IS NOT NULL`), and a future re-add would
         * silently no-op because the Stage 4g per-space ledger
         * still says "already present everywhere".
         *
         * Skipped on dry-run by design — a dry run must never mutate
         * the store. Skipped on partial failure so the store reflects
         * the operator's *actual* end state (some spaces still have
         * the member). */
        const store = deps.agreementsStore;
        let storeCleanup: {
          commonsAddedCleared: boolean;
          spaceAttemptsDeleted: number;
        } | null = null;
        if (store && !dryRun.value && failureCount === 0) {
          storeCleanup = store.markCommonsRemoved(memberId.value);
          if (storeCleanup.commonsAddedCleared) {
            ctx.log(
              `\nStore: cleared commons_added_at for ${fullMemberName.value} (member id ${memberId.value}).`,
            );
          }
          if (storeCleanup.spaceAttemptsDeleted > 0) {
            ctx.log(
              `Store: deleted ${storeCleanup.spaceAttemptsDeleted} member_space_attempts row(s) for ${fullMemberName.value}.`,
            );
          }
          if (!storeCleanup.commonsAddedCleared && storeCleanup.spaceAttemptsDeleted === 0) {
            ctx.log(`\nStore: no rollback needed (member had no commons_added_at flag or space-attempts).`);
          }
        }

        return { totalRemoved, skippedCount, failureCount, spaces: results, storeCleanup };
      },
      summarize: (r) =>
        `${r.totalRemoved} removed across ${r.spaces.length} spaces` +
        (r.skippedCount ? `, ${r.skippedCount} not in space` : '') +
        (r.failureCount ? `, ${r.failureCount} failed` : '') +
        (r.storeCleanup && r.storeCleanup.commonsAddedCleared
          ? `, store: commons_added_at cleared` +
            (r.storeCleanup.spaceAttemptsDeleted > 0
              ? ` (+${r.storeCleanup.spaceAttemptsDeleted} attempt rows)`
              : '')
          : ''),
    });
  });

  // ---------------------------------------------------------------------------
  // /run/add-space-member (single space)
  // ---------------------------------------------------------------------------

  app.post('/run/add-space-member', async (req: Request, res: Response) => {
    const body = req.body as Record<string, unknown>;
    const fullMemberName = requireStringField(body, 'fullMemberName');
    if (!fullMemberName.ok) { res.status(400).json({ error: fullMemberName.error }); return; }
    const memberId = requireStringField(body, 'memberId');
    if (!memberId.ok) { res.status(400).json({ error: memberId.error }); return; }
    const fullSpaceName = requireStringField(body, 'fullSpaceName');
    if (!fullSpaceName.ok) { res.status(400).json({ error: fullSpaceName.error }); return; }
    const headless = parseHeadless(body);
    if (!headless.ok) { res.status(400).json({ error: headless.error }); return; }

    await runExclusiveBrowserTask(res, {
      name: `addSpaceMember "${fullMemberName.value}" → "${fullSpaceName.value}"`,
      headless: headless.value,
      run: async (ctx) =>
        deps.addSpaceMember({
          page: ctx.page,
          fullMemberName: fullMemberName.value,
          memberId: memberId.value,
          fullSpaceName: fullSpaceName.value,
          log: ctx.log,
          abortSignal: ctx.abortSignal,
          sleep: ctx.sleep,
        }),
      summarize: (r) => {
        if (!r.success) return `failed — ${r.error ?? 'unknown error'}`;
        return r.error === ALREADY_A_MEMBER ? 'already a member' : 'added';
      },
    });
  });

  // ---------------------------------------------------------------------------
  // /run/add-space-member-all-spaces
  // ---------------------------------------------------------------------------

  app.post('/run/add-space-member-all-spaces', async (req: Request, res: Response) => {
    const body = req.body as Record<string, unknown>;
    const fullMemberName = requireStringField(body, 'fullMemberName');
    if (!fullMemberName.ok) { res.status(400).json({ error: fullMemberName.error }); return; }
    const memberId = requireStringField(body, 'memberId');
    if (!memberId.ok) { res.status(400).json({ error: memberId.error }); return; }
    const headless = parseHeadless(body);
    if (!headless.ok) { res.status(400).json({ error: headless.error }); return; }
    const force = parseForce(body);
    if (!force.ok) { res.status(400).json({ error: force.error }); return; }

    const job = buildAddToAllSpacesJob(
      { addSpaceMember: deps.addSpaceMember, store: deps.agreementsStore },
      { fullMemberName: fullMemberName.value, memberId: memberId.value, force: force.value },
    );
    // The manual endpoint always runs at its requested headless-ness.
    job.headless = headless.value;
    await runExclusiveBrowserTask(res, job);
  });

  // ---------------------------------------------------------------------------
  // /run/collect-active-member-list  +  /downloads/active-members*
  // ---------------------------------------------------------------------------

  /* The CSV produced here lives under `data/` (NOT `public/`) because it
   * contains member PII. It's served by an explicit token-gated handler
   * below; nothing about this feature is reachable through the static
   * middleware. */
  app.post('/run/collect-active-member-list', async (req: Request, res: Response) => {
    if (!deps.collectActiveMemberList) {
      res.status(404).json({
        error: 'collectActiveMemberList task is not wired on this server.',
      });
      return;
    }
    const body = req.body as Record<string, unknown>;
    const headless = parseHeadless(body);
    if (!headless.ok) { res.status(400).json({ error: headless.error }); return; }

    const collectTask = deps.collectActiveMemberList;
    await runExclusiveBrowserTask(res, {
      name: 'collectActiveMemberList',
      headless: headless.value,
      run: async (ctx) =>
        collectTask({
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

  /* The download link is fetched on demand by the UI rather than baked
   * into the static HTML. This means the token never appears in
   * `index.html` source, View Source caches, or screen-share recordings.
   * Anyone with browser DevTools to this server can still observe it,
   * but those people are admins by definition. */
  app.get('/downloads/active-members-link', (_req: Request, res: Response) => {
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
    } catch {
      /* File not yet generated. The UI uses `exists: false` to render
       * "(not generated yet)" instead of a broken link. */
    }
    res.status(200).json({
      url: `/downloads/active-members.csv?token=${encodeURIComponent(token)}`,
      exists,
      mtime,
    });
  });

  app.get('/downloads/active-members.csv', (req: Request, res: Response) => {
    const expected = process.env.ACTIVE_MEMBER_LIST_TOKEN?.trim();
    if (!expected) { res.status(404).end(); return; }
    const provided = typeof req.query.token === 'string' ? req.query.token : '';
    if (!tokensMatch(expected, provided)) { res.status(403).end(); return; }

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="active-members.csv"');
    res.setHeader('Cache-Control', 'no-store');
    res.sendFile(activeMembersCsvPath(), (err) => {
      if (err && !res.headersSent) res.status(404).end();
    });
  });

  // -----------------------------------------------------------------------
  // Stage 4d: agreements dashboard (read-only SQLite + optional IMAP meta)
  // -----------------------------------------------------------------------

  if (deps.agreementsStore) {
    app.get('/status/agreements', (_req: Request, res: Response) => {
      const store = deps.agreementsStore!;
      const dbOverview = store.getAgreementsOverview();
      const imap = deps.agreementsImapSnapshot?.() ?? null;
      res.status(200).json({
        db: dbOverview,
        imap,
        configuredAgreementArticles: AGREEMENT_ARTICLES.map((a) => ({
          articleId: a.articleId,
          spaceId: a.spaceId,
          title: a.title,
          url: a.url,
        })),
      });
    });

    app.post('/run/poll-agreements-mailbox', async (_req: Request, res: Response) => {
      if (!deps.agreementsImapPollOnce) {
        res.status(404).json({ error: 'IMAP poller not configured on this process' });
        return;
      }
      try {
        const result = await deps.agreementsImapPollOnce();
        res.status(200).json(result);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        res.status(500).json({ error: message });
      }
    });

    app.post('/run/reconcile-commons-membership', async (req: Request, res: Response) => {
      const store = deps.agreementsStore!;
      /* `headless` is a dev affordance: prod cron always launches headless
       * (it doesn't go through this endpoint — see the scheduler call
       * inside `safeCronSchedule('reconcile-commons', ...)` which omits
       * `options` and so picks up the headless-true default). The manual
       * UI lets an operator uncheck the "Headless mode" box to watch the
       * Puppeteer flow during a debug session. Anything other than the
       * literal `false` value falls back to headless. */
      const body = (req.body ?? {}) as Record<string, unknown>;
      const headless = body.headless === false ? false : true;
      const members = enqueueCommonsMembershipRepairJobs(
        scheduler,
        { addSpaceMember: deps.addSpaceMember },
        store,
        (msg) => console.log(msg),
        { headless },
      );
      res.status(200).json({
        enqueued: members.length,
        headless,
        members: members.map((m) => ({
          memberId: m.memberId,
          fullName: m.fullName,
          agreementCount: m.agreementCount,
        })),
      });
    });

    // ---------------------------------------------------------------------
    // Stage 4e: change-of-heart audit (manual trigger)
    // ---------------------------------------------------------------------

    app.post('/run/audit-agreements', async (req: Request, res: Response) => {
      const body = req.body as Record<string, unknown>;
      /* `headless` is a dev-affordance: prod cron always launches headless
       * (its caller is `enqueueBackground` which never touches this field).
       * From the UI the operator can set it to false to watch the audit
       * happen in a visible browser while debugging selectors. Defaults to
       * true to match the prod cron path. */
      const headless = parseHeadless(body);
      if (!headless.ok) { res.status(400).json({ error: headless.error }); return; }

      const store = deps.agreementsStore!;
      const job = buildChangeOfHeartAuditJob(store, {
        loadAndScrapeArticleComments: deps.auditAgreementsLoadAndScrape,
        articles: deps.auditAgreementsArticles,
      });
      job.headless = headless.value;
      await runExclusiveBrowserTask(res, job);
    });
  }

  if (deps.leadsStore) {
    const leads = deps.leadsStore;
    app.get('/status/leads', (_req: Request, res: Response) => {
      res.status(200).json({ leads: leads.list() });
    });

    app.post('/run/harvest-leads', async (req: Request, res: Response) => {
      const headless = req.body?.headless !== false;
      await runExclusiveBrowserTask(res, buildHarvestLeadsJob(leads, deps.sendLeadEmail, headless));
    });

    app.post('/run/leads/:email/approve', async (req: Request, res: Response) => {
      const email = req.params.email;
      await runExclusiveBrowserTask(res, {
        name: 'approve-lead', headless: req.body?.headless !== false,
        run: async ({ page, log }) => {
          const result = await approveLead(page, email, log);
          if (!result.success) throw new Error(result.error ?? 'Approve failed');
          leads.updateStatus(email, 'Joined');
          return result;
        }, summarize: (result) => `${result.status}: ${result.email}`,
      });
    });

    app.post('/run/leads/:email/decline', async (req: Request, res: Response) => {
      const email = req.params.email;
      await runExclusiveBrowserTask(res, {
        name: 'decline-lead', headless: req.body?.headless !== false,
        run: async ({ page, log }) => {
          const result = await declineLead(page, email, log);
          if (!result.success) throw new Error(result.error ?? 'Decline failed');
          leads.updateStatus(email, 'Declined');
          return result;
        }, summarize: (result) => `${result.status}: ${result.email}`,
      });
    });

    app.post('/run/leads/:email/email', async (req: Request, res: Response) => {
      const email = req.params.email;
      const lead = leads.getByEmail(email);
      if (!lead) { res.status(404).json({ error: 'Lead not found' }); return; }
      try {
        await (deps.sendLeadEmail ?? (async (message) => sendDirectEmail({ ...message, to: [message.to] })))(
          { from: 'kt@kevintriplett.com', to: lead.email, subject: 'Meet a greeter at Emergent Commons',
            text: 'Hello,\n\nThank you for asking to join Emergent Commons.\n\nChoose a time that suits you using this link:\nhttps://calendly.com/kevintriplett/emergent-commons-welcome\n\nBest regards,\nKevin Triplett' },
        );
        const updated = leads.markEmailSent(email);
        res.status(200).json(updated);
      } catch (error) {
        res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
      }
    });
  }

  // ---------------------------------------------------------------------------
  // WebSocket for live logs + abort signal
  // ---------------------------------------------------------------------------

  const server = http.createServer(app);
  const wss = new WebSocketServer({ server });

  wss.on('connection', (ws) => {
    clients.add(ws);
    ws.on('message', (data) => {
      try {
        const msg = JSON.parse(String(data)) as { type?: string };
        if (msg.type === 'abort') {
          const abort = scheduler.getCurrentAbort();
          if (abort) abort.aborted = true;
        }
      } catch {
        /* ignore malformed client messages */
      }
    });
    ws.on('close', () => {
      clients.delete(ws);
    });
  });

  return { server, scheduler };
}

export function createApp(deps: CreateAppDeps): http.Server {
  return createAppWithScheduler(deps).server;
}

const port = Number(process.env.PORT) || 3000;

const isMainModule =
  Boolean(process.argv[1]) && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;

if (isMainModule) {
  /**
   * Assemble the runtime dependency graph. SQLite + IMAP wiring is optional
   * and auto-disables unless every required env var is set, so a dev box
   * without IMAP creds just runs the manual-UI experience like before.
   *
   * Auth identity resolution:
   *   IMAP_USER (if set) -> the IMAP login identity
   *   else               -> MN_EMAIL (convenient default when the MN bot
   *                         account is itself the Gmail mailbox).
   * This split is important when `MN_EMAIL` is a forwarding alias
   * (e.g. host@company.org) that delivers to a different real mailbox
   * (e.g. ec-bot@gmail.com); IMAP requires auth against the MAILBOX
   * identity, not the alias.
   */
  const imapUser = process.env.IMAP_USER ?? process.env.MN_EMAIL ?? '';
  const agreementsEnabled =
    Boolean(imapUser) &&
    Boolean(process.env.IMAP_HOST) &&
    Boolean(process.env.IMAP_PASSWORD);

  let agreementsStore: AgreementsStore | undefined;
  /** Set immediately after createApp uses the closure shape; polls run only after assignment. */
  let imapPoller: ImapPoller | undefined;
  let reconcileCronTask: ReturnType<typeof cron.schedule> | undefined;
  let auditCronTask: ReturnType<typeof cron.schedule> | undefined;
  let leadsHarvestCronTask: ReturnType<typeof cron.schedule> | undefined;
  let leadsDeclineCronTask: ReturnType<typeof cron.schedule> | undefined;
  const leadsStore = openLeadsStore(process.env.EC_ADMIN_DB_PATH ?? path.join(process.cwd(), 'data', 'ec-admin.db'));

  const agreementsImapScratch: {
    lastPollCompletedAt: string | null;
    lastPollResult: PollResult | null;
  } = {
    lastPollCompletedAt: null,
    lastPollResult: null,
  };

  const imapPollIntervalMs =
    Number(process.env.IMAP_POLL_INTERVAL_MS) > 0
      ? Number(process.env.IMAP_POLL_INTERVAL_MS)
      : 5 * 60 * 1000;

  if (agreementsEnabled) {
    agreementsStore = openAgreementsStore({
      filePath: process.env.EC_ADMIN_DB_PATH ?? path.join(process.cwd(), 'data', 'ec-admin.db'),
      requiredAgreementCount: REQUIRED_AGREEMENT_COUNT,
    });
  }

  const { server, scheduler } = createAppWithScheduler({
    launchBrowser: defaultLaunchBrowser,
    removeSpaceMembers: defaultRemoveSpaceMembers,
    addSpaceMember: defaultAddSpaceMember,
    collectActiveMemberList: defaultCollectActiveMemberList,
    agreementsStore,
    leadsStore,
    sendLeadEmail: async (message) => sendDirectEmail({ ...message, to: [message.to] }),
    agreementsImapPollOnce:
      agreementsEnabled && agreementsStore
        ? async () => {
            if (!imapPoller) throw new Error('IMAP poller not initialized yet');
            const result = await imapPoller.pollOnce();
            agreementsImapScratch.lastPollCompletedAt = new Date().toISOString();
            agreementsImapScratch.lastPollResult = result;
            return result;
          }
        : undefined,
    agreementsImapSnapshot:
      agreementsEnabled && agreementsStore
        ? () => ({
            watcherEnabled: true,
            pollIntervalMs: imapPollIntervalMs,
            lastPollCompletedAt: agreementsImapScratch.lastPollCompletedAt,
            lastPollResult: agreementsImapScratch.lastPollResult,
          })
        : undefined,
  });

  if (agreementsEnabled && agreementsStore) {
    imapPoller = createImapPoller({
      store: agreementsStore,
      openConnection: () =>
        openImapConnection({
          host: process.env.IMAP_HOST as string,
          port: Number(process.env.IMAP_PORT) || 993,
          secure: (process.env.IMAP_SECURE ?? 'true') !== 'false',
          user: imapUser,
          pass: process.env.IMAP_PASSWORD as string,
          mailbox: process.env.IMAP_MAILBOX ?? 'INBOX',
        }),
      enqueueAddAllSpaces: ({ memberId, fullName }) => {
        const job = buildAddToAllSpacesJob(
          { addSpaceMember: defaultAddSpaceMember, store: agreementsStore },
          { fullMemberName: fullName, memberId, reason: '[auto]' },
        );
        void scheduler.enqueueBackground(job).catch((err) =>
          console.error(`[auto-add] ${fullName} (${memberId}) failed:`, err),
        );
      },
      log: (m) => console.log(`[imap] ${m}`),
    });

    const reconcileExpr = resolveReconcileCronExpr(process.env.RECONCILE_COMMONS_CRON);
    if (reconcileExpr !== null) {
      reconcileCronTask = safeCronSchedule('reconcile-commons', reconcileExpr, () => {
        enqueueCommonsMembershipRepairJobs(
          scheduler,
          { addSpaceMember: defaultAddSpaceMember },
          agreementsStore,
        );
      });
    }

    /* Stage 4e change-of-heart audit cron. Per Kevin's directive, this is
     * default-ON: an unset variable means "run at the default schedule"
     * and the only way to disable is an explicit opt-out value
     * (case-insensitive: 'off' | 'disabled' | 'false' | 'no' | '0').
     * Any other non-empty value is interpreted as a literal cron
     * expression. */
    const auditExpr = resolveAuditCronExpr(process.env.AGREEMENTS_AUDIT_CRON);
    if (auditExpr !== null) {
      auditCronTask = safeCronSchedule('change-of-heart-audit', auditExpr, () => {
        const job = buildChangeOfHeartAuditJob(agreementsStore);
        void scheduler.enqueueBackground(job).catch((err) => {
          console.error(`[audit] scheduled change-of-heart audit failed:`, err);
        });
      });
    }
  }

  const leadsHarvestExpr = resolveCronExpr(process.env.LEADS_HARVEST_CRON, '0 4 * * *');
  if (leadsHarvestExpr !== null) {
    leadsHarvestCronTask = safeCronSchedule('leads-harvest', leadsHarvestExpr, () => {
      void scheduler.enqueueBackground(buildHarvestLeadsJob(leadsStore, async (message) => sendDirectEmail({ ...message, to: GREETER_EMAILS }), true));
    });
  }
  const leadsDeclineExpr = resolveCronExpr(process.env.LEADS_DECLINE_CRON, '0 5 * * 0');
  if (leadsDeclineExpr !== null) {
    leadsDeclineCronTask = safeCronSchedule('leads-decline-stale', leadsDeclineExpr, () => {
      void scheduler.enqueueBackground(buildDeclineStaleLeadsJob(leadsStore, true));
    });
  }

  server.on('close', () => {
    imapPoller?.stop();
    reconcileCronTask?.stop();
    auditCronTask?.stop();
    leadsHarvestCronTask?.stop();
    leadsDeclineCronTask?.stop();
    leadsStore.close();
  });

  server.listen(port, () => {
    console.log(`MN Host Automator listening on http://localhost:${port}`);
    if (agreementsEnabled) {
      console.log(
        `Agreements watcher: IMAP poller started (user=${imapUser}, interval=${imapPollIntervalMs}ms)`,
      );
      imapPoller?.start(imapPollIntervalMs);
      if (reconcileCronTask && process.env.RECONCILE_COMMONS_CRON?.trim()) {
        console.log(`Reconciliation cron: ${process.env.RECONCILE_COMMONS_CRON!.trim()}`);
      } else {
        console.log('Reconciliation cron: disabled (RECONCILE_COMMONS_CRON=off)');
      }
      const auditExprActive = resolveAuditCronExpr(process.env.AGREEMENTS_AUDIT_CRON);
      if (auditCronTask && auditExprActive !== null) {
        console.log(`Change-of-heart audit cron: ${auditExprActive}`);
      } else {
        console.log('Change-of-heart audit cron: disabled (AGREEMENTS_AUDIT_CRON=off)');
      }
    } else {
      console.log(
        'Agreements watcher: disabled (set IMAP_USER or MN_EMAIL, plus IMAP_HOST + IMAP_PASSWORD, to enable)',
      );
    }
  });
}

/* `resolveAuditCronExpr` and its constants live near the top of the file so
 * they're initialized before `createAppWithScheduler` is invoked from the
 * entry-point block; see the comment above their declaration for the TDZ
 * rationale. */
