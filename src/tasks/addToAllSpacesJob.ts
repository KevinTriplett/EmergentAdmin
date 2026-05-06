import { SPACE_IDS } from './removeSpaceMembers.js';
import { addSpaceMember, ALREADY_A_MEMBER } from './addSpaceMember.js';
import type { BrowserJobContext, SchedulerJob } from '../scheduler/taskScheduler.js';
import type { AgreementsStore } from '../state/agreementsStore.js';

export { ALREADY_A_MEMBER };

export type AddToAllSpacesJobResult = {
  fullMemberName: string;
  memberId: string;
  addedCount: number;
  alreadyMemberCount: number;
  failureCount: number;
  spaces: Array<{ space: string; success: boolean; error?: string }>;
};

/**
 * Single browser session: add one member to every space in {@link SPACE_IDS}.
 * Shared by manual HTTP runs, IMAP auto-add, and nightly reconciliation.
 *
 * Stage 4f: optional `store` dep. When provided AND the run completes
 * with `failureCount === 0` AND every space was attempted (no abort),
 * the job calls `store.markCommonsAdded(memberId)` so the dashboard's
 * "Eligible, not yet added to Commons" list and the verified-added
 * counter both reflect reality. Manual endpoints without an agreements
 * store wired up (`store` undefined) still work — the mark step is
 * silently skipped and the job's other behaviour is unchanged.
 */
export function buildAddToAllSpacesJob(
  deps: { addSpaceMember: typeof addSpaceMember; store?: Pick<AgreementsStore, 'markCommonsAdded'> },
  input: { fullMemberName: string; memberId: string; reason?: string },
): SchedulerJob<AddToAllSpacesJobResult> {
  const namePrefix = input.reason ? `${input.reason} ` : '';
  return {
    name: `${namePrefix}addSpaceMember "${input.fullMemberName}" → ALL spaces`,
    headless: true,
    run: async (ctx: BrowserJobContext) => {
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
          fullMemberName: input.fullMemberName,
          memberId: input.memberId,
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

      /* Stage 4f: only mark commons-added when the entire spaces list
       * was actually attempted with zero failures. An abort partway
       * gives results.length < spaceNames.length and must NOT mark,
       * even if every space we did attempt succeeded — the member
       * isn't fully in the commons yet. Idempotent on repeat runs:
       * `markCommonsAdded` is first-write-wins. */
      if (
        deps.store &&
        results.length === spaceNames.length &&
        failureCount === 0
      ) {
        deps.store.markCommonsAdded(input.memberId);
      }

      return {
        fullMemberName: input.fullMemberName,
        memberId: input.memberId,
        addedCount,
        alreadyMemberCount,
        failureCount,
        spaces: results,
      };
    },
    summarize: (r) =>
      `added ${r.addedCount}, already member ${r.alreadyMemberCount}, failed ${r.failureCount}`,
  };
}
