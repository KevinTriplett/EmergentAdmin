import type { Page } from 'puppeteer';
import type {
  RunLogEmailPayload,
  RunLogOutcome,
} from '../email.js';

/**
 * TaskScheduler is the single gatekeeper for any Puppeteer-backed work in
 * EmergentAdmin. It owns:
 *   - The exclusive browser lock (only one task runs at a time)
 *   - Browser launch/teardown
 *   - Log capture for the live WebSocket + end-of-run admin email
 *   - Abort signalling (the WebSocket can still flip the current task's flag)
 *
 * Two entry points, picked by the caller based on semantics:
 *
 *   runNow(job)          - intended for HTTP endpoints. Throws
 *                          TaskConflictError immediately if anything else
 *                          holds the lock. No queueing.
 *   enqueueBackground(job) - intended for internal triggers (IMAP poller,
 *                          cron). Queued FIFO; drains whenever the lock is
 *                          free. Never fights an HTTP click for the lock.
 *
 * This matches Stage 4a's decision: manual UI clicks see "409 - a task is
 * already running" if a background job is mid-flight, and retry themselves.
 */

export type BrowserHandle = {
  newPage: () => Promise<Page>;
  close: () => Promise<void>;
};

export type BrowserJobContext = {
  page: Page;
  log: (message: string) => void;
  abortSignal: { aborted: boolean };
  sleep: (ms: number) => Promise<void>;
};

export type SchedulerJob<T> = {
  name: string;
  headless: boolean;
  run: (ctx: BrowserJobContext) => Promise<T>;
  summarize: (result: T) => string;
};

export type SchedulerDeps = {
  launchBrowser: (headless: boolean) => Promise<BrowserHandle>;
  broadcast: (payload: object) => void;
  sendRunLogEmail: (payload: RunLogEmailPayload) => Promise<void>;
  sleep: (ms: number) => Promise<void>;
  userAgent: string;
  extraHttpHeaders?: Record<string, string>;
};

export type TaskScheduler = {
  runNow<T>(job: SchedulerJob<T>): Promise<T>;
  enqueueBackground<T>(job: SchedulerJob<T>): Promise<T>;
  isRunning(): boolean;
  getCurrentAbort(): { aborted: boolean } | null;
};

export class TaskConflictError extends Error {
  constructor() {
    super('A task is already running');
    this.name = 'TaskConflictError';
  }
}

export function createTaskScheduler(deps: SchedulerDeps): TaskScheduler {
  let running = false;
  let currentAbort: { aborted: boolean } | null = null;

  type QueuedJob<T> = {
    job: SchedulerJob<T>;
    resolve: (value: T) => void;
    reject: (err: unknown) => void;
  };
  const backgroundQueue: QueuedJob<unknown>[] = [];
  let draining = false;

  /**
   * Core execution path. Callers must have already checked `!running` and
   * set `running = true` before invoking - this function manages only the
   * browser lifecycle, log capture, email send, and abort plumbing.
   */
  async function executeLocked<T>(job: SchedulerJob<T>): Promise<T> {
    const abortSignal = { aborted: false };
    currentAbort = abortSignal;

    const logLines: string[] = [];
    const log = (message: string): void => {
      console.log(message);
      logLines.push(message);
      deps.broadcast({ type: 'log', message });
    };

    let browser: BrowserHandle | null = null;
    let outcome: RunLogOutcome = 'success';
    let summary = 'completed';
    let emailResult: unknown = null;
    let caught: unknown = null;
    let result: T | undefined;

    try {
      browser = await deps.launchBrowser(job.headless);
      const page = await browser.newPage();
      await page.setUserAgent(deps.userAgent);
      if (deps.extraHttpHeaders) {
        await page.setExtraHTTPHeaders(deps.extraHttpHeaders);
      }

      result = await job.run({ page, log, abortSignal, sleep: deps.sleep });
      summary = job.summarize(result);
      emailResult = result;
      deps.broadcast({ type: 'done', result });
    } catch (err) {
      caught = err;
      const message = err instanceof Error ? err.message : String(err);
      outcome = 'error';
      summary = `error: ${message}`;
      emailResult = { error: message };
      deps.broadcast({ type: 'error', message });
    } finally {
      if (browser) await browser.close().catch(() => undefined);
      currentAbort = null;
      abortSignal.aborted = false;

      /*
       * Fire-and-forget email - same semantics as the old
       * runExclusiveBrowserTask: never let a transport failure bubble up
       * into the caller or affect the job's return value.
       */
      void deps
        .sendRunLogEmail({
          taskName: job.name,
          outcome,
          summary,
          logLines: logLines.slice(),
          result: emailResult,
        })
        .catch((e) => {
          console.warn(`sendRunLogEmail failed for "${job.name}":`, e);
        });
    }

    if (caught !== null) throw caught;
    return result as T;
  }

  /**
   * Drain the background queue as long as jobs are pending AND nothing else
   * holds the lock. Only one drainer runs at a time (guarded by `draining`).
   */
  function startDraining(): void {
    if (draining) return;
    draining = true;
    void (async () => {
      try {
        while (backgroundQueue.length > 0) {
          // If an HTTP caller grabbed the lock between iterations, wait for
          // them by exiting the drain loop - startDraining will be called
          // again after they release.
          if (running) break;

          const next = backgroundQueue.shift();
          if (!next) break;
          running = true;
          try {
            const result = await executeLocked(next.job);
            next.resolve(result);
          } catch (err) {
            next.reject(err);
          } finally {
            running = false;
          }
        }
      } finally {
        draining = false;
      }

      // If more work arrived (or an HTTP caller released the lock while the
      // queue still has items) kick the drainer again.
      if (backgroundQueue.length > 0 && !running) startDraining();
    })();
  }

  return {
    async runNow<T>(job: SchedulerJob<T>): Promise<T> {
      if (running) throw new TaskConflictError();
      running = true;
      try {
        return await executeLocked(job);
      } finally {
        running = false;
        // Let any queued background jobs pick up the slack.
        if (backgroundQueue.length > 0) startDraining();
      }
    },

    enqueueBackground<T>(job: SchedulerJob<T>): Promise<T> {
      return new Promise<T>((resolve, reject) => {
        backgroundQueue.push({
          job: job as SchedulerJob<unknown>,
          resolve: resolve as (v: unknown) => void,
          reject,
        });
        startDraining();
      });
    },

    isRunning(): boolean {
      return running;
    },

    getCurrentAbort(): { aborted: boolean } | null {
      return currentAbort;
    },
  };
}
