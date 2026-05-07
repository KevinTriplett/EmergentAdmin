import { describe, expect, it, vi } from 'vitest';
import type { Page } from 'puppeteer';
import { buildAddToAllSpacesJob, ALREADY_A_MEMBER } from '../src/tasks/addToAllSpacesJob.js';
import { SPACE_IDS } from '../src/tasks/removeSpaceMembers.js';
import type { AgreementsStore, MemberSpaceAttempt } from '../src/state/agreementsStore.js';
import type { BrowserJobContext } from '../src/scheduler/taskScheduler.js';

/**
 * Stage 4g wiring: the job consults the per-(member, space) attempt
 * ledger before each iteration and skips spaces with a verified
 * `'present'` row. Inside the loop:
 *
 *   - `success: true, error: ALREADY_A_MEMBER` (Phase-1-verified) writes
 *     a 'present' row.
 *   - `success: true` with no error (Phase-2 add-flow finished) writes
 *     NOTHING — verification waits for the next reconcile pass.
 *   - `success: false` writes a 'failed' row (and never overwrites a
 *     pre-existing 'present').
 *
 * `markCommonsAdded` fires only when every space in `SPACE_IDS` is
 * Phase-1-verified — either skipped at the top of an iteration or
 * `ALREADY_A_MEMBER` written this run. Phase-2 successes do not count.
 *
 * `force: true` bypasses the pre-loop skip so the operator can re-add
 * a member who explicitly asked to be put back.
 */

const NUM_SPACES = Object.keys(SPACE_IDS).length;
const SPACE_NAMES = Object.keys(SPACE_IDS);

function makeCtx(): BrowserJobContext {
  return {
    page: {} as unknown as Page,
    log: vi.fn(),
    abortSignal: { aborted: false },
    sleep: () => Promise.resolve(),
  };
}

type StoreSlice = Pick<
  AgreementsStore,
  'markCommonsAdded' | 'recordSpacePresent' | 'recordSpaceFailed' | 'listMemberSpaceAttempts'
>;

function makeStore(presentSpaces: string[] = []): StoreSlice & {
  presentCalls: Array<{ memberId: string; spaceName: string }>;
  failedCalls: Array<{ memberId: string; spaceName: string; error?: string }>;
} {
  const presentCalls: Array<{ memberId: string; spaceName: string }> = [];
  const failedCalls: Array<{ memberId: string; spaceName: string; error?: string }> = [];
  const initial: MemberSpaceAttempt[] = presentSpaces.map((spaceName) => ({
    spaceName,
    outcome: 'present',
    attemptedAt: 1,
    lastError: null,
  }));
  return {
    markCommonsAdded: vi.fn(),
    listMemberSpaceAttempts: vi.fn().mockReturnValue(initial),
    recordSpacePresent: vi.fn((memberId: string, spaceName: string) => {
      presentCalls.push({ memberId, spaceName });
    }),
    recordSpaceFailed: vi.fn((memberId: string, spaceName: string, error?: string) => {
      failedCalls.push({ memberId, spaceName, error });
    }),
    presentCalls,
    failedCalls,
  };
}

describe('buildAddToAllSpacesJob — Stage 4g attempt ledger', () => {
  it('calls markCommonsAdded when every space returns ALREADY_A_MEMBER (all Phase-1-verified this run)', async () => {
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
    expect(store.markCommonsAdded).toHaveBeenCalledTimes(1);
    expect(store.markCommonsAdded).toHaveBeenCalledWith('m-bob');
    /* Every Phase-1 hit writes a present row. */
    expect(store.presentCalls.length).toBe(NUM_SPACES);
  });

  it('does NOT mark when every space returns Phase-2 success (added but not yet verified)', async () => {
    const addSpaceMember = vi.fn().mockResolvedValue({ success: true });
    const store = makeStore();

    const job = buildAddToAllSpacesJob(
      { addSpaceMember: addSpaceMember as never, store: store as AgreementsStore },
      { fullMemberName: 'Alice', memberId: 'm-alice' },
    );
    const result = await job.run(makeCtx());

    expect(result.failureCount).toBe(0);
    expect(result.addedCount).toBe(NUM_SPACES);
    /* Phase-2 success is NOT trusted by Stage 4g — verification waits
     * for the next reconcile pass. */
    expect(store.markCommonsAdded).not.toHaveBeenCalled();
    expect(store.presentCalls).toEqual([]);
    expect(store.failedCalls).toEqual([]);
  });

  it('does NOT mark when result is mixed Phase-2 + Phase-1 (some not yet verified)', async () => {
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
    /* Even one Phase-2-only space leaves the member unverified for
     * the run; the next pass will Phase-1-confirm. */
    expect(store.markCommonsAdded).not.toHaveBeenCalled();
    /* Half of the calls were Phase-1 hits → present rows written for those. */
    expect(store.presentCalls.length).toBe(result.alreadyMemberCount);
  });

  it('marks when pre-existing present rows + this-run Phase-1 hits cover every space', async () => {
    /* Seed N-1 present rows; the loop visits the last space and
     * gets ALREADY_A_MEMBER, completing Phase-1 verification. */
    const seeded = SPACE_NAMES.slice(0, NUM_SPACES - 1);
    const lastSpace = SPACE_NAMES[NUM_SPACES - 1];
    const addSpaceMember = vi
      .fn()
      .mockResolvedValue({ success: true, error: ALREADY_A_MEMBER });
    const store = makeStore(seeded);

    const job = buildAddToAllSpacesJob(
      { addSpaceMember: addSpaceMember as never, store: store as AgreementsStore },
      { fullMemberName: 'Dave', memberId: 'm-dave' },
    );
    const result = await job.run(makeCtx());

    /* Skipped count includes pre-existing present rows. */
    expect(result.skippedCount).toBe(NUM_SPACES - 1);
    /* The one space we did visit returned ALREADY_A_MEMBER. */
    expect(result.alreadyMemberCount).toBe(1);
    expect(result.failureCount).toBe(0);
    expect(addSpaceMember).toHaveBeenCalledTimes(1);
    expect(store.presentCalls).toEqual([{ memberId: 'm-dave', spaceName: lastSpace }]);
    expect(store.markCommonsAdded).toHaveBeenCalledWith('m-dave');
  });

  it('does NOT mark when ANY space fails (failureCount > 0); writes a failed row', async () => {
    let call = 0;
    const addSpaceMember = vi.fn().mockImplementation(async () => {
      call += 1;
      return call === 1 ? { success: false, error: 'transient MN error' } : { success: true, error: ALREADY_A_MEMBER };
    });
    const store = makeStore();

    const job = buildAddToAllSpacesJob(
      { addSpaceMember: addSpaceMember as never, store: store as AgreementsStore },
      { fullMemberName: 'Errol', memberId: 'm-errol' },
    );
    const result = await job.run(makeCtx());

    expect(result.failureCount).toBe(1);
    expect(store.markCommonsAdded).not.toHaveBeenCalled();
    expect(store.failedCalls).toEqual([
      { memberId: 'm-errol', spaceName: SPACE_NAMES[0], error: 'transient MN error' },
    ]);
  });

  it('does NOT mark when the run is aborted partway through', async () => {
    let call = 0;
    const ctx = makeCtx();
    const addSpaceMember = vi.fn().mockImplementation(async () => {
      call += 1;
      if (call === 2) ctx.abortSignal.aborted = true;
      return { success: true, error: ALREADY_A_MEMBER };
    });
    const store = makeStore();

    const job = buildAddToAllSpacesJob(
      { addSpaceMember: addSpaceMember as never, store: store as AgreementsStore },
      { fullMemberName: 'Eve', memberId: 'm-eve' },
    );
    const result = await job.run(ctx);

    /* Spaces actually attempted < NUM_SPACES → can't be fully verified. */
    expect(result.spaces.length).toBeLessThan(NUM_SPACES);
    expect(store.markCommonsAdded).not.toHaveBeenCalled();
  });

  it('skips spaces with pre-existing present rows (consent gate: never re-add)', async () => {
    const seeded = [SPACE_NAMES[0], SPACE_NAMES[1]];
    const addSpaceMember = vi.fn().mockResolvedValue({ success: true });
    const store = makeStore(seeded);

    const job = buildAddToAllSpacesJob(
      { addSpaceMember: addSpaceMember as never, store: store as AgreementsStore },
      { fullMemberName: 'Sam', memberId: 'm-sam' },
    );
    const result = await job.run(makeCtx());

    /* Two spaces were skipped pre-loop; the rest were attempted. */
    expect(result.skippedCount).toBe(2);
    expect(addSpaceMember).toHaveBeenCalledTimes(NUM_SPACES - 2);
    /* The pre-loop skip must not invoke addSpaceMember for those spaces. */
    const calledSpaces = addSpaceMember.mock.calls.map((c) => c[0].fullSpaceName);
    expect(calledSpaces).not.toContain(SPACE_NAMES[0]);
    expect(calledSpaces).not.toContain(SPACE_NAMES[1]);
    /* Skipped spaces appear in result.spaces with skipped:true. */
    const skippedResults = result.spaces.filter((s) => s.skipped === true);
    expect(skippedResults.map((s) => s.space).sort()).toEqual([...seeded].sort());
  });

  it('force=true bypasses the pre-loop skip (operator override for "re-add me")', async () => {
    const seeded = SPACE_NAMES.slice(); // every space is "present"
    const addSpaceMember = vi.fn().mockResolvedValue({ success: true, error: ALREADY_A_MEMBER });
    const store = makeStore(seeded);

    const job = buildAddToAllSpacesJob(
      { addSpaceMember: addSpaceMember as never, store: store as AgreementsStore },
      { fullMemberName: 'Manual', memberId: 'm-manual', force: true },
    );
    const result = await job.run(makeCtx());

    /* Force ignored the present rows and visited every space. */
    expect(addSpaceMember).toHaveBeenCalledTimes(NUM_SPACES);
    expect(result.skippedCount).toBe(0);
    expect(result.alreadyMemberCount).toBe(NUM_SPACES);
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
