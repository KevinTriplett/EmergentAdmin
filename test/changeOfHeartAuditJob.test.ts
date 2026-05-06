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
     * The chat-with-member URL pattern is fixed by Mighty Networks:
     *   https://emergent-commons.mn.co/chats/new?user_id={memberId}
     * Wrapping each anomalous member's name in this anchor lets the admin
     * one-click DM the person from the email.
     */
    it('wraps each anomalous member name in an anchor pointing at the chats/new URL', async () => {
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

      expect(html).toContain(
        '<a href="https://emergent-commons.mn.co/chats/new?user_id=17557698">Alice Adams</a>',
      );
      expect(html).toContain(
        '<a href="https://emergent-commons.mn.co/chats/new?user_id=17557699">Bob Brown</a>',
      );
      expect(html).toContain('deleted');
      expect(html).toContain('edited');
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

    it('encodes member ids inside the anchor href as URL components', async () => {
      /* member_id is a numeric string in production, but the contract is
       * "the value of the user_id query parameter", so the anchor must
       * URI-encode it the same way the browser would. */
      store.recordAgreement({
        memberId: 'weird id&x',
        fullName: 'Edge Case',
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

      expect(html).toContain('user_id=weird%20id%26x');
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
});
