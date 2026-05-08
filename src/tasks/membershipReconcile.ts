import type { AgreementsStore } from '../state/agreementsStore.js';
import type { TaskScheduler } from '../scheduler/taskScheduler.js';
import { buildAddToAllSpacesJob } from './addToAllSpacesJob.js';
import { addSpaceMember } from './addSpaceMember.js';

/**
 * Stage 4g reconcile: enqueue an idempotent repair job for every
 * eligible member who is not yet verified-added to all Commons spaces.
 *
 * Scope is now fixed (no env-var toggle). The pre-Stage-4g design's
 * "all-eligible" sweep was removed in favour of the consent guarantee
 * that members are added to each space exactly once: the per-(member,
 * space) attempt ledger inside `addToAllSpacesJob` skips spaces with a
 * verified `'present'` row, so re-running for already-finished members
 * would just no-op anyway. We use `commons_added_at IS NULL` as the
 * fast filter so reconcile doesn't even iterate the finished cohort.
 *
 * The job each enqueued member runs:
 *
 *   - skips spaces it has already verified-present (consent gate);
 *   - retries spaces with a 'failed' row, or never-seen spaces;
 *   - records 'present' only on Phase-1-verified hits;
 *   - flips `commons_added_at` when every space is Phase-1-verified.
 *
 * Runs `pruneFailedSpaceAttempts` first with a 30-day cutoff so the
 * attempt ledger doesn't accumulate stale failures forever — failed
 * rows for members who are no longer eligible (audit invalidated, or
 * left the community) get cleaned up here without a separate cron.
 */
export const FAILED_ATTEMPT_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export function enqueueCommonsMembershipRepairJobs(
  scheduler: TaskScheduler,
  deps: { addSpaceMember: typeof addSpaceMember },
  store: AgreementsStore,
  log?: (msg: string) => void,
  /**
   * Forwarded onto every enqueued `addToAllSpacesJob`. Defaults to
   * `true` so the cron path and any caller that doesn't opt in stay
   * headless. Only the manual UI/HTTP trigger flips this to `false`
   * for visible-browser debugging on the dev box.
   */
  options?: { headless?: boolean },
): Array<{ memberId: string; fullName: string; agreementCount: number }> {
  const notify = log ?? console.log.bind(console);
  const headless = options?.headless ?? true;

  const cutoff = Date.now() - FAILED_ATTEMPT_TTL_MS;
  const pruned = store.pruneFailedSpaceAttempts(cutoff);
  if (pruned > 0) {
    notify(`[reconcile] pruned ${pruned} failed attempt row(s) older than 30 days`);
  }

  const eligible = store.listMembersEligibleNotYetCommonsAdded();
  notify(`[reconcile] enqueueing repair for ${eligible.length} member(s)`);

  for (const row of eligible) {
    const job = buildAddToAllSpacesJob(
      { ...deps, store },
      {
        fullMemberName: row.fullName,
        memberId: row.memberId,
        reason: '[reconcile]',
        headless,
      },
    );
    void scheduler.enqueueBackground(job).catch((err) => {
      console.error(`[reconcile] enqueue failed for ${row.fullName} (${row.memberId}):`, err);
    });
  }

  return eligible.slice();
}
