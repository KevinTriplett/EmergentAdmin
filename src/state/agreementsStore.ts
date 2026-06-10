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
 * Stage 4g per-(member, space) attempt ledger.
 *
 *   present - The member has been INDEPENDENTLY CONFIRMED to be in the
 *             space, by an `addSpaceMember` Phase-1 search returning
 *             `ALREADY_A_MEMBER` (i.e. the space's filtered member list
 *             contains a row matching `data-member-item='${memberId}'`).
 *             Once written, the row is permanent for the auto path:
 *             reconcile and the all-spaces job will never touch this
 *             pair again, even if the member later leaves the space.
 *             That's the consent guarantee — "added once, never again".
 *
 *   failed  - The most recent attempt to add this pair raised an error.
 *             Informational; subsequent passes retry. Replaced by
 *             'present' on the next Phase-1-verified hit, or aged out
 *             after `FAILED_ATTEMPT_TTL_MS` of no further activity.
 *
 * Phase-2-only successes (the add-flow's toast appeared but no
 * independent search ran) are deliberately NOT persisted: they require
 * a follow-up reconcile pass to be Phase-1-verified before the row
 * lands. That extra pass is the price of "trust nothing but the
 * verification search" — see `addToAllSpacesJob` for why.
 */
export type SpaceAttemptOutcome = 'present' | 'failed';

export type MemberSpaceAttempt = {
  spaceName: string;
  outcome: SpaceAttemptOutcome;
  attemptedAt: number;
  lastError: string | null;
};

/**
 * Stage 4e change-of-heart audit verdict for one (member, article) pair.
 *
 *   happy            - exactly one current comment, matches `isAgreementText`.
 *   deleted          - no current comment from this member.
 *   edited           - exactly one current comment, does NOT match `isAgreementText`.
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

/**
 * Stage 4f extension: a member who is already verified-added to commons
 * (`members.commons_added_at IS NOT NULL`) AND has at least one
 * `agreements` row whose `audit_state` is in ('deleted','edited','mixed').
 * Drives the dashboard's "Added to Commons, now anomaly, need to DM"
 * section — the operator's queue for follow-up DMs to members whose
 * agreement status has degraded since they were added.
 *
 * Each member rolls up their per-article anomalies into the `anomalies`
 * array so the dashboard can show "Alice — deleted on Community
 * Agreements, edited on Privacy Pledge" without the consumer having to
 * regroup the flat join in the browser.
 */
export type AddedWithAnomalyMember = {
  memberId: string;
  fullName: string;
  anomalies: ReadonlyArray<{
    articleId: string;
    auditState: Extract<AuditState, 'deleted' | 'edited' | 'mixed'>;
    auditAt: number | null;
    /**
     * The `agreements.comment_id` of the originally-recorded agreement.
     * For 'edited' and 'mixed' anomalies this id usually still exists
     * on MN (MN preserves comment ids across edits), so the dashboard
     * can build a deep-link to the comment for one-click triage. For
     * 'deleted' anomalies the original comment was removed and this
     * id will 404 — the dashboard falls back to the article URL in
     * that case. Empty string is preserved verbatim for the same
     * defensive reason.
     */
    commentId: string;
  }>;
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
  /**
   * Stage 4f: eligible members minus those already verified-added to
   * every commons space. This is the list the operator wants to see
   * under "Eligible, not yet added to Commons" — the actionable subset.
   */
  eligibleNotYetAddedCount: number;
  inProgressMemberCount: number;
  /**
   * Stage 4f flip: now counts `members.commons_added_at IS NOT NULL`
   * (verified-added by addToAllSpacesJob on failureCount===0), NOT the
   * legacy `added_at` dedup gate. The list and counter agree on what
   * "added" means after this change.
   */
  commonsAddedMemberCount: number;
  processedEmailCount: number;
  /**
   * Stage 4f extension: distinct member count whose `commons_added_at` is
   * set AND who have at least one anomalous `agreements` row. Mirrors the
   * shape of `eligibleNotYetAddedCount` — count stays exact even when the
   * listed members array is truncated.
   */
  addedWithAnomalyMemberCount: number;
  eligibleMembers: readonly EligibleCommonsMember[];
  /** Stage 4f: same shape as eligibleMembers, filtered to flag-IS-NULL. */
  eligibleNotYetAddedMembers: readonly EligibleCommonsMember[];
  inProgressMembers: readonly AgreementProgressMember[];
  /**
   * Stage 4f extension: members already verified-added to commons whose
   * current agreement state is anomalous. The "DM follow-up" queue.
   */
  addedWithAnomalyMembers: readonly AddedWithAnomalyMember[];
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
   * repair runs without scraping MN HTML. **Unfiltered** by `commons_added_at`
   * — reconcile chooses scope at its own level (env var toggle).
   */
  listMembersEligibleForCommonsAdd(): readonly EligibleCommonsMember[];
  /**
   * Stage 4f: same shape as `listMembersEligibleForCommonsAdd` but filtered
   * to members whose `commons_added_at` is still NULL. Drives the
   * dashboard's "Eligible, not yet added to Commons" panel and (when
   * the reconcile env-var toggle is on) the reconcile scope.
   */
  listMembersEligibleNotYetCommonsAdded(): readonly EligibleCommonsMember[];
  /**
   * Stage 4f: idempotently set `members.commons_added_at` for the given
   * member. Called by `addToAllSpacesJob` when the run finishes with
   * `failureCount === 0` (every space added cleanly OR was already-member).
   * Silently no-ops on unknown members so manual / auto / reconcile
   * callers can all wire it without pre-checking row existence.
   */
  markCommonsAdded(memberId: string, when?: number): void;
  /** Stage 4f: read back whether the member has been verified-added. */
  isCommonsAdded(memberId: string): boolean;
  /**
   * Stage 4f extension — roll back every store invariant the
   * add-to-all-spaces path established for this member, in a single
   * transaction:
   *   1. `members.commons_added_at` → NULL (drops them out of the
   *      "Added to Commons, now anomaly, need to DM" queue and out
   *      of `commonsAddedMemberCount` on the next overview read).
   *   2. Every `member_space_attempts` row for the member is
   *      deleted. Those rows are the Stage 4g consent gate — leaving
   *      'present' rows behind after a deliberate live removal would
   *      cause the next auto-add pass to skip every space (the
   *      pre-loop skip interprets 'present' as "already there, do
   *      not re-add"), silently turning a future re-add into a
   *      no-op the operator can't explain.
   *
   * Designed to be called from `POST /run/remove-space-member-all-spaces`
   * after a NON-dry-run that ended with `failureCount === 0` — i.e.
   * every commons space ended in the desired "not-a-member" state
   * (whether by an actual removal or because the member was already
   * absent / NOT_IN_SPACE). On partial failure the caller is
   * expected to leave the store alone so reality and the DB stay in
   * agreement.
   *
   * Returns counters so the task log / activity panel can show
   * exactly what was rolled back. Silently no-ops on unknown
   * members; idempotent on repeat calls (a follow-up invocation
   * with nothing left to clear returns `{false, 0}`).
   */
  markCommonsRemoved(memberId: string): {
    commonsAddedCleared: boolean;
    spaceAttemptsDeleted: number;
  };

  // ---- Stage 4g: per-(member, space) attempt ledger ------------------------
  /**
   * Stage 4g: persist a Phase-1-verified presence claim. Called by the
   * all-spaces job exactly when `addSpaceMember` returns
   * `success: true, error: ALREADY_A_MEMBER` — i.e. the member's row was
   * found in the space's filtered member list. Idempotent: re-recording
   * just bumps `attempted_at`. Transitions an existing 'failed' row to
   * 'present' and clears `last_error`.
   */
  recordSpacePresent(memberId: string, spaceName: string, when?: number): void;
  /**
   * Stage 4g: persist a failed add attempt. Caller passes the error
   * message verbatim into `last_error`. Will NOT overwrite an existing
   * 'present' row (verified presence is permanent on the auto path);
   * any other state is upserted with the new `attempted_at`.
   */
  recordSpaceFailed(
    memberId: string,
    spaceName: string,
    error?: string,
    when?: number,
  ): void;
  /**
   * Stage 4g: read every attempt row for a member. Drives the all-spaces
   * job's pre-loop skip ("don't touch spaces we already verified") and
   * the post-loop "is the member fully present?" check that flips
   * `commons_added_at`. Order is unspecified.
   */
  listMemberSpaceAttempts(memberId: string): readonly MemberSpaceAttempt[];
  /**
   * Stage 4g: delete `failed` attempt rows whose `attempted_at` is older
   * than `cutoffMs`. Returns the number of rows deleted. Called at the
   * start of each reconcile pass with a 30-day cutoff to keep the audit
   * trail bounded — `present` rows are never aged out (they encode the
   * member's consent decision).
   */
  pruneFailedSpaceAttempts(cutoffMs: number): number;

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
  /**
   * Stage 4f extension: members where `commons_added_at IS NOT NULL` AND
   * at least one `agreements` row has audit_state in
   * ('deleted','edited','mixed'). Used by the dashboard's "Added to
   * Commons, now anomaly, need to DM" section. Each member's
   * per-article anomalies are rolled up into the `anomalies` array so
   * the consumer doesn't need to regroup a flat join. Ordered by
   * full_name (case-insensitive) for stable UI.
   */
  listAddedToCommonsAnomalies(): readonly AddedWithAnomalyMember[];

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

  /*
   * Stage 4g: per-(member, space) attempt ledger. The all-spaces job
   * consults this before each iteration and skips spaces whose row is
   * 'present', which is the consent guarantee -- once we have added a
   * member to a space, we never re-add. 'failed' rows retry until they
   * either succeed (overwritten as 'present') or age out after 30 days.
   *
   * space_name is the human-readable key from SPACE_IDS. If a space is
   * ever renamed, existing rows orphan against the new key -- handle
   * that as a one-off DB UPDATE at rename time; auto-migration would
   * require coupling the DB to the JS constant which we deliberately
   * avoid here.
   */
  CREATE TABLE IF NOT EXISTS member_space_attempts (
    member_id TEXT NOT NULL,
    space_name TEXT NOT NULL,
    outcome TEXT NOT NULL CHECK (outcome IN ('present','failed')),
    attempted_at INTEGER NOT NULL,
    last_error TEXT,
    PRIMARY KEY (member_id, space_name),
    FOREIGN KEY (member_id) REFERENCES members(member_id) ON DELETE CASCADE
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

  /* Stage 4f: verified-added flag. `members.added_at` was always a dedup gate
   * (set BEFORE the add-job runs) — `commons_added_at` is the post-job
   * confirmation that every commons space accepted the member. Set by
   * `markCommonsAdded`, called from `addToAllSpacesJob` when failureCount
   * reaches zero. */
  ensureColumn(db, 'members', 'commons_added_at', 'INTEGER');

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
    /* Stage 4f: idempotent set of commons_added_at. Same first-write-wins
     * pattern as markAdded — once an add-job has verified the member is
     * in every commons space, later re-runs (e.g. reconcile) don't bump
     * the timestamp. */
    markCommonsAdded: db.prepare<[number, string]>(
      `UPDATE members SET commons_added_at = ? WHERE member_id = ? AND commons_added_at IS NULL`,
    ),
    /* Stage 4f extension: roll-back companion to markCommonsAdded. The
     * WHERE-guard against IS NOT NULL means `changes` reports 1 only
     * when we actually flipped the flag from set → NULL, so the caller
     * can tell "we cleared an in-effect verification" from "the row
     * was already cleared / member never verified". */
    clearCommonsAdded: db.prepare<[string]>(
      `UPDATE members SET commons_added_at = NULL WHERE member_id = ? AND commons_added_at IS NOT NULL`,
    ),
    /* Stage 4f extension: drop the Stage 4g per-(member, space) ledger
     * for a member. Wholesale delete (both 'present' and 'failed') —
     * once the operator has removed the member from every commons
     * space, the consent state for every (member, space) pair is
     * effectively zero and any prior verdict is stale. */
    deleteAllSpaceAttempts: db.prepare<[string]>(
      `DELETE FROM member_space_attempts WHERE member_id = ?`,
    ),
    selectMemberCommonsAdded: db.prepare<[string], { commons_added_at: number | null }>(
      `SELECT commons_added_at FROM members WHERE member_id = ?`,
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
    /* Stage 4f flip: this counter now tracks `commons_added_at IS NOT NULL`
     * (verified-added) instead of `added_at IS NOT NULL` (dedup gate).
     * Operator-visible "Members flagged commons-added" matches the new
     * "Eligible, not yet added to Commons" list semantics. */
    commonsAddedCount: db.prepare<[], { n: number }>(
      `SELECT COUNT(*) AS n FROM members WHERE commons_added_at IS NOT NULL`,
    ),
    /* Stage 4f filtered list: eligible AND not yet verified-added. Drives
     * the dashboard's "Eligible, not yet added to Commons" panel. */
    eligibleNotYetCommonsAddedLimited: db.prepare<[number, number], { member_id: string; full_name: string; agreement_count: number }>(
      `SELECT m.member_id, m.full_name, COUNT(DISTINCT a.article_id) AS agreement_count
       FROM members m
       INNER JOIN agreements a ON a.member_id = m.member_id AND ${AGREEMENT_VALID_WHERE}
       WHERE m.commons_added_at IS NULL
       GROUP BY m.member_id, m.full_name
       HAVING agreement_count >= ?
       ORDER BY m.full_name COLLATE NOCASE ASC
       LIMIT ?`,
    ),
    countEligibleNotYetCommonsAdded: db.prepare<[number], { n: number }>(
      `SELECT COUNT(*) AS n FROM (
         SELECT m.member_id
         FROM members m
         INNER JOIN agreements a ON a.member_id = m.member_id AND ${AGREEMENT_VALID_WHERE}
         WHERE m.commons_added_at IS NULL
         GROUP BY m.member_id
         HAVING COUNT(DISTINCT a.article_id) >= ?
       ) t`,
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
    /* Stage 4f extension: per-(member, article) flat join for the
     * "Added to Commons, now anomaly" list. Rolled up by member in
     * application code so a member with anomalies on two articles
     * appears once in the output with both articles in their
     * `anomalies` array. */
    listAddedToCommonsAnomaliesStmt: db.prepare<[], {
      member_id: string;
      full_name: string;
      article_id: string;
      comment_id: string;
      audit_state: 'deleted' | 'edited' | 'mixed';
      audit_at: number | null;
    }>(
      `SELECT m.member_id, m.full_name, a.article_id, a.comment_id, a.audit_state, a.audit_at
       FROM members m
       INNER JOIN agreements a ON a.member_id = m.member_id
       WHERE m.commons_added_at IS NOT NULL
         AND a.audit_state IN ('deleted','edited','mixed')
       ORDER BY m.full_name COLLATE NOCASE ASC, a.article_id ASC`,
    ),
    countAddedToCommonsAnomalyMembers: db.prepare<[], { n: number }>(
      `SELECT COUNT(DISTINCT m.member_id) AS n
       FROM members m
       INNER JOIN agreements a ON a.member_id = m.member_id
       WHERE m.commons_added_at IS NOT NULL
         AND a.audit_state IN ('deleted','edited','mixed')`,
    ),
    /* Stage 4g: attempt ledger statements. The 'present' upsert is allowed
     * to overwrite a 'failed' row (transition forward); the 'failed'
     * upsert WHERE-guards against an existing 'present' to make verified
     * presence permanent on the auto path. */
    upsertSpacePresent: db.prepare<[string, string, number]>(
      `INSERT INTO member_space_attempts (member_id, space_name, outcome, attempted_at, last_error)
       VALUES (?, ?, 'present', ?, NULL)
       ON CONFLICT(member_id, space_name) DO UPDATE SET
         outcome = 'present',
         attempted_at = excluded.attempted_at,
         last_error = NULL`,
    ),
    upsertSpaceFailed: db.prepare<[string, string, number, string | null]>(
      `INSERT INTO member_space_attempts (member_id, space_name, outcome, attempted_at, last_error)
       VALUES (?, ?, 'failed', ?, ?)
       ON CONFLICT(member_id, space_name) DO UPDATE SET
         outcome = 'failed',
         attempted_at = excluded.attempted_at,
         last_error = excluded.last_error
       WHERE member_space_attempts.outcome <> 'present'`,
    ),
    listMemberSpaceAttempts: db.prepare<[string], {
      space_name: string;
      outcome: SpaceAttemptOutcome;
      attempted_at: number;
      last_error: string | null;
    }>(
      `SELECT space_name, outcome, attempted_at, last_error
       FROM member_space_attempts
       WHERE member_id = ?`,
    ),
    pruneFailedAttempts: db.prepare<[number]>(
      `DELETE FROM member_space_attempts
       WHERE outcome = 'failed' AND attempted_at < ?`,
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
    listMembersEligibleNotYetCommonsAdded() {
      /* Use the limited statement with a generous cap so the call site
       * (UI dashboard / reconcile-with-toggle) gets the same shape as
       * `listMembersEligibleForCommonsAdd`. We intentionally use the same
       * 250-row default here as the overview's `maxListedMembers`; this
       * is fine because the UI also asks the overview for the count, and
       * reconcile only needs to enqueue jobs (queue capacity, not list
       * fidelity, is the bottleneck there). */
      const LARGE = 1_000_000;
      const rows = statements.eligibleNotYetCommonsAddedLimited.all(
        requiredAgreementCount,
        LARGE,
      );
      return rows.map((r) => ({
        memberId: r.member_id,
        fullName: r.full_name,
        agreementCount: r.agreement_count,
      }));
    },
    markCommonsAdded(memberId, when = Date.now()) {
      statements.markCommonsAdded.run(when, memberId);
    },
    isCommonsAdded(memberId) {
      const row = statements.selectMemberCommonsAdded.get(memberId) as
        | { commons_added_at: number | null }
        | undefined;
      return Boolean(row && row.commons_added_at !== null);
    },
    markCommonsRemoved(memberId) {
      /* Wrapped in a single transaction so the dashboard never sees
       * an inconsistent state where commons_added_at is cleared but
       * stale 'present' attempt rows remain (or vice-versa). */
      const txn = db.transaction((id: string) => {
        const updRes = statements.clearCommonsAdded.run(id);
        const delRes = statements.deleteAllSpaceAttempts.run(id);
        return {
          commonsAddedCleared: updRes.changes > 0,
          spaceAttemptsDeleted: delRes.changes,
        };
      });
      return txn(memberId);
    },
    recordSpacePresent(memberId, spaceName, when = Date.now()) {
      statements.upsertSpacePresent.run(memberId, spaceName, when);
    },
    recordSpaceFailed(memberId, spaceName, error, when = Date.now()) {
      statements.upsertSpaceFailed.run(memberId, spaceName, when, error ?? null);
    },
    listMemberSpaceAttempts(memberId) {
      const rows = statements.listMemberSpaceAttempts.all(memberId);
      return rows.map((r) => ({
        spaceName: r.space_name,
        outcome: r.outcome,
        attemptedAt: r.attempted_at,
        lastError: r.last_error,
      }));
    },
    pruneFailedSpaceAttempts(cutoffMs) {
      const res = statements.pruneFailedAttempts.run(cutoffMs);
      return res.changes;
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
    listAddedToCommonsAnomalies() {
      const rows = statements.listAddedToCommonsAnomaliesStmt.all();
      /* Roll up the flat (member, article) join into one entry per
       * member. The SQL ORDER BY guarantees the rows arrive grouped
       * by member already, so a single pass with a Map is enough and
       * preserves the alphabetical order for the UI. */
      const byMember = new Map<string, {
        memberId: string;
        fullName: string;
        anomalies: Array<{
          articleId: string;
          auditState: Extract<AuditState, 'deleted' | 'edited' | 'mixed'>;
          auditAt: number | null;
          commentId: string;
        }>;
      }>();
      for (const r of rows) {
        let entry = byMember.get(r.member_id);
        if (!entry) {
          entry = { memberId: r.member_id, fullName: r.full_name, anomalies: [] };
          byMember.set(r.member_id, entry);
        }
        entry.anomalies.push({
          articleId: r.article_id,
          auditState: r.audit_state,
          auditAt: r.audit_at,
          commentId: r.comment_id,
        });
      }
      return Array.from(byMember.values());
    },
    getAgreementsOverview(opts?: GetAgreementsOverviewOpts) {
      const maxListedMembers = opts?.maxListedMembers ?? 250;

      const distinctMembersWithAgreement =
        (statements.distinctAgreementMembersCount.get() as { n: number }).n;
      const totalAgreementRows = (statements.totalAgreementRowsCount.get() as { n: number }).n;
      const eligibleCount =
        (statements.countEligible.get(requiredAgreementCount) as { n: number }).n;
      const eligibleNotYetAddedCount =
        (statements.countEligibleNotYetCommonsAdded.get(requiredAgreementCount) as { n: number }).n;
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

      const eligibleNotYetAddedRows = statements.eligibleNotYetCommonsAddedLimited.all(
        requiredAgreementCount,
        maxListedMembers,
      );
      const eligibleNotYetAddedMembers = eligibleNotYetAddedRows.map((r) => ({
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

      const addedWithAnomalyMemberCount =
        (statements.countAddedToCommonsAnomalyMembers.get() as { n: number }).n;
      /* The full anomaly list is bounded by the verified-added population
       * (small in practice) and the rows are already grouped by member —
       * no need for the eligible-list truncation pattern here. If the
       * roster ever balloons we can add a LIMIT, but the dashboard slice
       * benefits from showing the full DM queue. */
      const addedWithAnomalyMembers = this.listAddedToCommonsAnomalies();

      return {
        requiredAgreementCount,
        distinctMembersWithAgreement,
        totalAgreementRows,
        eligibleCount,
        eligibleNotYetAddedCount,
        inProgressMemberCount,
        commonsAddedMemberCount,
        addedWithAnomalyMemberCount,
        processedEmailCount,
        eligibleMembers,
        eligibleNotYetAddedMembers,
        inProgressMembers,
        addedWithAnomalyMembers,
      };
    },
    close() {
      db.close();
    },
  };
}
