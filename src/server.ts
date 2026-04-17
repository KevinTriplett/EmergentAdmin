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

const publicDir = path.join(process.cwd(), 'public');
const DEFAULT_USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36';
const ALREADY_A_MEMBER = 'Already a member';

export type BrowserHandle = {
  newPage: () => Promise<Page>;
  close: () => Promise<void>;
};

export type CreateAppDeps = {
  launchBrowser: (headless: boolean) => Promise<BrowserHandle>;
  removeSpaceMembers: typeof defaultRemoveSpaceMembers;
  addSpaceMember: typeof defaultAddSpaceMember;
};

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Read a required non-empty string field from the request body.
 * Returns the trimmed value on success, or an error message suitable for a 400 response.
 */
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

export function createApp(deps: CreateAppDeps): http.Server {
  const clients = new Set<WebSocket>();
  let taskRunning = false;
  let currentAbort: { aborted: boolean } | null = null;

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

  function makeLog() {
    return (message: string): void => {
      console.log(message);
      broadcast({ type: 'log', message });
    };
  }

  /**
   * Shared plumbing for every browser-backed task endpoint:
   *   - rejects when another task is already running
   *   - sets up an abort signal
   *   - launches a browser, prepares a page, and always tears the browser down
   *   - broadcasts completion/error over the websocket
   *
   * The caller-provided `run` callback receives a ready page + a broadcasting
   * log fn + abort signal and returns the JSON response body.
   */
  async function runExclusiveBrowserTask<T>(
    res: Response,
    headless: boolean,
    run: (ctx: {
      page: Page;
      log: (m: string) => void;
      abortSignal: { aborted: boolean };
      sleep: (ms: number) => Promise<void>;
    }) => Promise<T>,
  ): Promise<void> {
    if (taskRunning) {
      res.status(409).json({ error: 'A task is already running' });
      return;
    }

    const abortSignal = { aborted: false };
    currentAbort = abortSignal;
    taskRunning = true;
    const log = makeLog();
    let browser: BrowserHandle | null = null;

    try {
      browser = await deps.launchBrowser(headless);
      const page = await browser.newPage();
      await page.setUserAgent(DEFAULT_USER_AGENT);
      await page.setExtraHTTPHeaders({ 'Accept-Language': 'en-US,en;q=0.9' });

      const result = await run({ page, log, abortSignal, sleep: defaultSleep });
      broadcast({ type: 'done', result });
      res.status(200).json(result);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      broadcast({ type: 'error', message });
      res.status(500).json({ error: message });
    } finally {
      if (browser) await browser.close().catch(() => undefined);
      taskRunning = false;
      currentAbort = null;
      abortSignal.aborted = false;
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

    await runExclusiveBrowserTask(res, headless.value, async (ctx) =>
      deps.removeSpaceMembers({
        page: ctx.page,
        fullSpaceName: space.value,
        dryRun: dryRun.value,
        log: ctx.log,
        abortSignal: ctx.abortSignal,
        sleep: ctx.sleep,
      }),
    );
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

    await runExclusiveBrowserTask(res, headless.value, async (ctx) => {
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

    await runExclusiveBrowserTask(res, headless.value, async (ctx) =>
      deps.addSpaceMember({
        page: ctx.page,
        fullMemberName: fullMemberName.value,
        memberId: memberId.value,
        fullSpaceName: fullSpaceName.value,
        log: ctx.log,
        abortSignal: ctx.abortSignal,
        sleep: ctx.sleep,
      }),
    );
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

    await runExclusiveBrowserTask(res, headless.value, async (ctx) => {
      type SpaceResult = { space: string; success: boolean; error?: string };
      const spaceNames = Object.keys(SPACE_IDS);
      const results: SpaceResult[] = [];
      let addedCount = 0;
      let alreadyMemberCount = 0;
      let failureCount = 0;

      for (const spaceName of spaceNames) {
        if (ctx.abortSignal.aborted) {
          ctx.log('Abort requested — skipping remaining spaces.');
          break;
        }
        ctx.log(`\n═══ Adding to space: ${spaceName} ═══`);
        const result = await deps.addSpaceMember({
          page: ctx.page,
          fullMemberName: fullMemberName.value,
          memberId: memberId.value,
          fullSpaceName: spaceName,
          log: ctx.log,
          abortSignal: ctx.abortSignal,
          sleep: ctx.sleep,
        });
        results.push({ space: spaceName, ...result });

        if (result.success && result.error === ALREADY_A_MEMBER) {
          alreadyMemberCount += 1;
          ctx.log(`• ${spaceName}: already a member.`);
        } else if (result.success) {
          addedCount += 1;
          ctx.log(`✓ ${spaceName}: added.`);
        } else {
          failureCount += 1;
          ctx.log(`✗ ${spaceName}: ${result.error ?? 'unknown error'}`);
        }
      }

      return {
        fullMemberName: fullMemberName.value,
        memberId: memberId.value,
        addedCount,
        alreadyMemberCount,
        failureCount,
        spaces: results,
      };
    });
  });

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
        if (msg.type === 'abort' && currentAbort) {
          currentAbort.aborted = true;
        }
      } catch {
        /* ignore malformed client messages */
      }
    });
    ws.on('close', () => {
      clients.delete(ws);
    });
  });

  return server;
}

const port = Number(process.env.PORT) || 3000;

const isMainModule =
  Boolean(process.argv[1]) && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;

if (isMainModule) {
  const server = createApp({
    launchBrowser: defaultLaunchBrowser,
    removeSpaceMembers: defaultRemoveSpaceMembers,
    addSpaceMember: defaultAddSpaceMember,
  });
  server.listen(port, () => {
    console.log(`MN Host Automator listening on http://localhost:${port}`);
  });
}
