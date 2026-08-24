import { pool } from '../db/pool';
import {
  correlateConversation,
  listOverlapCandidates,
  type CorrelationResult,
} from '../correlation/correlate';
import { assessMultiSessionRisk } from '../correlation/multiSession';
import { logEvent } from '../observability/logger';

/** Which recorder produced a conversation. Ids are namespaced per source. */
export type ConversationSource = 'bee' | 'pocket' | 'manual';

export interface ConversationInput {
  /** The recorder's own id for this recording (Pocket: `rec_…`, manual: `manual:<sha256>`). */
  source_id: string;
  source?: ConversationSource; // defaults to 'pocket'
  starts_at: string; // ISO 8601
  ends_at: string; // ISO 8601
  transcript?: string | null;
}

export interface IngestResult {
  conversationId: string;
  correlation: CorrelationResult;
  /** Set when the recording was held for review instead of filed. */
  hold?: { reasons: string[] };
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

    // The safety gate runs AFTER the matcher and can veto it.
    //
    // Order matters, and this order is the point: the matcher's job is to find
    // the best single appointment, and it is very good at producing a confident
    // answer for a recording that has no single right answer. On 2026-08-20 it
    // filed a 41-minute recording holding three consecutive consultations under
    // one client, at full confidence, and every check downstream agreed with it
    // — the note parsed, the evidence quotes verified, the coverage metric read
    // 99.7%. Nothing after this point can catch that, so it is caught here.
    //
    // A veto never reassigns. It parks the recording and names what looked
    // wrong; deciding whose words are whose is a clinical judgement and belongs
    // to Nicole.
    const candidates = await listOverlapCandidates(db, input.starts_at, input.ends_at);
    const matchedName =
      correlation.status === 'matched'
        ? candidates.find((c) => c.appointmentId === correlation.appointmentId)?.clientName ?? null
        : null;
    const risk = assessMultiSessionRisk({
      transcript: input.transcript ?? null,
      candidates,
      matchedClientName: matchedName,
    });

    const matched = correlation.status === 'matched' && !risk.hold;

    const ins = await db.query<{
      id: string;
      appointment_id: string | null;
      client_id: string | null;
      correlation_overlap_seconds: number | null;
      correlation_status: string;
    }>(
      `INSERT INTO conversations
              (source_id, source, starts_at, ends_at, transcript, appointment_id, client_id,
               correlation_status, correlation_overlap_seconds, correlation_hold_reason)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $11)
       ON CONFLICT (source, source_id) DO UPDATE
            SET transcript = COALESCE(EXCLUDED.transcript, conversations.transcript),
                -- A replay can DEMOTE an existing match, and has to be able to.
                -- The gate reads the transcript, and the transcript often arrives
                -- after the recording does: Pocket delivers audio first and words
                -- second. A recording that matched cleanly while it had no words
                -- would otherwise keep that match forever, even once the words
                -- revealed three clients in it.
                --
                -- Only an AUTO match is demoted. 'manual' and 'walk_in' are a
                -- human's decision about whose session this is, and a heuristic
                -- does not get to overrule one.
                correlation_status = CASE
                  WHEN $10::boolean AND conversations.correlation_status = 'matched'
                    THEN 'needs_review' ELSE conversations.correlation_status END,
                appointment_id = CASE
                  WHEN $10::boolean AND conversations.correlation_status = 'matched'
                    THEN NULL ELSE conversations.appointment_id END,
                client_id = CASE
                  WHEN $10::boolean AND conversations.correlation_status = 'matched'
                    THEN NULL ELSE conversations.client_id END,
                correlation_hold_reason = CASE
                  WHEN $10::boolean AND conversations.correlation_status = 'matched'
                    THEN $11::text ELSE conversations.correlation_hold_reason END
         RETURNING id, appointment_id, client_id, correlation_overlap_seconds, correlation_status`,
      [
        input.source_id,
        input.source ?? 'pocket',
        input.starts_at,
        input.ends_at,
        input.transcript ?? null,
        matched ? correlation.appointmentId : null,
        matched ? correlation.clientId : null,
        matched ? 'matched' : risk.hold ? 'needs_review' : 'unmatched',
        matched ? correlation.overlapSeconds : null,
        risk.hold,
        risk.hold ? risk.reasons.join('; ') : null,
      ],
    );

    if (risk.hold) {
      logEvent('warn', 'correlate', 'recording held for review — may span more than one client', {
        source_id: input.source_id,
        starts_at: input.starts_at,
        ends_at: input.ends_at,
        would_have_matched: correlation.status === 'matched' ? matchedName : null,
        reasons: risk.reasons,
      });
    }

    await db.query('COMMIT');

    // Report the STORED row's state, not the fresh computation. On a replay the
    // conflict update keeps the existing assignment (possibly manual), so the
    // fresh correlation can disagree with reality in both directions — and the
    // caller uses this result to decide whether to fire extraction. A replayed
    // transcript for a matched conversation must trigger it; a recomputed
    // "match" for a row a human left unmatched must not.
    const row = ins.rows[0];
    const effective: CorrelationResult = row.appointment_id
      ? {
          status: 'matched',
          appointmentId: row.appointment_id,
          clientId: row.client_id,
          // From the STORED row for the same reason the status is: on a replay
          // the row may carry an overlap from an earlier (or manual) assignment,
          // and reporting this pass's freshly computed number against someone
          // else's match would describe a join that never happened.
          overlapSeconds: row.correlation_overlap_seconds ?? 0,
        }
      : correlation.status === 'unmatched'
        ? correlation
        : { status: 'unmatched', reason: 'ambiguous', candidateCount: 1 };
    return {
      conversationId: row.id,
      correlation: effective,
      // Reported from the STORED status, so a replay that found a held row it
      // did not itself demote still tells the caller not to extract.
      hold:
        row.correlation_status === 'needs_review'
          ? { reasons: risk.hold ? risk.reasons : ['held for review'] }
          : undefined,
    };
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
