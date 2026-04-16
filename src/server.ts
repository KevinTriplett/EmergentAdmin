import 'dotenv/config';
import express from 'express';
import http from 'node:http';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { WebSocketServer, WebSocket } from 'ws';
import type { Page } from 'puppeteer';
import { launchBrowser as defaultLaunchBrowser } from './utils/browser.js';
import { removeSpaceMembers as defaultRemoveSpaceMembers, SPACE_IDS } from './tasks/removeSpaceMembers.js';

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
};

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function createApp(deps: CreateAppDeps): http.Server {
  const clients = new Set<WebSocket>();
  let taskRunning = false;
  let currentAbort: { aborted: boolean } | null = null;

  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '32kb' }));
  app.use(express.static(publicDir));

  app.post('/run/remove-space-members', async (req, res) => {
    const body = req.body as Record<string, unknown>;
    const fullSpaceName = body.fullSpaceName;

    if (typeof fullSpaceName !== 'string' || !fullSpaceName.trim()) {
      res.status(400).json({ error: 'fullSpaceName is required' });
      return;
    }

    if (typeof body.headless !== 'undefined' && typeof body.headless !== 'boolean') {
      res.status(400).json({ error: 'headless must be a boolean' });
      return;
    }
    if (typeof body.dryRun !== 'undefined' && typeof body.dryRun !== 'boolean') {
      res.status(400).json({ error: 'dryRun must be a boolean' });
      return;
    }

    const headless = typeof body.headless === 'boolean' ? body.headless : true;
    const dryRun = typeof body.dryRun === 'boolean' ? body.dryRun : true;

    if (taskRunning) {
      res.status(409).json({ error: 'A task is already running' });
      return;
    }

    const abortSignal = { aborted: false };
    currentAbort = abortSignal;
    taskRunning = true;

    const broadcast = (payload: object) => {
      const raw = JSON.stringify(payload);
      for (const ws of clients) {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(raw);
        }
      }
    };

    const log = (message: string) => {
      console.log(message);
      broadcast({ type: 'log', message });
    };

    let browser: BrowserHandle | null = null;

    try {
      browser = await deps.launchBrowser(headless);
      const page = await browser.newPage();
      await page.setUserAgent(DEFAULT_USER_AGENT);
      await page.setExtraHTTPHeaders({ 'Accept-Language': 'en-US,en;q=0.9' });
      const runtimeInfo = await page.evaluate(() => ({
        userAgent: navigator.userAgent,
        platform: navigator.platform,
        language: navigator.language,
      }));
      // log(
      //   `Puppeteer runtime: userAgent="${runtimeInfo.userAgent}" platform="${runtimeInfo.platform}" language="${runtimeInfo.language}" url="${page.url()}"`,
      // );
      const result = await deps.removeSpaceMembers({
        page,
        fullSpaceName: fullSpaceName.trim(),
        dryRun,
        log,
        abortSignal,
        sleep: defaultSleep,
      });
      broadcast({ type: 'done', result });
      res.status(200).json(result);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      broadcast({ type: 'error', message });
      res.status(500).json({ error: message });
    } finally {
      if (browser) {
        await browser.close().catch(() => undefined);
      }
      taskRunning = false;
      currentAbort = null;
      abortSignal.aborted = false;
    }
  });

  app.post('/run/remove-all-space-members', async (req, res) => {
    const body = req.body as Record<string, unknown>;

    if (typeof body.headless !== 'undefined' && typeof body.headless !== 'boolean') {
      res.status(400).json({ error: 'headless must be a boolean' });
      return;
    }
    if (typeof body.dryRun !== 'undefined' && typeof body.dryRun !== 'boolean') {
      res.status(400).json({ error: 'dryRun must be a boolean' });
      return;
    }

    const headless = typeof body.headless === 'boolean' ? body.headless : true;
    const dryRun = typeof body.dryRun === 'boolean' ? body.dryRun : true;

    if (taskRunning) {
      res.status(409).json({ error: 'A task is already running' });
      return;
    }

    const abortSignal = { aborted: false };
    currentAbort = abortSignal;
    taskRunning = true;

    const broadcast = (payload: object) => {
      const raw = JSON.stringify(payload);
      for (const ws of clients) {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(raw);
        }
      }
    };

    const log = (message: string) => {
      console.log(message);
      broadcast({ type: 'log', message });
    };

    let browser: BrowserHandle | null = null;
    const spaceNames = Object.keys(SPACE_IDS);
    const results: Array<{ space: string; success: boolean; removed: number; error?: string }> = [];

    try {
      browser = await deps.launchBrowser(headless);
      const page = await browser.newPage();
      await page.setUserAgent(DEFAULT_USER_AGENT);
      await page.setExtraHTTPHeaders({ 'Accept-Language': 'en-US,en;q=0.9' });

      for (const spaceName of spaceNames) {
        if (abortSignal.aborted) {
          log(`Abort requested — skipping remaining spaces.`);
          break;
        }

        log(`\n═══ Processing space: ${spaceName} ═══`);

        const result = await deps.removeSpaceMembers({
          page,
          fullSpaceName: spaceName,
          dryRun,
          log,
          abortSignal,
          sleep: defaultSleep,
        });

        results.push({ space: spaceName, ...result });

        if (result.success) {
          log(`✓ ${spaceName}: ${result.removed} removed.`);
        } else {
          log(`✗ ${spaceName}: ${result.error ?? 'unknown error'}`);
        }
      }

      const totalRemoved = results.reduce((sum, r) => sum + r.removed, 0);
      const summary = { totalRemoved, spaces: results };
      broadcast({ type: 'done', result: summary });
      res.status(200).json(summary);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      broadcast({ type: 'error', message });
      res.status(500).json({ error: message });
    } finally {
      if (browser) {
        await browser.close().catch(() => undefined);
      }
      taskRunning = false;
      currentAbort = null;
      abortSignal.aborted = false;
    }
  });

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
  });
  server.listen(port, () => {
    console.log(`MN Host Automator listening on http://localhost:${port}`);
  });
}
