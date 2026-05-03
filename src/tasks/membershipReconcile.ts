import type { AgreementsStore } from '../state/agreementsStore.js';
import type { TaskScheduler } from '../scheduler/taskScheduler.js';
import { buildAddToAllSpacesJob } from './addToAllSpacesJob.js';
import { addSpaceMember } from './addSpaceMember.js';

/**
 * Stage 4c: enqueue idempotent repair jobs so every member who has met the
 * agreement threshold receives a fresh add-to-all-spaces pass. Duplicate work
 * is cheap: `addSpaceMember` treats existing membership as success.
 */
export function enqueueCommonsMembershipRepairJobs(
  scheduler: TaskScheduler,
  deps: { addSpaceMember: typeof addSpaceMember },
  store: AgreementsStore,
  log?: (msg: string) => void,
): Array<{ memberId: string; fullName: string; agreementCount: number }> {
  const eligible = store.listMembersEligibleForCommonsAdd();
  const notify = log ?? console.log.bind(console);
  notify(`[reconcile] enqueueing repair for ${eligible.length} member(s) with threshold met`);

  for (const row of eligible) {
    const job = buildAddToAllSpacesJob(deps, {
      fullMemberName: row.fullName,
      memberId: row.memberId,
      reason: '[reconcile]',
    });
    void scheduler.enqueueBackground(job).catch((err) => {
      console.error(`[reconcile] enqueue failed for ${row.fullName} (${row.memberId}):`, err);
    });
  }

  return eligible.slice();
}
