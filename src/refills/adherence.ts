import { getDatabase } from '../db/index.js';

// WF4 adherence bundling. A light adherence signal from a client's refill
// history: the share of refills they acted on (notified/closed) versus refills
// that went overdue. High, evidenced adherence → suggest a multi-month bundle so
// reliable clients aren't nudged monthly.

export const BUNDLE_THRESHOLD = 0.8;
export const BUNDLE_MIN_HISTORY = 2; // need evidence before bundling
export const BUNDLE_MONTHS = 3;

export interface Adherence {
  score: number; // 0..1
  actioned: number;
  overdue: number;
}

/** Bottles to order given an adherence signal: multi-month only for proven, high adherence. */
export function suggestedMonths(a: Adherence): number {
  const evidence = a.actioned + a.overdue;
  return a.score >= BUNDLE_THRESHOLD && evidence >= BUNDLE_MIN_HISTORY ? BUNDLE_MONTHS : 1;
}

/** Compute a client's adherence from their refill history. No history → score 0 (won't bundle). */
export async function computeAdherence(clientId: string): Promise<Adherence> {
  // Two `count(*) FILTER` aggregates over one client's refills. Firestore has no
  // filtered aggregate, and a client's refill history is a handful of documents,
  // so both counts come off a single indexed read of that client's rows rather
  // than two count() queries with different predicates.
  const refills = await getDatabase().refills.listByClient(clientId);
  const today = new Date().toISOString().slice(0, 10);

  let actioned = 0;
  let overdue = 0;
  for (const r of refills) {
    if (r.status === 'notified' || r.status === 'closed') actioned++;
    else if (r.status === 'pending' && r.due_date < today) overdue++;
  }

  const denom = actioned + overdue;
  return { score: denom === 0 ? 0 : actioned / denom, actioned, overdue };
}
