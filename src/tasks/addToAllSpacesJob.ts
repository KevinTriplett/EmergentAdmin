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
  /**
   * Stage 4g: spaces skipped without invoking `addSpaceMember` because
   * the attempt ledger already has a verified `'present'` row for the
   * pair. Counted toward the "fully present" gate so a member whose
   * every space is already verified retires immediately.
   */
  skippedCount: number;
  spaces: Array<{ space: string; success: boolean; error?: string; skipped?: boolean }>;
};

/**
 * Stage 4g store contract. Optional so the manual endpoint stays usable
 * without an agreements DB; when present, the job consults the attempt
 * ledger before each iteration and writes verified outcomes after each.
 */
type StoreDeps = Pick<
  AgreementsStore,
  | 'markCommonsAdded'
  | 'recordSpacePresent'
  | 'recordSpaceFailed'
  | 'listMemberSpaceAttempts'
>;

/**
 * Single browser session: add one member to every space in {@link SPACE_IDS}.
 * Shared by manual HTTP runs, IMAP auto-add, and nightly reconciliation.
 *
 * Stage 4g — "added once, never again":
 *
 *   1. Pre-loop, the job loads the member's attempt ledger and skips
 *      every space whose row is already `'present'` (i.e. an earlier
 *      pass independently confirmed the member is in that space). This
 *      is the consent guarantee: once we've added a member to a space,
 *      we will never add them again, even if they later leave it.
 *
 *   2. For each space the job actually visits, we trust ONLY the
 *      Phase-1 search inside `addSpaceMember` (which returns
 *      `ALREADY_A_MEMBER` when the member's row is found in the space's
 *      filtered member list) as evidence of presence. That's the only
 *      result that writes a `'present'` ledger row. A Phase-2 success
 *      (the toast appeared, but no independent search ran) is left
 *      unrecorded; the next reconcile pass will Phase-1-verify and
 *      record on that pass — at the cost of one extra reconcile cycle
 *      per fully-new member.
 *
 *      Residual race: between the IMAP-triggered Phase-2 add and the
 *      next reconcile pass, the member's `'present'` row doesn't
 *      exist yet, so a reconcile firing in that window will retry the
 *      Phase-1 + Phase-2 flow. If the member chose to leave a space
 *      in that same narrow window, Phase 1 will not find them and
 *      Phase 2 will re-add them. Mitigation: keep the reconcile cron
 *      interval (default daily) the same order of magnitude as the
 *      window in which a member would plausibly notice and leave.
 *      The deeper fix would be a Phase-3 re-verification inside
 *      `addSpaceMember` itself; deliberately deferred per Stage 4g's
 *      "next-pass verification" design.
 *
 *   3. Failures persist a `'failed'` ledger row so subsequent passes
 *      retry the same pair instead of every space. Failed rows age out
 *      after 30 days (see `pruneFailedSpaceAttempts`); they will NEVER
 *      overwrite a `'present'` row.
 *
 *   4. `members.commons_added_at` is set when the run finishes and
 *      every space in `SPACE_IDS` is accounted for as Phase-1-verified
 *      — either skipped at the top of an iteration (pre-existing
 *      `'present'`) or `ALREADY_A_MEMBER` written this run. Phase-2
 *      successes never count toward this gate; the member retires on
 *      the follow-up pass instead.
 *
 * `force: true` (manual operator override) bypasses the pre-loop skip
 * — the job runs Phase 1 + Phase 2 against every space. Used when the
 * operator explicitly wants to re-add a member who left, e.g. after
 * the member asks to be put back. Even under force the ledger writes
 * remain conservative: only Phase-1-verified results yield `'present'`
 * rows, and failures still go through the no-clobber-present guard.
 */
export function buildAddToAllSpacesJob(
  deps: { addSpaceMember: typeof addSpaceMember; store?: StoreDeps },
  input: { fullMemberName: string; memberId: string; reason?: string; force?: boolean },
): SchedulerJob<AddToAllSpacesJobResult> {
  const namePrefix = input.reason ? `${input.reason} ` : '';
  const force = input.force ?? false;
  return {
    name: `${namePrefix}addSpaceMember "${input.fullMemberName}" → ALL spaces${force ? ' (force)' : ''}`,
    headless: true,
    run: async (ctx: BrowserJobContext) => {
      type SpaceResult = { space: string; success: boolean; error?: string; skipped?: boolean };
      const spaceNames = Object.keys(SPACE_IDS);
      const expectedSpaceCount = spaceNames.length;
      const results: SpaceResult[] = [];
      let addedCount = 0;
      let alreadyMemberCount = 0;
      let failureCount = 0;
      let skippedCount = 0;

      /* Pre-loop ledger fetch. The set encodes "already verified
       * present in our DB"; we treat each entry as if the space had
       * just answered ALREADY_A_MEMBER, without paying the network
       * round-trip. Under `force`, we deliberately ignore the set so
       * the operator can re-attempt every space. */
      const presentSpaces = new Set<string>();
      if (deps.store && !force) {
        for (const a of deps.store.listMemberSpaceAttempts(input.memberId)) {
          if (a.outcome === 'present') presentSpaces.add(a.spaceName);
        }
      }

      /* Counts every space confirmed Phase-1-present after the loop:
       * pre-existing skipped rows + ALREADY_A_MEMBER hits this run.
       * If this reaches `expectedSpaceCount`, the member is fully
       * verified-present in our DB and `commons_added_at` flips. */
      let phase1VerifiedCount = 0;

      for (const spaceName of spaceNames) {
        if (ctx.abortSignal.aborted) {
          ctx.log('Abort requested — skipping remaining spaces.');
          break;
        }

        if (presentSpaces.has(spaceName)) {
          ctx.log(`• ${spaceName}: ${input.fullMemberName} already verified present in DB; skipping.`);
          results.push({ space: spaceName, success: true, error: ALREADY_A_MEMBER, skipped: true });
          skippedCount += 1;
          phase1VerifiedCount += 1;
          continue;
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
          phase1VerifiedCount += 1;
          deps.store?.recordSpacePresent(input.memberId, spaceName);
          ctx.log(`• ${spaceName}: already a member.`);
        } else if (result.success) {
          addedCount += 1;
          /* Phase-2 success: the add-to-spaces toast appeared, but
           * no independent search ran. Per Stage 4g we deliberately
           * do NOT write a 'present' row here — the next reconcile
           * pass will Phase-1-verify and record then. */
          ctx.log(`✓ ${spaceName}: added (verification pending next reconcile pass).`);
        } else {
          failureCount += 1;
          deps.store?.recordSpaceFailed(input.memberId, spaceName, result.error);
          ctx.log(`✗ ${spaceName}: ${result.error ?? 'unknown error'}`);
        }
      }

      /* Stage 4g mark-commons gate: every space accounted for as
       * Phase-1-verified. An abort partway through gives
       * phase1VerifiedCount < expectedSpaceCount because we never
       * reached those iterations. A run with even one Phase-2-only
       * success is also < expectedSpaceCount, so the member rolls
       * over to the next reconcile pass for verification. Idempotent
       * on repeat runs: `markCommonsAdded` is first-write-wins. */
      if (deps.store && phase1VerifiedCount === expectedSpaceCount) {
        deps.store.markCommonsAdded(input.memberId);
      }

      return {
        fullMemberName: input.fullMemberName,
        memberId: input.memberId,
        addedCount,
        alreadyMemberCount,
        failureCount,
        skippedCount,
        spaces: results,
      };
    },
    summarize: (r) =>
      `added ${r.addedCount}, already member ${r.alreadyMemberCount}, ` +
      `skipped ${r.skippedCount}, failed ${r.failureCount}`,
  };
}
