import 'dotenv/config';
import express from 'express';
import type { Request, Response } from 'express';
import http from 'node:http';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { WebSocketServer, WebSocket } from 'ws';
import type { Page } from 'puppeteer';
import { launchBrowser as defaultLaunchBrowser } from './utils/browser.js';
import {
  removeSpaceMembers as defaultRemoveSpaceMembers,
  SPACE_IDS,
} from './tasks/removeSpaceMembers.js';
import { addSpaceMember as defaultAddSpaceMember } from './tasks/addSpaceMember.js';
import { sendRunLogEmail as defaultSendRunLogEmail } from './email.js';
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
import { AGREEMENT_ARTICLES, REQUIRED_AGREEMENT_COUNT } from './config/agreements.js';
import { buildAddToAllSpacesJob, ALREADY_A_MEMBER } from './tasks/addToAllSpacesJob.js';
import { enqueueCommonsMembershipRepairJobs } from './tasks/membershipReconcile.js';
import cron from 'node-cron';

const publicDir = path.join(process.cwd(), 'public');
const DEFAULT_USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36';

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
   * `sendRunLogEmail` is used by default; it no-ops outside of production.
   */
  sendRunLogEmail?: typeof defaultSendRunLogEmail;
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

    const job = buildAddToAllSpacesJob(
      { addSpaceMember: deps.addSpaceMember },
      { fullMemberName: fullMemberName.value, memberId: memberId.value },
    );
    // The manual endpoint always runs at its requested headless-ness.
    job.headless = headless.value;
    await runExclusiveBrowserTask(res, job);
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

    app.post('/run/reconcile-commons-membership', async (_req: Request, res: Response) => {
      const store = deps.agreementsStore!;
      const members = enqueueCommonsMembershipRepairJobs(
        scheduler,
        { addSpaceMember: deps.addSpaceMember },
        store,
        (msg) => console.log(msg),
      );
      res.status(200).json({
        enqueued: members.length,
        members: members.map((m) => ({
          memberId: m.memberId,
          fullName: m.fullName,
          agreementCount: m.agreementCount,
        })),
      });
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
    agreementsStore,
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
          { addSpaceMember: defaultAddSpaceMember },
          { fullMemberName: fullName, memberId, reason: '[auto]' },
        );
        void scheduler.enqueueBackground(job).catch((err) =>
          console.error(`[auto-add] ${fullName} (${memberId}) failed:`, err),
        );
      },
      log: (m) => console.log(`[imap] ${m}`),
    });

    const reconcileExpr = process.env.RECONCILE_COMMONS_CRON?.trim();
    if (reconcileExpr) {
      reconcileCronTask = cron.schedule(reconcileExpr, () => {
        enqueueCommonsMembershipRepairJobs(
          scheduler,
          { addSpaceMember: defaultAddSpaceMember },
          agreementsStore,
        );
      });
    }
  }

  server.on('close', () => {
    imapPoller?.stop();
    reconcileCronTask?.stop();
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
      }
    } else {
      console.log(
        'Agreements watcher: disabled (set IMAP_USER or MN_EMAIL, plus IMAP_HOST + IMAP_PASSWORD, to enable)',
      );
    }
  });
}
