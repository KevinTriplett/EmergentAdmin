import { describe, expect, it, vi } from 'vitest';
import {
  createTaskScheduler,
  TaskConflictError,
  type BrowserHandle,
  type SchedulerJob,
} from '../src/scheduler/taskScheduler.js';

/**
 * Behavioral pins for the scheduler. The critical invariants:
 *   1. `runNow` is strictly non-queueing - the second concurrent caller
 *      gets TaskConflictError.
 *   2. `enqueueBackground` is strictly FIFO and never races `runNow` for
 *      the lock - HTTP clicks always win if both arrive simultaneously.
 *   3. Background jobs that were queued while `runNow` held the lock drain
 *      automatically once the lock releases.
 *   4. The fire-and-forget `sendRunLogEmail` dep is always invoked with the
 *      captured log lines (success OR error).
 */

type MockPage = { setUserAgent: ReturnType<typeof vi.fn>; setExtraHTTPHeaders: ReturnType<typeof vi.fn> };

function buildMockPage(): MockPage {
  return {
    setUserAgent: vi.fn().mockResolvedValue(undefined),
    setExtraHTTPHeaders: vi.fn().mockResolvedValue(undefined),
  };
}

function buildBrowser(): BrowserHandle {
  const page = buildMockPage();
  return {
    newPage: vi.fn().mockResolvedValue(page),
    close: vi.fn().mockResolvedValue(undefined),
  } as unknown as BrowserHandle;
}

function buildJob<T>(
  name: string,
  run: SchedulerJob<T>['run'],
  summarize: SchedulerJob<T>['summarize'] = () => 'ok',
): SchedulerJob<T> {
  return { name, headless: true, run, summarize };
}

describe('taskScheduler', () => {
  function newScheduler() {
    const launchBrowser = vi.fn().mockImplementation(async () => buildBrowser());
    const broadcast = vi.fn();
    const sendRunLogEmail = vi.fn().mockResolvedValue(undefined);
    const scheduler = createTaskScheduler({
      launchBrowser,
      broadcast,
      sendRunLogEmail,
      sleep: () => Promise.resolve(),
      userAgent: 'test-UA',
    });
    return { scheduler, launchBrowser, broadcast, sendRunLogEmail };
  }

  it('runNow returns the job result', async () => {
    const { scheduler } = newScheduler();
    const result = await scheduler.runNow(buildJob('t', async () => 42, () => '42'));
    expect(result).toBe(42);
  });

  it('runNow throws TaskConflictError when invoked concurrently', async () => {
    const { scheduler } = newScheduler();
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => (release = r));

    const first = scheduler.runNow(
      buildJob('t1', async () => {
        await gate;
        return 1;
      }),
    );

    await expect(scheduler.runNow(buildJob('t2', async () => 2))).rejects.toBeInstanceOf(
      TaskConflictError,
    );

    release();
    await expect(first).resolves.toBe(1);
  });

  it('calls sendRunLogEmail with success outcome + captured log lines', async () => {
    const { scheduler, sendRunLogEmail } = newScheduler();
    await scheduler.runNow(
      buildJob(
        'logging-task',
        async ({ log }) => {
          log('line A');
          log('line B');
          return { ok: true };
        },
        () => 'fine',
      ),
    );
    await expect.poll(() => sendRunLogEmail.mock.calls.length).toBeGreaterThan(0);
    const payload = sendRunLogEmail.mock.calls[0][0];
    expect(payload.outcome).toBe('success');
    expect(payload.taskName).toBe('logging-task');
    expect(payload.summary).toBe('fine');
    expect(payload.logLines).toEqual(['line A', 'line B']);
  });

  it('calls sendRunLogEmail with error outcome when the job throws', async () => {
    const { scheduler, sendRunLogEmail } = newScheduler();
    await expect(
      scheduler.runNow(
        buildJob('boom-task', async () => {
          throw new Error('boom');
        }),
      ),
    ).rejects.toThrow('boom');
    await expect.poll(() => sendRunLogEmail.mock.calls.length).toBeGreaterThan(0);
    const payload = sendRunLogEmail.mock.calls[0][0];
    expect(payload.outcome).toBe('error');
    expect(payload.summary).toContain('boom');
  });

  it('enqueueBackground queues jobs FIFO and drains them sequentially', async () => {
    const { scheduler, launchBrowser } = newScheduler();
    const order: string[] = [];

    const p1 = scheduler.enqueueBackground(
      buildJob('bg-1', async () => {
        order.push('start-1');
        await Promise.resolve();
        order.push('end-1');
        return 1;
      }),
    );
    const p2 = scheduler.enqueueBackground(
      buildJob('bg-2', async () => {
        order.push('start-2');
        return 2;
      }),
    );

    await expect(p1).resolves.toBe(1);
    await expect(p2).resolves.toBe(2);

    expect(order).toEqual(['start-1', 'end-1', 'start-2']);
    expect(launchBrowser).toHaveBeenCalledTimes(2);
  });

  it('runNow wins the lock over a simultaneously-queued background job', async () => {
    const { scheduler } = newScheduler();
    const events: string[] = [];

    let releaseNow: () => void = () => {};
    const nowGate = new Promise<void>((r) => (releaseNow = r));

    const now = scheduler.runNow(
      buildJob('now', async () => {
        events.push('now-start');
        await nowGate;
        events.push('now-end');
        return 'NOW';
      }),
    );

    // Queued while runNow holds the lock. Must wait.
    const bg = scheduler.enqueueBackground(
      buildJob('bg', async () => {
        events.push('bg-start');
        return 'BG';
      }),
    );

    await expect.poll(() => events).toEqual(['now-start']);

    releaseNow();
    await expect(now).resolves.toBe('NOW');
    await expect(bg).resolves.toBe('BG');
    expect(events).toEqual(['now-start', 'now-end', 'bg-start']);
  });

  it('propagates job errors out of enqueueBackground', async () => {
    const { scheduler } = newScheduler();
    await expect(
      scheduler.enqueueBackground(
        buildJob('bad-bg', async () => {
          throw new Error('nope');
        }),
      ),
    ).rejects.toThrow('nope');
  });

  it('isRunning reflects active execution', async () => {
    const { scheduler } = newScheduler();
    expect(scheduler.isRunning()).toBe(false);

    let release: () => void = () => {};
    const gate = new Promise<void>((r) => (release = r));

    const p = scheduler.runNow(
      buildJob('probe', async () => {
        await gate;
        return 0;
      }),
    );

    await expect.poll(() => scheduler.isRunning()).toBe(true);
    release();
    await p;
    expect(scheduler.isRunning()).toBe(false);
  });
});
