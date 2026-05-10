import crypto from 'node:crypto';
import path from 'node:path';

/**
 * Cross-cutting helpers for the `collectActiveMemberList` feature.
 *
 * Two consumers share these:
 *   1. `src/tasks/collectActiveMemberList.ts` — writes the CSV.
 *   2. `src/server.ts` — `/downloads/active-members*` endpoints stream
 *      the same file gated by a token from `.env`.
 *
 * Keeping these in one tiny module guarantees both ends agree on
 * (a) the on-disk path of the artifact and (b) the constant-time
 * compare used to gate downloads.
 */

/**
 * Absolute path of the CSV produced by the collect task and served
 * (through a token gate) by the download endpoint.
 *
 * Defaults to `<cwd>/data/active-members.csv`. The file lives in
 * `data/` (which is gitignored project-wide) rather than `public/`
 * because it contains member PII and must NOT be served by the
 * static-file middleware. Override via `ACTIVE_MEMBER_LIST_PATH` for
 * tests / one-off diagnostics.
 */
export function activeMembersCsvPath(): string {
  const override = process.env.ACTIVE_MEMBER_LIST_PATH?.trim();
  if (override && override.length > 0) return override;
  return path.join(process.cwd(), 'data', 'active-members.csv');
}

/**
 * Constant-time string compare used to gate the CSV download.
 *
 * `crypto.timingSafeEqual` throws on length mismatch, so we short-
 * circuit on length first (intentionally a non-constant-time check)
 * before doing the byte-level compare. Leaking the length of the
 * expected token is acceptable: the entropy lives in the token's
 * content, not its length, and an attacker who can probe length is
 * already in a position to make millions of unauthenticated requests.
 *
 * Both arguments are converted to UTF-8 buffers; non-ASCII tokens
 * therefore work correctly. Empty strings are rejected up-front so a
 * misconfigured server (token unset on one side, empty query string
 * on the other) cannot pass.
 */
export function tokensMatch(expected: string, provided: string): boolean {
  if (expected.length === 0 || provided.length === 0) return false;
  /* Compare BYTE lengths, not char lengths: a multi-byte UTF-8 token
   * (e.g. one containing 'é') has more bytes than chars, and
   * `crypto.timingSafeEqual` will throw on a length mismatch in
   * bytes regardless of how many chars each input had. */
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(provided, 'utf8');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}
