import type { PoolClient } from 'pg';

export type CorrelationResult =
  | { status: 'matched'; appointmentId: string; clientId: string | null }
  | { status: 'unmatched'; reason: 'no_candidates' | 'ambiguous'; candidateCount: number };

/**
 * The make-or-break join: match a Bee conversation to a PB appointment by
 * overlapping time window. Uses Postgres range overlap (&&) against the
 * appointments time index.
 *
 * Hard rule (build plan §4/§9): never auto-guess. Exactly one candidate =>
 * matched. Zero or many => unmatched, routed to manual tagging.
 */
export async function correlateConversation(
  db: PoolClient,
  startsAt: string,
  endsAt: string,
): Promise<CorrelationResult> {
  const { rows } = await db.query<{ id: string; client_id: string | null }>(
    `SELECT id, client_id
       FROM appointments
      WHERE tstzrange(starts_at, ends_at) && tstzrange($1, $2)
      ORDER BY starts_at`,
    [startsAt, endsAt],
  );

  if (rows.length === 1) {
    return { status: 'matched', appointmentId: rows[0].id, clientId: rows[0].client_id };
  }
  return {
    status: 'unmatched',
    reason: rows.length === 0 ? 'no_candidates' : 'ambiguous',
    candidateCount: rows.length,
  };
}
