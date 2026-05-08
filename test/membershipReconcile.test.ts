import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  enqueueCommonsMembershipRepairJobs,
  FAILED_ATTEMPT_TTL_MS,
} from '../src/tasks/membershipReconcile.js';
import { openAgreementsStore, type AgreementsStore } from '../src/state/agreementsStore.js';
import type { TaskScheduler } from '../src/scheduler/taskScheduler.js';

/**
 * Stage 4g reconcile: scope is fixed to "eligible AND
 * commons_added_at IS NULL". The pre-Stage-4g all-eligible scope and
 * its `RECONCILE_COMMONS_SCOPE` env var have been removed; the per-
 * (member, space) attempt ledger inside the job handles consent and
 * partial-completion cases that the all-eligible sweep used to cover.
 *
 * Reconcile also prunes failed attempt rows older than 30 days at the
 * start of every pass.
 */

const REQUIRED = 2;

function agreement(memberId: string, articleId: string, fullName: string) {
  return {
    memberId,
    fullName,
    articleId,
    commentId: `c-${memberId}-${articleId}`,
    commentedAt: 1,
    source: 'email' as const,
  };
}

function makeFakeScheduler(): { scheduler: TaskScheduler; enqueued: Array<{ name: string }> } {
  const enqueued: Array<{ name: string }> = [];
  const scheduler = {
    enqueueBackground: vi.fn(async (job: { name: string }) => {
      enqueued.push({ name: job.name });
      return undefined as unknown as void;
    }),
  } as unknown as TaskScheduler;
  return { scheduler, enqueued };
}

describe('enqueueCommonsMembershipRepairJobs — Stage 4g', () => {
  let store: AgreementsStore;

  beforeEach(() => {
    store = openAgreementsStore({ filePath: ':memory:', requiredAgreementCount: REQUIRED });
    /* Two members, both at threshold. */
    store.recordAgreement(agreement('m1', 'a1', 'Alice'));
    store.recordAgreement(agreement('m1', 'a2', 'Alice'));
    store.recordAgreement(agreement('m2', 'a1', 'Bob'));
    store.recordAgreement(agreement('m2', 'a2', 'Bob'));
  });

  afterEach(() => {
    store.close();
  });

  it('enqueues only members whose commons_added_at is NULL (consent gate)', () => {
    /* m1 already verified-added; reconcile must skip them. m2 still
     * pending, so they get one job. */
    store.markCommonsAdded('m1');
    const { scheduler } = makeFakeScheduler();
    const addSpaceMember = vi.fn();

    const out = enqueueCommonsMembershipRepairJobs(
      scheduler,
      { addSpaceMember: addSpaceMember as never },
      store,
    );

    expect(out.map((r) => r.memberId)).toEqual(['m2']);
    expect((scheduler.enqueueBackground as ReturnType<typeof vi.fn>)).toHaveBeenCalledTimes(1);
  });

  it('enqueues every eligible member when no one is verified-added yet', () => {
    const { scheduler } = makeFakeScheduler();
    const addSpaceMember = vi.fn();

    const out = enqueueCommonsMembershipRepairJobs(
      scheduler,
      { addSpaceMember: addSpaceMember as never },
      store,
    );

    expect(out.map((r) => r.memberId).sort()).toEqual(['m1', 'm2']);
    expect((scheduler.enqueueBackground as ReturnType<typeof vi.fn>)).toHaveBeenCalledTimes(2);
  });

  it('prunes failed attempt rows older than 30 days at the start of the pass', () => {
    /* Seed a stale failed row (older than the TTL) and a fresh one
     * (within the TTL). Reconcile should only delete the stale one. */
    const now = Date.now();
    const stale = now - FAILED_ATTEMPT_TTL_MS - 60_000;
    const fresh = now - 60_000;
    store.recordSpaceFailed('m1', 'old-failed', 'stale', stale);
    store.recordSpaceFailed('m1', 'recent-failed', 'fresh', fresh);

    const messages: string[] = [];
    const { scheduler } = makeFakeScheduler();

    enqueueCommonsMembershipRepairJobs(
      scheduler,
      { addSpaceMember: vi.fn() as never },
      store,
      (m) => messages.push(m),
    );

    const remaining = store.listMemberSpaceAttempts('m1').map((r) => r.spaceName).sort();
    expect(remaining).toEqual(['recent-failed']);
    expect(messages.some((m) => /pruned 1 failed attempt row/.test(m))).toBe(true);
  });

  it('does not log a prune line when nothing was pruned', () => {
    const messages: string[] = [];
    const { scheduler } = makeFakeScheduler();

    enqueueCommonsMembershipRepairJobs(
      scheduler,
      { addSpaceMember: vi.fn() as never },
      store,
      (m) => messages.push(m),
    );

    expect(messages.some((m) => /pruned/.test(m))).toBe(false);
  });

  it('logs an enqueue summary with the eligible count', () => {
    const messages: string[] = [];
    const { scheduler } = makeFakeScheduler();

    enqueueCommonsMembershipRepairJobs(
      scheduler,
      { addSpaceMember: vi.fn() as never },
      store,
      (m) => messages.push(m),
    );

    expect(messages.some((m) => /enqueueing repair for 2 member\(s\)/.test(m))).toBe(true);
  });
});
