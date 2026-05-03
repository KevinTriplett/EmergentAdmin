import { simpleParser, type ParsedMail } from 'mailparser';

/**
 * Parses a real Mighty Networks comment-notification email into a
 * structured event. Shape of the real emails (verified against
 * `notification_email_body.html` + `notification_email_header.txt`
 * samples in the repo root):
 *
 *   Header:
 *     From: <Community Name> <emergent-commons@mn.co>
 *     Subject: <Commenter Name> commented on your Post: <comment text>
 *     X-Mailgun-Tag: notification_space_post_comment_create_recent
 *     Message-Id: <...>
 *
 *   Body HTML (relevant parts):
 *     <a ... href="https://emergent-commons.mn.co/members/<memberId>"> -- commenter profile (FIRST /members/ link)
 *     <a ... href="https://app.mn.co/<n>/spaces/<networkId>/posts/<postId>/comments/<commentId>?..."> -- "See Comment" deep link
 *
 * Design:
 *   - Subject line is the single source of truth for commenter name + comment
 *     text. It carries both, and MN always populates it regardless of HTML
 *     template drift.
 *   - Post id (== agreement article id in our config) and comment id come
 *     from the "See Comment" deep link in the body. We never rely on order
 *     of appearance beyond "first /members/ link wins" for the commenter.
 *   - The X-Mailgun-Tag header is a cheap positive signal we can use to
 *     short-circuit non-comment emails before we even try to parse the body.
 *
 * The three regexes at the top of this file are the ONLY things to tune if
 * MN's format changes again.
 */

export type ParsedAgreementNotification = {
  messageId: string;
  memberId: string;
  fullName: string;
  articleId: string;
  spaceId: string;
  commentId: string;
  commentText: string;
};

const MN_SENDER_RE = /@(?:[a-z0-9-]+\.)*mn\.co$/i;

/**
 * Matches e.g. "Jane Doe commented on your Post: I agree" or "Jane O'Malley
 * commented on your Comment: So do I.". Captures (1) commenter name and
 * (2) comment text. Kept permissive on the trailing noun ("Post" /
 * "Comment" / "Article") because MN reuses this template across surfaces.
 *
 * The same sentence appears in FOUR places in a real MN notification:
 *   1. Subject: header (most reliable; we try this first)
 *   2. Inside <a class="notification-text">...<strong>NAME commented on
 *      your Post</strong>: TEXT</a>
 *   3. <title>NAME commented on your Post: TEXT</title>
 *   4. <div class="preheader">NAME commented on your Post: TEXT ...</div>
 * We try each source in that order so the parser degrades gracefully if
 * MN ever drops Subject or truncates body elements differently.
 */
const SUBJECT_COMMENT_RE = /^(.+?)\s+commented on your (?:Post|Comment|Article)\s*:\s*(.+?)\s*$/i;

/**
 * Body-fallback 1: the "See Comment" anchor block. Looks like:
 *   <a class="... notification-text" href="..."><strong>NAME commented on
 *   your Post</strong>: TEXT</a>
 * The <strong> ends the name portion; everything between "</strong>: "
 * and the closing "</a>" is the comment text (MN doesn't nest tags here).
 */
const NOTIFICATION_TEXT_ANCHOR_RE =
  /<a\b[^>]*class="[^"]*\bnotification-text\b[^"]*"[^>]*>[\s\S]*?<strong[^>]*>\s*([^<]+?)\s+commented on your (?:Post|Comment|Article)\s*<\/strong>\s*:\s*([\s\S]*?)<\/a>/i;

/**
 * Body-fallback 2: <title> tag in the HTML <head>.
 */
const TITLE_TAG_RE = /<title[^>]*>([\s\S]*?)<\/title>/i;

/**
 * Body-fallback 3: <div class="preheader">TEXT ...</div>. MN pads the
 * preheader with whitespace-only invisible chars after the sentence; we
 * just take the first non-blank line of text content and hand it to
 * SUBJECT_COMMENT_RE.
 */
const PREHEADER_DIV_RE =
  /<div[^>]*class="[^"]*\bpreheader\b[^"]*"[^>]*>([\s\S]*?)<\/div>/i;

/**
 * "See Comment" deep link, the authoritative source for (postId, commentId).
 * Example:
 *   https://app.mn.co/8/spaces/4747401/posts/100847768/comments/146833875?notification_id=...
 * We don't capture the networkId (the first `spaces/<n>`) because it's not
 * needed by any downstream consumer and tying to it would break if MN ever
 * drops the `<n>/spaces/...` prefix.
 */
const POST_WITH_COMMENT_URL_RE =
  /https?:\/\/[a-z0-9.-]+\.mn\.co\/[^"'\s<>]*?\/posts\/(\d+)\/comments\/(\d+)/i;

/**
 * Fallback: post deep link without a comment id. Used only when the email
 * body doesn't include the /comments/<id> form (older templates).
 */
const POST_URL_RE =
  /https?:\/\/[a-z0-9.-]+\.mn\.co\/(?:[^"'\s<>]*?\/)?posts\/(\d+)(?![^"'\s<>]*\/comments)/i;

/**
 * First /members/<id> link in the body = the commenter. MN templates put
 * the commenter's avatar + name block above the post author's block.
 */
const MEMBER_URL_RE =
  /https?:\/\/[a-z0-9-]+\.mn\.co\/members\/(\d+)/i;

/**
 * Secondary space-id source. The email header table has a link of the form
 *   https://app.mn.co/<n>/spaces/<networkId>/spaces/<spaceId>
 * where the inner number is the real space id. Not required for correctness
 * (spaceId is metadata only — the config owns the canonical mapping) but
 * useful for logs/debug and for Stage 4c reconciliation cross-checks.
 */
const SPACE_URL_RE =
  /https?:\/\/[a-z0-9.-]+\.mn\.co\/[^"'\s<>]*?\/spaces\/\d+\/spaces\/(\d+)/i;

function pickBody(mail: ParsedMail): string {
  const html = typeof mail.html === 'string' ? mail.html : '';
  const text = typeof mail.text === 'string' ? mail.text : '';
  return html || text;
}

function senderAddress(mail: ParsedMail): string {
  const from = mail.from;
  if (!from) return '';
  const list = Array.isArray(from) ? from : [from];
  for (const entry of list) {
    const value = entry?.value?.[0]?.address;
    if (value) return value;
  }
  return '';
}

function readSubject(mail: ParsedMail): string {
  const s = mail.subject;
  if (typeof s === 'string') return s;
  return '';
}

/**
 * Strips HTML tags and decodes the handful of entities MN actually emits
 * (&amp;, &quot;, &#39;, &nbsp;). We avoid pulling in a full HTML parser
 * for what amounts to unwrapping a plain sentence.
 */
/**
 * Invisible Unicode padding chars MN stuffs into the preheader (to pad
 * the subject line preview on iOS/Android without rendering visibly).
 * We must scrub these BEFORE trimming, otherwise they survive `\s`
 * collapse and bleed into the captured comment text.
 *   U+034F  COMBINING GRAPHEME JOINER
 *   U+00AD  SOFT HYPHEN
 *   U+200B..U+200D  ZWSP / ZWNJ / ZWJ
 *   U+2060  WORD JOINER
 *   U+FEFF  ZERO WIDTH NO-BREAK SPACE (BOM)
 */
const INVISIBLE_PAD_RE = /[\u034F\u00AD\u200B-\u200D\u2060\uFEFF]/g;

function stripHtmlToText(html: string): string {
  return html
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&apos;/gi, "'")
    .replace(/&nbsp;/gi, ' ')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(INVISIBLE_PAD_RE, '')
    .replace(/\s+/g, ' ')
    .trim();
}

type CommenterAndText = { fullName: string; commentText: string };

/**
 * Tries the four known locations of "<Name> commented on your Post: <text>"
 * in order of reliability. Returns null only if every source fails.
 */
function extractCommenterAndText(
  mail: ParsedMail,
  body: string,
): CommenterAndText | null {
  // 1. Subject header (primary).
  const subjectMatch = readSubject(mail).match(SUBJECT_COMMENT_RE);
  if (subjectMatch) {
    return {
      fullName: subjectMatch[1].trim(),
      commentText: subjectMatch[2].trim(),
    };
  }

  // 2. <a class="notification-text"> anchor - the clickable headline in
  //    the email body. This is the most likely to have the FULL comment
  //    text (un-truncated) because it's the primary CTA.
  const anchorMatch = body.match(NOTIFICATION_TEXT_ANCHOR_RE);
  if (anchorMatch) {
    const fullName = stripHtmlToText(anchorMatch[1]);
    const commentText = stripHtmlToText(anchorMatch[2]);
    if (fullName && commentText) return { fullName, commentText };
  }

  // 3. <title> tag. Mirror of Subject.
  const titleMatch = body.match(TITLE_TAG_RE);
  if (titleMatch) {
    const text = stripHtmlToText(titleMatch[1]);
    const m = text.match(SUBJECT_COMMENT_RE);
    if (m) return { fullName: m[1].trim(), commentText: m[2].trim() };
  }

  // 4. preheader div (last resort). MN pads with invisible whitespace
  //    chars (&#x034F; etc.) that stripHtmlToText collapses to single
  //    spaces, so the SUBJECT_COMMENT_RE match still works here.
  const preheaderMatch = body.match(PREHEADER_DIV_RE);
  if (preheaderMatch) {
    const text = stripHtmlToText(preheaderMatch[1]);
    const m = text.match(SUBJECT_COMMENT_RE);
    if (m) return { fullName: m[1].trim(), commentText: m[2].trim() };
  }

  return null;
}

/**
 * Parse a raw RFC-822 email (Buffer or string). Returns null when the email
 * doesn't look like a valid MN comment notification.
 */
export async function parseMnCommentEmail(
  raw: Buffer | string,
): Promise<ParsedAgreementNotification | null> {
  const mail = await simpleParser(raw);
  return extractFromParsed(mail);
}

/**
 * Same as parseMnCommentEmail but operates on an already-parsed ParsedMail.
 * Exported for the IMAP poller, which receives ParsedMail directly.
 */
export function extractFromParsed(mail: ParsedMail): ParsedAgreementNotification | null {
  /*
   * mailparser preserves the angle brackets from the raw Message-Id header
   * (e.g. "<abc@mn.co>"). Strip them here so downstream dedup keys are the
   * canonical, bracket-less form regardless of whether the source uses RFC
   * 822 angle-bracket syntax.
   */
  const messageId = (mail.messageId ?? '').trim().replace(/^<|>$/g, '');
  if (!messageId) return null;

  const sender = senderAddress(mail);
  if (!MN_SENDER_RE.test(sender)) return null;

  const body = pickBody(mail);
  if (!body) return null;

  const extracted = extractCommenterAndText(mail, body);
  if (!extracted) return null;
  const { fullName, commentText } = extracted;
  if (!fullName || !commentText) return null;

  let articleId: string;
  let commentId: string;
  const commentUrlMatch = body.match(POST_WITH_COMMENT_URL_RE);
  if (commentUrlMatch) {
    articleId = commentUrlMatch[1];
    commentId = commentUrlMatch[2];
  } else {
    const postUrlMatch = body.match(POST_URL_RE);
    if (!postUrlMatch) return null;
    articleId = postUrlMatch[1];
    /* No comment id in the email - synthesize a stable one from the
     * messageId so our store's dedup still works. Daily reconciliation
     * can overwrite this with the real id later. */
    commentId = `msg-${messageId}`;
  }

  const memberMatch = body.match(MEMBER_URL_RE);
  if (!memberMatch) return null;
  const memberId = memberMatch[1];

  const spaceMatch = body.match(SPACE_URL_RE);
  const spaceId = spaceMatch ? spaceMatch[1] : '';

  return {
    messageId,
    memberId,
    fullName,
    articleId,
    spaceId,
    commentId,
    commentText,
  };
}
