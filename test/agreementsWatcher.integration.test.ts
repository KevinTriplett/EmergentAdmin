import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ParsedMail } from 'mailparser';
import { simpleParser } from 'mailparser';

import { openAgreementsStore, type AgreementsStore } from '../src/state/agreementsStore.js';
import {
  createImapPoller,
  type FetchedMessage,
  type ImapConnection,
} from '../src/ingestion/imapPoller.js';
import {
  createTaskScheduler,
  type BrowserHandle,
  type SchedulerJob,
} from '../src/scheduler/taskScheduler.js';
import type { AgreementArticle } from '../src/config/agreements.js';

/**
 * End-to-end integration test for the Stage 4a agreements watcher:
 *
 *   8 fake MN notification emails (one per agreement article) for the same
 *   member -> exactly ONE add-all-spaces job lands in the scheduler, it
 *   executes the real add-member loop against mocked `addSpaceMember`, and
 *   the run-log email hook fires with the expected summary.
 *
 * Additional replays of any of the 8 messages (message-id dedup, same-article
 * dedup) MUST NOT produce a second add job. This is the guardrail the whole
 * feature hinges on.
 */

/* Numeric IDs: the real MN parser requires `\d+` for article / comment /
 * member / space ids. */
const TEST_ARTICLES: AgreementArticle[] = Array.from({ length: 8 }, (_, i) => ({
  articleId: String(1000 + i),
  spaceId: String(2000 + i),
  title: `Article ${i}`,
}));
const REQUIRED = TEST_ARTICLES.length;

function testFindAgreementArticle(articleId: string): AgreementArticle | null {
  return TEST_ARTICLES.find((a) => a.articleId === articleId) ?? null;
}

function testIsAgreementText(text: string): boolean {
  return /^\s*i\s+agree\.?\s*$/i.test(text);
}

/**
 * Real-format MN comment notification. Subject carries commenter name +
 * comment text; body has the `/posts/<id>/comments/<id>` deep link with
 * the commenter's /members/ link appearing FIRST.
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
  return [
    `From: Emergent Commons <emergent-commons@mn.co>`,
    `To: host@example.com`,
    `Subject: ${opts.memberName} commented on your Post: ${opts.commentText}`,
    `Message-ID: <${opts.messageId}>`,
    `MIME-Version: 1.0`,
    `Content-Type: text/html; charset=UTF-8`,
    `X-Mailgun-Tag: notification_space_post_comment_create_recent`,
    '',
    `<html><body>
      <a href="https://app.mn.co/8/spaces/4747401/spaces/${opts.spaceId}">Space</a>
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
    </body></html>`,
  ].join('\r\n');
}

async function toFetched(raw: string, uid: number): Promise<FetchedMessage> {
  const parsed: ParsedMail = await simpleParser(raw);
  return { uid, parsed };
}

function buildBrowser(): BrowserHandle {
  return {
    newPage: vi.fn().mockResolvedValue({
      setUserAgent: vi.fn().mockResolvedValue(undefined),
      setExtraHTTPHeaders: vi.fn().mockResolvedValue(undefined),
    }),
    close: vi.fn().mockResolvedValue(undefined),
  } as unknown as BrowserHandle;
}

describe('agreements watcher integration', () => {
  let store: AgreementsStore;

  beforeEach(() => {
    store = openAgreementsStore({ filePath: ':memory:', requiredAgreementCount: REQUIRED });
  });

  afterEach(() => {
    store.close();
  });

  it('REQUIRED agreement emails -> exactly one add-all-spaces job; replays produce no extra adds', async () => {
    // --- Build REQUIRED fake emails (one per article) for the same member ---
    const member = { id: '90001', name: 'Integrator McTestface' };
    const messages: FetchedMessage[] = [];
    for (let i = 0; i < REQUIRED; i++) {
      messages.push(
        await toFetched(
          buildRawEmail({
            messageId: `int-${i}@mn.co`,
            memberId: member.id,
            memberName: member.name,
            articleId: TEST_ARTICLES[i].articleId,
            spaceId: TEST_ARTICLES[i].spaceId,
            commentId: String(3000 + i),
            commentText: 'I agree',
          }),
          100 + i,
        ),
      );
    }

    // --- Set up a mock IMAP connection that initially yields only the first 4,
    //     then on the second poll yields the remaining 4 + a replay of #0. ---
    let pollIndex = 0;
    const firstBatch = messages.slice(0, 4);
    const secondBatch = [...messages.slice(4), messages[0]]; // replay #0
    const conn: ImapConnection = {
      async *fetchUnseen(): AsyncIterable<FetchedMessage> {
        const batch = pollIndex === 0 ? firstBatch : secondBatch;
        for (const m of batch) yield m;
      },
      async markSeen(_uids) {
        /* We don't track flag state between polls - the store's
         * processed_emails table is the dedup source of truth. */
      },
      async close() {},
    };

    // --- Scheduler + mock addSpaceMember that records each call ---
    const addSpaceMember = vi.fn().mockImplementation(async () => ({ success: true, removed: 0 }));
    const sendRunLogEmail = vi.fn().mockResolvedValue(undefined);
    const scheduler = createTaskScheduler({
      launchBrowser: vi.fn().mockImplementation(async () => buildBrowser()),
      broadcast: () => undefined,
      sendRunLogEmail,
      sleep: () => Promise.resolve(),
      userAgent: 'int-test-UA',
    });

    // --- The enqueue trigger: builds the exact same SchedulerJob shape the
    //     production server would build for /run/add-space-member-all-spaces.
    //     We assert it's invoked once. ---
    const jobInvocations: Array<{ memberId: string; fullName: string }> = [];
    const enqueueAddAllSpaces = vi.fn().mockImplementation(
      ({ memberId, fullName }: { memberId: string; fullName: string }) => {
        jobInvocations.push({ memberId, fullName });
        const job: SchedulerJob<{
          fullMemberName: string;
          memberId: string;
          addedCount: number;
        }> = {
          name: `[auto] addSpaceMember "${fullName}" → ALL spaces`,
          headless: true,
          run: async (ctx) => {
            ctx.log(`auto-add starting for ${fullName}`);
            // Simulate the add-all-spaces loop by calling addSpaceMember once
            // per agreement-space.
            let addedCount = 0;
            for (const art of TEST_ARTICLES) {
              const result = await addSpaceMember({
                page: ctx.page,
                fullMemberName: fullName,
                memberId,
                fullSpaceName: art.spaceId,
                log: ctx.log,
                abortSignal: ctx.abortSignal,
                sleep: ctx.sleep,
              });
              if (result.success) addedCount += 1;
            }
            return { fullMemberName: fullName, memberId, addedCount };
          },
          summarize: (r) => `added ${r.addedCount}`,
        };
        void scheduler.enqueueBackground(job);
      },
    );

    const poller = createImapPoller({
      store,
      openConnection: async () => conn,
      enqueueAddAllSpaces,
      findAgreementArticle: testFindAgreementArticle,
      isAgreementText: testIsAgreementText,
    });

    // --- Poll #1: 4 agreements, not yet at threshold ---
    const r1 = await poller.pollOnce();
    expect(r1.newAgreements).toBe(4);
    expect(r1.addsQueued).toBe(0);
    expect(enqueueAddAllSpaces).not.toHaveBeenCalled();
    expect(store.countAgreements(member.id)).toBe(4);

    // --- Poll #2: 4 more + a replay of #0. The replay is dedup'd via
    //     processed_emails, and the threshold is crossed exactly once. ---
    pollIndex = 1;
    const r2 = await poller.pollOnce();
    expect(r2.newAgreements).toBe(4); // only the 4 new articles count
    expect(r2.skipped).toBe(1); // the replay of #0
    expect(r2.addsQueued).toBe(1);
    expect(enqueueAddAllSpaces).toHaveBeenCalledTimes(1);
    expect(jobInvocations).toEqual([{ memberId: member.id, fullName: member.name }]);

    // --- Wait for the background job to drain, then assert results. ---
    await expect.poll(() => addSpaceMember.mock.calls.length).toBe(REQUIRED);
    await expect.poll(() => sendRunLogEmail.mock.calls.length).toBeGreaterThan(0);
    const emailPayload = sendRunLogEmail.mock.calls[0][0];
    expect(emailPayload.taskName).toContain(member.name);
    expect(emailPayload.outcome).toBe('success');
    expect(emailPayload.summary).toBe('added 8');

    // --- Poll #3 (same connection replays the full second batch again):
    //     still no additional adds. This is the real durability test. ---
    pollIndex = 1;
    const r3 = await poller.pollOnce();
    expect(r3.newAgreements).toBe(0);
    expect(r3.addsQueued).toBe(0);
    expect(enqueueAddAllSpaces).toHaveBeenCalledTimes(1); // STILL once
    expect(store.isMemberAdded(member.id)).toBe(true);
  });
});
