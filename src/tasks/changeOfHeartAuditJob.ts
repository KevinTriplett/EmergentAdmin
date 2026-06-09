import type { Page } from 'puppeteer';
import {
  AGREEMENT_ARTICLES,
  commentUrl,
  postUrl,
  type AgreementArticle,
} from '../config/agreements.js';
import type {
  AgreementsStore,
  AuditState,
} from '../state/agreementsStore.js';
import type {
  BrowserJobContext,
  SchedulerJob,
} from '../scheduler/taskScheduler.js';
import { loginIfNeeded } from '../auth.js';
import { classifyMemberOnArticle } from './auditAgreements.js';
import { isAgreementText as matchesAgreementPattern } from '../config/agreements.js';
import { escapeHtml } from '../email.js';

/**
 * Mighty Networks "start a new chat with this user" URL pattern. The link is
 * what makes the admin email actionable — one click and the admin is in a DM
 * with the member whose agreement just disappeared / changed.
 */
const CHAT_WITH_MEMBER_URL_BASE = 'https://emergent-commons.mn.co/chats/new';

function chatWithMemberUrl(memberId: string): string {
  return `${CHAT_WITH_MEMBER_URL_BASE}?user_id=${encodeURIComponent(memberId)}`;
}

/**
 * Stage 4e — change-of-heart audit job.
 *
 * For each agreement article in the configured list, navigate to the public
 * post page, expand all comments, scrape them, and run the pure classifier
 * for every member the agreements store knows about for that article. Write
 * the verdict back to the store (Stage 4e schema columns audit_state /
 * audit_at), aggregate per-member anomalies (cases 1/2/3 only — happy and
 * multi_agreement are silent), and return a structured result.
 *
 * The result + summary feed the standard scheduler email path; an admin gets
 * a mail at the end of every audit run, with subject containing either
 * "0 anomalies — all clear" or "N anomalies: …" — per Q4 always send.
 *
 * Repair behavior (Stage 4c) is NOT changed by this job. Anomalous rows
 * stop counting toward the threshold via the audit-aware WHERE clauses in
 * `agreementsStore`; that's the entire mechanism for "decrease the
 * agreement count" called out in the spec. No new branches, no new
 * removals from commons spaces.
 */

// === CSS SELECTORS — UPDATE THESE IF MN CHANGES ITS DOM ===
const SEL_COMMENTS_CONTAINER = '.comments-list-container';
const SEL_LOAD_MORE_PREVIOUS = `${SEL_COMMENTS_CONTAINER} a.btn-load-more-previous-comments`;
const SEL_COMMENT_LI = `${SEL_COMMENTS_CONTAINER} ul li[data-detail-comment]`;
const SEL_COMMENT_AUTHOR_LINK = '.author-name a[href]';
const SEL_COMMENT_BODY = '.comment-body';

// === TIMING ===
const WAIT_READY_MS = 60_000;
const WAIT_COMMENTS_MS = 15_000;
/** Hard upper bound on expand-comments iterations to defend against an
 *  always-visible loader (e.g. selector-only-half-correct on a future MN
 *  redesign). One agreement post with thousands of comments still fits
 *  well under this. */
const MAX_LOAD_MORE_ITERATIONS = 200;
/** Per-iteration timeout waiting for new comments to render after a click. */
const WAIT_NEW_COMMENTS_MS = 8_000;

export type ScrapedComment = {
  commentId: string;
  memberId: string;
  fullName: string;
  text: string;
};

export type AnomalyEntry = {
  memberId: string;
  fullName: string;
  articleId: string;
  articleTitle: string;
  articleUrl: string;
  state: Extract<AuditState, 'deleted' | 'edited' | 'mixed'>;
  /**
   * For 'edited' / 'mixed': the text(s) that did not match AGREE_PATTERN, so
   * the admin can see *what* the member wrote without opening the post.
   * Empty for 'deleted' (no comments to sample). Capped to keep the email
   * compact.
   */
  sampleNonMatchingText: string[];
};

/**
 * Stage 4f — a single comment on an agreement post whose text does not
 * match the strict `AGREE_PATTERN`. Surfaced verbatim in the audit result
 * (and the admin email) with a deep-link back to the comment on the live
 * MN post so an admin can one-click into the offending comment for
 * follow-up. This is independent of `AnomalyEntry`:
 *
 *   - `AnomalyEntry` is keyed off the agreements store (the member must
 *     already have a row in `agreements` for that article); it captures
 *     "people whose effective count went down" — the change-of-heart
 *     signal that drives eligibility.
 *
 *   - `NonMatchingComment` is keyed off the page: any commenter whose
 *     text fails the regex is included, even if they have no row in
 *     the store (e.g. a curious member who hasn't yet said "I agree",
 *     a wandering off-topic comment, or a spammer). This is the
 *     forensic list the operator asked for in Stage 4f — "any comments
 *     that do not fit the I agree regex, with a link back to the
 *     comment, for check up".
 */
export type NonMatchingComment = {
  commentId: string;
  memberId: string;
  fullName: string;
  articleId: string;
  articleTitle: string;
  /**
   * Deep link to the comment on the live MN post when `commentId` is
   * non-empty; falls back to the parent post URL otherwise (defensive —
   * MN's DOM has always rendered `data-detail-comment` so far, but an
   * empty id should still point the operator somewhere clickable).
   */
  url: string;
  /** Comment text truncated to `SAMPLE_TEXT_TRUNCATE`. */
  text: string;
};

const SAMPLE_TEXT_MAX = 5;
const SAMPLE_TEXT_TRUNCATE = 200;

export type ChangeOfHeartArticleResult = {
  articleId: string;
  title: string;
  url: string;
  commentsLoaded: number;
  membersAudited: number;
  happyCount: number;
  multiAgreementCount: number;
  anomalies: AnomalyEntry[];
  /** Stage 4f: every non-matching comment on this article, deduped. */
  nonMatchingComments: NonMatchingComment[];
};

export type ChangeOfHeartAuditResult = {
  articles: ChangeOfHeartArticleResult[];
  /** Anomalies aggregated across articles. */
  anomalies: AnomalyEntry[];
  totalAnomalies: number;
  totalMembersAudited: number;
  /** Stage 4f: every non-matching comment, aggregated across articles. */
  nonMatchingComments: NonMatchingComment[];
  totalNonMatchingComments: number;
};

export type ChangeOfHeartAuditDeps = {
  /**
   * Inject to override scrape behavior — the production default does
   * `goto + loginIfNeeded + expand + scrape` against the live MN page; tests
   * pass a stub that returns canned arrays per articleId. Keeping this
   * injected is what makes the orchestration easy to unit-test.
   */
  loadAndScrapeArticleComments?: LoadAndScrapeArticleComments;
  /** Override the article list (default: AGREEMENT_ARTICLES). Useful for tests. */
  articles?: readonly AgreementArticle[];
};

type LoadAndScrapeArticleComments = (
  page: Page,
  articleId: string,
  log: (message: string) => void,
  abortSignal: { aborted: boolean },
) => Promise<ScrapedComment[]>;

export function buildChangeOfHeartAuditJob(
  store: AgreementsStore,
  deps: ChangeOfHeartAuditDeps = {},
): SchedulerJob<ChangeOfHeartAuditResult> {
  const articles = deps.articles ?? AGREEMENT_ARTICLES;
  const loadAndScrape = deps.loadAndScrapeArticleComments ?? defaultLoadAndScrapeArticleComments;

  return {
    name: 'auditAgreements (change of heart)',
    headless: true,
    run: async (ctx: BrowserJobContext): Promise<ChangeOfHeartAuditResult> => {
      const articleResults: ChangeOfHeartArticleResult[] = [];
      const allAnomalies: AnomalyEntry[] = [];
      const allNonMatchingComments: NonMatchingComment[] = [];
      let totalMembersAudited = 0;

      for (const article of articles) {
        if (ctx.abortSignal.aborted) {
          ctx.log('Abort requested — skipping remaining articles.');
          break;
        }

        ctx.log(`\n=== Auditing article: ${article.title} (${article.articleId}) ===`);
        const scraped = await loadAndScrape(ctx.page, article.articleId, ctx.log, ctx.abortSignal);
        /* MN sometimes renders the same logical comment in two DOM
         * places (verified live May 2026: same commentId scraped twice
         * for multiple members on the agreements post). Without dedup
         * those rows fake a multi_agreement verdict and trigger
         * spurious anomalies. Dedup is silent (operator approved
         * "quiet" disposition); first occurrence wins so a later
         * truncated/edited render can't override the original. Rows
         * with empty commentId are preserved as-is — empty isn't a
         * stable key. */
        const deduped = dedupeByCommentId(scraped);
        const byMember = groupCommentsByMember(deduped);
        const members = store.listMembersForArticle(article.articleId);

        /* Stage 4f: every comment whose text fails the strict agree
         * regex, regardless of whether the commenter has an
         * `agreements` row. This is the forensic list — the operator
         * wants to be able to one-click into each comment from the
         * UI / email. We use the same `deduped` list so MN UI
         * artifacts don't fake two non-matching entries from a single
         * underlying comment. */
        const nonMatchingForArticle: NonMatchingComment[] = deduped
          .filter((c) => !textMatchesAgreement(c.text))
          .map((c) => ({
            commentId: c.commentId,
            memberId: c.memberId,
            fullName: c.fullName,
            articleId: article.articleId,
            articleTitle: article.title,
            url: c.commentId
              ? commentUrl(article.articleId, c.commentId)
              : article.url ?? postUrl(article.articleId),
            text: truncate(c.text, SAMPLE_TEXT_TRUNCATE),
          }));

        let happyCount = 0;
        let multiAgreementCount = 0;
        const anomaliesForArticle: AnomalyEntry[] = [];

        for (const m of members) {
          const memberComments = byMember.get(m.memberId) ?? [];
          const state = classifyMemberOnArticle(memberComments);
          store.recordAuditOutcome(m.memberId, article.articleId, state);
          totalMembersAudited += 1;

          if (state === 'happy') {
            happyCount += 1;
          } else if (state === 'multi_agreement') {
            multiAgreementCount += 1;
            /* Counted silently in the per-article tally, but the
             * operator needs *which* member + *which* comments to
             * triage "did they really say it twice, or did the
             * scraper double-count a single DOM-rendered comment".
             * Each comment is logged with id and a short text snippet
             * so a dup is obvious at a glance. */
            ctx.log(
              `  • MULTI_AGREEMENT: ${m.fullName} (id ${m.memberId}) — ` +
                `${memberComments.length} comments: ` +
                memberComments
                  .map((c) => `[${c.commentId}] "${c.text.slice(0, 80)}"`)
                  .join(' / '),
            );
          } else {
            const entry: AnomalyEntry = {
              memberId: m.memberId,
              fullName: m.fullName,
              articleId: article.articleId,
              articleTitle: article.title,
              articleUrl: article.url ?? postUrl(article.articleId),
              state,
              sampleNonMatchingText: sampleNonMatching(memberComments, state),
            };
            anomaliesForArticle.push(entry);
            ctx.log(
              `  • ${state.toUpperCase()}: ${m.fullName} (id ${m.memberId})${
                entry.sampleNonMatchingText.length > 0
                  ? ` — "${entry.sampleNonMatchingText[0]!.slice(0, 80)}"`
                  : ''
              }`,
            );
          }
        }

        articleResults.push({
          articleId: article.articleId,
          title: article.title,
          url: article.url ?? postUrl(article.articleId),
          commentsLoaded: scraped.length,
          membersAudited: members.length,
          happyCount,
          multiAgreementCount,
          anomalies: anomaliesForArticle,
          nonMatchingComments: nonMatchingForArticle,
        });
        allAnomalies.push(...anomaliesForArticle);
        allNonMatchingComments.push(...nonMatchingForArticle);

        ctx.log(
          `  audited ${members.length} member(s): ${happyCount} happy, ${multiAgreementCount} multi-agreement, ${anomaliesForArticle.length} anomaly(ies), ${nonMatchingForArticle.length} non-matching comment(s).`,
        );
      }

      return {
        articles: articleResults,
        anomalies: allAnomalies,
        totalAnomalies: allAnomalies.length,
        totalMembersAudited,
        nonMatchingComments: allNonMatchingComments,
        totalNonMatchingComments: allNonMatchingComments.length,
      };
    },
    summarize: (result: ChangeOfHeartAuditResult): string => {
      const pairsLabel = pluralize(result.totalMembersAudited, 'pair', 'pairs');
      const articlesLabel = pluralize(result.articles.length, 'article', 'articles');
      /* Stage 4f: the non-matching-comments tail is appended to both
       * the "all clear" and the "N anomalies" summary so the operator
       * sees it regardless of whether anyone with an existing
       * agreement row downgraded. `nonMatchingTail` returns the empty
       * string when there are zero non-matching comments, keeping
       * the legacy "all clear" message unchanged in the common case. */
      if (result.totalAnomalies === 0) {
        return `0 anomalies — all clear (audited ${result.totalMembersAudited} member-article ${pairsLabel} across ${result.articles.length} ${articlesLabel})${nonMatchingTail(result)}`;
      }
      const items = result.anomalies
        .map((a) => `${a.fullName} (${a.state})`)
        .join(', ');
      const anomLabel = pluralize(result.totalAnomalies, 'anomaly', 'anomalies');
      return `${result.totalAnomalies} ${anomLabel}: ${items}${nonMatchingTail(result)}`;
    },
    htmlBody: renderAuditHtml,
  };
}

function nonMatchingTail(result: ChangeOfHeartAuditResult): string {
  if (result.totalNonMatchingComments === 0) return '';
  const label = pluralize(result.totalNonMatchingComments, 'comment', 'comments');
  return ` (+${result.totalNonMatchingComments} non-matching ${label})`;
}

// ---------------------------------------------------------------------------
// HTML email body
// ---------------------------------------------------------------------------

/**
 * Renders the change-of-heart audit's main email body fragment. The
 * surrounding envelope (header, log, result blocks) is added by `email.ts`'s
 * `formatHtmlBody`. We render only the audit-specific section here.
 *
 * The whole point of this render is the per-anomaly anchor:
 *   <a href="https://emergent-commons.mn.co/chats/new?user_id=…">Full Name</a>
 * which makes the admin email actionable — one click DMs the member.
 */
function renderAuditHtml(result: ChangeOfHeartAuditResult): string {
  const nonMatchingSection = renderNonMatchingCommentsHtml(result.nonMatchingComments);

  if (result.totalAnomalies === 0) {
    const allClear = `
      <h3>Change-of-heart audit</h3>
      <p>0 anomalies — all clear (audited ${result.totalMembersAudited} member-article ${pluralize(
        result.totalMembersAudited,
        'pair',
        'pairs',
      )} across ${result.articles.length} ${pluralize(
        result.articles.length,
        'article',
        'articles',
      )}).</p>`;
    return allClear + nonMatchingSection;
  }

  const items = result.anomalies
    .map((a) => {
      const memberLink = `<a href="${escapeHtml(
        chatWithMemberUrl(a.memberId),
      )}">${escapeHtml(a.fullName)}</a>`;
      const articleLink = `<a href="${escapeHtml(a.articleUrl)}">${escapeHtml(
        a.articleTitle,
      )}</a>`;
      const sample =
        a.sampleNonMatchingText.length > 0
          ? ` — <em>${escapeHtml(a.sampleNonMatchingText[0]!)}</em>`
          : '';
      return `<li>${memberLink} — <strong>${escapeHtml(
        a.state,
      )}</strong> on ${articleLink}${sample}</li>`;
    })
    .join('\n      ');

  return `
    <h3>Change-of-heart audit — ${result.totalAnomalies} ${pluralize(
      result.totalAnomalies,
      'anomaly',
      'anomalies',
    )}</h3>
    <ul>
      ${items}
    </ul>${nonMatchingSection}`;
}

/**
 * Stage 4f: render the "non-matching comments" section of the email. Each
 * entry is a clickable deep-link to the comment on the live MN post so the
 * admin can one-click into the offending comment from the email. Returns
 * the empty string when the list is empty, so the surrounding template
 * doesn't need to branch on it.
 */
function renderNonMatchingCommentsHtml(items: readonly NonMatchingComment[]): string {
  if (items.length === 0) return '';

  const lis = items
    .map((c) => {
      const commentLink = `<a href="${escapeHtml(c.url)}">${escapeHtml(
        c.fullName || '(unknown commenter)',
      )}</a>`;
      const articleSuffix = ` on ${escapeHtml(c.articleTitle)}`;
      const sample = c.text ? ` — <em>${escapeHtml(c.text)}</em>` : '';
      return `<li>${commentLink}${articleSuffix}${sample}</li>`;
    })
    .join('\n      ');

  return `
    <h3>Non-matching comments — ${items.length} ${pluralize(
      items.length,
      'comment',
      'comments',
    )}</h3>
    <p style="margin:0 0 0.5em 0;font-size:13px">Comments on agreement posts that don't match the "I agree" regex. Click a name to open the comment on MN.</p>
    <ul>
      ${lis}
    </ul>`;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function groupCommentsByMember(comments: readonly ScrapedComment[]): Map<string, ScrapedComment[]> {
  const out = new Map<string, ScrapedComment[]>();
  for (const c of comments) {
    const arr = out.get(c.memberId);
    if (arr) arr.push(c);
    else out.set(c.memberId, [c]);
  }
  return out;
}

/**
 * Collapse scraped rows that share a commentId down to a single row
 * (first occurrence wins). MN occasionally renders the same logical
 * comment in two DOM places — without this dedup we'd classify the
 * member as multi_agreement just because the UI duplicated their
 * "I agree". Rows with empty commentId are passed through untouched
 * because we have no stable key to dedup by; treat each such row as
 * a distinct comment.
 */
function dedupeByCommentId(comments: readonly ScrapedComment[]): ScrapedComment[] {
  const seen = new Set<string>();
  const out: ScrapedComment[] = [];
  for (const c of comments) {
    if (!c.commentId) {
      out.push(c);
      continue;
    }
    if (seen.has(c.commentId)) continue;
    seen.add(c.commentId);
    out.push(c);
  }
  return out;
}

/**
 * Pull non-matching texts for forensic display. Mirrors the classifier's
 * matcher so the sample is exactly the texts that drove the verdict.
 *
 *   'deleted' -> []          (no comments existed)
 *   'edited'  -> [the one non-matching text]
 *   'mixed'   -> all non-matching texts (capped)
 */
function sampleNonMatching(
  memberComments: readonly ScrapedComment[],
  state: AuditState,
): string[] {
  if (state === 'deleted') return [];
  if (state === 'happy' || state === 'multi_agreement') return [];

  const nonMatching = memberComments
    .filter((c) => !textMatchesAgreement(c.text))
    .map((c) => truncate(c.text, SAMPLE_TEXT_TRUNCATE));

  return nonMatching.slice(0, SAMPLE_TEXT_MAX);
}

function textMatchesAgreement(text: string): boolean {
  return matchesAgreementPattern(text);
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + '…';
}

function pluralize(n: number, singular: string, plural: string): string {
  return n === 1 ? singular : plural;
}

// ---------------------------------------------------------------------------
// Default page-driven scraper. Not unit-tested here (selectors are MN-side);
// covered by the structural smoke checks above and verified on a live first
// run. Update SEL_* constants if MN changes class names.
// ---------------------------------------------------------------------------

const defaultLoadAndScrapeArticleComments: LoadAndScrapeArticleComments = async (
  page,
  articleId,
  log,
  abortSignal,
) => {
  const url = postUrl(articleId);
  /* `domcontentloaded` not `networkidle2` — see addSpaceMember.ts for
   * the rationale. `waitForSelector(SEL_COMMENTS_CONTAINER, …)` below
   * is the actual signal that the comments region has mounted. */
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await loginIfNeeded(page, log);
  await page.waitForSelector(SEL_COMMENTS_CONTAINER, { timeout: WAIT_READY_MS });
  /* The comments <ul> may be empty if no one has commented yet — that's a
   * legitimate "0 comments" result, not an error. So we wait for the
   * container, not for the first <li>. */
  try {
    await page.waitForSelector(SEL_COMMENT_LI, { timeout: WAIT_COMMENTS_MS });
  } catch {
    await log(`  no comments rendered within ${WAIT_COMMENTS_MS}ms; treating as 0 comments`);
    return [];
  }

  /* Expand all "Previous Comments" loaders. Verified live (May 2026):
   * MN's "Previous Comments" loads ALL remaining older comments in a
   * single click and then hides the wrapper as its "no more comments"
   * signal — so a typical expansion finishes in 1–2 iterations. The
   * iteration cap exists only as a safety net in case MN ever paginates. */
  for (let i = 0; i < MAX_LOAD_MORE_ITERATIONS; i++) {
    if (abortSignal.aborted) {
      await log('  abort requested; ending expansion');
      break;
    }
    const beforeCount = await page.$$eval(SEL_COMMENT_LI, (els) => els.length);

    /* Find a *visible* (non-zero rect) load-more anchor and click it. If
     * no visible anchor exists, MN has either removed the wrapper from
     * the DOM (anchor count 0) or hidden it (parent display:none, class
     * "hidden") — either way, "no more comments". */
    const clicked = await page.evaluate((sel) => {
      const all = Array.from(document.querySelectorAll(sel)) as HTMLElement[];
      const a = all.find((el) => {
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
      });
      if (!a) return false;
      a.click();
      return true;
    }, SEL_LOAD_MORE_PREVIOUS);
    if (!clicked) break;

    try {
      await page.waitForFunction(
        (sel, prev) => document.querySelectorAll(sel).length > prev,
        { timeout: WAIT_NEW_COMMENTS_MS },
        SEL_COMMENT_LI,
        beforeCount,
      );
    } catch {
      await log(
        `  warning: clicked Previous Comments but comment count did not grow within ${WAIT_NEW_COMMENTS_MS}ms; ending expansion`,
      );
      break;
    }
  }

  const scraped = await page.$$eval(
    SEL_COMMENT_LI,
    (els, sels) => {
      const { authorLinkSel, bodySel } = sels as { authorLinkSel: string; bodySel: string };
      const out: Array<{ commentId: string; memberId: string; fullName: string; text: string }> = [];
      for (const el of els as HTMLElement[]) {
        const commentId = el.getAttribute('data-detail-comment') ?? '';
        const a = el.querySelector(authorLinkSel) as HTMLAnchorElement | null;
        const href = a?.getAttribute('href') ?? '';
        const m = /\/members\/(\d+)/.exec(href);
        const memberId = m ? m[1]! : '';
        const fullName = a?.getAttribute('title') ?? '';
        const body = el.querySelector(bodySel);
        const text = (body?.textContent ?? '').trim();
        if (!memberId) continue; // skip rows we can't attribute to a member
        out.push({ commentId, memberId, fullName, text });
      }
      return out;
    },
    { authorLinkSel: SEL_COMMENT_AUTHOR_LINK, bodySel: SEL_COMMENT_BODY },
  );

  await log(`  loaded ${scraped.length} comment(s)`);
  return scraped;
};
