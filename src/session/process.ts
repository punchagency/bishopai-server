import { pool } from '../db/pool';
import { extractSessionNote } from './extract';
import { logError, logEvent } from '../observability/logger';

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

    // Re-verify the claim before writing anything. The LLM call takes seconds,
    // and in that window the conversation can be UNMATCHED (Nicole caught a
    // wrong assignment) — its drafts deleted and appointment_id nulled. Writing
    // the extracted note against the appointment captured at claim time would
    // resurrect a draft attributed to a client she just detached. This UPDATE
    // doubles as the check and the row lock: no matching row → drop the result.
    const still = await db.query(
      `UPDATE conversations
          SET extraction_status = 'done', updated_at = now()
        WHERE id = $1 AND appointment_id = $2 AND extraction_status = 'processing'
    RETURNING id`,
      [conversationId, appointment_id],
    );
    if (still.rowCount === 0) {
      await db.query('ROLLBACK');
      logEvent('info', 'session.extract', 'conversation moved during extraction — result dropped', {
        conversation_id: conversationId,
        claimed_appointment_id: appointment_id,
      });
      return;
    }

    // Never touch an approved note here. Approved content only changes through
    // Amend (which snapshots the superseded version); an extraction result
    // landing on an approved appointment means a recording was matched where a
    // signed-off session already lives — refused upstream, and refused again
    // here so no path can silently demote approved clinical content to draft.
    const sheet = await db.query(
      `INSERT INTO appointment_sheets (appointment_id, client_id, content_json, status)
            VALUES ($1, $2, $3, 'draft')
       ON CONFLICT (appointment_id) DO UPDATE
            SET content_json = EXCLUDED.content_json,
                client_id    = EXCLUDED.client_id,
                status       = 'draft'
          WHERE appointment_sheets.status <> 'approved'`,
      [appointment_id, client_id, noteJson],
    );

    // Protocol is client-facing; skip if the appointment has no client attached.
    if (client_id) {
      await db.query(
        `INSERT INTO protocols (client_id, appointment_id, content_json, status)
              VALUES ($1, $2, $3, 'draft')
         ON CONFLICT (appointment_id) DO UPDATE
              SET content_json = EXCLUDED.content_json,
                  status       = 'draft'
            WHERE protocols.status <> 'approved'`,
        [client_id, appointment_id, noteJson],
      );
    }

    await db.query('COMMIT');
    if (sheet.rowCount === 0) {
      logEvent('warn', 'session.extract', 'approved note left untouched — extraction result not applied', {
        conversation_id: conversationId,
        appointment_id,
      });
    }
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
