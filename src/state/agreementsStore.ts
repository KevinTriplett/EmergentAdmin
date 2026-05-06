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

/**
 * Stage 4e change-of-heart audit verdict for one (member, article) pair.
 *
 *   happy            - exactly one current comment, matches AGREE_PATTERN.
 *   deleted          - no current comment from this member.
 *   edited           - exactly one current comment, does NOT match AGREE_PATTERN.
 *   mixed            - multiple current comments, at least one does NOT match.
 *   multi_agreement  - multiple current comments, all match.
 *
 * Rows whose audit_state is in ('deleted','edited','mixed') are EXCLUDED from
 * a member's effective agreement count (Q5 / spec: "decrease the agreement
 * count" for cases 1/2/3). NULL (never audited), 'happy', and
 * 'multi_agreement' all count toward eligibility.
 */
export type AuditState = 'happy' | 'deleted' | 'edited' | 'mixed' | 'multi_agreement';

const AUDIT_STATES_VALID = ['happy', 'multi_agreement'] as const;

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
  /** Current distinct-article agreement count for this member after the op (audit-aware: invalidated rows excluded). */
  agreementCount: number;
};

export type EligibleCommonsMember = {
  memberId: string;
  fullName: string;
  agreementCount: number;
};

export type AgreementProgressMember = {
  memberId: string;
  fullName: string;
  distinctAgreementArticles: number;
};

export type GetAgreementsOverviewOpts = {
  /** Max rows returned for eligible + in-progress lists (counts stay exact). Default 250. */
  maxListedMembers?: number;
};

/** Read-only rollup for Stage 4d admin UI / JSON status endpoint. */
export type AgreementsOverview = {
  requiredAgreementCount: number;
  distinctMembersWithAgreement: number;
  totalAgreementRows: number;
  eligibleCount: number;
  inProgressMemberCount: number;
  commonsAddedMemberCount: number;
  processedEmailCount: number;
  eligibleMembers: readonly EligibleCommonsMember[];
  inProgressMembers: readonly AgreementProgressMember[];
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
  getAgreementsOverview(opts?: GetAgreementsOverviewOpts): AgreementsOverview;

  // ---- Stage 4e: change-of-heart audit -------------------------------------
  /**
   * Distinct members who have AT LEAST ONE row in `agreements` for the given
   * article, regardless of `audit_state`. The change-of-heart audit uses this
   * to know whom to look for on the rendered post page; flagged-as-invalid
   * rows are still listed because the audit needs to be able to upgrade them
   * back to valid (e.g. when the member re-posts an "I agree" comment).
   */
  listMembersForArticle(articleId: string): readonly { memberId: string; fullName: string }[];
  /**
   * Write the audit verdict for a single (member, article) pair. Silently
   * no-ops when no such row exists - the audit job only iterates known
   * (member, article) pairs from `listMembersForArticle`, so a missing row
   * means the member's agreement was deleted between the listing call and
   * the write, which the next audit pass will catch idempotently anyway.
   */
  recordAuditOutcome(memberId: string, articleId: string, state: AuditState, when?: number): void;
  /** Read back the last audit verdict for a (member, article); null when no row or never audited. */
  getAuditState(memberId: string, articleId: string): AuditState | null;

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

/**
 * Idempotent column-add. SQLite can't do `ALTER TABLE ... ADD COLUMN IF NOT
 * EXISTS`, so we read the table_info pragma and only ALTER when the column is
 * actually missing. Safe to call on every open; runs zero ALTERs once the
 * column already exists.
 */
function ensureColumn(
  db: SqliteDatabase,
  table: string,
  column: string,
  definition: string,
): void {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  if (!cols.some((c) => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

/**
 * SQL fragment that filters `agreements` rows down to those still counting
 * toward a member's effective agreement total. Centralised so every count /
 * eligibility query stays in lock-step with `recordAuditOutcome`'s state set.
 */
const AGREEMENT_VALID_WHERE = `(audit_state IS NULL OR audit_state IN ('happy','multi_agreement'))`;

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

  /* Stage 4e schema additions. Kept as ALTER (not in SCHEMA_SQL) so older DBs
   * created under Stage 4a-4d migrate forward on first open. */
  ensureColumn(db, 'agreements', 'audit_state', 'TEXT');
  ensureColumn(db, 'agreements', 'audit_at', 'INTEGER');

  const statements = {
    upsertMember: db.prepare<[string, string]>(
      `INSERT INTO members (member_id, full_name) VALUES (?, ?)
       ON CONFLICT(member_id) DO UPDATE SET full_name = excluded.full_name
       WHERE excluded.full_name <> members.full_name`,
    ),
    /*
     * Upsert that resets audit_state to NULL on re-record. Stage 4e: when a
     * row was previously flagged 'deleted'/'edited'/'mixed' and a fresh
     * "I agree" arrives via the IMAP poller for the same (member, article),
     * we want the row to count again until the next audit re-verifies it.
     * `changes` from the run reflects the underlying upsert: 0 changes
     * means the row was unchanged (same values, no audit reset needed),
     * but per SQLite semantics any DO UPDATE that runs counts as a change,
     * so we DO NOT use `res.changes > 0` as the "is this new?" signal.
     * Instead we look up agreementCount before vs after; see recordAgreementTx.
     */
    insertAgreement: db.prepare<[string, string, string, number, AgreementSource]>(
      `INSERT INTO agreements (member_id, article_id, comment_id, commented_at, source)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(member_id, article_id) DO UPDATE SET
         comment_id = excluded.comment_id,
         commented_at = excluded.commented_at,
         source = excluded.source,
         audit_state = NULL,
         audit_at = NULL`,
    ),
    /** Used to decide outcome=inserted vs duplicate without relying on `changes`. */
    existsAgreement: db.prepare<[string, string], { n: number }>(
      `SELECT COUNT(*) AS n FROM agreements WHERE member_id = ? AND article_id = ?`,
    ),
    countAgreements: db.prepare<[string]>(
      `SELECT COUNT(*) AS n FROM agreements WHERE member_id = ? AND ${AGREEMENT_VALID_WHERE}`,
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
       INNER JOIN agreements a ON a.member_id = m.member_id AND ${AGREEMENT_VALID_WHERE}
       GROUP BY m.member_id, m.full_name
       HAVING agreement_count >= ?`,
    ),
    countEligible: db.prepare<[number], { n: number }>(
      `SELECT COUNT(*) AS n FROM (
         SELECT m.member_id
         FROM members m
         INNER JOIN agreements a ON a.member_id = m.member_id AND ${AGREEMENT_VALID_WHERE}
         GROUP BY m.member_id
         HAVING COUNT(DISTINCT a.article_id) >= ?
       ) t`,
    ),
    eligibleForCommonsLimited: db.prepare<[number, number], { member_id: string; full_name: string; agreement_count: number }>(
      `SELECT m.member_id, m.full_name, COUNT(DISTINCT a.article_id) AS agreement_count
       FROM members m
       INNER JOIN agreements a ON a.member_id = m.member_id AND ${AGREEMENT_VALID_WHERE}
       GROUP BY m.member_id, m.full_name
       HAVING agreement_count >= ?
       ORDER BY m.full_name COLLATE NOCASE ASC
       LIMIT ?`,
    ),
    distinctAgreementMembersCount: db.prepare<[], { n: number }>(
      `SELECT COUNT(DISTINCT member_id) AS n FROM agreements`,
    ),
    totalAgreementRowsCount: db.prepare<[], { n: number }>(
      `SELECT COUNT(*) AS n FROM agreements`,
    ),
    commonsAddedCount: db.prepare<[], { n: number }>(
      `SELECT COUNT(*) AS n FROM members WHERE added_at IS NOT NULL`,
    ),
    processedEmailsCountStmt: db.prepare<[], { n: number }>(
      `SELECT COUNT(*) AS n FROM processed_emails`,
    ),
    inProgressLimited: db.prepare<[number, number], { member_id: string; full_name: string; distinct_n: number }>(
      `SELECT m.member_id, m.full_name, COUNT(DISTINCT a.article_id) AS distinct_n
       FROM members m
       INNER JOIN agreements a ON a.member_id = m.member_id AND ${AGREEMENT_VALID_WHERE}
       GROUP BY m.member_id, m.full_name
       HAVING COUNT(DISTINCT a.article_id) >= 1 AND COUNT(DISTINCT a.article_id) < ?
       ORDER BY COUNT(DISTINCT a.article_id) ASC, m.full_name COLLATE NOCASE ASC
       LIMIT ?`,
    ),
    countInProgressMembers: db.prepare<[number], { n: number }>(
      `SELECT COUNT(*) AS n FROM (
         SELECT m.member_id
         FROM members m
         INNER JOIN agreements a ON a.member_id = m.member_id AND ${AGREEMENT_VALID_WHERE}
         GROUP BY m.member_id
         HAVING COUNT(DISTINCT a.article_id) >= 1 AND COUNT(DISTINCT a.article_id) < ?
       ) t`,
    ),
    membersForArticle: db.prepare<[string], { member_id: string; full_name: string }>(
      `SELECT DISTINCT m.member_id, m.full_name
       FROM members m
       INNER JOIN agreements a ON a.member_id = m.member_id
       WHERE a.article_id = ?
       ORDER BY m.full_name COLLATE NOCASE ASC`,
    ),
    setAuditOutcome: db.prepare<[AuditState, number, string, string]>(
      `UPDATE agreements SET audit_state = ?, audit_at = ?
       WHERE member_id = ? AND article_id = ?`,
    ),
    selectAuditState: db.prepare<[string, string], { audit_state: AuditState | null }>(
      `SELECT audit_state FROM agreements WHERE member_id = ? AND article_id = ?`,
    ),
  };

  /**
   * The body of recordAgreement runs inside a transaction so the upsert of
   * the member row and the insert/update of the agreement row commit or
   * fail as a unit. Without this a crash between the two could leave
   * agreements pointing at an unknown member.
   *
   * Stage 4e note: outcome=inserted vs duplicate is determined by checking
   * the row's existence BEFORE the upsert, not by SQLite's `changes` count
   * (which would be 1 for both INSERT and ON CONFLICT DO UPDATE).
   */
  const recordAgreementTx = db.transaction((input: RecordAgreementInput): RecordAgreementResult => {
    statements.upsertMember.run(input.memberId, input.fullName);
    const existed =
      (statements.existsAgreement.get(input.memberId, input.articleId) as { n: number }).n > 0;
    statements.insertAgreement.run(
      input.memberId,
      input.articleId,
      input.commentId,
      input.commentedAt,
      input.source,
    );
    const count = (statements.countAgreements.get(input.memberId) as { n: number }).n;
    return {
      outcome: existed ? 'duplicate' : 'inserted',
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

    /* countAgreements is audit-aware (excludes 'deleted'/'edited'/'mixed'),
     * so a member whose audit downgraded them below threshold can no longer
     * claim. */
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
    listMembersForArticle(articleId) {
      const rows = statements.membersForArticle.all(articleId) as Array<{
        member_id: string;
        full_name: string;
      }>;
      return rows.map((r) => ({ memberId: r.member_id, fullName: r.full_name }));
    },
    recordAuditOutcome(memberId, articleId, state, when = Date.now()) {
      statements.setAuditOutcome.run(state, when, memberId, articleId);
    },
    getAuditState(memberId, articleId) {
      const row = statements.selectAuditState.get(memberId, articleId) as
        | { audit_state: AuditState | null }
        | undefined;
      if (!row) return null;
      return row.audit_state ?? null;
    },
    getAgreementsOverview(opts?: GetAgreementsOverviewOpts) {
      const maxListedMembers = opts?.maxListedMembers ?? 250;

      const distinctMembersWithAgreement =
        (statements.distinctAgreementMembersCount.get() as { n: number }).n;
      const totalAgreementRows = (statements.totalAgreementRowsCount.get() as { n: number }).n;
      const eligibleCount =
        (statements.countEligible.get(requiredAgreementCount) as { n: number }).n;
      const inProgressMemberCount =
        (statements.countInProgressMembers.get(requiredAgreementCount) as { n: number }).n;
      const commonsAddedMemberCount = (statements.commonsAddedCount.get() as { n: number }).n;
      const processedEmailCount =
        (statements.processedEmailsCountStmt.get() as { n: number }).n;

      const eligibleRows = statements.eligibleForCommonsLimited.all(
        requiredAgreementCount,
        maxListedMembers,
      );
      const eligibleMembers = eligibleRows.map((r) => ({
        memberId: r.member_id,
        fullName: r.full_name,
        agreementCount: r.agreement_count,
      }));

      const inRows = statements.inProgressLimited.all(requiredAgreementCount, maxListedMembers);
      const inProgressMembers = inRows.map((r) => ({
        memberId: r.member_id,
        fullName: r.full_name,
        distinctAgreementArticles: r.distinct_n,
      }));

      return {
        requiredAgreementCount,
        distinctMembersWithAgreement,
        totalAgreementRows,
        eligibleCount,
        inProgressMemberCount,
        commonsAddedMemberCount,
        processedEmailCount,
        eligibleMembers,
        inProgressMembers,
      };
    },
    close() {
      db.close();
    },
  };
}
