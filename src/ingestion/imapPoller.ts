import type { ParsedMail } from 'mailparser';
import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';

import type { AgreementsStore } from '../state/agreementsStore.js';
import { extractFromParsed } from './emailParser.js';
import {
  findAgreementArticle as defaultFindAgreementArticle,
  isAgreementText as defaultIsAgreementText,
  type AgreementArticle,
} from '../config/agreements.js';

/**
 * The IMAP poller is the live ingestion path for Stage 4a. Every N minutes
 * it asks the mailbox for unseen messages, hands each one to the parser,
 * records valid agreements in the store, and on the 8th unique agreement
 * per member atomically claims the right to enqueue an add-all-spaces job.
 *
 * All IMAP interaction is funnelled through the `ImapConnection` interface
 * below so tests can swap in an in-memory mailbox. The real wrapper lives
 * at the bottom of this file (`openImapConnection`).
 *
 * Crash safety:
 *   - We mark a message seen in IMAP *after* we commit to the store. A
 *     crash in between means on restart we'll re-fetch and re-parse it,
 *     but the store's `(member, article)` primary key + `processed_emails`
 *     dedup mean the second attempt is a no-op.
 */

export type FetchedMessage = {
  uid: number;
  parsed: ParsedMail;
};

export interface ImapConnection {
  fetchUnseen(): AsyncIterable<FetchedMessage>;
  markSeen(uids: number[]): Promise<void>;
  close(): Promise<void>;
}

export type AddAllSpacesTrigger = (input: { memberId: string; fullName: string }) => void;
export type MalformedDmTrigger = (input: {
  memberId: string;
  fullName: string;
  articleId: string;
  commentId: string;
  commentText: string;
}) => void;

export type ImapPollerDeps = {
  store: AgreementsStore;
  openConnection: () => Promise<ImapConnection>;
  enqueueAddAllSpaces: AddAllSpacesTrigger;
  /** Optional in Stage 4a; wired in 4b. If undefined we just count & log malformed comments. */
  enqueueMalformedDm?: MalformedDmTrigger;
  /** Injectable for tests. Defaults to the production `AGREEMENT_ARTICLES` lookup. */
  findAgreementArticle?: (articleId: string) => AgreementArticle | null;
  /** Injectable for tests. Defaults to the production `AGREE_PATTERN` matcher. */
  isAgreementText?: (text: string) => boolean;
  log?: (message: string) => void;
};

export type PollResult = {
  fetched: number;
  newAgreements: number;
  duplicates: number;
  addsQueued: number;
  dmsQueued: number;
  skipped: number;
  errors: number;
};

export interface ImapPoller {
  pollOnce(): Promise<PollResult>;
  start(intervalMs: number): void;
  stop(): void;
}

export function createImapPoller(deps: ImapPollerDeps): ImapPoller {
  const log = deps.log ?? (() => undefined);
  const findAgreementArticle = deps.findAgreementArticle ?? defaultFindAgreementArticle;
  const isAgreementText = deps.isAgreementText ?? defaultIsAgreementText;
  let timer: NodeJS.Timeout | null = null;
  let polling = false;

  async function pollOnce(): Promise<PollResult> {
    if (polling) {
      /* Overlapping ticks (a slow IMAP round-trip + short interval) would
       * double-process the same UIDs if both reached fetchUnseen before
       * markSeen. The `processed_emails` table protects the store anyway,
       * but skipping overlapping ticks keeps the log tidy. */
      log('imapPoller: skipping tick - previous poll still running');
      return { fetched: 0, newAgreements: 0, duplicates: 0, addsQueued: 0, dmsQueued: 0, skipped: 0, errors: 0 };
    }
    polling = true;
    const result: PollResult = {
      fetched: 0,
      newAgreements: 0,
      duplicates: 0,
      addsQueued: 0,
      dmsQueued: 0,
      skipped: 0,
      errors: 0,
    };

    let conn: ImapConnection | null = null;
    try {
      conn = await deps.openConnection();
      const uidsToMarkSeen: number[] = [];

      for await (const msg of conn.fetchUnseen()) {
        result.fetched += 1;
        try {
          const handled = await processMessage(msg, result);
          if (handled) uidsToMarkSeen.push(msg.uid);
        } catch (err) {
          result.errors += 1;
          log(
            `imapPoller: error processing uid=${msg.uid}: ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
          /*
           * Intentionally NOT marking seen so a transient failure can be
           * retried next tick. If the error is persistent (e.g. a parser
           * exception) the admin will notice from the log and can manually
           * mark the offending UID seen in the mailbox.
           */
        }
      }

      if (uidsToMarkSeen.length > 0) {
        await conn.markSeen(uidsToMarkSeen);
      }
    } catch (err) {
      result.errors += 1;
      log(
        `imapPoller: top-level error: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    } finally {
      polling = false;
      if (conn) await conn.close().catch(() => undefined);
    }
    return result;
  }

  /**
   * Returns true iff the message should be marked \Seen after this tick.
   * We always mark processed emails as seen, even when they weren't an
   * agreement - otherwise an unrelated notification would re-enter the
   * "unseen" pool on every single tick forever.
   */
  async function processMessage(msg: FetchedMessage, result: PollResult): Promise<boolean> {
    const messageId = (msg.parsed.messageId ?? '').trim();
    if (!messageId) {
      result.skipped += 1;
      return true;
    }

    if (deps.store.hasProcessedEmail(messageId)) {
      result.skipped += 1;
      return true;
    }

    const parsed = extractFromParsed(msg.parsed);
    if (!parsed) {
      deps.store.markEmailProcessed(messageId);
      result.skipped += 1;
      return true;
    }

    const article = findAgreementArticle(parsed.articleId);
    if (!article) {
      // A comment on a non-agreement post. Record as processed and move on.
      deps.store.markEmailProcessed(messageId);
      result.skipped += 1;
      return true;
    }

    if (isAgreementText(parsed.commentText)) {
      const record = deps.store.recordAgreement({
        memberId: parsed.memberId,
        fullName: parsed.fullName,
        articleId: parsed.articleId,
        commentId: parsed.commentId,
        commentedAt: Date.now(),
        source: 'email',
      });
      if (record.outcome === 'inserted') result.newAgreements += 1;
      else result.duplicates += 1;

      if (deps.store.claimAddForMember(parsed.memberId)) {
        try {
          deps.enqueueAddAllSpaces({
            memberId: parsed.memberId,
            fullName: parsed.fullName,
          });
          result.addsQueued += 1;
          log(`imapPoller: member ${parsed.fullName} (${parsed.memberId}) reached required agreements - add-all-spaces enqueued`);
        } catch (err) {
          /* If enqueue somehow fails we leave the member marked as added
           * so we don't quickly repeat. Stage 4c reconciliation will catch
           * any subsequent gap. Admin is warned via log + email. */
          result.errors += 1;
          log(
            `imapPoller: enqueueAddAllSpaces threw for ${parsed.memberId}: ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
        }
      }
    } else {
      // Malformed comment on an agreement article - queue a DM (4b).
      if (deps.enqueueMalformedDm) {
        try {
          deps.enqueueMalformedDm({
            memberId: parsed.memberId,
            fullName: parsed.fullName,
            articleId: parsed.articleId,
            commentId: parsed.commentId,
            commentText: parsed.commentText,
          });
          result.dmsQueued += 1;
        } catch (err) {
          result.errors += 1;
          log(
            `imapPoller: enqueueMalformedDm threw for ${parsed.memberId}: ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
        }
      } else {
        log(
          `imapPoller: malformed agreement comment from ${parsed.fullName} (${parsed.memberId}) on ${parsed.articleId}: "${parsed.commentText.slice(0, 80)}" (DM trigger not wired)`,
        );
      }
    }

    deps.store.markEmailProcessed(messageId);
    return true;
  }

  return {
    pollOnce,
    start(intervalMs) {
      if (timer) return;
      const tick = (): void => {
        void pollOnce().catch((e) =>
          log(`imapPoller: unhandled pollOnce rejection: ${e instanceof Error ? e.message : String(e)}`),
        );
      };
      tick();
      timer = setInterval(tick, intervalMs);
    },
    stop() {
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Real IMAP connection wrapper (imapflow + mailparser)
// ---------------------------------------------------------------------------

export type ImapConfig = {
  host: string;
  port: number;
  secure: boolean;
  user: string;
  pass: string;
  mailbox?: string;
};

/**
 * Production ImapConnection built on top of imapflow. Re-connects on every
 * poll - MN's mailbox is low-volume and a fresh connection avoids the
 * long-lived IMAP idle / NOOP dance. We lock + search + fetch + flag + unlock
 * sequentially inside one mailbox lock.
 */
export async function openImapConnection(cfg: ImapConfig): Promise<ImapConnection> {
  const client = new ImapFlow({
    host: cfg.host,
    port: cfg.port,
    secure: cfg.secure,
    auth: { user: cfg.user, pass: cfg.pass },
    logger: false,
  });

  await client.connect();
  const lock = await client.getMailboxLock(cfg.mailbox ?? 'INBOX');

  return {
    async *fetchUnseen(): AsyncIterable<FetchedMessage> {
      for await (const msg of client.fetch(
        { seen: false },
        { uid: true, source: true },
      )) {
        if (!msg.source) continue;
        const parsed = await simpleParser(msg.source as Buffer);
        yield { uid: msg.uid, parsed };
      }
    },
    async markSeen(uids) {
      if (uids.length === 0) return;
      await client.messageFlagsAdd({ uid: uids.join(',') }, ['\\Seen'], { uid: true });
    },
    async close() {
      try {
        lock.release();
      } catch {
        /* already released */
      }
      await client.logout().catch(() => undefined);
    },
  };
}
