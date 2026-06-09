import { describe, expect, it } from 'vitest';
import { classifyMemberOnArticle } from '../src/tasks/auditAgreements.js';

/**
 * Stage 4e classifier — pure function, no I/O. The classifier is the only
 * place where the five "change of heart" cases get named. The audit job and
 * the store both consume the AuditState produced here.
 *
 * Spec mapping (project_spec.md Stage 4e):
 *   - "no comment found"                              -> 'deleted'   (case 1)
 *   - "now comment does not match agree regex"        -> 'edited'    (case 2)
 *   - "multiple comment(s) and one or more do not"    -> 'mixed'     (case 3)
 *   - "multiple comment(s) but all match"             -> 'multi_agreement' (case 4)
 *   - implicit happy path: single comment, matches    -> 'happy'     (case 0)
 */
describe('classifyMemberOnArticle', () => {
  it('returns "deleted" when the member has no comments on the article', () => {
    expect(classifyMemberOnArticle([])).toBe('deleted');
  });

  it('returns "happy" for a single comment matching the agreement matcher', () => {
    expect(classifyMemberOnArticle([{ text: 'I agree' }])).toBe('happy');
  });

  it('matches the trailing-period agreement variant', () => {
    expect(classifyMemberOnArticle([{ text: 'I agree.' }])).toBe('happy');
  });

  it('matches case-insensitively and tolerates surrounding whitespace', () => {
    expect(classifyMemberOnArticle([{ text: '  i AGREE  ' }])).toBe('happy');
  });

  it('returns "edited" for a single comment that does not match', () => {
    expect(classifyMemberOnArticle([{ text: 'actually no thanks' }])).toBe('edited');
  });

  it('treats a single empty-string comment as "edited", not "deleted"', () => {
    /* The "deleted" case fires when the audit found NO li at all for this
     * member. An empty li is still a present comment that no longer agrees. */
    expect(classifyMemberOnArticle([{ text: '' }])).toBe('edited');
  });

  it('returns "multi_agreement" when every one of multiple comments matches', () => {
    expect(
      classifyMemberOnArticle([
        { text: 'I agree' },
        { text: 'I agree.' },
        { text: 'i agree' },
      ]),
    ).toBe('multi_agreement');
  });

  it('returns "mixed" when one of multiple comments fails to match', () => {
    expect(
      classifyMemberOnArticle([
        { text: 'I agree' },
        { text: 'wait, I changed my mind' },
      ]),
    ).toBe('mixed');
  });

  it('returns "mixed" when every comment fails to match (still multi-comment)', () => {
    /* Spec case 3 reads "one or more do not match"; "all do not match" is a
     * subset. The state name 'mixed' is fine for both — either way it goes in
     * the admin email. */
    expect(
      classifyMemberOnArticle([
        { text: 'no' },
        { text: 'still no' },
      ]),
    ).toBe('mixed');
  });

  it('uses an injected matcher when supplied (for tests / config swap)', () => {
    /* Verifies the classifier doesn't bake in the production agreement
     * matcher — useful if the threshold language ever shifts
     * community-by-community. */
    const onlyShouty = (s: string): boolean => s === 'I AGREE!!!';
    expect(
      classifyMemberOnArticle(
        [{ text: 'I AGREE!!!' }, { text: 'I AGREE!!!' }],
        onlyShouty,
      ),
    ).toBe('multi_agreement');
    expect(classifyMemberOnArticle([{ text: 'I agree' }], onlyShouty)).toBe('edited');
  });

  /* -----------------------------------------------------------------
   * Loose-matcher fixtures.
   *
   * These pin the production matcher's behaviour through the
   * classifier (the default matcher is plugged in unless tests pass
   * one explicitly). The matcher is Candidate D: a positive "I … agree"
   * or bare "Agreed" shape anchored at end-of-string, vetoed by an
   * explicit "not agree" / "disagree" negation. See
   * src/config/agreements.ts for the contract.
   *
   * Why pin behaviour here rather than in a dedicated matcher test:
   * the contract that matters to the rest of the system is "how does
   * the classifier behave on this text?" — that's what drives audit
   * verdicts and the IMAP auto-add path. Exercising it through the
   * classifier keeps the spec-level intent visible.
   * --------------------------------------------------------------- */
  describe('loose-matcher (production default) verdicts', () => {
    /* Variants the strict regex used to reject but that read as
     * unambiguous agreements. The new matcher must accept them, or
     * Stage 4f forensic noise piles up and the IMAP auto-add path
     * keeps DM'ing people who clearly said yes. */
    it.each([
      ['I agree!'],
      ['i also agree!'],
      ['Yes, I agree.'],
      ['I really agree.'],
      ['I do absolutely agree.'],
      ['Agreed!'],
      ['Agreed.'],
    ])('treats %j as "happy" (accepted loose variant)', (text) => {
      expect(classifyMemberOnArticle([{ text }])).toBe('happy');
    });

    /* Explicit negations must veto regardless of "I … agree" shape.
     * Without the negation veto these would auto-add the member to
     * commons spaces — see the rationale in
     * src/config/agreements.ts above AGREE_NEGATION_PATTERN. */
    it.each([
      ['I do not agree'],
      ['I cannot agree'],
      ['I disagree'],
      ['I disagree.'],
      ['I agree to disagree'],
    ])('treats %j as "edited" (negation vetoes the loose shape)', (text) => {
      expect(classifyMemberOnArticle([{ text }])).toBe('edited');
    });

    /* Comments that lack the closing "agree" / "Agreed" clause are
     * still malformed even if they happen to contain the word
     * "agree" somewhere upstream. Anchoring the shape at end-of-
     * string is what prevents the IMAP poller from auto-adding
     * people whose comment was a hedge or off-topic. */
    it.each([
      ['I agree with point 1 but not 3'],
      ['hi everyone, just lurking'],
      ['Maybe later'],
    ])('treats %j as "edited" (no closing agreement clause)', (text) => {
      expect(classifyMemberOnArticle([{ text }])).toBe('edited');
    });
  });
});
