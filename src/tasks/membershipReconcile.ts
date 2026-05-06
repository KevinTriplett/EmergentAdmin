import type { AgreementsStore } from '../state/agreementsStore.js';
import type { TaskScheduler } from '../scheduler/taskScheduler.js';
import { buildAddToAllSpacesJob } from './addToAllSpacesJob.js';
import { addSpaceMember } from './addSpaceMember.js';

/**
 * Stage 4c / 4f: enqueue idempotent repair jobs so members who meet the
 * agreement threshold receive an add-to-all-spaces pass.
 *
 * Default scope (`onlyNotYetAdded` omitted or false): every eligible
 * member, regardless of `commons_added_at`. Idempotent on already-added
 * spaces, and the only mechanism that catches silent drift between MN
 * and our DB. Stays the safe default per Stage 4f's design.
 *
 * Trimmed scope (`onlyNotYetAdded: true`): eligible AND
 * `commons_added_at IS NULL`. Useful when the full sweep is too
 * expensive to run nightly and the operator trusts the verified-added
 * flag as ground truth. Driven by the `RECONCILE_COMMONS_SCOPE` env
 * var (`not-yet-added` enables it; any other value or unset uses the
 * default).
 *
 * Either way, the job receives the `store` dep so a successful run
 * (failureCount===0) flips `commons_added_at` on the way out.
 */
export type EnqueueRepairOptions = {
  /**
   * When true, restrict the queue to members whose `commons_added_at`
   * is still NULL. Default false → re-run for every eligible member.
   */
  onlyNotYetAdded?: boolean;
};

export function enqueueCommonsMembershipRepairJobs(
  scheduler: TaskScheduler,
  deps: { addSpaceMember: typeof addSpaceMember },
  store: AgreementsStore,
  log?: (msg: string) => void,
  opts?: EnqueueRepairOptions,
): Array<{ memberId: string; fullName: string; agreementCount: number }> {
  const onlyNotYetAdded = opts?.onlyNotYetAdded ?? false;
  const eligible = onlyNotYetAdded
    ? store.listMembersEligibleNotYetCommonsAdded()
    : store.listMembersEligibleForCommonsAdd();
  const notify = log ?? console.log.bind(console);
  const scopeLabel = onlyNotYetAdded ? 'not-yet-added' : 'all-eligible';
  notify(
    `[reconcile] enqueueing repair for ${eligible.length} member(s) (scope=${scopeLabel})`,
  );

  for (const row of eligible) {
    const job = buildAddToAllSpacesJob(
      { ...deps, store },
      {
        fullMemberName: row.fullName,
        memberId: row.memberId,
        reason: '[reconcile]',
      },
    );
    void scheduler.enqueueBackground(job).catch((err) => {
      console.error(`[reconcile] enqueue failed for ${row.fullName} (${row.memberId}):`, err);
    });
  }

  return eligible.slice();
}
