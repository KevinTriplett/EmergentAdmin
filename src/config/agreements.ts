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
 * Loose match: a comment counts as an agreement if it has one of two
 * positive shapes AND does not contain an explicit negation. Tolerates
 * the common variants the strict regex used to reject ("i also agree!",
 * "Yes, I really agree.", "Agreed!") without opening the door to off-
 * topic comments — anything that doesn't end on "agree[.!?…]" or a bare
 * "Agreed" is still treated as malformed and DM'd per Kevin's policy.
 *
 *   Positive shape A — "I [≤3 adverbs] agree" as the closing clause:
 *     "I agree", "I agree.", "I agree!", "i also agree!",
 *     "Yes, I really agree.", "I do absolutely agree :)".
 *
 *   Positive shape B — a bare "Agreed":
 *     "Agreed", "Agreed.", "Agreed!".
 *
 *   Negation veto — vetoes either shape regardless:
 *     /not\s+agree/  catches "I do not agree", "cannot agree"
 *                    (intentionally no \b before "not" so "cannot"
 *                     is also caught).
 *     /disagree/     catches "I disagree", "I disagreed",
 *                    "I agree to disagree", "disagreement".
 *
 * The shapes are anchored at end-of-string (with optional trailing
 * non-word chars) so a comment that *begins* with "I agree" but goes
 * on to say other things ("I agree with point 1 but not 3") is not
 * counted as an unqualified agreement — those still get the DM-for-
 * clarification treatment from the IMAP poller, and surface as an
 * anomaly in the change-of-heart audit.
 */
export const AGREE_SHAPE_I_AGREE = /\bi\s+(?:\w+\s+){0,3}agree\b\W*$/i;
export const AGREE_SHAPE_AGREED = /^\s*agreed\b\W*$/i;
export const AGREE_NEGATION_PATTERN = /not\s+agree|disagree/i;

/** Lookup an agreement by its MN article id. Returns null for non-agreements. */
export function findAgreementArticle(articleId: string): AgreementArticle | null {
  return AGREEMENT_ARTICLES.find((a) => a.articleId === articleId) ?? null;
}

/** True iff the given comment text reads as an agreement. */
export function isAgreementText(text: string): boolean {
  const t = text.trim();
  if (t.length === 0) return false;
  if (AGREE_NEGATION_PATTERN.test(t)) return false;
  return AGREE_SHAPE_I_AGREE.test(t) || AGREE_SHAPE_AGREED.test(t);
}
