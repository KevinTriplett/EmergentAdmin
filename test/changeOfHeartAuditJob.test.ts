import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Page } from 'puppeteer';
import {
  buildChangeOfHeartAuditJob,
  type ScrapedComment,
} from '../src/tasks/changeOfHeartAuditJob.js';
import {
  openAgreementsStore,
  type AgreementsStore,
} from '../src/state/agreementsStore.js';
import type { AgreementArticle } from '../src/config/agreements.js';
import type { BrowserJobContext } from '../src/scheduler/taskScheduler.js';

/**
 * Stage 4e audit job tests. The orchestration is what we exercise here
 * (per-member classification, store writes, abort handling, summary shape).
 * The Puppeteer scraping itself is injected as a stub that returns canned
 * `ScrapedComment[]` per article — keeping these tests hermetic and pinning
 * the contract between "page → comments[]" and the rest of the audit.
 */

const ART_A: AgreementArticle = {
  articleId: 'art-A',
  spaceId: 'space-A',
  title: 'Community Agreements',
  url: 'https://emergent-commons.mn.co/posts/art-A',
};
const ART_B: AgreementArticle = {
  articleId: 'art-B',
  spaceId: 'space-B',
  title: 'Other Agreement',
  url: 'https://emergent-commons.mn.co/posts/art-B',
};

const MEMBERS = {
  alice: { memberId: 'm-alice', fullName: 'Alice Adams' },
  bob: { memberId: 'm-bob', fullName: 'Bob Brown' },
  carol: { memberId: 'm-carol', fullName: 'Carol Cole' },
};

function makeCtx(overrides: Partial<BrowserJobContext> = {}): BrowserJobContext {
  return {
    page: {} as unknown as Page,
    log: vi.fn(),
    abortSignal: { aborted: false },
    sleep: () => Promise.resolve(),
    ...overrides,
  };
}

function comment(member: { memberId: string; fullName: string }, text: string, commentId = 'c-1'): ScrapedComment {
  return { commentId, memberId: member.memberId, fullName: member.fullName, text };
}

describe('buildChangeOfHeartAuditJob', () => {
  let store: AgreementsStore;

  beforeEach(() => {
    store = openAgreementsStore({ filePath: ':memory:', requiredAgreementCount: 1 });
  });

  afterEach(() => {
    store.close();
  });

  it('returns 0 anomalies and audits 0 members when the store has no recordings', async () => {
    const job = buildChangeOfHeartAuditJob(store, {
      articles: [ART_A],
      loadAndScrapeArticleComments: async () => [],
    });
    const result = await job.run(makeCtx());

    expect(result.totalAnomalies).toBe(0);
    expect(result.totalMembersAudited).toBe(0);
    expect(result.anomalies).toEqual([]);
    expect(result.articles[0]?.commentsLoaded).toBe(0);
  });

  it('writes audit_state="happy" and produces 0 anomalies when the only member has one matching comment', async () => {
    store.recordAgreement({
      memberId: MEMBERS.alice.memberId,
      fullName: MEMBERS.alice.fullName,
      articleId: ART_A.articleId,
      commentId: 'c-old',
      commentedAt: 1,
      source: 'email',
    });

    const job = buildChangeOfHeartAuditJob(store, {
      articles: [ART_A],
      loadAndScrapeArticleComments: async () => [comment(MEMBERS.alice, 'I agree')],
    });

    const result = await job.run(makeCtx());

    expect(result.totalAnomalies).toBe(0);
    expect(result.totalMembersAudited).toBe(1);
    expect(store.getAuditState(MEMBERS.alice.memberId, ART_A.articleId)).toBe('happy');
  });

  it('writes audit_state="deleted" and reports anomaly when the member has no comment on the page', async () => {
    store.recordAgreement({
      memberId: MEMBERS.alice.memberId,
      fullName: MEMBERS.alice.fullName,
      articleId: ART_A.articleId,
      commentId: 'c-old',
      commentedAt: 1,
      source: 'email',
    });

    const job = buildChangeOfHeartAuditJob(store, {
      articles: [ART_A],
      loadAndScrapeArticleComments: async () => [comment(MEMBERS.bob, 'I agree')],
    });

    const result = await job.run(makeCtx());

    expect(store.getAuditState(MEMBERS.alice.memberId, ART_A.articleId)).toBe('deleted');
    expect(result.totalAnomalies).toBe(1);
    const a = result.anomalies[0]!;
    expect(a.memberId).toBe(MEMBERS.alice.memberId);
    expect(a.articleId).toBe(ART_A.articleId);
    expect(a.state).toBe('deleted');
    expect(a.articleUrl).toBe(ART_A.url);
    expect(a.sampleNonMatchingText).toEqual([]);
  });

  it('writes audit_state="edited" and surfaces the non-matching text for forensics', async () => {
    store.recordAgreement({
      memberId: MEMBERS.alice.memberId,
      fullName: MEMBERS.alice.fullName,
      articleId: ART_A.articleId,
      commentId: 'c-old',
      commentedAt: 1,
      source: 'email',
    });

    const job = buildChangeOfHeartAuditJob(store, {
      articles: [ART_A],
      loadAndScrapeArticleComments: async () => [
        comment(MEMBERS.alice, 'actually no thanks'),
      ],
    });

    const result = await job.run(makeCtx());

    expect(store.getAuditState(MEMBERS.alice.memberId, ART_A.articleId)).toBe('edited');
    expect(result.totalAnomalies).toBe(1);
    const a = result.anomalies[0]!;
    expect(a.state).toBe('edited');
    expect(a.sampleNonMatchingText).toEqual(['actually no thanks']);
  });

  it('writes audit_state="multi_agreement" and 0 anomalies when all of multiple comments match', async () => {
    store.recordAgreement({
      memberId: MEMBERS.alice.memberId,
      fullName: MEMBERS.alice.fullName,
      articleId: ART_A.articleId,
      commentId: 'c-old',
      commentedAt: 1,
      source: 'email',
    });

    const job = buildChangeOfHeartAuditJob(store, {
      articles: [ART_A],
      loadAndScrapeArticleComments: async () => [
        comment(MEMBERS.alice, 'I agree', 'c1'),
        comment(MEMBERS.alice, 'I agree.', 'c2'),
      ],
    });

    const result = await job.run(makeCtx());

    expect(store.getAuditState(MEMBERS.alice.memberId, ART_A.articleId)).toBe('multi_agreement');
    expect(result.totalAnomalies).toBe(0);
  });

  it('logs a diagnostic line for each multi_agreement member naming the member, commentIds, and texts (so manual triage can spot scraper artifacts vs real duplicates)', async () => {
    /* Why this test exists: when the audit reports "1 multi-agreement"
     * but the operator can't see two "I agree" comments on the page,
     * the only way to triage is to know WHICH member triggered it and
     * WHAT their scraped comments looked like. Without this log line
     * the operator has to crack the SQLite store open. */
    store.recordAgreement({
      memberId: MEMBERS.alice.memberId,
      fullName: MEMBERS.alice.fullName,
      articleId: ART_A.articleId,
      commentId: 'c-old',
      commentedAt: 1,
      source: 'email',
    });

    const log = vi.fn();
    const job = buildChangeOfHeartAuditJob(store, {
      articles: [ART_A],
      loadAndScrapeArticleComments: async () => [
        comment(MEMBERS.alice, 'I agree', 'c-aa'),
        comment(MEMBERS.alice, 'I agree.', 'c-bb'),
      ],
    });

    await job.run(makeCtx({ log }));

    const lines = log.mock.calls.map((c) => String(c[0]));
    const diag = lines.find((l) => l.includes('MULTI_AGREEMENT') && l.includes(MEMBERS.alice.fullName));
    expect(diag, `expected a MULTI_AGREEMENT diagnostic line; got:\n${lines.join('\n')}`).toBeDefined();
    /* The diagnostic must surface enough to triage: member id + each
     * scraped commentId + each text snippet. Loose assertions so we
     * don't pin exact formatting. */
    expect(diag).toContain(MEMBERS.alice.memberId);
    expect(diag).toContain('c-aa');
    expect(diag).toContain('c-bb');
    expect(diag).toContain('I agree');
  });

  it('treats duplicate commentIds in the scrape as a single comment so MN UI artifacts cannot fake multi_agreement', async () => {
    /* MN sometimes renders the same comment in two DOM places (e.g.
     * a top-level + reply view). Verified live (May 2026): both
     * Kai and Sigurd were flagged multi_agreement when their two
     * scraped rows shared a commentId. Dedup-by-commentId before
     * classification kills the false positive. First occurrence
     * wins per Kevin's choice. */
    store.recordAgreement({
      memberId: MEMBERS.alice.memberId,
      fullName: MEMBERS.alice.fullName,
      articleId: ART_A.articleId,
      commentId: 'c-old',
      commentedAt: 1,
      source: 'email',
    });

    const log = vi.fn();
    const job = buildChangeOfHeartAuditJob(store, {
      articles: [ART_A],
      loadAndScrapeArticleComments: async () => [
        comment(MEMBERS.alice, 'I agree', 'c-dup'),
        comment(MEMBERS.alice, 'I agree', 'c-dup'),
      ],
    });

    const result = await job.run(makeCtx({ log }));

    expect(store.getAuditState(MEMBERS.alice.memberId, ART_A.articleId)).toBe('happy');
    expect(result.totalAnomalies).toBe(0);
    /* Quiet dedup per Kevin: the operator should NOT see a noisy
     * "duplicate commentId" line on every run. The dedup is silent;
     * only the verdict ("happy") is visible. */
    const lines = log.mock.calls.map((c) => String(c[0]));
    const noisyDupLine = lines.find((l) => /duplicate.*commentId/i.test(l));
    expect(noisyDupLine, `dedup must be silent; got noisy line:\n${noisyDupLine}`).toBeUndefined();
    /* And no MULTI_AGREEMENT diagnostic should fire either, since
     * after dedup there's only one comment. */
    const multiLine = lines.find((l) => l.includes('MULTI_AGREEMENT'));
    expect(multiLine).toBeUndefined();
  });

  it('preserves the FIRST occurrence text when deduping (first-wins, defensive against later rows with truncated/different text)', async () => {
    /* If two scrape rows share a commentId but disagree on text,
     * the first-wins rule means classification keys off the first
     * row's text. This pins behaviour explicitly so a future change
     * (e.g. switch to longest-text) is a deliberate decision. */
    store.recordAgreement({
      memberId: MEMBERS.alice.memberId,
      fullName: MEMBERS.alice.fullName,
      articleId: ART_A.articleId,
      commentId: 'c-old',
      commentedAt: 1,
      source: 'email',
    });

    const job = buildChangeOfHeartAuditJob(store, {
      articles: [ART_A],
      loadAndScrapeArticleComments: async () => [
        comment(MEMBERS.alice, 'I agree', 'c-dup'),
        comment(MEMBERS.alice, 'something else entirely', 'c-dup'),
      ],
    });

    await job.run(makeCtx());

    /* First row was a match → classifier saw a single matching comment → happy. */
    expect(store.getAuditState(MEMBERS.alice.memberId, ART_A.articleId)).toBe('happy');
  });

  it('preserves rows with no commentId rather than collapsing them (defensive: empty id is not a stable key)', async () => {
    /* If MN's DOM ever renders a comment without `data-detail-comment`
     * we'd get an empty commentId. Dedup must NOT collapse multiple
     * such rows — they could be distinct comments. Keep them all. */
    store.recordAgreement({
      memberId: MEMBERS.alice.memberId,
      fullName: MEMBERS.alice.fullName,
      articleId: ART_A.articleId,
      commentId: 'c-old',
      commentedAt: 1,
      source: 'email',
    });

    const job = buildChangeOfHeartAuditJob(store, {
      articles: [ART_A],
      loadAndScrapeArticleComments: async () => [
        comment(MEMBERS.alice, 'I agree', ''),
        comment(MEMBERS.alice, 'I agree', ''),
      ],
    });

    await job.run(makeCtx());

    /* Two rows with empty id, both matching → classifier sees 2 → multi_agreement. */
    expect(store.getAuditState(MEMBERS.alice.memberId, ART_A.articleId)).toBe('multi_agreement');
  });

  it('writes audit_state="mixed" and reports anomaly with non-matching samples when some comments fail to match', async () => {
    store.recordAgreement({
      memberId: MEMBERS.alice.memberId,
      fullName: MEMBERS.alice.fullName,
      articleId: ART_A.articleId,
      commentId: 'c-old',
      commentedAt: 1,
      source: 'email',
    });

    const job = buildChangeOfHeartAuditJob(store, {
      articles: [ART_A],
      loadAndScrapeArticleComments: async () => [
        comment(MEMBERS.alice, 'I agree', 'c1'),
        comment(MEMBERS.alice, 'wait, no', 'c2'),
        comment(MEMBERS.alice, 'still no', 'c3'),
      ],
    });

    const result = await job.run(makeCtx());

    expect(store.getAuditState(MEMBERS.alice.memberId, ART_A.articleId)).toBe('mixed');
    expect(result.totalAnomalies).toBe(1);
    expect(result.anomalies[0]!.state).toBe('mixed');
    expect(result.anomalies[0]!.sampleNonMatchingText).toEqual(['wait, no', 'still no']);
  });

  it('aggregates results across multiple articles', async () => {
    // Alice agreed to A and B; Bob only to A.
    for (const article of [ART_A, ART_B]) {
      store.recordAgreement({
        memberId: MEMBERS.alice.memberId,
        fullName: MEMBERS.alice.fullName,
        articleId: article.articleId,
        commentId: 'c-old',
        commentedAt: 1,
        source: 'email',
      });
    }
    store.recordAgreement({
      memberId: MEMBERS.bob.memberId,
      fullName: MEMBERS.bob.fullName,
      articleId: ART_A.articleId,
      commentId: 'c-old',
      commentedAt: 1,
      source: 'email',
    });

    const job = buildChangeOfHeartAuditJob(store, {
      articles: [ART_A, ART_B],
      loadAndScrapeArticleComments: async (_p, articleId) => {
        if (articleId === ART_A.articleId) {
          /* Alice deletes on A, Bob still agrees on A. */
          return [comment(MEMBERS.bob, 'I agree')];
        }
        // ART_B: Alice still agrees.
        return [comment(MEMBERS.alice, 'I agree')];
      },
    });

    const result = await job.run(makeCtx());

    expect(result.articles).toHaveLength(2);
    expect(result.totalMembersAudited).toBe(3); // (alice@A, bob@A, alice@B)
    expect(result.totalAnomalies).toBe(1);
    expect(result.anomalies[0]!.memberId).toBe(MEMBERS.alice.memberId);
    expect(result.anomalies[0]!.articleId).toBe(ART_A.articleId);
    expect(result.anomalies[0]!.state).toBe('deleted');

    expect(store.getAuditState(MEMBERS.alice.memberId, ART_A.articleId)).toBe('deleted');
    expect(store.getAuditState(MEMBERS.alice.memberId, ART_B.articleId)).toBe('happy');
    expect(store.getAuditState(MEMBERS.bob.memberId, ART_A.articleId)).toBe('happy');
  });

  it('respects the abort signal between articles and stops processing further articles', async () => {
    store.recordAgreement({
      memberId: MEMBERS.alice.memberId,
      fullName: MEMBERS.alice.fullName,
      articleId: ART_A.articleId,
      commentId: 'c1',
      commentedAt: 1,
      source: 'email',
    });
    store.recordAgreement({
      memberId: MEMBERS.alice.memberId,
      fullName: MEMBERS.alice.fullName,
      articleId: ART_B.articleId,
      commentId: 'c2',
      commentedAt: 1,
      source: 'email',
    });

    const abortSignal = { aborted: false };
    const scrape = vi.fn(async (_p: Page, articleId: string) => {
      if (articleId === ART_A.articleId) {
        // Trip the abort flag *after* the first article's scrape completes.
        abortSignal.aborted = true;
        return [comment(MEMBERS.alice, 'I agree')];
      }
      throw new Error('should never reach the second article after abort');
    });

    const job = buildChangeOfHeartAuditJob(store, {
      articles: [ART_A, ART_B],
      loadAndScrapeArticleComments: scrape,
    });

    const result = await job.run(makeCtx({ abortSignal }));

    expect(scrape).toHaveBeenCalledTimes(1);
    expect(result.articles).toHaveLength(1);
    /* art-B never audited, so audit_state for that pair should still be NULL. */
    expect(store.getAuditState(MEMBERS.alice.memberId, ART_B.articleId)).toBeNull();
  });

  it('summarize() reports "0 anomalies — all clear" when nothing flagged', async () => {
    const job = buildChangeOfHeartAuditJob(store, {
      articles: [ART_A],
      loadAndScrapeArticleComments: async () => [],
    });
    const result = await job.run(makeCtx());
    expect(job.summarize(result)).toMatch(/0 anomalies — all clear/);
  });

  it('summarize() lists anomalous members and their case when there are anomalies', async () => {
    store.recordAgreement({
      memberId: MEMBERS.alice.memberId,
      fullName: MEMBERS.alice.fullName,
      articleId: ART_A.articleId,
      commentId: 'c1',
      commentedAt: 1,
      source: 'email',
    });
    store.recordAgreement({
      memberId: MEMBERS.bob.memberId,
      fullName: MEMBERS.bob.fullName,
      articleId: ART_A.articleId,
      commentId: 'c2',
      commentedAt: 1,
      source: 'email',
    });

    const job = buildChangeOfHeartAuditJob(store, {
      articles: [ART_A],
      loadAndScrapeArticleComments: async () => [
        comment(MEMBERS.bob, 'I disagree'),
      ],
    });
    const result = await job.run(makeCtx());

    const summary = job.summarize(result);
    expect(summary).toMatch(/2 anomalies/);
    expect(summary).toContain(MEMBERS.alice.fullName);
    expect(summary).toContain('deleted');
    expect(summary).toContain(MEMBERS.bob.fullName);
    expect(summary).toContain('edited');
  });

  describe('htmlBody (admin email)', () => {
    /**
     * Anomaly anchors point at the member's MOST-RECENT current comment
     * on the article (MN's per-comment deep link), or the article URL
     * itself when no current comment exists (the 'deleted' state). The
     * operator lands directly on the evidence; from there MN's comment
     * view exposes the author's profile / DM in one more click.
     * Replaces the legacy `chats/new?user_id=` pattern, which dropped
     * the operator into a blank DM screen with no context.
     */
    it('anchors each anomalous member name to their most-recent comment on the article', async () => {
      store.recordAgreement({
        memberId: '17557698',
        fullName: 'Alice Adams',
        articleId: ART_A.articleId,
        commentId: 'c1',
        commentedAt: 1,
        source: 'email',
      });
      store.recordAgreement({
        memberId: '17557699',
        fullName: 'Bob Brown',
        articleId: ART_A.articleId,
        commentId: 'c2',
        commentedAt: 1,
        source: 'email',
      });

      const job = buildChangeOfHeartAuditJob(store, {
        articles: [ART_A],
        loadAndScrapeArticleComments: async () => [
          { commentId: 'c-bob', memberId: '17557699', fullName: 'Bob Brown', text: 'I disagree' },
        ],
      });

      const result = await job.run(makeCtx());
      const html = job.htmlBody!(result);

      /* Bob's current comment is c-bob (state='edited') → anchor to
       * that comment's deep link. */
      expect(html).toContain(
        `<a href="https://emergent-commons.mn.co/posts/${ART_A.articleId}/comments/c-bob">Bob Brown</a>`,
      );
      /* Alice has no current comment (state='deleted') → fall back to
       * the article URL since the original comment is gone. */
      expect(html).toContain(`<a href="${ART_A.url}">Alice Adams</a>`);
      expect(html).toContain('deleted');
      expect(html).toContain('edited');
      /* And no chats/new URL anywhere — that's the legacy pattern we
       * replaced. */
      expect(html).not.toContain('chats/new');
    });

    it('renders an "all clear" fragment when there are zero anomalies', async () => {
      const job = buildChangeOfHeartAuditJob(store, {
        articles: [ART_A],
        loadAndScrapeArticleComments: async () => [],
      });
      const result = await job.run(makeCtx());
      const html = job.htmlBody!(result);

      expect(html).toMatch(/all clear/i);
      expect(html).not.toContain('chats/new');
    });

    it('escapes member full names that contain HTML-special characters', async () => {
      /* MN doesn't allow tags in display names today, but defensive escaping
       * is cheap and protects the admin's mail client from anything weird
       * the future might throw at it (e.g. emoji, Unicode quirks). */
      store.recordAgreement({
        memberId: '17557700',
        fullName: 'Mallory <script>alert(1)</script>',
        articleId: ART_A.articleId,
        commentId: 'c-old',
        commentedAt: 1,
        source: 'email',
      });

      const job = buildChangeOfHeartAuditJob(store, {
        articles: [ART_A],
        loadAndScrapeArticleComments: async () => [],
      });
      const result = await job.run(makeCtx());
      const html = job.htmlBody!(result);

      expect(html).not.toContain('<script>alert(1)</script>');
      expect(html).toContain('Mallory &lt;script&gt;alert(1)&lt;/script&gt;');
    });

    it('falls back to the article URL when the anomalous member has no current comment', async () => {
      /* Pure 'deleted' regression: member is in the store but has no
       * comments on the page. The anchor can't deep-link to a comment
       * that doesn't exist, so it lands on the article instead — still
       * actionable (the admin can scroll the comments for context),
       * never broken (no 404 from a stale comment id). */
      store.recordAgreement({
        memberId: 'm-edge',
        fullName: 'Edge Case',
        articleId: ART_A.articleId,
        commentId: 'c-original-gone',
        commentedAt: 1,
        source: 'email',
      });

      const job = buildChangeOfHeartAuditJob(store, {
        articles: [ART_A],
        loadAndScrapeArticleComments: async () => [],
      });
      const result = await job.run(makeCtx());
      const html = job.htmlBody!(result);

      expect(result.anomalies[0]?.commentUrl).toBe(ART_A.url);
      expect(html).toContain(`<a href="${ART_A.url}">Edge Case</a>`);
    });

    it('links each anomaly back to the article it was found on', async () => {
      store.recordAgreement({
        memberId: 'm1',
        fullName: 'M1',
        articleId: ART_A.articleId,
        commentId: 'c1',
        commentedAt: 1,
        source: 'email',
      });

      const job = buildChangeOfHeartAuditJob(store, {
        articles: [ART_A],
        loadAndScrapeArticleComments: async () => [],
      });
      const result = await job.run(makeCtx());
      const html = job.htmlBody!(result);

      expect(html).toContain(`href="${ART_A.url}"`);
    });
  });

  it('skips writing audit_state for a member who has no row for the article (defensive)', async () => {
    /* listMembersForArticle drives the iteration, so a stranger commenter on
     * the page who isn't in our table for this article should be ignored —
     * not promoted, not flagged, not written. */
    const job = buildChangeOfHeartAuditJob(store, {
      articles: [ART_A],
      loadAndScrapeArticleComments: async () => [comment(MEMBERS.carol, 'random')],
    });

    const result = await job.run(makeCtx());

    expect(result.totalMembersAudited).toBe(0);
    expect(result.totalAnomalies).toBe(0);
    expect(store.getAuditState(MEMBERS.carol.memberId, ART_A.articleId)).toBeNull();
  });

  /* -----------------------------------------------------------------
   * Stage 4f — Audit Anomalies (non-matching comments)
   *
   * The spec calls this out separately from the change-of-heart
   * cases: "As part of the daily audit run, I need to know if any
   * comments do not fit the 'I agree' regex with a link back to the
   * comment. List these in the interface along with all other
   * anomalies, for check up."
   *
   * The forensic list is page-scoped (every non-matching comment
   * on every agreement post), NOT store-scoped — so a comment
   * from a member who never recorded an agreement still surfaces.
   * Each entry carries a `url` field with the deep-link MN uses
   * for individual comments (`/posts/{articleId}/comments/{commentId}`)
   * so the operator can one-click into the offending comment.
   * --------------------------------------------------------------- */
  describe('Stage 4f — non-matching comments list', () => {
    it('omits agreement comments and includes only non-matching ones', async () => {
      const job = buildChangeOfHeartAuditJob(store, {
        articles: [ART_A],
        loadAndScrapeArticleComments: async () => [
          comment(MEMBERS.alice, 'I agree', 'c-1'),
          comment(MEMBERS.bob, 'I agree.', 'c-2'),
          comment(MEMBERS.carol, 'Wait — what about clause 3?', 'c-3'),
        ],
      });

      const result = await job.run(makeCtx());

      expect(result.totalNonMatchingComments).toBe(1);
      expect(result.nonMatchingComments).toHaveLength(1);
      expect(result.nonMatchingComments[0]!.memberId).toBe(MEMBERS.carol.memberId);
      expect(result.nonMatchingComments[0]!.fullName).toBe(MEMBERS.carol.fullName);
      expect(result.nonMatchingComments[0]!.text).toBe('Wait — what about clause 3?');
    });

    it('includes non-matching comments from commenters who have no agreements row (page-scoped, not store-scoped)', async () => {
      /* Carol has NEVER recorded an agreement (store is empty). Her
       * stray non-matching comment still surfaces — that's the whole
       * point of Stage 4f's forensic list. */
      const job = buildChangeOfHeartAuditJob(store, {
        articles: [ART_A],
        loadAndScrapeArticleComments: async () => [
          comment(MEMBERS.carol, 'hi everyone, just lurking', 'c-stray'),
        ],
      });

      const result = await job.run(makeCtx());

      /* No store-scoped anomaly (Carol has no row to downgrade)... */
      expect(result.totalAnomalies).toBe(0);
      /* ...but the comment still shows up in the forensic list. */
      expect(result.totalNonMatchingComments).toBe(1);
      expect(result.nonMatchingComments[0]!.memberId).toBe(MEMBERS.carol.memberId);
    });

    it('builds a clickable comment URL of the form /posts/{articleId}/comments/{commentId}', async () => {
      const job = buildChangeOfHeartAuditJob(store, {
        articles: [ART_A],
        loadAndScrapeArticleComments: async () => [
          comment(MEMBERS.carol, 'no thanks', 'c-xyz'),
        ],
      });

      const result = await job.run(makeCtx());

      expect(result.nonMatchingComments[0]!.url).toBe(
        'https://emergent-commons.mn.co/posts/art-A/comments/c-xyz',
      );
    });

    it('falls back to the post URL when commentId is empty (defensive)', async () => {
      /* MN's DOM has always rendered `data-detail-comment`, but if it
       * ever stops doing so we still want a clickable URL — landing
       * on the article is better than an unclickable list entry. */
      const job = buildChangeOfHeartAuditJob(store, {
        articles: [ART_A],
        loadAndScrapeArticleComments: async () => [
          comment(MEMBERS.carol, 'no comment id here', ''),
        ],
      });

      const result = await job.run(makeCtx());

      expect(result.nonMatchingComments[0]!.url).toBe(ART_A.url);
    });

    it('truncates long comment text the same way anomaly samples are truncated', async () => {
      const longText = 'x'.repeat(500);
      const job = buildChangeOfHeartAuditJob(store, {
        articles: [ART_A],
        loadAndScrapeArticleComments: async () => [
          comment(MEMBERS.carol, longText, 'c-long'),
        ],
      });

      const result = await job.run(makeCtx());

      /* SAMPLE_TEXT_TRUNCATE = 200 → 199 chars + '…' = 200 total. */
      expect(result.nonMatchingComments[0]!.text.length).toBe(200);
      expect(result.nonMatchingComments[0]!.text.endsWith('…')).toBe(true);
    });

    it('respects the silent dedupe-by-commentId so MN UI artifacts do not double-count non-matching rows', async () => {
      /* Same dedup that protects the multi_agreement classifier
       * (verified live May 2026 — MN sometimes renders the same
       * logical comment twice). The forensic list must use the
       * deduped set too, otherwise a single off-topic comment shows
       * up as two entries to chase. */
      const job = buildChangeOfHeartAuditJob(store, {
        articles: [ART_A],
        loadAndScrapeArticleComments: async () => [
          comment(MEMBERS.carol, 'no thanks', 'c-dup'),
          comment(MEMBERS.carol, 'no thanks', 'c-dup'),
        ],
      });

      const result = await job.run(makeCtx());

      expect(result.totalNonMatchingComments).toBe(1);
    });

    it('aggregates non-matching comments across articles', async () => {
      const job = buildChangeOfHeartAuditJob(store, {
        articles: [ART_A, ART_B],
        loadAndScrapeArticleComments: async (_p, articleId) => {
          if (articleId === ART_A.articleId) {
            return [comment(MEMBERS.alice, 'I disagree', 'a-1')];
          }
          return [
            comment(MEMBERS.bob, 'maybe later', 'b-1'),
            comment(MEMBERS.carol, 'I agree', 'b-2'),
          ];
        },
      });

      const result = await job.run(makeCtx());

      expect(result.totalNonMatchingComments).toBe(2);
      const byArticle = result.nonMatchingComments.map((c) => c.articleId).sort();
      expect(byArticle).toEqual(['art-A', 'art-B']);
      /* Per-article tally agrees with the aggregate. */
      const articleA = result.articles.find((a) => a.articleId === ART_A.articleId)!;
      const articleB = result.articles.find((a) => a.articleId === ART_B.articleId)!;
      expect(articleA.nonMatchingComments).toHaveLength(1);
      expect(articleB.nonMatchingComments).toHaveLength(1);
    });

    it('summarize() appends a non-matching-comment tail to "all clear" runs', async () => {
      /* Even when nobody has changed their mind, the operator wants to
       * see in the subject line that there are N off-topic comments to
       * triage. */
      const job = buildChangeOfHeartAuditJob(store, {
        articles: [ART_A],
        loadAndScrapeArticleComments: async () => [
          comment(MEMBERS.carol, 'random thought', 'c-1'),
        ],
      });

      const result = await job.run(makeCtx());

      const summary = job.summarize(result);
      expect(summary).toMatch(/all clear/);
      expect(summary).toContain('(+1 non-matching comment)');
    });

    it('summarize() appends a non-matching-comment tail to the anomaly list', async () => {
      store.recordAgreement({
        memberId: MEMBERS.alice.memberId,
        fullName: MEMBERS.alice.fullName,
        articleId: ART_A.articleId,
        commentId: 'c-old',
        commentedAt: 1,
        source: 'email',
      });

      const job = buildChangeOfHeartAuditJob(store, {
        articles: [ART_A],
        loadAndScrapeArticleComments: async () => [
          comment(MEMBERS.alice, 'changed my mind', 'c-1'),
          comment(MEMBERS.carol, 'random', 'c-2'),
        ],
      });

      const result = await job.run(makeCtx());

      const summary = job.summarize(result);
      /* "1 anomaly: ..." — the singular/plural is exercised
       * elsewhere; here we care that the non-matching tail rides
       * along after the change-of-heart payload. */
      expect(summary).toMatch(/^1 anomaly:/);
      expect(summary).toMatch(/\(\+2 non-matching comments\)$/);
    });

    it('htmlBody renders a "Non-matching comments" section with a clickable link per comment', async () => {
      const job = buildChangeOfHeartAuditJob(store, {
        articles: [ART_A],
        loadAndScrapeArticleComments: async () => [
          comment(MEMBERS.carol, 'wait, no', 'c-xyz'),
        ],
      });

      const result = await job.run(makeCtx());
      const html = job.htmlBody!(result);

      expect(html).toMatch(/Non-matching comments/);
      expect(html).toContain(
        '<a href="https://emergent-commons.mn.co/posts/art-A/comments/c-xyz">Carol Cole</a>',
      );
      /* The comment text is included as the forensic sample so the
       * admin can decide whether to follow the link. */
      expect(html).toContain('wait, no');
    });

    it('htmlBody omits the Non-matching comments section entirely when the list is empty', async () => {
      const job = buildChangeOfHeartAuditJob(store, {
        articles: [ART_A],
        loadAndScrapeArticleComments: async () => [],
      });

      const result = await job.run(makeCtx());
      const html = job.htmlBody!(result);

      expect(html).not.toMatch(/Non-matching comments/);
    });

    it('htmlBody renders the Non-matching section alongside the anomaly list when both are populated', async () => {
      /* Both lists coexist in the same email and the same UI panel —
       * the spec calls Stage 4f a list "along with all other
       * anomalies", so neither suppresses the other. */
      store.recordAgreement({
        memberId: MEMBERS.alice.memberId,
        fullName: MEMBERS.alice.fullName,
        articleId: ART_A.articleId,
        commentId: 'c-old',
        commentedAt: 1,
        source: 'email',
      });

      const job = buildChangeOfHeartAuditJob(store, {
        articles: [ART_A],
        loadAndScrapeArticleComments: async () => [
          comment(MEMBERS.alice, 'changed my mind', 'c-alice'),
          comment(MEMBERS.carol, 'unrelated', 'c-carol'),
        ],
      });

      const result = await job.run(makeCtx());
      const html = job.htmlBody!(result);

      /* Anomaly side: Alice's anchor lands on her most-recent current
       * comment (c-alice). */
      expect(html).toContain('/posts/art-A/comments/c-alice');
      /* Stage 4f side: Carol via the non-matching forensic list link. */
      expect(html).toContain('/posts/art-A/comments/c-carol');
      /* Sanity: no remaining chats/new URLs anywhere. */
      expect(html).not.toContain('chats/new');
    });

    /* -----------------------------------------------------------------
     * Stage 4f extension — newly-eligible promotion + added-to-commons
     * anomaly queue.
     *
     * The audit now does two extra things on top of classifying members
     * who already have an `agreements` row:
     *
     *   1. For every commenter on the page who does NOT have an
     *      agreements row for the article, look at their most recent
     *      comment (by `commentId`, which MN issues monotonically). If
     *      it matches the loose agreement matcher, the audit records
     *      an agreement on their behalf — so the "i also agree!" case
     *      the strict regex used to ignore stops being invisible.
     *      Tracked in `newlyEligibleMembers` / `totalNewlyEligibleMembers`.
     *
     *   2. From the change-of-heart anomalies, filter out the ones whose
     *      member is already `commons_added_at IS NOT NULL` — those are
     *      the "Added to Commons, now anomaly, need to DM" queue and
     *      drive a new email + dashboard section.
     *
     * These tests pin behaviour through the orchestrator with a real
     * in-memory store so the recordAgreement / recordAuditOutcome calls
     * are exercised end-to-end.
     * --------------------------------------------------------------- */
    it('promotes a non-store commenter whose latest comment matches the agreement matcher', async () => {
      /* Carol has never appeared in the store. Her one comment is the
       * loose-matcher case ("i also agree!") the strict era ignored.
       * After the audit she should have an agreement row recorded,
       * and the result should surface her as newlyEligible. */
      const job = buildChangeOfHeartAuditJob(store, {
        articles: [ART_A],
        loadAndScrapeArticleComments: async () => [
          comment(MEMBERS.carol, 'i also agree!', 'c-late'),
        ],
      });

      const result = await job.run(makeCtx());

      expect(result.totalNewlyEligibleMembers).toBe(1);
      expect(result.newlyEligibleMembers).toHaveLength(1);
      const ne = result.newlyEligibleMembers[0]!;
      expect(ne.memberId).toBe(MEMBERS.carol.memberId);
      expect(ne.articleId).toBe(ART_A.articleId);
      expect(ne.commentId).toBe('c-late');
      /* The audit must actually record the agreement, not just report
       * it — otherwise the dashboard won't pick her up. */
      expect(store.countAgreements(MEMBERS.carol.memberId)).toBe(1);
      expect(store.getAuditState(MEMBERS.carol.memberId, ART_A.articleId)).toBe('happy');
      /* Promoted commenter is NOT in the non-matching forensic list
       * since their comment matches. */
      expect(result.totalNonMatchingComments).toBe(0);
    });

    it('does NOT promote a commenter whose latest comment is a non-agreement (even if an older one matched)', async () => {
      /* Per the operator's note: "the date of their comment ...
       * indicates if they should be added if they first disagreed and
       * now are agreeing." The converse is also true — if they
       * earlier agreed but later changed their mind, don't promote.
       * Sort key is commentId; '900' < '1000', so the disagreement
       * is the more recent comment. */
      const job = buildChangeOfHeartAuditJob(store, {
        articles: [ART_A],
        loadAndScrapeArticleComments: async () => [
          comment(MEMBERS.carol, 'I agree', '900'),
          comment(MEMBERS.carol, 'I do not agree any more', '1000'),
        ],
      });

      const result = await job.run(makeCtx());

      expect(result.totalNewlyEligibleMembers).toBe(0);
      expect(store.countAgreements(MEMBERS.carol.memberId)).toBe(0);
      /* The non-matching comment is still surfaced in the forensic
       * list because its text fails the matcher. */
      expect(result.totalNonMatchingComments).toBeGreaterThanOrEqual(1);
    });

    it('promotes a commenter who first disagreed and then agreed (latest-comment-wins by commentId)', async () => {
      /* Mirror image of the previous test: '900' is the old
       * disagreement, '1000' is the new agreement. The audit
       * should treat them as currently agreeing. */
      const job = buildChangeOfHeartAuditJob(store, {
        articles: [ART_A],
        loadAndScrapeArticleComments: async () => [
          comment(MEMBERS.carol, 'I disagree, sorry', '900'),
          comment(MEMBERS.carol, 'I agree.', '1000'),
        ],
      });

      const result = await job.run(makeCtx());

      expect(result.totalNewlyEligibleMembers).toBe(1);
      expect(store.countAgreements(MEMBERS.carol.memberId)).toBe(1);
      expect(result.newlyEligibleMembers[0]!.commentId).toBe('1000');
    });

    it('does NOT promote a commenter whose latest (and only) comment is a non-agreement', async () => {
      const job = buildChangeOfHeartAuditJob(store, {
        articles: [ART_A],
        loadAndScrapeArticleComments: async () => [
          comment(MEMBERS.carol, 'hi everyone, just lurking', 'c-1'),
        ],
      });

      const result = await job.run(makeCtx());

      expect(result.totalNewlyEligibleMembers).toBe(0);
      expect(store.countAgreements(MEMBERS.carol.memberId)).toBe(0);
    });

    it('does NOT re-promote a member who already has a row (existing-member path classifies them instead)', async () => {
      /* Once a member is in the store the audit's pre-existing
       * classification path owns them — they go through
       * classifyMemberOnArticle and don't fall into the
       * newly-eligible promotion loop. */
      store.recordAgreement({
        memberId: MEMBERS.alice.memberId,
        fullName: MEMBERS.alice.fullName,
        articleId: ART_A.articleId,
        commentId: 'c-old',
        commentedAt: 1,
        source: 'email',
      });

      const job = buildChangeOfHeartAuditJob(store, {
        articles: [ART_A],
        loadAndScrapeArticleComments: async () => [
          comment(MEMBERS.alice, 'I agree', 'c-new'),
        ],
      });

      const result = await job.run(makeCtx());

      expect(result.totalNewlyEligibleMembers).toBe(0);
      /* And classified as happy via the regular path. */
      expect(store.getAuditState(MEMBERS.alice.memberId, ART_A.articleId)).toBe('happy');
    });

    it('newly-promoted member becomes eligible-not-yet-added in the overview', async () => {
      /* End-to-end: after the audit promotes Carol, the dashboard's
       * "Eligible, not yet added to Commons" panel should see her. */
      const job = buildChangeOfHeartAuditJob(store, {
        articles: [ART_A],
        loadAndScrapeArticleComments: async () => [
          comment(MEMBERS.carol, 'I agree.', 'c-1'),
        ],
      });

      await job.run(makeCtx());

      const overview = store.getAgreementsOverview();
      const memberIds = overview.eligibleNotYetAddedMembers.map((m) => m.memberId);
      expect(memberIds).toContain(MEMBERS.carol.memberId);
    });

    it('aggregates newly-eligible members across articles', async () => {
      const job = buildChangeOfHeartAuditJob(store, {
        articles: [ART_A, ART_B],
        loadAndScrapeArticleComments: async (_p, articleId) => {
          if (articleId === ART_A.articleId) {
            return [comment(MEMBERS.alice, 'I agree!', 'a-1')];
          }
          return [comment(MEMBERS.bob, 'i also agree!', 'b-1')];
        },
      });

      const result = await job.run(makeCtx());

      expect(result.totalNewlyEligibleMembers).toBe(2);
      const ids = result.newlyEligibleMembers.map((e) => e.memberId).sort();
      expect(ids).toEqual([MEMBERS.alice.memberId, MEMBERS.bob.memberId].sort());
    });

    it('addedWithAnomalies surfaces anomalies whose member is already verified-added to commons', async () => {
      /* Alice agreed earlier, got added to all commons (commons_added_at
       * is set), then changed her mind — her current state is
       * 'edited'. She should appear in the DM queue. Bob is also
       * anomalous but was NEVER verified-added, so he stays out of
       * this queue (he's still in `anomalies`). */
      store.recordAgreement({
        memberId: MEMBERS.alice.memberId,
        fullName: MEMBERS.alice.fullName,
        articleId: ART_A.articleId,
        commentId: 'c-alice-old',
        commentedAt: 1,
        source: 'email',
      });
      store.markCommonsAdded(MEMBERS.alice.memberId);
      store.recordAgreement({
        memberId: MEMBERS.bob.memberId,
        fullName: MEMBERS.bob.fullName,
        articleId: ART_A.articleId,
        commentId: 'c-bob-old',
        commentedAt: 1,
        source: 'email',
      });
      /* Bob is in the store but NOT verified-added. */

      const job = buildChangeOfHeartAuditJob(store, {
        articles: [ART_A],
        loadAndScrapeArticleComments: async () => [
          comment(MEMBERS.alice, 'I do not agree', 'c-alice-new'),
          comment(MEMBERS.bob, 'I disagree', 'c-bob-new'),
        ],
      });

      const result = await job.run(makeCtx());

      expect(result.totalAnomalies).toBe(2);
      expect(result.totalAddedWithAnomalies).toBe(1);
      expect(result.addedWithAnomalies[0]!.memberId).toBe(MEMBERS.alice.memberId);
      expect(result.addedWithAnomalies[0]!.state).toBe('edited');
    });

    it('summarize() appends a newly-eligible tail when members were promoted', async () => {
      const job = buildChangeOfHeartAuditJob(store, {
        articles: [ART_A],
        loadAndScrapeArticleComments: async () => [
          comment(MEMBERS.carol, 'i also agree!', 'c-1'),
        ],
      });
      const result = await job.run(makeCtx());
      const summary = job.summarize(result);
      expect(summary).toContain('(+1 newly eligible member)');
    });

    it('summarize() appends an added-to-commons-DM tail when there are anomalies on verified-added members', async () => {
      store.recordAgreement({
        memberId: MEMBERS.alice.memberId,
        fullName: MEMBERS.alice.fullName,
        articleId: ART_A.articleId,
        commentId: 'c-old',
        commentedAt: 1,
        source: 'email',
      });
      store.markCommonsAdded(MEMBERS.alice.memberId);

      const job = buildChangeOfHeartAuditJob(store, {
        articles: [ART_A],
        loadAndScrapeArticleComments: async () => [
          comment(MEMBERS.alice, 'I disagree now', 'c-new'),
        ],
      });
      const result = await job.run(makeCtx());
      const summary = job.summarize(result);
      expect(summary).toMatch(/\(1 added-to-commons member needs? DM\)/);
    });

    it('htmlBody renders the "Added to Commons, now anomaly, need to DM" section anchored to the member\'s latest comment', async () => {
      store.recordAgreement({
        memberId: 'm-alice-id',
        fullName: 'Alice Adams',
        articleId: ART_A.articleId,
        commentId: 'c-old',
        commentedAt: 1,
        source: 'email',
      });
      store.markCommonsAdded('m-alice-id');

      const job = buildChangeOfHeartAuditJob(store, {
        articles: [ART_A],
        loadAndScrapeArticleComments: async () => [
          { commentId: 'c-new', memberId: 'm-alice-id', fullName: 'Alice Adams', text: 'I disagree' },
        ],
      });
      const result = await job.run(makeCtx());
      const html = job.htmlBody!(result);

      expect(html).toMatch(/Added to Commons, now anomaly, need to DM/);
      /* Alice's anchor → her current (and only) comment on the
       * article, which is the evidence the operator needs to read
       * before opening the DM. */
      expect(html).toContain(`/posts/${ART_A.articleId}/comments/c-new`);
      expect(html).not.toContain('chats/new');
    });

    it('htmlBody renders a "Newly eligible" section linking to the promotion comment', async () => {
      const job = buildChangeOfHeartAuditJob(store, {
        articles: [ART_A],
        loadAndScrapeArticleComments: async () => [
          { commentId: 'c-promo', memberId: MEMBERS.carol.memberId, fullName: MEMBERS.carol.fullName, text: 'I agree!' },
        ],
      });
      const result = await job.run(makeCtx());
      const html = job.htmlBody!(result);

      expect(html).toMatch(/Newly eligible/);
      expect(html).toContain('/posts/art-A/comments/c-promo');
    });

    it('escapes HTML in non-matching comment text and member names', async () => {
      const job = buildChangeOfHeartAuditJob(store, {
        articles: [ART_A],
        loadAndScrapeArticleComments: async () => [
          {
            commentId: 'c-1',
            memberId: 'mallory',
            fullName: '<script>alert(1)</script>',
            text: '<img src=x onerror=alert(2)>',
          },
        ],
      });

      const result = await job.run(makeCtx());
      const html = job.htmlBody!(result);

      expect(html).not.toContain('<script>alert(1)</script>');
      expect(html).not.toContain('<img src=x onerror=alert(2)>');
      expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    });
  });
});
