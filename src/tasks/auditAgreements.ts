import { isAgreementText as defaultIsAgreementText } from '../config/agreements.js';
import type { AuditState } from '../state/agreementsStore.js';

/**
 * Pure classifier for the Stage 4e change-of-heart audit.
 *
 * Given the comments a *single* member currently has on a *single* agreement
 * article (already filtered to that member by the caller), returns the
 * AuditState that captures the spec's five cases:
 *
 *   []                              -> 'deleted'         (case 1)
 *   [agree]                         -> 'happy'           (case 0)
 *   [non-agree]                     -> 'edited'          (case 2)
 *   [agree, agree, ...]             -> 'multi_agreement' (case 4)
 *   anything else with N>=2         -> 'mixed'           (case 3)
 *
 * The matcher is injectable so tests can pin the regex and so a future
 * per-community matcher swap is one parameter away.
 */
export function classifyMemberOnArticle(
  commentsForMember: ReadonlyArray<{ text: string }>,
  isAgreementText: (text: string) => boolean = defaultIsAgreementText,
): AuditState {
  if (commentsForMember.length === 0) return 'deleted';

  const matches = commentsForMember.map((c) => isAgreementText(c.text));

  if (commentsForMember.length === 1) {
    return matches[0] ? 'happy' : 'edited';
  }

  return matches.every(Boolean) ? 'multi_agreement' : 'mixed';
}
