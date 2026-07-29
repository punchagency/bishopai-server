import { pool } from '../db/pool';
import { extractSessionNote } from './extract';
import { logError, logEvent } from '../observability/logger';
import { rawFromError } from '../llm/errors';
import { markExtractionFailed } from './reclaim';
import { fetchSupplementVocabulary } from './supplements';

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
  // `extraction_leased_at` is what makes the claim recoverable: without it a
  // process that dies here leaves the row in `processing` forever, and the
  // reclaim sweep has no way to tell a live call from an abandoned one.
  const claim = await pool.query<{
    appointment_id: string;
    client_id: string | null;
    transcript: string;
    client_name: string | null;
    appointment_date: string | null;
  }>(
    `UPDATE conversations c
        SET extraction_status = 'processing',
            extraction_leased_at = now(),
            updated_at = now()
      WHERE c.id = $1
        AND c.appointment_id IS NOT NULL
        AND c.transcript IS NOT NULL
        AND c.extraction_status IN ('pending', 'failed')
      RETURNING c.appointment_id, c.client_id, c.transcript,
                (SELECT name FROM clients WHERE id = c.client_id) AS client_name,
                (SELECT starts_at::date::text FROM appointments WHERE id = c.appointment_id)
                  AS appointment_date`,
    [conversationId],
  );
  if (claim.rowCount === 0) return;
  const { appointment_id, client_id, transcript, client_name, appointment_date } = claim.rows[0];

  let note;
  try {
    // Who the client is, and which products this practice actually sells, are
    // both known here and were previously withheld from the model — leaving it
    // to infer which speaker is which, and to spell garbled product names from
    // scratch. Neither is a guess we need it to make.
    const catalog = await fetchSupplementVocabulary(client_id).catch(() => []);
    note = await extractSessionNote(transcript, {
      clientName: client_name,
      practitionerName: process.env.PRACTITIONER_NAME ?? 'Nicole',
      appointmentDate: appointment_date,
      catalog,
    });
  } catch (err) {
    // Keep the raw model output: without it, truncation, a schema violation and
    // a refusal all look identical in the logs after the fact.
    await markExtractionFailed(
      conversationId,
      err instanceof Error ? err.message : String(err),
      rawFromError(err),
    );
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
          SET extraction_status = 'done',
              extraction_leased_at = NULL,
              extraction_next_attempt_at = NULL,
              extraction_error = NULL,
              extraction_raw = NULL,
              updated_at = now()
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
    await markExtractionFailed(
      conversationId,
      err instanceof Error ? err.message : String(err),
      null,
    );
    await logError('session.extract', 'persisting session note failed', err, {
      conversation_id: conversationId,
    });
  } finally {
    db.release();
  }
}
