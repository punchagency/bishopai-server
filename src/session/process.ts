import { pool } from '../db/pool';
import { extractSessionNote } from './extract';
import { logError } from '../observability/logger';

/**
 * Turn a matched conversation's transcript into an Appointment Sheet + Protocol.
 *
 * Runs off the request path (fire-and-forget from the ingest handlers). The
 * paid, slow LLM call happens OUTSIDE any DB transaction. Idempotent and
 * safe to call repeatedly: it atomically claims the row first, so a second
 * caller (retry, duplicate webhook) is a no-op.
 */
export async function processConversation(conversationId: string): Promise<void> {
  // Claim: proceed only if matched (has appointment), has a transcript, and
  // isn't already done or in-flight. The UPDATE is the lock — if it returns no
  // row, someone else owns it or there's nothing to do.
  const claim = await pool.query<{
    appointment_id: string;
    client_id: string | null;
    transcript: string;
  }>(
    `UPDATE conversations
        SET extraction_status = 'processing', updated_at = now()
      WHERE id = $1
        AND appointment_id IS NOT NULL
        AND transcript IS NOT NULL
        AND extraction_status IN ('pending', 'failed')
      RETURNING appointment_id, client_id, transcript`,
    [conversationId],
  );
  if (claim.rowCount === 0) return;
  const { appointment_id, client_id, transcript } = claim.rows[0];

  let note;
  try {
    note = await extractSessionNote(transcript);
  } catch (err) {
    await markStatus(conversationId, 'failed');
    await logError('session.extract', 'transcript extraction failed', err, {
      conversation_id: conversationId,
    });
    return;
  }

  const noteJson = JSON.stringify(note);
  const db = await pool.connect();
  try {
    await db.query('BEGIN');

    await db.query(
      `INSERT INTO appointment_sheets (appointment_id, client_id, content_json, status)
            VALUES ($1, $2, $3, 'draft')
       ON CONFLICT (appointment_id) DO UPDATE
            SET content_json = EXCLUDED.content_json,
                client_id    = EXCLUDED.client_id,
                status       = 'draft'`,
      [appointment_id, client_id, noteJson],
    );

    // Protocol is client-facing; skip if the appointment has no client attached.
    if (client_id) {
      await db.query(
        `INSERT INTO protocols (client_id, appointment_id, content_json, status)
              VALUES ($1, $2, $3, 'draft')
         ON CONFLICT (appointment_id) DO UPDATE
              SET content_json = EXCLUDED.content_json,
                  status       = 'draft'`,
        [client_id, appointment_id, noteJson],
      );
    }

    await db.query(
      `UPDATE conversations SET extraction_status = 'done', updated_at = now() WHERE id = $1`,
      [conversationId],
    );
    await db.query('COMMIT');
  } catch (err) {
    await db.query('ROLLBACK');
    await markStatus(conversationId, 'failed');
    await logError('session.extract', 'persisting session note failed', err, {
      conversation_id: conversationId,
    });
  } finally {
    db.release();
  }
}

async function markStatus(id: string, status: 'failed'): Promise<void> {
  await pool
    .query(`UPDATE conversations SET extraction_status = $2, updated_at = now() WHERE id = $1`, [
      id,
      status,
    ])
    .catch(() => {
      /* best-effort; the original error is already logged */
    });
}
