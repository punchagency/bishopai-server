import { getDatabase } from '../db/index.js';
import { conversationDocId } from '../db/ids.js';
import type { Conversation } from '../db/interfaces/types.js';
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
  const db = getDatabase();
  const id = conversationDocId(input.bee_id);
  const now = new Date().toISOString();

  const correlation = await correlateConversation(input.starts_at, input.ends_at);

  // Claim the appointment BEFORE writing the conversation that points at it.
  //
  // This replaces `conversations_appointment_unique` (0022). Two overlapping
  // recordings ingested concurrently can both correlate to the same appointment;
  // in Postgres the unique index rejected the loser and ingest retried, landing
  // it unmatched. Here the claim document does the rejecting, and doing it first
  // means a conversation is never written matched to an appointment it lost —
  // there is no window in which the pointer exists and the claim doesn't.
  let matched = correlation.status === 'matched';
  if (matched && correlation.status === 'matched') {
    const won = await db.conversations.claimAppointment({
      id: correlation.appointmentId,
      conversation_id: id,
      claimed_at: now,
    });
    // Losing is not an error: a competing chunk belongs in the unmatched queue,
    // which is where a human decides which recording is the real session.
    if (!won) matched = false;
  }

  const candidate: Conversation = {
    id,
    bee_id: input.bee_id,
    starts_at: input.starts_at,
    ends_at: input.ends_at,
    transcript: input.transcript ?? null,
    appointment_id: matched && correlation.status === 'matched' ? correlation.appointmentId : null,
    client_id: matched && correlation.status === 'matched' ? correlation.clientId : null,
    correlation_status: matched ? 'matched' : 'unmatched',
    extraction_status: 'pending',
    extraction_attempts: 0,
    extraction_next_attempt_at: now,
    extraction_leased_at: null,
    created_at: now,
    updated_at: now,
  };

  const { conversation: stored, created } = await db.conversations.upsertByBeeId(candidate);

  // On a replay the upsert kept the EXISTING assignment (possibly a manual one)
  // and this call's claim was against an appointment the stored row may not be
  // on. Hand it back so the claim collection stays a true mirror of what the
  // conversations actually hold.
  if (!created && matched && correlation.status === 'matched') {
    if (stored.appointment_id !== correlation.appointmentId) {
      await db.conversations.releaseAppointment(correlation.appointmentId);
    }
  }

  // Report the STORED row's state, not the fresh computation. On a replay the
  // upsert keeps the existing assignment (possibly manual), so the fresh
  // correlation can disagree with reality in both directions — and the caller
  // uses this result to decide whether to fire extraction. A replayed transcript
  // for a matched conversation must trigger it; a recomputed "match" for a row a
  // human left unmatched must not.
  const effective: CorrelationResult = stored.appointment_id
    ? {
        status: 'matched',
        appointmentId: stored.appointment_id,
        clientId: stored.client_id ?? null,
      }
    : correlation.status === 'unmatched'
      ? correlation
      : { status: 'unmatched', reason: 'ambiguous', candidateCount: 1 };

  return { conversationId: stored.id, correlation: effective };
}
