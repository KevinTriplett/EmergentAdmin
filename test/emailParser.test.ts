import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parseMnCommentEmail } from '../src/ingestion/emailParser.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * The synthetic fixtures below mirror Mighty Networks' real notification
 * template (as verified against a live sample — the real deep-link URL form,
 * first-/members/-link-wins ordering, subject-line carries both commenter
 * name and comment text).
 */

const DEFAULT_HEADERS: Record<string, string> = {
  From: 'Emergent Commons <emergent-commons@mn.co>',
  To: 'host@example.com',
  'Message-Id': '<msg-1@mn.co>',
  'Mime-Version': '1.0',
  'Content-Type': 'text/html; charset=UTF-8',
  'X-Mailgun-Tag': 'notification_space_post_comment_create_recent',
};

function buildRawEmail(opts: {
  headers?: Partial<Record<string, string>>;
  subject: string;
  bodyHtml: string;
}): string {
  const headers = { ...DEFAULT_HEADERS, ...opts.headers, Subject: opts.subject };
  const lines = Object.entries(headers).map(([k, v]) => `${k}: ${v}`);
  return lines.join('\r\n') + '\r\n\r\n' + opts.bodyHtml;
}

function buildRealisticBody(opts: {
  memberId: string;
  memberName: string;
  postAuthorMemberId: string;
  articleId: string;
  commentId: string;
  spaceId: string;
  networkId: string;
}): string {
  // The commenter's /members/ link appears FIRST (before the post author).
  // The "See Comment" button links to /posts/<id>/comments/<id>.
  // A space-avatar link has the /spaces/<net>/spaces/<space> double form.
  return `
    <html><body>
      <a class="mighty-avatar-medium"
         href="https://app.mn.co/8/spaces/${opts.networkId}/spaces/${opts.spaceId}"
         title="Space">Space</a>
      <a class="mighty-avatar-user-large no-underline email-avatar"
         href="https://emergent-commons.mn.co/members/${opts.memberId}">
        <img alt="${opts.memberName}" />
      </a>
      <a class="no-underline user-name"
         href="https://emergent-commons.mn.co/members/${opts.memberId}">
        ${opts.memberName}
      </a>
      <a class="text-align-center notification-text"
         href="https://app.mn.co/8/spaces/${opts.networkId}/posts/${opts.articleId}/comments/${opts.commentId}?notification_id=1&amp;origin_method=email">
        <strong>${opts.memberName} commented on your Post</strong>: sample
      </a>
      <a href="https://emergent-commons.mn.co/members/${opts.postAuthorMemberId}">Post Author</a>
      <a href="https://emergent-commons.mn.co/posts/${opts.articleId}">Visit Post</a>
    </body></html>`;
}

describe('parseMnCommentEmail', () => {
  it('extracts the full event from a realistic MN notification', async () => {
    const raw = buildRawEmail({
      subject: 'Jane Doe commented on your Post: I agree',
      bodyHtml: buildRealisticBody({
        memberId: '7698608',
        memberName: 'Jane Doe',
        postAuthorMemberId: '12314607',
        articleId: '100847768',
        commentId: '146833875',
        spaceId: '23462808',
        networkId: '4747401',
      }),
    });
    const result = await parseMnCommentEmail(raw);
    expect(result).toEqual({
      messageId: 'msg-1@mn.co',
      memberId: '7698608',
      fullName: 'Jane Doe',
      articleId: '100847768',
      spaceId: '23462808',
      commentId: '146833875',
      commentText: 'I agree',
    });
  });

  it('returns null for a non-MN sender', async () => {
    const raw = buildRawEmail({
      headers: { From: 'newsletter@example.com' },
      subject: 'Jane Doe commented on your Post: I agree',
      bodyHtml: buildRealisticBody({
        memberId: '1', memberName: 'Jane', postAuthorMemberId: '2',
        articleId: '10', commentId: '20', spaceId: '30', networkId: '99',
      }),
    });
    expect(await parseMnCommentEmail(raw)).toBeNull();
  });

  it('returns null when NEITHER subject NOR any body fallback contains a comment sentence', async () => {
    // Subject is a digest, body has no notification-text / title / preheader.
    const raw = buildRawEmail({
      subject: 'Weekly digest: catch up on what you missed',
      bodyHtml: `<html><body>
        <a href="https://emergent-commons.mn.co/members/1">Jane</a>
        <a href="https://app.mn.co/8/spaces/99/posts/10/comments/20">See</a>
      </body></html>`,
    });
    expect(await parseMnCommentEmail(raw)).toBeNull();
  });

  it('falls back to the notification-text anchor when Subject is missing', async () => {
    const raw = buildRawEmail({
      // Subject that does NOT match SUBJECT_COMMENT_RE
      subject: 'Weekly digest',
      bodyHtml: `<html>
        <head><title>unrelated page title</title></head>
        <body>
          <a href="https://emergent-commons.mn.co/members/7698608">Kevin</a>
          <a class="text-align-center notification-text"
             href="https://app.mn.co/8/spaces/4747401/posts/100847768/comments/146833875?x=1">
             <strong>Kevin Triplett commented on your Post</strong>: I agree
          </a>
        </body>
      </html>`,
    });
    const result = await parseMnCommentEmail(raw);
    expect(result).toMatchObject({
      fullName: 'Kevin Triplett',
      commentText: 'I agree',
      memberId: '7698608',
      articleId: '100847768',
      commentId: '146833875',
    });
  });

  it('falls back to the <title> tag when Subject AND notification-text both fail', async () => {
    const raw = buildRawEmail({
      subject: 'Weekly digest',
      bodyHtml: `<html>
        <head><title>Kevin Triplett commented on your Post: I agree</title></head>
        <body>
          <a href="https://emergent-commons.mn.co/members/7698608">Kevin</a>
          <a href="https://app.mn.co/8/spaces/4747401/posts/100847768/comments/146833875?x=1">See</a>
        </body>
      </html>`,
    });
    const result = await parseMnCommentEmail(raw);
    expect(result).toMatchObject({
      fullName: 'Kevin Triplett',
      commentText: 'I agree',
      articleId: '100847768',
      commentId: '146833875',
    });
  });

  it('falls back to the preheader div as a last resort', async () => {
    // Preheader includes MN's invisible padding chars to illustrate that
    // stripHtmlToText collapses them out of the way.
    const raw = buildRawEmail({
      subject: 'Weekly digest',
      bodyHtml: `<html>
        <head><title>unrelated</title></head>
        <body>
          <div class="preheader">
            Kevin Triplett commented on your Post: I agree
            \u034F \u200C     \u00AD
          </div>
          <a href="https://emergent-commons.mn.co/members/7698608">Kevin</a>
          <a href="https://app.mn.co/8/spaces/4747401/posts/100847768/comments/146833875?x=1">See</a>
        </body>
      </html>`,
    });
    const result = await parseMnCommentEmail(raw);
    expect(result).toMatchObject({
      fullName: 'Kevin Triplett',
      commentText: 'I agree',
      articleId: '100847768',
      commentId: '146833875',
    });
  });

  it('returns null when the body has no comment deep-link', async () => {
    const raw = buildRawEmail({
      subject: 'Jane Doe commented on your Post: I agree',
      bodyHtml: `<html><body>
        <a href="https://emergent-commons.mn.co/members/1">Jane</a>
        <p>No deep link here.</p>
      </body></html>`,
    });
    expect(await parseMnCommentEmail(raw)).toBeNull();
  });

  it('returns null when the body has no /members/ link (unknown commenter)', async () => {
    const raw = buildRawEmail({
      subject: 'Jane Doe commented on your Post: I agree',
      bodyHtml: `<html><body>
        <a href="https://app.mn.co/8/spaces/99/posts/10/comments/20?x=1">See</a>
      </body></html>`,
    });
    expect(await parseMnCommentEmail(raw)).toBeNull();
  });

  it('uses the FIRST /members/ link (the commenter, not the post author)', async () => {
    const raw = buildRawEmail({
      subject: 'Jane Doe commented on your Post: I agree',
      bodyHtml: buildRealisticBody({
        memberId: '7698608',
        memberName: 'Jane Doe',
        postAuthorMemberId: '12314607',
        articleId: '100847768',
        commentId: '146833875',
        spaceId: '23462808',
        networkId: '4747401',
      }),
    });
    const result = await parseMnCommentEmail(raw);
    expect(result?.memberId).toBe('7698608');
  });

  it('captures a malformed comment text verbatim from the subject', async () => {
    const raw = buildRawEmail({
      subject: 'Joe Sixpack commented on your Post: Totally agree with this!',
      bodyHtml: buildRealisticBody({
        memberId: '5', memberName: 'Joe Sixpack', postAuthorMemberId: '6',
        articleId: '100', commentId: '200', spaceId: '300', networkId: '4747401',
      }),
    });
    const result = await parseMnCommentEmail(raw);
    expect(result?.commentText).toBe('Totally agree with this!');
    expect(result?.memberId).toBe('5');
  });

  it('accepts a Subject with a "Comment" target ("commented on your Comment")', async () => {
    const raw = buildRawEmail({
      subject: 'Jane Doe commented on your Comment: I agree',
      bodyHtml: buildRealisticBody({
        memberId: '7698608', memberName: 'Jane Doe', postAuthorMemberId: '12314607',
        articleId: '100847768', commentId: '146833875', spaceId: '23462808', networkId: '4747401',
      }),
    });
    const result = await parseMnCommentEmail(raw);
    expect(result).not.toBeNull();
    expect(result?.commentText).toBe('I agree');
  });

  it('synthesizes a stable commentId when the body only has the post URL', async () => {
    const raw = buildRawEmail({
      subject: 'K T commented on your Post: I agree',
      headers: { 'Message-Id': '<no-comment-id@mn.co>' },
      bodyHtml: `<html><body>
        <a href="https://emergent-commons.mn.co/members/123">K T</a>
        <a href="https://emergent-commons.mn.co/posts/100847768">Visit Post</a>
      </body></html>`,
    });
    const result = await parseMnCommentEmail(raw);
    expect(result?.articleId).toBe('100847768');
    expect(result?.commentId).toContain('msg-');
    expect(result?.commentId).toContain('no-comment-id@mn.co');
  });

  it('leaves spaceId empty when the space-url form is absent (not an error)', async () => {
    const raw = buildRawEmail({
      subject: 'Jane commented on your Post: I agree',
      bodyHtml: `<html><body>
        <a href="https://emergent-commons.mn.co/members/1">Jane</a>
        <a href="https://app.mn.co/8/spaces/99/posts/10/comments/20?x=1">See</a>
      </body></html>`,
    });
    const result = await parseMnCommentEmail(raw);
    expect(result?.articleId).toBe('10');
    expect(result?.commentId).toBe('20');
    expect(result?.spaceId).toBe('');
  });

  /*
   * Golden-file test: splices the real header file (`notification_email_header.txt`)
   * together with the real body file (`notification_email_body.html`)
   * from the repo root, and parses the result end-to-end. If MN ever
   * changes its notification shape, this is the first test to break.
   *
   * The header file's original body was PGP-encrypted by ProtonMail on
   * delivery - it is NOT the plaintext MN sent. We keep only the
   * headers (everything up to the first blank line) and splice in the
   * decrypted HTML body separately.
   */
  it('parses the real MN sample from notification_email_{header.txt,body.html}', async () => {
    const repoRoot = path.resolve(__dirname, '..');
    const headerPath = path.join(repoRoot, 'notification_email_header.txt');
    const bodyPath = path.join(repoRoot, 'notification_email_body.html');
    if (!fs.existsSync(headerPath) || fs.statSync(headerPath).size === 0) {
      /* File hasn't been repopulated yet - skip rather than fail. The
       * synthetic tests above still cover the same shape. */
      return;
    }

    const headerRaw = fs
      .readFileSync(headerPath, 'utf8')
      .replace(/\r?\n/g, '\r\n');
    const bodyRaw = fs
      .readFileSync(bodyPath, 'utf8')
      .replace(/\r?\n/g, '\r\n');
    const boundary = headerRaw.search(/\r\n\r\n/);
    const onlyHeaders = boundary >= 0 ? headerRaw.slice(0, boundary) : headerRaw;
    const reconstructed = `${onlyHeaders}\r\n\r\n${bodyRaw}`;

    const result = await parseMnCommentEmail(reconstructed);
    expect(result).not.toBeNull();
    expect(result).toMatchObject({
      fullName: 'Kevin Triplett',
      commentText: 'I agree',
      memberId: '7698608', // commenter (post author is 12314607)
      articleId: '100847768',
      commentId: '146833875',
      spaceId: '23462808',
      messageId: '69e2f12ac2342_588efe84114a@mn.co',
    });
  });
});
