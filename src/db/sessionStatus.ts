import type { DocStatus } from './interfaces/types.js';

/**
 * One status for a session, combined from the two documents it is made of.
 *
 * A session counts as approved only when every document it actually HAS is
 * approved. A session with no protocol (no client attached yet) is decided by
 * its sheet alone — "both approved" would be unreachable for it, and it would
 * sit in the pending queue forever.
 *
 * Lives here rather than in session/sessionService.ts because the repository
 * layer evaluates it too: the guarded write asserts the combined status inside
 * the transaction, and a second copy of this rule would be a second answer.
 */
export function combineStatus(
  sheet: string | null | undefined,
  protocol: string | null | undefined,
): DocStatus {
  const present = [sheet, protocol].filter(Boolean) as string[];
  if (present.length === 0) return 'draft';
  if (present.every((s) => s === 'approved')) return 'approved';
  if (present.some((s) => s === 'in_review')) return 'in_review';
  return 'draft';
}
