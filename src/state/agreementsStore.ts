import Database from 'better-sqlite3';
import type { Database as SqliteDatabase } from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';

/**
 * SQLite-backed state for the Agreements Watcher.
 *
 * Design notes:
 * - Tables are created idempotently on `open` so there's no separate migration
 *   step yet. When the schema grows beyond 4a we'll adopt a real migrations
 *   runner; for now `CREATE TABLE IF NOT EXISTS` is enough.
 * - All mutating ops that must be atomic are wrapped in a single SQLite
 *   transaction so a crash can never leave a half-committed agreement that
 *   would be double-counted on replay.
 * - The store is deliberately synchronous (better-sqlite3) because every
 *   caller is already single-threaded Node code - no pool, no async/await
 *   noise, much faster for this tiny dataset.
 */

export type AgreementSource = 'email' | 'reconciliation';

export type RecordAgreementInput = {
  memberId: string;
  fullName: string;
  articleId: string;
  commentId: string;
  commentedAt: number;
  source: AgreementSource;
};

export type RecordAgreementResult = {
  /** 'inserted' = first time we've recorded this (member, article). 'duplicate' = already present. */
  outcome: 'inserted' | 'duplicate';
  /** Current distinct-article agreement count for this member after the op. */
  agreementCount: number;
};

export type EligibleCommonsMember = {
  memberId: string;
  fullName: string;
  agreementCount: number;
};

export interface AgreementsStore {
  recordAgreement(input: RecordAgreementInput): RecordAgreementResult;
  countAgreements(memberId: string): number;
  isMemberAdded(memberId: string): boolean;
  /**
   * Atomically check "has the member reached the required count and not yet
   * been marked added?" and, if so, flip `members.added_at`. Returns true iff
   * the caller is the one who should enqueue the add-all-spaces job.
   *
   * This is the critical dedup knob that prevents two concurrent callers
   * (e.g. the IMAP poller and a manual reconciliation run) from both
   * enqueuing an add for the same member.
   */
  claimAddForMember(memberId: string, when?: number): boolean;
  hasProcessedEmail(messageId: string): boolean;
  markEmailProcessed(messageId: string, processedAt?: number): void;
  getMemberFullName(memberId: string): string | null;
  /**
   * Members whose recorded agreement rows meet or exceed `requiredAgreementCount`
   * (distinct `article_id` per member). Stage 4c uses this list to enqueue
   * repair runs without scraping MN HTML.
   */
  listMembersEligibleForCommonsAdd(): readonly EligibleCommonsMember[];
  close(): void;
}

export type OpenStoreOptions = {
  /** Filesystem path. Use ':memory:' for tests. */
  filePath: string;
  /** Required agreements for the "ready to add" threshold. */
  requiredAgreementCount: number;
};

const SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS members (
    member_id TEXT PRIMARY KEY,
    full_name TEXT NOT NULL,
    added_at INTEGER
  );

  CREATE TABLE IF NOT EXISTS agreements (
    member_id TEXT NOT NULL,
    article_id TEXT NOT NULL,
    comment_id TEXT NOT NULL,
    commented_at INTEGER NOT NULL,
    source TEXT NOT NULL CHECK (source IN ('email','reconciliation')),
    PRIMARY KEY (member_id, article_id),
    FOREIGN KEY (member_id) REFERENCES members(member_id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS processed_emails (
    message_id TEXT PRIMARY KEY,
    processed_at INTEGER NOT NULL
  );

  /*
   * dms_sent lands its schema in 4a so Stage 4b can flip on writes without a
   * migration. One row = one DM we've actually delivered, so the poller
   * and (later) reconciliation never re-nag a member about the same
   * malformed comment.
   */
  CREATE TABLE IF NOT EXISTS dms_sent (
    member_id TEXT NOT NULL,
    article_id TEXT NOT NULL,
    sent_at INTEGER NOT NULL,
    PRIMARY KEY (member_id, article_id)
  );
`;

export function openAgreementsStore(opts: OpenStoreOptions): AgreementsStore {
  const { filePath, requiredAgreementCount } = opts;

  if (filePath !== ':memory:') {
    const dir = path.dirname(path.resolve(filePath));
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  }

  const db: SqliteDatabase = new Database(filePath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA_SQL);

  const statements = {
    upsertMember: db.prepare<[string, string]>(
      `INSERT INTO members (member_id, full_name) VALUES (?, ?)
       ON CONFLICT(member_id) DO UPDATE SET full_name = excluded.full_name
       WHERE excluded.full_name <> members.full_name`,
    ),
    insertAgreement: db.prepare<[string, string, string, number, AgreementSource]>(
      `INSERT OR IGNORE INTO agreements (member_id, article_id, comment_id, commented_at, source)
       VALUES (?, ?, ?, ?, ?)`,
    ),
    countAgreements: db.prepare<[string]>(
      `SELECT COUNT(*) AS n FROM agreements WHERE member_id = ?`,
    ),
    selectMember: db.prepare<[string]>(
      `SELECT added_at FROM members WHERE member_id = ?`,
    ),
    selectMemberName: db.prepare<[string]>(
      `SELECT full_name FROM members WHERE member_id = ?`,
    ),
    markAdded: db.prepare<[number, string]>(
      `UPDATE members SET added_at = ? WHERE member_id = ? AND added_at IS NULL`,
    ),
    hasProcessedEmail: db.prepare<[string]>(
      `SELECT 1 FROM processed_emails WHERE message_id = ?`,
    ),
    markEmailProcessed: db.prepare<[string, number]>(
      `INSERT OR IGNORE INTO processed_emails (message_id, processed_at) VALUES (?, ?)`,
    ),
    eligibleForCommons: db.prepare(
      `SELECT m.member_id, m.full_name, COUNT(DISTINCT a.article_id) AS agreement_count
       FROM members m
       INNER JOIN agreements a ON a.member_id = m.member_id
       GROUP BY m.member_id, m.full_name
       HAVING agreement_count >= ?`,
    ),
  };

  /**
   * The body of recordAgreement runs inside a transaction so the upsert of
   * the member row and the insert of the agreement row commit or fail as a
   * unit. Without this a crash between the two could leave agreements
   * pointing at an unknown member.
   */
  const recordAgreementTx = db.transaction((input: RecordAgreementInput): RecordAgreementResult => {
    statements.upsertMember.run(input.memberId, input.fullName);
    const res = statements.insertAgreement.run(
      input.memberId,
      input.articleId,
      input.commentId,
      input.commentedAt,
      input.source,
    );
    const count = (statements.countAgreements.get(input.memberId) as { n: number }).n;
    return {
      outcome: res.changes > 0 ? 'inserted' : 'duplicate',
      agreementCount: count,
    };
  });

  /**
   * claimAddForMember is the dedup guardrail: it atomically checks
   * `count >= requiredAgreementCount AND added_at IS NULL`, and if true
   * stamps added_at. The `UPDATE ... WHERE added_at IS NULL` makes this
   * last-write-wins free: only the first concurrent caller sees `changes > 0`.
   */
  const claimAddTx = db.transaction((memberId: string, when: number): boolean => {
    const row = statements.selectMember.get(memberId) as { added_at: number | null } | undefined;
    if (!row) return false;
    if (row.added_at !== null) return false;

    const count = (statements.countAgreements.get(memberId) as { n: number }).n;
    if (count < requiredAgreementCount) return false;

    const res = statements.markAdded.run(when, memberId);
    return res.changes > 0;
  });

  return {
    recordAgreement(input) {
      return recordAgreementTx(input);
    },
    countAgreements(memberId) {
      return (statements.countAgreements.get(memberId) as { n: number }).n;
    },
    isMemberAdded(memberId) {
      const row = statements.selectMember.get(memberId) as { added_at: number | null } | undefined;
      return Boolean(row && row.added_at !== null);
    },
    claimAddForMember(memberId, when = Date.now()) {
      return claimAddTx(memberId, when);
    },
    hasProcessedEmail(messageId) {
      return statements.hasProcessedEmail.get(messageId) !== undefined;
    },
    markEmailProcessed(messageId, processedAt = Date.now()) {
      statements.markEmailProcessed.run(messageId, processedAt);
    },
    getMemberFullName(memberId) {
      const row = statements.selectMemberName.get(memberId) as { full_name: string } | undefined;
      return row?.full_name ?? null;
    },
    listMembersEligibleForCommonsAdd() {
      const rows = statements.eligibleForCommons.all(
        requiredAgreementCount,
      ) as Array<{ member_id: string; full_name: string; agreement_count: number }>;
      return rows.map((r) => ({
        memberId: r.member_id,
        fullName: r.full_name,
        agreementCount: r.agreement_count,
      }));
    },
    close() {
      db.close();
    },
  };
}
