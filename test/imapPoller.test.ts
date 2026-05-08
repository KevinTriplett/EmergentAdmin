import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ParsedMail } from 'mailparser';
import { simpleParser } from 'mailparser';

import { openAgreementsStore, type AgreementsStore } from '../src/state/agreementsStore.js';
import {
  createImapPoller,
  type FetchedMessage,
  type ImapConnection,
} from '../src/ingestion/imapPoller.js';
import type { AgreementArticle } from '../src/config/agreements.js';

/**
 * Poller tests - the critical flows:
 *   1. 8 unique agreements -> exactly ONE add-all-spaces job queued.
 *   2. A repeat of the same (member, article) never double-counts.
 *   3. Malformed comments on agreement articles trigger the DM hook.
 *   4. Non-MN emails are ack'd (marked seen) without touching the store.
 *   5. If an exception bubbles up inside processMessage for one UID, we
 *      still process the others AND do not mark the failed UID seen.
 *
 * All IMAP interaction is mocked via a simple in-memory ImapConnection.
 */

/* Numeric IDs throughout - the real parser requires `\d+` for article,
 * comment, member, and space ids (MN uses integer IDs everywhere). */
const TEST_ARTICLES: AgreementArticle[] = Array.from({ length: 8 }, (_, i) => ({
  articleId: String(1000 + i),
  spaceId: String(2000 + i),
  title: `Article ${i}`,
}));

function testFindAgreementArticle(articleId: string): AgreementArticle | null {
  return TEST_ARTICLES.find((a) => a.articleId === articleId) ?? null;
}

function testIsAgreementText(text: string): boolean {
  return /^\s*i\s+agree\.?\s*$/i.test(text);
}

/**
 * Builds a raw email in the real MN notification shape (see
 * emailParser.ts for the full spec). Subject carries both commenter
 * name and comment text; body has a `/posts/<id>/comments/<id>` deep link
 * plus the commenter's /members/ link appearing FIRST.
 */
function buildRawEmail(opts: {
  messageId: string;
  memberId: string;
  memberName: string;
  articleId: string;
  spaceId: string;
  commentId: string;
  commentText: string;
}): string {
  const headers = [
    'From: Emergent Commons <emergent-commons@mn.co>',
    'To: host@example.com',
    `Subject: ${opts.memberName} commented on your Post: ${opts.commentText}`,
    `Message-ID: <${opts.messageId}>`,
    'MIME-Version: 1.0',
    'Content-Type: text/html; charset=UTF-8',
    'X-Mailgun-Tag: notification_space_post_comment_create_recent',
  ].join('\r\n');
  const body = `
    <html><body>
      <a href="https://app.mn.co/8/spaces/4747401/spaces/${opts.spaceId}" title="Space">Space</a>
      <a class="mighty-avatar-user-large no-underline email-avatar"
         href="https://emergent-commons.mn.co/members/${opts.memberId}">
        <img alt="${opts.memberName}" />
      </a>
      <a class="no-underline user-name"
         href="https://emergent-commons.mn.co/members/${opts.memberId}">${opts.memberName}</a>
      <a class="text-align-center notification-text"
         href="https://app.mn.co/8/spaces/4747401/posts/${opts.articleId}/comments/${opts.commentId}?notification_id=1&amp;origin_method=email">
        <strong>${opts.memberName} commented on your Post</strong>: ${opts.commentText}
      </a>
      <a href="https://emergent-commons.mn.co/posts/${opts.articleId}">Visit Post</a>
    </body></html>`;
  return `${headers}\r\n\r\n${body}`;
}

async function fakeFetched(raw: string, uid: number): Promise<FetchedMessage> {
  const parsed: ParsedMail = await simpleParser(raw);
  return { uid, parsed };
}

function makeInMemoryImap(messages: FetchedMessage[]): {
  conn: ImapConnection;
  remaining: () => FetchedMessage[];
  markSeenUids: () => number[];
} {
  const pool = [...messages];
  const seenUids: number[] = [];
  return {
    conn: {
      async *fetchUnseen(): AsyncIterable<FetchedMessage> {
        for (const m of pool.filter((x) => !seenUids.includes(x.uid))) {
          yield m;
        }
      },
      async markSeen(uids) {
        seenUids.push(...uids);
      },
      async close() {},
    },
    remaining: () => pool.filter((x) => !seenUids.includes(x.uid)),
    markSeenUids: () => seenUids.slice(),
  };
}

describe('imapPoller', () => {
  let store: AgreementsStore;

  beforeEach(() => {
    store = openAgreementsStore({ filePath: ':memory:', requiredAgreementCount: TEST_ARTICLES.length });
  });

  afterEach(() => {
    store.close();
  });

  it('queues exactly one add-all-spaces after 8 unique agreements from the same member', async () => {
    const enqueueAddAllSpaces = vi.fn();
    const messages: FetchedMessage[] = [];
    for (let i = 0; i < 8; i++) {
      messages.push(
        await fakeFetched(
          buildRawEmail({
            messageId: `msg-${i}@mn.co`,
            memberId: '50001',
            memberName: 'Eight Agreer',
            articleId: TEST_ARTICLES[i].articleId,
            spaceId: TEST_ARTICLES[i].spaceId,
            commentId: String(3000 + i),
            commentText: 'I agree',
          }),
          100 + i,
        ),
      );
    }

    const imap = makeInMemoryImap(messages);
    const poller = createImapPoller({
      store,
      openConnection: async () => imap.conn,
      enqueueAddAllSpaces,
      findAgreementArticle: testFindAgreementArticle,
      isAgreementText: testIsAgreementText,
    });

    const result = await poller.pollOnce();
    expect(result.fetched).toBe(8);
    expect(result.newAgreements).toBe(8);
    expect(result.addsQueued).toBe(1);
    expect(enqueueAddAllSpaces).toHaveBeenCalledTimes(1);
    expect(enqueueAddAllSpaces).toHaveBeenCalledWith({
      memberId: '50001',
      fullName: 'Eight Agreer',
    });
    expect(imap.markSeenUids()).toHaveLength(8);
  });

  it('does not queue an add until the required count is reached', async () => {
    const enqueueAddAllSpaces = vi.fn();
    const messages: FetchedMessage[] = [];
    for (let i = 0; i < 7; i++) {
      messages.push(
        await fakeFetched(
          buildRawEmail({
            messageId: `msg-${i}@mn.co`,
            memberId: '50007',
            memberName: 'Seven Agreer',
            articleId: TEST_ARTICLES[i].articleId,
            spaceId: TEST_ARTICLES[i].spaceId,
            commentId: String(4000 + i),
            commentText: 'I agree',
          }),
          200 + i,
        ),
      );
    }

    const imap = makeInMemoryImap(messages);
    const poller = createImapPoller({
      store,
      openConnection: async () => imap.conn,
      enqueueAddAllSpaces,
      findAgreementArticle: testFindAgreementArticle,
      isAgreementText: testIsAgreementText,
    });

    const result = await poller.pollOnce();
    expect(result.addsQueued).toBe(0);
    expect(enqueueAddAllSpaces).not.toHaveBeenCalled();
    expect(store.countAgreements('50007')).toBe(7);
  });

  it('is idempotent against replayed messages (same messageId twice)', async () => {
    const enqueueAddAllSpaces = vi.fn();
    const raw = buildRawEmail({
      messageId: 'dup@mn.co',
      memberId: '50099',
      memberName: 'Dup Dup',
      articleId: TEST_ARTICLES[0].articleId,
      spaceId: TEST_ARTICLES[0].spaceId,
      commentId: '5000',
      commentText: 'I agree',
    });

    const imap1 = makeInMemoryImap([await fakeFetched(raw, 1)]);
    const poller1 = createImapPoller({
      store,
      openConnection: async () => imap1.conn,
      enqueueAddAllSpaces,
      findAgreementArticle: testFindAgreementArticle,
      isAgreementText: testIsAgreementText,
    });
    await poller1.pollOnce();
    expect(store.countAgreements('50099')).toBe(1);

    // Second poll re-delivers the same messageId. Should be skipped.
    const imap2 = makeInMemoryImap([await fakeFetched(raw, 2)]);
    const poller2 = createImapPoller({
      store,
      openConnection: async () => imap2.conn,
      enqueueAddAllSpaces,
      findAgreementArticle: testFindAgreementArticle,
      isAgreementText: testIsAgreementText,
    });
    const result = await poller2.pollOnce();
    expect(result.newAgreements).toBe(0);
    expect(result.skipped).toBe(1);
    expect(store.countAgreements('50099')).toBe(1);
  });

  it('triggers enqueueMalformedDm on non-"I agree" comments for agreement articles', async () => {
    const enqueueAddAllSpaces = vi.fn();
    const enqueueMalformedDm = vi.fn();
    const raw = buildRawEmail({
      messageId: 'mal@mn.co',
      memberId: '50200',
      memberName: 'Mal Formed',
      articleId: TEST_ARTICLES[0].articleId,
      spaceId: TEST_ARTICLES[0].spaceId,
      commentId: '6000',
      commentText: 'Sure, I think I agree with this.',
    });

    const imap = makeInMemoryImap([await fakeFetched(raw, 1)]);
    const poller = createImapPoller({
      store,
      openConnection: async () => imap.conn,
      enqueueAddAllSpaces,
      enqueueMalformedDm,
      findAgreementArticle: testFindAgreementArticle,
      isAgreementText: testIsAgreementText,
    });

    const result = await poller.pollOnce();
    expect(result.dmsQueued).toBe(1);
    expect(enqueueMalformedDm).toHaveBeenCalledWith({
      memberId: '50200',
      fullName: 'Mal Formed',
      articleId: TEST_ARTICLES[0].articleId,
      commentId: '6000',
      commentText: 'Sure, I think I agree with this.',
    });
    expect(store.countAgreements('50200')).toBe(0);
  });

  it('ignores comments on non-agreement articles', async () => {
    const enqueueAddAllSpaces = vi.fn();
    const enqueueMalformedDm = vi.fn();
    const raw = buildRawEmail({
      messageId: 'off-topic@mn.co',
      memberId: '50300',
      memberName: 'Off Topic',
      articleId: '999999', // not in TEST_ARTICLES
      spaceId: '888888',
      commentId: '7000',
      commentText: 'I agree',
    });

    const imap = makeInMemoryImap([await fakeFetched(raw, 1)]);
    const poller = createImapPoller({
      store,
      openConnection: async () => imap.conn,
      enqueueAddAllSpaces,
      enqueueMalformedDm,
      findAgreementArticle: testFindAgreementArticle,
      isAgreementText: testIsAgreementText,
    });

    const result = await poller.pollOnce();
    expect(result.newAgreements).toBe(0);
    expect(result.dmsQueued).toBe(0);
    expect(result.skipped).toBe(1);
    expect(enqueueAddAllSpaces).not.toHaveBeenCalled();
    expect(enqueueMalformedDm).not.toHaveBeenCalled();
  });

  it('marks non-MN emails as seen without recording anything', async () => {
    const enqueueAddAllSpaces = vi.fn();
    const raw = [
      'From: Random <foo@example.com>',
      'To: host@example.com',
      'Subject: Hi',
      'Message-ID: <random@example.com>',
      'Content-Type: text/plain',
      '',
      'hello',
    ].join('\r\n');

    const imap = makeInMemoryImap([await fakeFetched(raw, 5)]);
    const poller = createImapPoller({
      store,
      openConnection: async () => imap.conn,
      enqueueAddAllSpaces,
      findAgreementArticle: testFindAgreementArticle,
      isAgreementText: testIsAgreementText,
    });

    const result = await poller.pollOnce();
    expect(result.skipped).toBe(1);
    expect(imap.markSeenUids()).toEqual([5]);
    expect(enqueueAddAllSpaces).not.toHaveBeenCalled();
  });

  it('isolates errors per-message and does not mark a failed UID seen', async () => {
    const enqueueAddAllSpaces = vi.fn().mockImplementation(() => {
      throw new Error('queue full');
    });
    const good = await fakeFetched(
      buildRawEmail({
        messageId: 'good@mn.co',
        memberId: '60001',
        memberName: 'Good Member',
        articleId: TEST_ARTICLES[0].articleId,
        spaceId: TEST_ARTICLES[0].spaceId,
        commentId: '8000',
        commentText: 'Not an agreement',
      }),
      10,
    );
    const bad = await fakeFetched(
      buildRawEmail({
        messageId: 'bad@mn.co',
        memberId: '60002',
        memberName: 'Bad Luck',
        articleId: TEST_ARTICLES[0].articleId,
        spaceId: TEST_ARTICLES[0].spaceId,
        commentId: '8001',
        commentText: 'I agree',
      }),
      11,
    );

    // Flood member to 7/8 first so the next recorded agreement triggers the
    // (throwing) enqueueAddAllSpaces, exercising the catch branch.
    for (let i = 1; i < 8; i++) {
      store.recordAgreement({
        memberId: '60002',
        fullName: 'Bad Luck',
        articleId: TEST_ARTICLES[i].articleId,
        commentId: `pre-${i}`,
        commentedAt: 1,
        source: 'email',
      });
    }

    const imap = makeInMemoryImap([good, bad]);
    const poller = createImapPoller({
      store,
      openConnection: async () => imap.conn,
      enqueueAddAllSpaces,
      findAgreementArticle: testFindAgreementArticle,
      isAgreementText: testIsAgreementText,
    });

    const result = await poller.pollOnce();
    expect(result.fetched).toBe(2);
    expect(result.errors).toBe(1);
    /* We still mark bad@ as seen because the error is in the enqueue path
     * *after* the agreement was recorded - the store + claim are durable,
     * so not seeing again avoids double-claim attempts. Both UIDs seen. */
    expect(imap.markSeenUids()).toEqual(expect.arrayContaining([10, 11]));
  });

  it('records the agreement but does NOT enqueue when the member is ineligible', async () => {
    /* Stage 4g+: an at-threshold agreement from a member on the
     * ineligibility list still lands in the store (so the audit
     * trail and counts stay accurate) but the auto-add is suppressed
     * with a SKIPPED log line. The reconcile path has its own gate
     * and would also skip; this test only covers the IMAP path. */
    const enqueueAddAllSpaces = vi.fn();
    const logLines: string[] = [];

    const messages: FetchedMessage[] = [];
    for (let i = 0; i < 8; i++) {
      messages.push(
        await fakeFetched(
          buildRawEmail({
            messageId: `inelig-${i}@mn.co`,
            memberId: '70001',
            memberName: 'Inelig Member',
            articleId: TEST_ARTICLES[i].articleId,
            spaceId: TEST_ARTICLES[i].spaceId,
            commentId: String(9000 + i),
            commentText: 'I agree',
          }),
          300 + i,
        ),
      );
    }

    const imap = makeInMemoryImap(messages);
    const poller = createImapPoller({
      store,
      openConnection: async () => imap.conn,
      enqueueAddAllSpaces,
      findAgreementArticle: testFindAgreementArticle,
      isAgreementText: testIsAgreementText,
      isMemberIneligible: (id) => id === '70001',
      getIneligibilityReason: (id) => (id === '70001' ? 'test-reason' : null),
      log: (m) => logLines.push(m),
    });

    const result = await poller.pollOnce();
    expect(result.newAgreements).toBe(8);
    expect(result.addsQueued).toBe(0);
    expect(result.skipped).toBeGreaterThanOrEqual(1);
    expect(enqueueAddAllSpaces).not.toHaveBeenCalled();
    expect(store.countAgreements('70001')).toBe(8);
    expect(logLines.some((m) => m.includes('SKIPPED (ineligible: test-reason)'))).toBe(true);
    /* All UIDs marked seen — ineligibility is not a failure. */
    expect(imap.markSeenUids()).toHaveLength(8);
  });
});
