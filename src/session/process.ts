import { getDatabase } from '../db/index.js';
import { extractSessionNote } from './extract';
import { logError, logEvent } from '../observability/logger';
import { rawFromError } from '../llm/errors';
import { markExtractionFailed } from './reclaim';
import { fetchSupplementVocabulary } from './supplements';

/**
 * Turn a matched conversation's transcript into an Appointment Sheet + Protocol.
 *
 * Runs off the request path (fire-and-forget from the ingest handlers). The
 * paid, slow LLM call happens OUTSIDE any transaction. Idempotent and safe to
 * call repeatedly: it atomically claims the row first, so a second caller
 * (retry, duplicate webhook) is a no-op.
 */
export async function processConversation(conversationId: string): Promise<void> {
  const db = getDatabase();

  // Claim: proceed only if matched (has appointment), has a transcript, and
  // isn't already done or in-flight. The guarded transition IS the lock — if it
  // returns null, someone else owns it or there's nothing to do.
  //
  // `extraction_leased_at` is what makes the claim recoverable: without it a
  // process that dies here leaves the row in `processing` forever, and the
  // reclaim sweep has no way to tell a live call from an abandoned one. It is
  // written unconditionally, not COALESCEd at read time, because Firestore
  // excludes documents missing an ordered field from a range query entirely
  // (§3.5) — a claim with no lease would be invisible to the sweep.
  const claimed = await db.conversations.transitionExtraction(
    conversationId,
    ['pending', 'failed'],
    { extraction_status: 'processing', extraction_leased_at: new Date().toISOString() },
    (row) => !!row.appointment_id && !!row.transcript,
  );
  if (!claimed) return;

  const appointmentId = claimed.appointment_id!;
  const transcript = claimed.transcript!;
  const clientId = claimed.client_id ?? null;

  const [client, appointment] = await Promise.all([
    clientId ? db.clients.findById(clientId) : Promise.resolve(null),
    db.appointments.findById(appointmentId),
  ]);
  const appointmentDate = appointment?.starts_at
    ? new Date(appointment.starts_at).toISOString().slice(0, 10)
    : null;

  let note;
  try {
    // Who the client is, and which products this practice actually sells, are
    // both known here and were previously withheld from the model — leaving it
    // to infer which speaker is which, and to spell garbled product names from
    // scratch. Neither is a guess we need it to make.
    const catalog = await fetchSupplementVocabulary(clientId).catch(() => []);
    note = await extractSessionNote(transcript, {
      clientName: client?.name ?? null,
      practitionerName: process.env.PRACTITIONER_NAME ?? 'Nicole',
      appointmentDate,
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

  // Re-verify the claim before writing anything. The LLM call takes seconds, and
  // in that window the conversation can be UNMATCHED (Nicole caught a wrong
  // assignment) — its drafts deleted and appointment_id nulled. Writing the
  // extracted note against the appointment captured at claim time would
  // resurrect a draft attributed to a client she just detached.
  const still = await db.conversations.transitionExtraction(
    conversationId,
    ['processing'],
    {
      extraction_status: 'done',
      extraction_leased_at: null,
      extraction_next_attempt_at: null,
      extraction_error: null,
      extraction_raw: null,
    },
    (row) => row.appointment_id === appointmentId,
  );
  if (!still) {
    logEvent('info', 'session.extract', 'conversation moved during extraction — result dropped', {
      conversation_id: conversationId,
      claimed_appointment_id: appointmentId,
    });
    return;
  }

  // The note write follows the status change rather than sharing a transaction
  // with it, because the two live in different collections and a transaction
  // spanning them would be retried as a unit — including the re-verification,
  // whose whole point is to observe a decision made elsewhere. If this write
  // fails the conversation is put back into the retry loop below, which is what
  // the pg ROLLBACK achieved: the extraction is re-run, not silently lost.
  try {
    const { written } = await db.sessionNotes.saveExtractedNote({
      appointmentId,
      clientId,
      // Denormalized onto both documents so every later ordering — the flow
      // sheet rebuild, prior-session lookup, history — is one indexed query
      // rather than a join Firestore cannot do.
      startsAt: appointment?.starts_at ?? null,
      clientName: client?.name ?? null,
      content: note as unknown as Record<string, unknown>,
    });
    if (!written) {
      logEvent(
        'warn',
        'session.extract',
        'approved note left untouched — extraction result not applied',
        { conversation_id: conversationId, appointment_id: appointmentId },
      );
    }
  } catch (err) {
    await markExtractionFailed(
      conversationId,
      err instanceof Error ? err.message : String(err),
      null,
    );
    await logError('session.extract', 'persisting session note failed', err, {
      conversation_id: conversationId,
    });
  }
}
