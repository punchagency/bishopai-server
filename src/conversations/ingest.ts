import { pool } from '../db/pool';
import { correlateConversation, type CorrelationResult } from '../correlation/correlate';

export interface ConversationInput {
  bee_id: string;
  starts_at: string; // ISO 8601
  ends_at: string; // ISO 8601
  transcript?: string | null;
}

export interface IngestResult {
  conversationId: string;
  correlation: CorrelationResult;
}

/**
 * Single code path for landing a Bee conversation: correlate it to an
 * appointment, then upsert. Used by both the SSE consumer (production) and
 * the webhook stand-in (testing). Idempotent on bee_id so a replayed event
 * or reconnect can't duplicate a conversation.
 */
export async function ingestConversation(input: ConversationInput): Promise<IngestResult> {
  const db = await pool.connect();
  try {
    await db.query('BEGIN');

    const correlation = await correlateConversation(db, input.starts_at, input.ends_at);
    const matched = correlation.status === 'matched';

    const ins = await db.query<{ id: string }>(
      `INSERT INTO conversations
              (bee_id, starts_at, ends_at, transcript, appointment_id, client_id, correlation_status)
            VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (bee_id) DO UPDATE
            SET transcript = COALESCE(EXCLUDED.transcript, conversations.transcript)
         RETURNING id`,
      [
        input.bee_id,
        input.starts_at,
        input.ends_at,
        input.transcript ?? null,
        matched ? correlation.appointmentId : null,
        matched ? correlation.clientId : null,
        matched ? 'matched' : 'unmatched',
      ],
    );

    await db.query('COMMIT');
    return { conversationId: ins.rows[0].id, correlation };
  } catch (err) {
    await db.query('ROLLBACK');
    throw err;
  } finally {
    db.release();
  }
}
