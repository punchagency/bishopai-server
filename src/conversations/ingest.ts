import { pool } from '../db/pool';
import { correlateConversation, type CorrelationResult } from '../correlation/correlate';

/** Which recorder produced a conversation. Ids are namespaced per source. */
export type ConversationSource = 'bee' | 'pocket';

export interface ConversationInput {
  /** The recorder's own id for this recording (Pocket: `rec_…`). */
  source_id: string;
  source?: ConversationSource; // defaults to 'pocket'
  starts_at: string; // ISO 8601
  ends_at: string; // ISO 8601
  transcript?: string | null;
}

export interface IngestResult {
  conversationId: string;
  correlation: CorrelationResult;
}

/**
 * Single code path for landing a recording: correlate it to an appointment,
 * then upsert. Used by both the Pocket webhook (production) and the poller
 * backstop. Idempotent on (source, source_id) so a redelivered webhook, a
 * poller pass over the same window, or a replayed event can't duplicate a
 * conversation.
 */
export async function ingestConversation(input: ConversationInput): Promise<IngestResult> {
  return ingestOnce(input, true);
}

async function ingestOnce(input: ConversationInput, retryOnTaken: boolean): Promise<IngestResult> {
  const db = await pool.connect();
  try {
    await db.query('BEGIN');

    const correlation = await correlateConversation(db, input.starts_at, input.ends_at);
    const matched = correlation.status === 'matched';

    const ins = await db.query<{
      id: string;
      appointment_id: string | null;
      client_id: string | null;
    }>(
      `INSERT INTO conversations
              (source_id, source, starts_at, ends_at, transcript, appointment_id, client_id, correlation_status)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (source, source_id) DO UPDATE
            SET transcript = COALESCE(EXCLUDED.transcript, conversations.transcript)
         RETURNING id, appointment_id, client_id`,
      [
        input.source_id,
        input.source ?? 'pocket',
        input.starts_at,
        input.ends_at,
        input.transcript ?? null,
        matched ? correlation.appointmentId : null,
        matched ? correlation.clientId : null,
        matched ? 'matched' : 'unmatched',
      ],
    );

    await db.query('COMMIT');

    // Report the STORED row's state, not the fresh computation. On a replay the
    // conflict update keeps the existing assignment (possibly manual), so the
    // fresh correlation can disagree with reality in both directions — and the
    // caller uses this result to decide whether to fire extraction. A replayed
    // transcript for a matched conversation must trigger it; a recomputed
    // "match" for a row a human left unmatched must not.
    const row = ins.rows[0];
    const effective: CorrelationResult = row.appointment_id
      ? { status: 'matched', appointmentId: row.appointment_id, clientId: row.client_id }
      : correlation.status === 'unmatched'
        ? correlation
        : { status: 'unmatched', reason: 'ambiguous', candidateCount: 1 };
    return { conversationId: row.id, correlation: effective };
  } catch (err) {
    await db.query('ROLLBACK');
    // Two overlapping recordings ingested concurrently can both correlate to the
    // same appointment; the unique index rejects the loser. Re-run once — the
    // second pass sees the appointment as taken and lands unmatched, which is
    // where a competing chunk belongs anyway.
    if (retryOnTaken && isUniqueViolation(err, 'conversations_appointment_unique')) {
      // finally releases this client; the retry checks out its own.
      return ingestOnce(input, false);
    }
    throw err;
  } finally {
    db.release();
  }
}

function isUniqueViolation(err: unknown, constraint: string): boolean {
  const e = err as { code?: string; constraint?: string };
  return e?.code === '23505' && e?.constraint === constraint;
}
