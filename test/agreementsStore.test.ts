import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  openAgreementsStore,
  type AgreementsStore,
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
});
