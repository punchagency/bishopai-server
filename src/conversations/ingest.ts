import { pool } from '../db/pool';
import {
  correlateConversation,
  listOverlapCandidates,
  type CorrelationResult,
} from '../correlation/correlate';
import { assessMultiSessionRisk, type MultiSessionRisk } from '../correlation/multiSession';
import { logEvent } from '../observability/logger';

/** Which recorder produced a conversation. Ids are namespaced per source. */
export type ConversationSource = 'bee' | 'pocket' | 'manual';

export interface ConversationInput {
  /** The recorder's own id for this recording (Pocket: `rec_…`, manual: `manual:<sha256>`). */
  source_id: string;
  /**
   * Required, with no default, because guessing it is a provenance lie.
   *
   * This used to fall back to 'pocket'. Nothing reached the fallback — every
   * writer names its source — but the cost of one that ever did is not a
   * mislabel. 0027 replaced the global unique on the id with `(source,
   * source_id)` precisely because two recorders' id namespaces can collide, so
   * a row that guesses 'pocket' is placed INTO the Pocket namespace, where an
   * unrelated recording can overwrite its transcript. And 0028 asks that a note
   * built from a hand-pasted transcript stay traceable as one. A required field
   * makes the next ingress path state which recorder it speaks for, at compile
   * time, instead of inheriting an answer from the recorder we happened to use
   * when the column was added.
   */
  source: ConversationSource;
  starts_at: string; // ISO 8601
  ends_at: string; // ISO 8601
  transcript?: string | null;
}

export interface IngestResult {
  conversationId: string;
  correlation: CorrelationResult;
  /** Set when the recording was held for review instead of filed. */
  hold?: { reasons: string[] };
  /** Set when the recording was filed as noise instead of correlated — short,
   *  and with no speech in it. Terminal: nothing matches, extracts or re-reads
   *  it, and it does not appear in the Unmatched review queue. */
  discarded?: { reason: string };
  /** True when this recording was held as a possible multi-client recording and
   *  a split proposal is now queued. Callers should enqueueSegmentation so the
   *  proposal is computed without waiting for the recovery tick. */
  segmentationQueued?: boolean;
}

/** Below this a recording is an artefact, not a consultation — mirrors
 *  MIN_RECORDING_MS in correlation/correlate.ts, which is where a recording this
 *  short already fails the matcher. */
const NOISE_MAX_MS = 60_000;

/**
 * Is this a recording of nothing?
 *
 * Pocket's transcriber does not hand back an empty string for a recording that
 * caught no speech — it returns a single bracketed event tag and nothing else:
 * "[click]", "[background noise]", "[BLANK_AUDIO]". Two such rows landed within a
 * second of each other on 2026-09-03 — a 1-second "[click]" and a 15-second
 * "[background noise]" — most likely the recorder switched on and straight back
 * off. Each one still goes through the full correlate path, fails the matcher's
 * one-minute floor, and comes to rest in the Unmatched review queue as an
 * ordinary "tag a client" row with nothing in it to tag or extract.
 *
 * Returns the reason string when the recording should be filed as noise, or null
 * when it is — or might yet become — a real session. Both conditions must hold:
 *
 *  - under a minute long. A genuine exchange this brief ("Hi, I need to
 *    reschedule") still has words in it and fails the speech test below, so this
 *    bound really guards the other direction: a three-minute recording that
 *    transcribes to noise alone is likelier a transcription failure worth a
 *    human's eyes than a recording of silence.
 *  - no speech. Every "[...]" tag removed, then every non-alphanumeric
 *    character; if nothing is left, nobody spoke. "[laughs] yeah, I've been
 *    tired" keeps letters and is not noise.
 *
 * A missing transcript is NOT noise: Pocket delivers audio before words, so an
 * empty body here is a recording still waiting for its transcript. It stays in
 * the normal flow and is re-evaluated on the upsert when the words arrive.
 *
 * Exported so the rule itself is unit-testable — it decides whether a recording
 * is ever seen again.
 */
export function classifyNoiseRecording(input: ConversationInput): string | null {
  const transcript = input.transcript?.trim();
  if (!transcript) return null;

  const durMs = new Date(input.ends_at).getTime() - new Date(input.starts_at).getTime();
  if (!Number.isFinite(durMs) || durMs >= NOISE_MAX_MS) return null;

  const speech = transcript.replace(/\[[^\]]*\]/g, ' ').replace(/[^\p{L}\p{N}]+/gu, '');
  if (speech.length > 0) return null;

  const secs = Math.max(0, Math.round(durMs / 1000));
  const preview = transcript.length > 60 ? `${transcript.slice(0, 57)}…` : transcript;
  return `${secs}s recording with no speech in it (${preview}) — filed as noise, not left for identification.`;
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
  // Decided before the transaction opens: it is a pure read of the payload, and
  // a noise recording skips both correlation queries below.
  const noiseReason = classifyNoiseRecording(input);

  const db = await pool.connect();
  try {
    await db.query('BEGIN');

    // A noise recording never reaches the matcher. Skipping it is deliberate,
    // not just an optimisation: a stray "[click]" that happens to fall inside a
    // booked slot would otherwise correlate to it, filing an empty body against
    // a client's chart. It is written anyway — provenance, and so a redelivery
    // stays idempotent on (source, source_id) — but as 'discarded', which is
    // terminal.
    const correlation: CorrelationResult = noiseReason
      ? { status: 'unmatched', reason: 'recording_too_short', candidateCount: 0 }
      : await correlateConversation(db, input.starts_at, input.ends_at);

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
    const candidates = noiseReason
      ? []
      : await listOverlapCandidates(db, input.starts_at, input.ends_at);
    const matchedName =
      correlation.status === 'matched'
        ? candidates.find((c) => c.appointmentId === correlation.appointmentId)?.clientName ?? null
        : null;
    const risk: MultiSessionRisk = noiseReason
      ? { hold: false, reasons: [] }
      : assessMultiSessionRisk({
          transcript: input.transcript ?? null,
          candidates,
          matchedClientName: matchedName,
        });

    const matched = correlation.status === 'matched' && !risk.hold;
    // 'discarded' outranks 'needs_review': a recording with no speech in it
    // cannot also be a multi-client hold, and `risk` is not even computed above
    // when `noiseReason` is set.
    const status = matched
      ? 'matched'
      : noiseReason
        ? 'discarded'
        : risk.hold
          ? 'needs_review'
          : 'unmatched';
    // Both are auto-status changes an upsert may need to apply to an existing
    // row: `demote` covers the veto path (a match the transcript later revealed
    // as multi-client) and the noise path (a "[click]" whose transcript arrived
    // after the audio).
    const demote = !!noiseReason || risk.hold;
    const holdReason = noiseReason ?? (risk.hold ? risk.reasons.join('; ') : null);

    const ins = await db.query<{
      id: string;
      appointment_id: string | null;
      client_id: string | null;
      correlation_overlap_seconds: number | null;
      correlation_status: string;
      segmentation_status: string | null;
    }>(
      `INSERT INTO conversations
              (source_id, source, starts_at, ends_at, transcript, appointment_id, client_id,
               correlation_status, correlation_overlap_seconds, correlation_hold_reason,
               segmentation_status)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
                    CASE WHEN $8 = 'needs_review' THEN 'pending' ELSE NULL END)
       ON CONFLICT (source, source_id) DO UPDATE
            SET transcript = COALESCE(EXCLUDED.transcript, conversations.transcript),
                -- A replay can DEMOTE an existing match, and has to be able to.
                -- The gate reads the transcript, and the transcript often arrives
                -- after the recording does: Pocket delivers audio first and words
                -- second. A recording that matched cleanly while it had no words
                -- would otherwise keep that match forever, even once the words
                -- revealed three clients in it — or revealed that no one spoke.
                --
                -- Only an AUTO status is touched. 'manual' and 'walk_in' are a
                -- human's decision about whose session this is, and a heuristic
                -- does not get to overrule one.
                --
                -- 'unmatched' is included for the same reason 'matched' is, and
                -- it is the commoner case. Audio arrives before words, and a
                -- recording with no transcript reaches the gate with nothing to
                -- read, so it lands in the queue as plain 'unmatched'. When the
                -- transcript finally arrives this is the moment the gate can
                -- see two clients in it — and demoting only from 'matched'
                -- meant that recording kept a bare 'unmatched' label, with no
                -- hold reason and nothing telling Nicole to split it.
                correlation_status = CASE
                  WHEN $11::boolean AND conversations.correlation_status IN ('matched', 'unmatched')
                    THEN CASE WHEN $12::boolean THEN 'discarded' ELSE 'needs_review' END
                  ELSE conversations.correlation_status END,
                appointment_id = CASE
                  WHEN $11::boolean AND conversations.correlation_status IN ('matched', 'unmatched')
                    THEN NULL ELSE conversations.appointment_id END,
                client_id = CASE
                  WHEN $11::boolean AND conversations.correlation_status IN ('matched', 'unmatched')
                    THEN NULL ELSE conversations.client_id END,
                correlation_hold_reason = CASE
                  WHEN $11::boolean AND conversations.correlation_status IN ('matched', 'unmatched')
                    THEN $10::text ELSE conversations.correlation_hold_reason END,
                -- A late transcript that reveals two clients demotes to
                -- 'needs_review' here (never to 'discarded' — that path is
                -- $12). Queue the split proposal at the same moment, unless one
                -- already ran. And if a held recording's transcript is REPLACED
                -- by a redelivery, re-queue: the stored proposal was computed
                -- from text that no longer exists.
                segmentation_status = CASE
                  WHEN $11::boolean AND NOT $12::boolean
                       AND conversations.correlation_status IN ('matched', 'unmatched')
                       AND conversations.segmentation_status IS NULL
                    THEN 'pending'
                  WHEN conversations.correlation_status = 'needs_review'
                       AND EXCLUDED.transcript IS NOT NULL
                       AND EXCLUDED.transcript IS DISTINCT FROM conversations.transcript
                    THEN 'pending'
                  ELSE conversations.segmentation_status END
         RETURNING id, appointment_id, client_id, correlation_overlap_seconds,
                   correlation_status, segmentation_status`,
      [
        input.source_id,
        input.source,
        input.starts_at,
        input.ends_at,
        input.transcript ?? null,
        matched ? correlation.appointmentId : null,
        matched ? correlation.clientId : null,
        status,
        matched ? correlation.overlapSeconds : null,
        holdReason,
        demote,
        !!noiseReason,
      ],
    );

    if (noiseReason) {
      logEvent('info', 'correlate', 'recording filed as noise — no speech in it', {
        source_id: input.source_id,
        starts_at: input.starts_at,
        ends_at: input.ends_at,
        reason: noiseReason,
      });
    } else if (risk.hold) {
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
      discarded:
        row.correlation_status === 'discarded'
          ? { reason: noiseReason ?? row.correlation_status }
          : undefined,
      segmentationQueued: row.segmentation_status === 'pending',
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
