import { pool } from '../db/pool';

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
  const r = await pool.query<{ actioned: number; overdue: number }>(
    `SELECT
       count(*) FILTER (WHERE status IN ('notified', 'closed'))::int AS actioned,
       count(*) FILTER (WHERE status = 'pending' AND due_date < current_date)::int AS overdue
       FROM refills WHERE client_id = $1`,
    [clientId],
  );
  const { actioned, overdue } = r.rows[0] ?? { actioned: 0, overdue: 0 };
  const denom = actioned + overdue;
  return { score: denom === 0 ? 0 : actioned / denom, actioned, overdue };
}
