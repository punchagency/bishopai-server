import type { PoolClient } from 'pg';
import { logEvent } from '../observability/logger';
import { processConversation } from '../session/process';
import type { OverlapCandidate } from './multiSession';

export type CorrelationResult =
  | { status: 'matched'; appointmentId: string; clientId: string | null; overlapSeconds: number }
  | { status: 'unmatched'; reason: 'no_candidates' | 'ambiguous' | 'overlap_too_small'; candidateCount: number };

/**
 * The make-or-break join: match a recording to a PB appointment by
 * overlapping time window. Uses Postgres range overlap (&&) against the
 * appointments time index.
 *
 * Hard rule (build plan §4/§9): never auto-guess. Exactly one candidate =>
 * matched. Zero or many => unmatched, routed to manual tagging.
 *
 * Two additional guards prevent false matches:
 *
 * 1. Duration ratio: if the recording is >1.5× the appointment AND ≥35 min,
 *    it almost certainly spans multiple sessions — flag as ambiguous so the UI
 *    can offer a split instead of silently merging two clients' notes.
 *
 * 2. Minimum overlap: if the actual intersection is less than
 *    max(5 min, 25% of appointment duration), the recording only bleeds into
 *    the appointment window rather than belonging to it. Auto-matching on a
 *    90-second bleed is the inverse of the Jodi bug — a different client's
 *    recording attributed to the wrong appointment because they share a minute
 *    at the boundary.
 */
/**
 * Every non-cancelled appointment overlapping the recording window, with the
 * client's name and the size of the overlap.
 *
 * Deliberately NOT filtered by `NOT EXISTS (... cv.appointment_id = a.id)` the
 * way the matcher is. The matcher skips a taken appointment because it cannot
 * assign to it; the safety gate needs to know the appointment is THERE. "This
 * recording spans Jodi's slot and Carissa's slot" is true whether or not
 * Carissa's slot already has a recording of its own — and if anything, a
 * neighbouring slot that already has audio makes it MORE likely this recording
 * crosses a boundary, not less.
 */
export async function listOverlapCandidates(
  db: PoolClient,
  startsAt: string,
  endsAt: string,
): Promise<OverlapCandidate[]> {
  const { rows } = await db.query<{
    id: string;
    client_name: string | null;
    overlap_seconds: number;
  }>(
    `SELECT a.id,
            (SELECT name FROM clients WHERE id = a.client_id) AS client_name,
            GREATEST(0, EXTRACT(EPOCH FROM (
              LEAST(a.ends_at, $2::timestamptz) - GREATEST(a.starts_at, $1::timestamptz)
            )))::integer AS overlap_seconds
       FROM appointments a
      WHERE tstzrange(a.starts_at, a.ends_at) && tstzrange($1, $2)
        AND a.status <> 'cancelled'
      ORDER BY overlap_seconds DESC`,
    [startsAt, endsAt],
  );
  return rows.map((r) => ({
    appointmentId: r.id,
    clientName: r.client_name,
    overlapSeconds: r.overlap_seconds,
  }));
}

export async function correlateConversation(
  db: PoolClient,
  startsAt: string,
  endsAt: string,
): Promise<CorrelationResult> {
  // Two exclusions, both misattribution guards:
  // - cancelled bookings: the slot may have been filled by someone else (a
  //   walk-in), and matching their recording to the cancelled client's chart is
  //   exactly the wrong-person error auto-matching must never make;
  // - appointments that already carry a recording: a second overlapping chunk
  //   (a split recording) must go to a human, not silently overwrite the
  //   first chunk's extracted note.
  //
  // overlap_seconds is computed in SQL so we avoid a round-trip and keep the
  // arithmetic in one place. EXTRACT(EPOCH FROM ...) returns fractional seconds;
  // GREATEST(..., 0) guards against negative values from floating-point rounding.
  const { rows } = await db.query<{
    id: string;
    client_id: string | null;
    starts_at: string;
    ends_at: string;
    overlap_seconds: number;
  }>(
    `SELECT id, client_id, starts_at, ends_at,
            GREATEST(0, EXTRACT(EPOCH FROM (
              LEAST(ends_at, $2::timestamptz) - GREATEST(starts_at, $1::timestamptz)
            )))::integer AS overlap_seconds
       FROM appointments a
      WHERE tstzrange(starts_at, ends_at) && tstzrange($1, $2)
        AND status <> 'cancelled'
        AND NOT EXISTS (SELECT 1 FROM conversations cv WHERE cv.appointment_id = a.id)
      ORDER BY starts_at`,
    [startsAt, endsAt],
  );

  if (rows.length === 1) {
    const candidate = rows[0];
    const recDurMs = new Date(endsAt).getTime() - new Date(startsAt).getTime();
    const apptDurMs =
      new Date(candidate.ends_at).getTime() - new Date(candidate.starts_at).getTime();
    const apptDurSec = apptDurMs / 1000;

    // Guard 1 — multi-session continuous recording:
    // if the recording is significantly longer than the single candidate
    // appointment (>1.5x and >=35 min), do not auto-match. Route to splitting.
    if (recDurMs >= 35 * 60_000 && apptDurMs > 0 && recDurMs / apptDurMs > 1.5) {
      return { status: 'unmatched', reason: 'ambiguous', candidateCount: 1 };
    }

    // Guard 2 — minimum overlap:
    // Require at least 5 minutes OR 25% of the appointment duration, whichever
    // is larger. A recording that bleeds 90 seconds into an appointment boundary
    // belongs to the adjacent slot, not this one.
    const minOverlapSec = Math.max(300, apptDurSec * 0.25);
    if (apptDurSec > 0 && candidate.overlap_seconds < minOverlapSec) {
      logEvent('info', 'correlate', 'overlap too small for auto-match', {
        starts_at: startsAt,
        ends_at: endsAt,
        overlap_seconds: candidate.overlap_seconds,
        min_overlap_seconds: Math.round(minOverlapSec),
        appointment_id: candidate.id,
      });
      return { status: 'unmatched', reason: 'overlap_too_small', candidateCount: 1 };
    }

    return {
      status: 'matched',
      appointmentId: candidate.id,
      clientId: candidate.client_id,
      overlapSeconds: candidate.overlap_seconds,
    };
  }

  return {
    status: 'unmatched',
    reason: rows.length === 0 ? 'no_candidates' : 'ambiguous',
    candidateCount: rows.length,
  };
}

/**
 * Re-evaluate recent conversations overlapping a newly synced appointment window.
 *
 * Catches two failure modes:
 *
 * 1. Race: a recording arrived minutes before its PB appointment synced. The
 *    recording landed unmatched (no candidate existed yet); now the appointment
 *    exists and we can match it.
 *
 * 2. Window: uses the appointment's own time window rather than conversation
 *    creation time, so a recording from last week whose appointment was just
 *    manually entered is still found.
 *
 * Callers: pbSync (on appointment upsert) and correlationSweepJob (periodic
 * catch-all for appointments inserted outside pbSync).
 *
 * After a successful re-match, processConversation is triggered so the note
 * is extracted without requiring manual intervention.
 */
export async function recorrelateOverlappingConversations(
  db: PoolClient,
  startsAt: string,
  endsAt: string,
): Promise<void> {
  // 7-day window relative to the appointment start: catches late PB syncs,
  // server downtime gaps, and manual appointment insertions. Using the
  // appointment's time window (not conversation.created_at) so the query is
  // anchor-independent — a recording from 3 days ago is equally recoverable
  // as one from 3 minutes ago if its appointment just appeared.
  const { rows } = await db.query<{
    id: string;
    starts_at: string;
    ends_at: string;
    appointment_id: string | null;
    correlation_status: string;
  }>(
    `SELECT id, starts_at, ends_at, appointment_id, correlation_status
       FROM conversations
      WHERE tstzrange(starts_at, ends_at) && tstzrange($1, $2)
        AND starts_at > $1::timestamptz - interval '7 days'
        AND parent_conversation_id IS NULL
        AND (appointment_id IS NULL OR correlation_status = 'unmatched')`,
    [startsAt, endsAt],
  );

  for (const conv of rows) {
    const res = await correlateConversation(db, conv.starts_at, conv.ends_at);
    if (res.status !== 'matched') continue;
    if (res.appointmentId === conv.appointment_id) continue;

    const updated = await db.query<{ id: string }>(
      `UPDATE conversations
          SET appointment_id = $2,
              client_id = $3,
              correlation_status = 'matched',
              correlation_overlap_seconds = $4,
              updated_at = now()
        WHERE id = $1
          AND (appointment_id IS NULL OR correlation_status = 'unmatched')
        RETURNING id`,
      [conv.id, res.appointmentId, res.clientId, res.overlapSeconds],
    );

    if ((updated.rowCount ?? 0) > 0) {
      logEvent('info', 'correlate.recorrelate', 'late-sync re-match succeeded', {
        conversation_id: conv.id,
        appointment_id: res.appointmentId,
        overlap_seconds: res.overlapSeconds,
      });
      // Trigger extraction now that the conversation has a home. Fire-and-forget
      // is fine here: the extraction job (reclaim.ts) will retry on failure, and
      // we must not block the caller's transaction on a long LLM call.
      void processConversation(conv.id).catch((err) => {
        logEvent('warn', 'correlate.recorrelate', 'processConversation failed after re-match', {
          conversation_id: conv.id,
          error: String(err),
        });
      });
    }
  }
}
