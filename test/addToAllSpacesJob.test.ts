import { describe, expect, it, vi } from 'vitest';
import type { Page } from 'puppeteer';
import { buildAddToAllSpacesJob, ALREADY_A_MEMBER } from '../src/tasks/addToAllSpacesJob.js';
import { SPACE_IDS } from '../src/tasks/removeSpaceMembers.js';
import type { AgreementsStore } from '../src/state/agreementsStore.js';
import type { BrowserJobContext } from '../src/scheduler/taskScheduler.js';

/**
 * Stage 4f wiring: the job accepts an optional `store` dep and, on a
 * fully-clean run (failureCount === 0 — every space either added or was
 * already-member), calls `store.markCommonsAdded(memberId)`. Anything
 * less than fully-clean leaves the flag untouched so the next reconcile
 * pass picks the member up again.
 *
 * The job is otherwise unchanged: no store call on failures, no store
 * call when `store` isn't provided (manual endpoint without an
 * agreements DB stays usable).
 */

const NUM_SPACES = Object.keys(SPACE_IDS).length;

function makeCtx(): BrowserJobContext {
  return {
    page: {} as unknown as Page,
    log: vi.fn(),
    abortSignal: { aborted: false },
    sleep: () => Promise.resolve(),
  };
}

function makeStore(): Pick<AgreementsStore, 'markCommonsAdded'> {
  return { markCommonsAdded: vi.fn() };
}

describe('buildAddToAllSpacesJob — Stage 4f markCommonsAdded wiring', () => {
  it('calls store.markCommonsAdded(memberId) when every space succeeds (failureCount===0, addedCount only)', async () => {
    const addSpaceMember = vi.fn().mockResolvedValue({ success: true });
    const store = makeStore();

    const job = buildAddToAllSpacesJob(
      { addSpaceMember: addSpaceMember as never, store: store as AgreementsStore },
      { fullMemberName: 'Alice', memberId: 'm-alice' },
    );
    const result = await job.run(makeCtx());

    expect(result.failureCount).toBe(0);
    expect(result.addedCount).toBe(NUM_SPACES);
    expect(store.markCommonsAdded).toHaveBeenCalledTimes(1);
    expect(store.markCommonsAdded).toHaveBeenCalledWith('m-alice');
  });

  it('also marks when every space returns ALREADY_A_MEMBER (failureCount===0, all already-member)', async () => {
    const addSpaceMember = vi
      .fn()
      .mockResolvedValue({ success: true, error: ALREADY_A_MEMBER });
    const store = makeStore();

    const job = buildAddToAllSpacesJob(
      { addSpaceMember: addSpaceMember as never, store: store as AgreementsStore },
      { fullMemberName: 'Bob', memberId: 'm-bob' },
    );
    const result = await job.run(makeCtx());

    expect(result.failureCount).toBe(0);
    expect(result.alreadyMemberCount).toBe(NUM_SPACES);
    /* "Already a member of every space" still counts as 'verified
     * present in commons' — that's the whole point of the flag. */
    expect(store.markCommonsAdded).toHaveBeenCalledTimes(1);
    expect(store.markCommonsAdded).toHaveBeenCalledWith('m-bob');
  });

  it('marks when result is mixed added + already-member but ZERO failures', async () => {
    let call = 0;
    const addSpaceMember = vi.fn().mockImplementation(async () => {
      call += 1;
      return call % 2 === 0
        ? { success: true, error: ALREADY_A_MEMBER }
        : { success: true };
    });
    const store = makeStore();

    const job = buildAddToAllSpacesJob(
      { addSpaceMember: addSpaceMember as never, store: store as AgreementsStore },
      { fullMemberName: 'Carol', memberId: 'm-carol' },
    );
    const result = await job.run(makeCtx());

    expect(result.failureCount).toBe(0);
    expect(result.addedCount + result.alreadyMemberCount).toBe(NUM_SPACES);
    expect(store.markCommonsAdded).toHaveBeenCalledTimes(1);
    expect(store.markCommonsAdded).toHaveBeenCalledWith('m-carol');
  });

  it('does NOT mark when ANY space fails (failureCount > 0)', async () => {
    let call = 0;
    const addSpaceMember = vi.fn().mockImplementation(async () => {
      call += 1;
      /* First call fails. Subsequent calls succeed. Even one failure
       * should keep the member off the verified list — reconcile will
       * retry next run. */
      return call === 1 ? { success: false, error: 'transient MN error' } : { success: true };
    });
    const store = makeStore();

    const job = buildAddToAllSpacesJob(
      { addSpaceMember: addSpaceMember as never, store: store as AgreementsStore },
      { fullMemberName: 'Dave', memberId: 'm-dave' },
    );
    const result = await job.run(makeCtx());

    expect(result.failureCount).toBe(1);
    expect(store.markCommonsAdded).not.toHaveBeenCalled();
  });

  it('does NOT mark when the run is aborted partway through (abortSignal.aborted=true mid-loop)', async () => {
    let call = 0;
    const ctx = makeCtx();
    const addSpaceMember = vi.fn().mockImplementation(async () => {
      call += 1;
      if (call === 2) {
        /* Flip abort after the second space; the job should bail
         * before touching the rest. failureCount stays 0 in this
         * case, but we still don't want to mark — the member isn't
         * actually in every space. */
        ctx.abortSignal.aborted = true;
      }
      return { success: true };
    });
    const store = makeStore();

    const job = buildAddToAllSpacesJob(
      { addSpaceMember: addSpaceMember as never, store: store as AgreementsStore },
      { fullMemberName: 'Eve', memberId: 'm-eve' },
    );
    const result = await job.run(ctx);

    /* spaces.length must be < NUM_SPACES for this test to be meaningful. */
    expect(result.spaces.length).toBeLessThan(NUM_SPACES);
    expect(result.failureCount).toBe(0);
    expect(store.markCommonsAdded).not.toHaveBeenCalled();
  });

  it('runs to completion without any error when no store is provided (manual-without-DB path)', async () => {
    const addSpaceMember = vi.fn().mockResolvedValue({ success: true });

    const job = buildAddToAllSpacesJob(
      { addSpaceMember: addSpaceMember as never },
      { fullMemberName: 'Frank', memberId: 'm-frank' },
    );
    /* The point of this test: not throwing when store is undefined. */
    await expect(job.run(makeCtx())).resolves.toBeDefined();
  });
});
