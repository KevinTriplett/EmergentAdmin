/**
 * Members explicitly excluded from automatic Commons-space membership.
 *
 * The list is version-controlled and edited by a developer; there is
 * intentionally no HTTP/UI management surface. Restart the service
 * after editing so the new list is loaded.
 *
 * Where the gate fires (all three independently — defence in depth):
 *
 *   1. IMAP poller. A member at threshold who is on this list still
 *      has their agreement recorded in SQLite (so the dashboard's
 *      counts stay accurate), but the auto-enqueue of
 *      `addToAllSpacesJob` is suppressed with a log line. The
 *      `claimAddForMember` dedup gate still fires.
 *
 *   2. Reconcile. `enqueueCommonsMembershipRepairJobs` filters the
 *      eligible list against this set before enqueueing, so a
 *      previously-claimed-but-not-yet-added ineligible member is also
 *      excluded from the nightly repair pass.
 *
 *   3. Manual add endpoints (`POST /run/add-space-member` and
 *      `POST /run/add-space-member-all-spaces`). Both reject with
 *      HTTP 403 when the target is ineligible. The existing
 *      `force: true` flag does NOT bypass this gate — `force` is for
 *      bypassing the per-(member, space) ledger in Stage 4g, which
 *      presupposes the member is eligible. Operator override path is
 *      to remove the entry from this file and redeploy.
 *
 * What the gate does NOT do:
 *
 *   - Does not remove existing memberships. A member who was already
 *     added to spaces (e.g. before they were marked ineligible) stays
 *     in those spaces; this list only blocks future adds. Removal
 *     belongs to a separate flow.
 *   - Does not stop agreement recording. Their "I agree" comments
 *     still land in the `agreements` table so audits and dashboards
 *     see reality. Only the act of adding them to spaces is gated.
 *
 * To add an entry:
 *   1. Append to `INELIGIBLE_MEMBERS` below with the member's full
 *      name, MN member id, and a brief reason (free text).
 *   2. Commit + deploy + restart the service.
 *   3. Verify on the dashboard that the entry appears under
 *      "Ineligible members" and is filtered out of "Eligible, not
 *      yet added to Commons".
 */
export type IneligibleMember = {
  /** MN numeric member id, as a string (matches `members.member_id`). */
  memberId: string;
  /**
   * Full name as it last appeared in MN, used for the dashboard and
   * log lines. Mismatched names do NOT affect gating — the lookup is
   * by `memberId` only — but a stale name here will mislead the human
   * reader. Update if the member renames themselves.
   */
  fullName: string;
  /**
   * Free-text reason recorded for audit. Surfaced in the dashboard
   * panel and in the 403 body of the manual-add endpoints. Keep it
   * short and durable (e.g. a date + cause), not transient context.
   */
  reason: string;
};

/**
 * The active ineligibility list. Empty by default; edit and redeploy
 * to change. Order is irrelevant — lookups are by memberId.
 */
export const INELIGIBLE_MEMBERS: ReadonlyArray<IneligibleMember> = [
  // { memberId: '1234567', fullName: 'Example Person', reason: 'Banned 2026-05-01: code-of-conduct violation' },
  {
    memberId: '16933091',
    fullName: 'Charles Blake',
    reason: 'repeated patterns of not willing to engage with conflict resolution and relationality'
  }
];

/**
 * Built once at module load. The exported helpers below all delegate
 * to this map so callers don't pay an O(n) scan per check.
 */
const INELIGIBLE_BY_ID: ReadonlyMap<string, IneligibleMember> = new Map(
  INELIGIBLE_MEMBERS.map((m) => [m.memberId, m]),
);

/**
 * `true` iff the given member id is on the ineligibility list. Used
 * by all three gate sites; do not duplicate the lookup logic
 * elsewhere — keep it routed through this function so we can later
 * swap the storage backend without touching call sites.
 */
export function isMemberIneligible(memberId: string): boolean {
  return INELIGIBLE_BY_ID.has(memberId);
}

/**
 * The reason string from the matching entry, or `null` if the member
 * is not on the list. Distinct from `isMemberIneligible` because
 * callers that surface user-facing text (HTTP 403 body, log lines)
 * want the reason in the same lookup.
 */
export function getIneligibilityReason(memberId: string): string | null {
  return INELIGIBLE_BY_ID.get(memberId)?.reason ?? null;
}
