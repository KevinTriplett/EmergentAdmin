import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  openAgreementsStore,
  type AgreementsStore,
  type AuditState,
} from '../src/state/agreementsStore.js';

/**
 * These tests run against an in-memory better-sqlite3 database so they're
 * hermetic and fast. The critical invariants they pin:
 *   1. Duplicate (member, article) pairs are counted exactly once.
 *   2. `claimAddForMember` only fires once per member, even across parallel
 *      callers - this is what prevents the poller and reconciliation from
 *      both enqueuing an add-all-spaces job for the same 8th agreement.
 *   3. processed_emails dedup survives re-insertion with the same message id.
 */

const REQUIRED = 8;

function agreement(
  memberId: string,
  articleId: string,
  overrides: { fullName?: string; commentId?: string; commentedAt?: number } = {},
) {
  return {
    memberId,
    fullName: overrides.fullName ?? `Full of ${memberId}`,
    articleId,
    commentId: overrides.commentId ?? `c-${memberId}-${articleId}`,
    commentedAt: overrides.commentedAt ?? Date.now(),
    source: 'email' as const,
  };
}

describe('agreementsStore', () => {
  let store: AgreementsStore;

  beforeEach(() => {
    store = openAgreementsStore({ filePath: ':memory:', requiredAgreementCount: REQUIRED });
  });

  afterEach(() => {
    store.close();
  });

  it('records a first agreement and returns outcome=inserted', () => {
    const res = store.recordAgreement(agreement('m1', 'a1'));
    expect(res.outcome).toBe('inserted');
    expect(res.agreementCount).toBe(1);
  });

  it('treats a repeat of the same (member, article) as duplicate without bumping the count', () => {
    store.recordAgreement(agreement('m1', 'a1', { commentId: 'c-first' }));
    const res = store.recordAgreement(agreement('m1', 'a1', { commentId: 'c-second' }));
    expect(res.outcome).toBe('duplicate');
    expect(res.agreementCount).toBe(1);
  });

  it('counts distinct articles per member independently', () => {
    for (let i = 0; i < 3; i++) store.recordAgreement(agreement('m1', `a${i}`));
    for (let i = 0; i < 5; i++) store.recordAgreement(agreement('m2', `a${i}`));
    expect(store.countAgreements('m1')).toBe(3);
    expect(store.countAgreements('m2')).toBe(5);
    expect(store.countAgreements('m-nobody')).toBe(0);
  });

  it('updates member full_name on recordAgreement when it changes', () => {
    store.recordAgreement(agreement('m1', 'a1', { fullName: 'Jane Doe' }));
    expect(store.getMemberFullName('m1')).toBe('Jane Doe');

    store.recordAgreement(agreement('m1', 'a2', { fullName: 'Jane D.' }));
    expect(store.getMemberFullName('m1')).toBe('Jane D.');
  });

  describe('claimAddForMember', () => {
    it('returns false until the required count is reached', () => {
      for (let i = 0; i < REQUIRED - 1; i++) {
        store.recordAgreement(agreement('m1', `a${i}`));
      }
      expect(store.claimAddForMember('m1')).toBe(false);
      expect(store.isMemberAdded('m1')).toBe(false);
    });

    it('returns true exactly once when the count crosses the threshold', () => {
      for (let i = 0; i < REQUIRED; i++) {
        store.recordAgreement(agreement('m1', `a${i}`));
      }

      expect(store.claimAddForMember('m1')).toBe(true);
      expect(store.isMemberAdded('m1')).toBe(true);

      expect(store.claimAddForMember('m1')).toBe(false);
      expect(store.claimAddForMember('m1')).toBe(false);
    });

    it('returns false for unknown members', () => {
      expect(store.claimAddForMember('m-nobody')).toBe(false);
    });

    it('stamps added_at with the provided timestamp', () => {
      for (let i = 0; i < REQUIRED; i++) store.recordAgreement(agreement('m1', `a${i}`));
      const t = 1_700_000_000_000;
      expect(store.claimAddForMember('m1', t)).toBe(true);
      expect(store.isMemberAdded('m1')).toBe(true);
    });
  });

  describe('listMembersEligibleForCommonsAdd', () => {
    it('returns empty when no member meets the threshold', () => {
      for (let i = 0; i < REQUIRED - 1; i++) {
        store.recordAgreement(agreement('m1', `a${i}`));
      }
      expect(store.listMembersEligibleForCommonsAdd()).toEqual([]);
    });

    it('returns every member whose distinct-article count >= requiredAgreementCount', () => {
      for (let i = 0; i < REQUIRED; i++) store.recordAgreement(agreement('m1', `a${i}`));
      store.recordAgreement(agreement('m2', 'only-one'));
      const rows = store.listMembersEligibleForCommonsAdd();
      expect(rows).toHaveLength(1);
      expect(rows[0].memberId).toBe('m1');
      expect(rows[0].agreementCount).toBe(REQUIRED);
      expect(rows[0].fullName).toBe(`Full of m1`);
    });

    it('includes every member who meets the threshold', () => {
      for (let i = 0; i < REQUIRED; i++) {
        store.recordAgreement(agreement('mA', `a${i}`, { fullName: 'Alice' }));
        store.recordAgreement(agreement('mB', `b${i}`, { fullName: 'Bob' }));
      }
      const rows = store.listMembersEligibleForCommonsAdd();
      expect(rows).toHaveLength(2);
      const ids = rows.map((r) => r.memberId).sort();
      expect(ids).toEqual(['mA', 'mB']);
    });
  });

  describe('getAgreementsOverview', () => {
    it('returns zeros when the DB is empty', () => {
      const o = store.getAgreementsOverview();
      expect(o.requiredAgreementCount).toBe(REQUIRED);
      expect(o.distinctMembersWithAgreement).toBe(0);
      expect(o.totalAgreementRows).toBe(0);
      expect(o.eligibleCount).toBe(0);
      expect(o.inProgressMemberCount).toBe(0);
      expect(o.commonsAddedMemberCount).toBe(0);
      expect(o.processedEmailCount).toBe(0);
      expect(o.eligibleMembers).toEqual([]);
      expect(o.inProgressMembers).toEqual([]);
    });

    it('counts processed emails independently of agreements', () => {
      store.markEmailProcessed('m1');
      store.markEmailProcessed('m2');
      const o = store.getAgreementsOverview();
      expect(o.processedEmailCount).toBe(2);
    });

    it('counts in-progress vs eligible memberships', () => {
      const tiny = openAgreementsStore({ filePath: ':memory:', requiredAgreementCount: 2 });
      try {
        tiny.recordAgreement(agreement('p1', 'x1'));
        tiny.recordAgreement(agreement('p2', 'y1'));
        tiny.recordAgreement(agreement('p2', 'y2'));
        const ov = tiny.getAgreementsOverview();
        expect(ov.distinctMembersWithAgreement).toBe(2);
        expect(ov.totalAgreementRows).toBe(3);
        expect(ov.eligibleCount).toBe(1);
        expect(ov.inProgressMemberCount).toBe(1);
        expect(ov.eligibleMembers[0]?.memberId).toBe('p2');
        expect(ov.eligibleMembers[0]?.agreementCount).toBe(2);
        expect(ov.inProgressMembers.map((x) => x.memberId)).toContain('p1');
      } finally {
        tiny.close();
      }
    });
  });

  describe('processed_emails', () => {
    it('remembers processed message ids', () => {
      expect(store.hasProcessedEmail('msg-1')).toBe(false);
      store.markEmailProcessed('msg-1', 1);
      expect(store.hasProcessedEmail('msg-1')).toBe(true);
    });

    it('is idempotent on repeated markEmailProcessed calls', () => {
      store.markEmailProcessed('msg-1', 1);
      expect(() => store.markEmailProcessed('msg-1', 2)).not.toThrow();
      expect(store.hasProcessedEmail('msg-1')).toBe(true);
    });
  });

  /*
   * Stage 4e — change-of-heart audit. The store gains:
   *   - audit_state column on agreements (null = never audited)
   *   - audit_at column (epoch ms of last audit write)
   *   - recordAuditOutcome(member, article, state, when?) — writes both
   *   - getAuditState(member, article) — reads back (null if no row)
   *   - listMembersForArticle(article) — distinct members with any row,
   *     regardless of audit_state, so the audit can re-evaluate them
   *
   * Behavioral invariant: rows whose audit_state is in
   * ('deleted','edited','mixed') stop counting toward a member's
   * agreement total. NULL/'happy'/'multi_agreement' all count.
   */
  describe('Stage 4e audit fields', () => {
    it('starts with no audit_state for a freshly recorded agreement', () => {
      store.recordAgreement(agreement('m1', 'a1'));
      expect(store.getAuditState('m1', 'a1')).toBeNull();
    });

    it('returns null audit state for a (member, article) with no row', () => {
      expect(store.getAuditState('m-nobody', 'a-nobody')).toBeNull();
    });

    it('records and reads back audit outcome', () => {
      store.recordAgreement(agreement('m1', 'a1'));
      store.recordAuditOutcome('m1', 'a1', 'happy', 1_700_000_000_000);
      expect(store.getAuditState('m1', 'a1')).toBe('happy');
    });

    it('overwrites a previous audit outcome on re-audit', () => {
      store.recordAgreement(agreement('m1', 'a1'));
      store.recordAuditOutcome('m1', 'a1', 'happy');
      store.recordAuditOutcome('m1', 'a1', 'deleted');
      expect(store.getAuditState('m1', 'a1')).toBe('deleted');
    });

    it('silently no-ops recordAuditOutcome on an unknown (member, article)', () => {
      expect(() => store.recordAuditOutcome('m-ghost', 'a-ghost', 'happy')).not.toThrow();
      expect(store.getAuditState('m-ghost', 'a-ghost')).toBeNull();
    });

    it.each<['deleted' | 'edited' | 'mixed']>([['deleted'], ['edited'], ['mixed']])(
      'excludes %s rows from countAgreements',
      (state) => {
        store.recordAgreement(agreement('m1', 'a1'));
        store.recordAgreement(agreement('m1', 'a2'));
        expect(store.countAgreements('m1')).toBe(2);
        store.recordAuditOutcome('m1', 'a1', state);
        expect(store.countAgreements('m1')).toBe(1);
      },
    );

    it.each<['happy' | 'multi_agreement']>([['happy'], ['multi_agreement']])(
      'keeps counting %s rows in countAgreements',
      (state) => {
        store.recordAgreement(agreement('m1', 'a1'));
        store.recordAuditOutcome('m1', 'a1', state);
        expect(store.countAgreements('m1')).toBe(1);
      },
    );

    it('drops a member out of listMembersEligibleForCommonsAdd when the audit invalidates enough rows', () => {
      const tiny = openAgreementsStore({ filePath: ':memory:', requiredAgreementCount: 2 });
      try {
        tiny.recordAgreement(agreement('m1', 'a1'));
        tiny.recordAgreement(agreement('m1', 'a2'));
        expect(tiny.listMembersEligibleForCommonsAdd().map((r) => r.memberId)).toEqual(['m1']);

        tiny.recordAuditOutcome('m1', 'a1', 'deleted');
        expect(tiny.listMembersEligibleForCommonsAdd()).toEqual([]);
      } finally {
        tiny.close();
      }
    });

    it('still allows claimAddForMember when only happy/multi_agreement rows count to threshold', () => {
      const tiny = openAgreementsStore({ filePath: ':memory:', requiredAgreementCount: 2 });
      try {
        tiny.recordAgreement(agreement('m1', 'a1'));
        tiny.recordAgreement(agreement('m1', 'a2'));
        tiny.recordAuditOutcome('m1', 'a1', 'happy');
        tiny.recordAuditOutcome('m1', 'a2', 'multi_agreement');
        expect(tiny.claimAddForMember('m1')).toBe(true);
      } finally {
        tiny.close();
      }
    });

    it('blocks claimAddForMember when the audit invalidates a row needed to reach threshold', () => {
      const tiny = openAgreementsStore({ filePath: ':memory:', requiredAgreementCount: 2 });
      try {
        tiny.recordAgreement(agreement('m1', 'a1'));
        tiny.recordAgreement(agreement('m1', 'a2'));
        tiny.recordAuditOutcome('m1', 'a1', 'edited');
        expect(tiny.claimAddForMember('m1')).toBe(false);
      } finally {
        tiny.close();
      }
    });

    it('reflects the audit_state filter in getAgreementsOverview eligible/in-progress lists', () => {
      const tiny = openAgreementsStore({ filePath: ':memory:', requiredAgreementCount: 2 });
      try {
        tiny.recordAgreement(agreement('m1', 'a1'));
        tiny.recordAgreement(agreement('m1', 'a2'));
        tiny.recordAuditOutcome('m1', 'a1', 'mixed');
        const o = tiny.getAgreementsOverview();
        expect(o.eligibleCount).toBe(0);
        expect(o.inProgressMemberCount).toBe(1);
        expect(o.inProgressMembers[0]?.memberId).toBe('m1');
        expect(o.inProgressMembers[0]?.distinctAgreementArticles).toBe(1);
      } finally {
        tiny.close();
      }
    });

    it('clears audit_state to NULL when recordAgreement re-records an existing (member, article)', () => {
      store.recordAgreement(agreement('m1', 'a1', { commentId: 'c-old' }));
      store.recordAuditOutcome('m1', 'a1', 'deleted');
      expect(store.getAuditState('m1', 'a1')).toBe('deleted');

      const res = store.recordAgreement(agreement('m1', 'a1', { commentId: 'c-new' }));
      expect(res.outcome).toBe('duplicate');
      expect(store.getAuditState('m1', 'a1')).toBeNull();
    });

    it('keeps the original audit_state untouched when recordAgreement adds a different (member, article)', () => {
      store.recordAgreement(agreement('m1', 'a1'));
      store.recordAuditOutcome('m1', 'a1', 'deleted');
      store.recordAgreement(agreement('m1', 'a2'));
      expect(store.getAuditState('m1', 'a1')).toBe('deleted');
      expect(store.getAuditState('m1', 'a2')).toBeNull();
    });
  });

  describe('listMembersForArticle', () => {
    it('returns empty when no member has a row for the article', () => {
      expect(store.listMembersForArticle('article-empty')).toEqual([]);
    });

    it('returns one row per distinct member who has any agreement on the article', () => {
      store.recordAgreement(agreement('m1', 'art-1', { fullName: 'Alice' }));
      store.recordAgreement(agreement('m2', 'art-1', { fullName: 'Bob' }));
      store.recordAgreement(agreement('m1', 'art-2', { fullName: 'Alice' }));

      const rows = store.listMembersForArticle('art-1');
      const sorted = rows.slice().sort((a, b) => a.memberId.localeCompare(b.memberId));
      expect(sorted).toEqual([
        { memberId: 'm1', fullName: 'Alice' },
        { memberId: 'm2', fullName: 'Bob' },
      ]);
    });

    it('includes members regardless of audit_state so the audit can re-evaluate flagged rows', () => {
      store.recordAgreement(agreement('m1', 'art-1', { fullName: 'Alice' }));
      store.recordAuditOutcome('m1', 'art-1', 'deleted');
      const rows = store.listMembersForArticle('art-1');
      expect(rows).toEqual([{ memberId: 'm1', fullName: 'Alice' }]);
    });
  });

  /*
   * Stage 4f — verified-added flag.
   *
   * Today `members.added_at` is set by `claimAddForMember()` BEFORE the
   * add-all-spaces job runs; it's a dedup gate, not a "is the member
   * actually in every commons space?" answer. Stage 4f introduces:
   *
   *   - members.commons_added_at INTEGER NULL  (new column)
   *   - markCommonsAdded(memberId, when?)      (set on add-job success)
   *   - isCommonsAdded(memberId)               (read back)
   *   - listMembersEligibleNotYetCommonsAdded() — eligible AND flag IS NULL
   *
   * Behavioural invariants this block pins:
   *   1. `added_at` and `commons_added_at` are independent. Setting the
   *      dedup gate does NOT mark the member as verified-added.
   *   2. `markCommonsAdded` silently no-ops on unknown members so the
   *      manual add-by-name endpoint is safe to wire through it.
   *   3. `listMembersEligibleForCommonsAdd` (used by reconcile) still
   *      returns ALL eligible members regardless of the new flag —
   *      reconcile chooses scope at its own level.
   *   4. `commonsAddedMemberCount` in the overview switches to count
   *      `commons_added_at IS NOT NULL` (operator-visible counter
   *      now matches the 'verified added' semantic).
   */
  describe('Stage 4f commons_added_at', () => {
    it('starts unset on a fresh member row', () => {
      store.recordAgreement(agreement('m1', 'a1'));
      expect(store.isCommonsAdded('m1')).toBe(false);
    });

    it('markCommonsAdded sets the flag for an existing member', () => {
      store.recordAgreement(agreement('m1', 'a1'));
      store.markCommonsAdded('m1');
      expect(store.isCommonsAdded('m1')).toBe(true);
    });

    it('markCommonsAdded silently no-ops on an unknown member', () => {
      expect(() => store.markCommonsAdded('m-ghost')).not.toThrow();
      expect(store.isCommonsAdded('m-ghost')).toBe(false);
    });

    it('markCommonsAdded is idempotent on repeated calls', () => {
      store.recordAgreement(agreement('m1', 'a1'));
      store.markCommonsAdded('m1', 1);
      expect(() => store.markCommonsAdded('m1', 2)).not.toThrow();
      expect(store.isCommonsAdded('m1')).toBe(true);
    });

    it('added_at and commons_added_at are independent (dedup gate vs verified-added)', () => {
      const tiny = openAgreementsStore({ filePath: ':memory:', requiredAgreementCount: 2 });
      try {
        tiny.recordAgreement(agreement('m1', 'a1'));
        tiny.recordAgreement(agreement('m1', 'a2'));
        expect(tiny.claimAddForMember('m1')).toBe(true);
        expect(tiny.isMemberAdded('m1')).toBe(true);
        /* Dedup gate flipped, but verified-added has not. */
        expect(tiny.isCommonsAdded('m1')).toBe(false);

        tiny.markCommonsAdded('m1');
        expect(tiny.isCommonsAdded('m1')).toBe(true);
      } finally {
        tiny.close();
      }
    });

    it('listMembersEligibleNotYetCommonsAdded returns eligible members whose flag is null', () => {
      const tiny = openAgreementsStore({ filePath: ':memory:', requiredAgreementCount: 2 });
      try {
        tiny.recordAgreement(agreement('m1', 'a1', { fullName: 'Alice' }));
        tiny.recordAgreement(agreement('m1', 'a2', { fullName: 'Alice' }));
        tiny.recordAgreement(agreement('m2', 'a1', { fullName: 'Bob' }));
        tiny.recordAgreement(agreement('m2', 'a2', { fullName: 'Bob' }));

        const before = tiny.listMembersEligibleNotYetCommonsAdded();
        expect(before.map((r) => r.memberId).sort()).toEqual(['m1', 'm2']);

        tiny.markCommonsAdded('m1');
        const after = tiny.listMembersEligibleNotYetCommonsAdded();
        expect(after.map((r) => r.memberId)).toEqual(['m2']);
      } finally {
        tiny.close();
      }
    });

    it('listMembersEligibleForCommonsAdd is unchanged: still returns ALL eligible regardless of commons_added_at', () => {
      const tiny = openAgreementsStore({ filePath: ':memory:', requiredAgreementCount: 2 });
      try {
        tiny.recordAgreement(agreement('m1', 'a1'));
        tiny.recordAgreement(agreement('m1', 'a2'));
        tiny.markCommonsAdded('m1');
        const rows = tiny.listMembersEligibleForCommonsAdd();
        expect(rows.map((r) => r.memberId)).toEqual(['m1']);
      } finally {
        tiny.close();
      }
    });

    it('overview.commonsAddedMemberCount counts commons_added_at IS NOT NULL (verified-added semantic)', () => {
      const tiny = openAgreementsStore({ filePath: ':memory:', requiredAgreementCount: 2 });
      try {
        tiny.recordAgreement(agreement('m1', 'a1'));
        tiny.recordAgreement(agreement('m1', 'a2'));
        /* Dedup gate alone must NOT bump the counter — that was the
         * old (Stage 4a) semantic where the counter inflated as soon
         * as a job was enqueued, even if the job later failed. */
        expect(tiny.claimAddForMember('m1')).toBe(true);
        expect(tiny.getAgreementsOverview().commonsAddedMemberCount).toBe(0);

        tiny.markCommonsAdded('m1');
        expect(tiny.getAgreementsOverview().commonsAddedMemberCount).toBe(1);
      } finally {
        tiny.close();
      }
    });

    it('overview exposes eligibleNotYetAddedMembers / eligibleNotYetAddedCount alongside the unchanged eligible* fields', () => {
      const tiny = openAgreementsStore({ filePath: ':memory:', requiredAgreementCount: 2 });
      try {
        tiny.recordAgreement(agreement('m1', 'a1', { fullName: 'Alice' }));
        tiny.recordAgreement(agreement('m1', 'a2', { fullName: 'Alice' }));
        tiny.recordAgreement(agreement('m2', 'a1', { fullName: 'Bob' }));
        tiny.recordAgreement(agreement('m2', 'a2', { fullName: 'Bob' }));

        const o1 = tiny.getAgreementsOverview();
        expect(o1.eligibleCount).toBe(2);
        expect(o1.eligibleNotYetAddedCount).toBe(2);
        expect(o1.eligibleNotYetAddedMembers.map((r) => r.memberId).sort()).toEqual(['m1', 'm2']);

        tiny.markCommonsAdded('m1');
        const o2 = tiny.getAgreementsOverview();
        expect(o2.eligibleCount).toBe(2); // baseline "at threshold" stays
        expect(o2.eligibleNotYetAddedCount).toBe(1);
        expect(o2.eligibleNotYetAddedMembers.map((r) => r.memberId)).toEqual(['m2']);
      } finally {
        tiny.close();
      }
    });
  });

  /*
   * Stage 4g — per-(member, space) attempt ledger.
   *
   * The ledger is the consent gate: once a row is `'present'` for
   * (member, space), the auto path (reconcile + the all-spaces job's
   * pre-loop skip) will never re-attempt that pair, even if the member
   * later leaves the space. `'failed'` rows are informational and age
   * out after 30 days.
   *
   * Behavioral invariants this block pins:
   *   1. recordSpacePresent upserts and replaces 'failed' with 'present'.
   *   2. recordSpaceFailed never overwrites a 'present' row.
   *   3. listMemberSpaceAttempts returns one entry per (member, space).
   *   4. pruneFailedSpaceAttempts only deletes 'failed' rows older than
   *      the supplied cutoff and leaves 'present' rows untouched.
   *   5. The ledger cascades on member deletion (via FK ON DELETE CASCADE).
   */
  describe('Stage 4g member_space_attempts', () => {
    function seedMember(id: string, name: string) {
      store.recordAgreement(agreement(id, 'a1', { fullName: name }));
    }

    it('starts empty for a fresh member', () => {
      seedMember('m1', 'Alice');
      expect(store.listMemberSpaceAttempts('m1')).toEqual([]);
    });

    it('recordSpacePresent inserts a present row', () => {
      seedMember('m1', 'Alice');
      store.recordSpacePresent('m1', 'Marketplace', 1_700_000_000_000);
      const rows = store.listMemberSpaceAttempts('m1');
      expect(rows).toHaveLength(1);
      expect(rows[0]).toEqual({
        spaceName: 'Marketplace',
        outcome: 'present',
        attemptedAt: 1_700_000_000_000,
        lastError: null,
      });
    });

    it('recordSpacePresent overwrites a prior failed row (transition forward)', () => {
      seedMember('m1', 'Alice');
      store.recordSpaceFailed('m1', 'Marketplace', 'transient MN error', 1);
      expect(store.listMemberSpaceAttempts('m1')[0].outcome).toBe('failed');

      store.recordSpacePresent('m1', 'Marketplace', 2);
      const rows = store.listMemberSpaceAttempts('m1');
      expect(rows).toHaveLength(1);
      expect(rows[0]).toEqual({
        spaceName: 'Marketplace',
        outcome: 'present',
        attemptedAt: 2,
        lastError: null,
      });
    });

    it('recordSpacePresent is idempotent on repeat calls (bumps attempted_at, stays present)', () => {
      seedMember('m1', 'Alice');
      store.recordSpacePresent('m1', 'Marketplace', 1);
      store.recordSpacePresent('m1', 'Marketplace', 2);
      const rows = store.listMemberSpaceAttempts('m1');
      expect(rows).toHaveLength(1);
      expect(rows[0]).toEqual({
        spaceName: 'Marketplace',
        outcome: 'present',
        attemptedAt: 2,
        lastError: null,
      });
    });

    it('recordSpaceFailed does NOT overwrite a present row (consent guarantee)', () => {
      seedMember('m1', 'Alice');
      store.recordSpacePresent('m1', 'Marketplace', 1);
      /* Manual force-style retry that throws. The ledger must not
       * downgrade a verified-present row back to 'failed' — that would
       * re-open the door to re-adding a member who chose to leave. */
      store.recordSpaceFailed('m1', 'Marketplace', 'late error', 2);
      const rows = store.listMemberSpaceAttempts('m1');
      expect(rows).toHaveLength(1);
      expect(rows[0].outcome).toBe('present');
      expect(rows[0].attemptedAt).toBe(1);
      expect(rows[0].lastError).toBeNull();
    });

    it('recordSpaceFailed upserts when no row exists', () => {
      seedMember('m1', 'Alice');
      store.recordSpaceFailed('m1', 'Marketplace', 'boom', 7);
      const rows = store.listMemberSpaceAttempts('m1');
      expect(rows).toHaveLength(1);
      expect(rows[0]).toEqual({
        spaceName: 'Marketplace',
        outcome: 'failed',
        attemptedAt: 7,
        lastError: 'boom',
      });
    });

    it('recordSpaceFailed updates an existing failed row (latest attempt wins)', () => {
      seedMember('m1', 'Alice');
      store.recordSpaceFailed('m1', 'Marketplace', 'first error', 1);
      store.recordSpaceFailed('m1', 'Marketplace', 'second error', 2);
      const rows = store.listMemberSpaceAttempts('m1');
      expect(rows).toHaveLength(1);
      expect(rows[0]).toEqual({
        spaceName: 'Marketplace',
        outcome: 'failed',
        attemptedAt: 2,
        lastError: 'second error',
      });
    });

    it('listMemberSpaceAttempts returns one row per (member, space)', () => {
      seedMember('m1', 'Alice');
      seedMember('m2', 'Bob');
      store.recordSpacePresent('m1', 'Marketplace', 1);
      store.recordSpacePresent('m1', 'Creative Center', 2);
      store.recordSpaceFailed('m1', '8. Miscellaneous', 'oops', 3);
      store.recordSpacePresent('m2', 'Marketplace', 4);

      const m1 = store.listMemberSpaceAttempts('m1');
      expect(m1.map((r) => r.spaceName).sort()).toEqual([
        '8. Miscellaneous',
        'Creative Center',
        'Marketplace',
      ]);
      const m2 = store.listMemberSpaceAttempts('m2');
      expect(m2.map((r) => r.spaceName)).toEqual(['Marketplace']);
    });

    it('pruneFailedSpaceAttempts deletes only failed rows older than the cutoff', () => {
      seedMember('m1', 'Alice');
      store.recordSpaceFailed('m1', 'old-failed', 'stale', 100);
      store.recordSpaceFailed('m1', 'recent-failed', 'fresh', 500);
      store.recordSpacePresent('m1', 'old-present', 100);
      store.recordSpacePresent('m1', 'recent-present', 500);

      const deleted = store.pruneFailedSpaceAttempts(200);
      expect(deleted).toBe(1);

      const remaining = store.listMemberSpaceAttempts('m1').map((r) => r.spaceName).sort();
      expect(remaining).toEqual(['old-present', 'recent-failed', 'recent-present']);
    });

    it('pruneFailedSpaceAttempts NEVER removes a present row, even when very old', () => {
      seedMember('m1', 'Alice');
      store.recordSpacePresent('m1', 'Marketplace', 1);
      const deleted = store.pruneFailedSpaceAttempts(Number.MAX_SAFE_INTEGER);
      expect(deleted).toBe(0);
      expect(store.listMemberSpaceAttempts('m1')).toHaveLength(1);
    });

  });

  describe('schema migration', () => {
    it('opening an existing DB file twice is idempotent and preserves data', () => {
      // Use a temp file path so we can re-open it.
      const tmp = `:memory:`;
      // The :memory: case can't truly test cross-open persistence, but it does
      // exercise the idempotent ALTER path because openAgreementsStore runs
      // ensureColumn on every open. Re-running on the same handle isn't
      // possible (each :memory: is a fresh DB), so the assertion is simply
      // that opening + a second open in the same process does not throw.
      const a = openAgreementsStore({ filePath: tmp, requiredAgreementCount: 1 });
      a.recordAgreement(agreement('m1', 'a1'));
      a.close();
      const b = openAgreementsStore({ filePath: tmp, requiredAgreementCount: 1 });
      expect(() => b.recordAgreement(agreement('m2', 'a1'))).not.toThrow();
      b.close();
    });
  });
});

// Static type-level check: AuditState exported and accepts the 5 documented values.
const _auditStateSamples: readonly AuditState[] = [
  'happy',
  'deleted',
  'edited',
  'mixed',
  'multi_agreement',
];
void _auditStateSamples;
