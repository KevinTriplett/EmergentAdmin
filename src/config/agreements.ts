/**
 * Configuration for the Agreements Watcher (Stage 4).
 *
 * AGREEMENT_ARTICLES is the authoritative list of articles a member must post
 * "I agree" on before they get auto-added to all commons spaces. Currently
 * there is exactly ONE such article; the array shape is preserved so that
 * re-introducing a multi-article gate later is a config-only change (the
 * store, poller, and threshold logic are all already N-aware).
 *
 * The articleId / spaceId pair is the numeric pair captured by the email
 * parser from MN's "See Comment" deep link, which looks like:
 *   https://app.mn.co/<n>/spaces/<spaceId>/posts/<articleId>/comments/<commentId>?...
 */

/**
 * Public-facing community URL. Centralised here so any future move
 * (custom domain, staging mirror, etc.) is a one-line change.
 */
export const MN_COMMUNITY_BASE_URL = 'https://emergent-commons.mn.co';

/** Public URL for an MN post (article). */
export function postUrl(articleId: string): string {
  return `${MN_COMMUNITY_BASE_URL}/posts/${articleId}`;
}

/** Public URL for a specific comment on an MN post. */
export function commentUrl(articleId: string, commentId: string): string {
  return `${postUrl(articleId)}/comments/${commentId}`;
}

export type AgreementArticle = {
  articleId: string;
  spaceId: string;
  title: string;
  /** Public URL - optional, for humans. Parsers work off articleId alone. */
  url?: string;
};

/**
 * Single agreement article. Update both IDs (and the title) when the
 * canonical agreement post is changed; everything else is derived.
 */
export const AGREEMENT_ARTICLES: readonly AgreementArticle[] = [
  {
    articleId: '101507246',
    spaceId: '4747401',
    title: 'Community Agreements',
    url: postUrl('101507246'),
  },
] as const;

/**
 * Total agreements a member needs before being auto-added. Derived from the
 * length of AGREEMENT_ARTICLES so collapsing/expanding the array above is
 * the only change needed to adjust the threshold.
 */
export const REQUIRED_AGREEMENT_COUNT = AGREEMENT_ARTICLES.length;

/**
 * Strict match: the comment text, after trim, must be exactly "I agree" or
 * "I agree." (case-insensitive). Anything else is "malformed" per Kevin's
 * policy in clarifications / chat: we DM the member rather than try to
 * interpret their intent.
 */
export const AGREE_PATTERN = /^\s*i\s+agree\.?\s*$/i;

/** Lookup an agreement by its MN article id. Returns null for non-agreements. */
export function findAgreementArticle(articleId: string): AgreementArticle | null {
  return AGREEMENT_ARTICLES.find((a) => a.articleId === articleId) ?? null;
}

/** True iff the given comment text is a strict agreement. */
export function isAgreementText(text: string): boolean {
  return AGREE_PATTERN.test(text);
}
