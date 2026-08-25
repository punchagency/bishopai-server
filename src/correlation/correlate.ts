import type { PoolClient } from 'pg';
import { logEvent } from '../observability/logger';
import { processConversation } from '../session/process';
import type { OverlapCandidate } from './multiSession';

export type CorrelationResult =
  | { status: 'matched'; appointmentId: string; clientId: string | null; overlapSeconds: number }
  | {
      status: 'unmatched';
      reason:
        | 'no_candidates'
        | 'ambiguous'
        | 'recording_too_short'
        | 'start_too_far'
        | 'margin_too_tight';
      candidateCount: number;
    };

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

/**
 * The make-or-break join: match a recording to a PB appointment by how closely
 * the recording STARTS to the booking, not by how much the two windows overlap.
 *
 * Overlap was the original rule, and it is structurally blind to a clinic
 * running late. Measured across every labelled recording we have, the recorder
 * starts anywhere from 24 minutes before the booking to 44 minutes after it —
 * and on a day running ~30-45 minutes behind, a recording lands entirely inside
 * the NEXT client's slot and overlaps its own booking by exactly zero seconds.
 * Three of nine recordings were unmatchable for that reason alone (Steve
 * Broderick +35m, Devin Brooks +31m, Nell-Rose Foreman +43m). The old query
 * could not even see their appointments: `&&` returned no rows at all, so they
 * came back `no_candidates` rather than as anything a human could act on.
 *
 * Start proximity has no such blind spot. Scored against those same nine:
 *
 *     max overlap (previous rule)   6/9 correct, 0 wrong, 3 abstained
 *     midpoint inside slot          6/9 correct, 0 wrong, 3 abstained
 *     nearest start (this rule)     9/9 correct, 0 wrong, 0 abstained
 *
 * Never-auto-guess is unchanged in substance, but it is expressed differently.
 * The old rule abstained whenever more than one appointment overlapped, which on
 * a back-to-back day is nearly all of them — the abstention was driven by the
 * clinic's booking density rather than by any real doubt. This one abstains on
 * MARGIN: the nearest booking must beat the runner-up by a clear distance. Every
 * true match in the corpus won by 16-95 minutes, so the threshold sits well
 * below any observed correct decision instead of being tuned to squeeze one in.
 *
 * Guards, in the order they fire:
 *
 * 1. Recording length — under a minute is an artefact, not a consultation. This
 *    is what separates a 0-minute stub from a real 2-minute one.
 *
 * 2. Multi-session — recording >1.5x the chosen appointment AND >=35 min almost
 *    certainly spans two consults, so hand it to the splitter rather than merge
 *    two clients' notes. This is the 2026-08-20 guard, and it stays.
 *
 * 3. Start distance — past 45 minutes the recorder is not plausibly running late
 *    for this booking any more; it is a different session.
 *
 * 4. Margin — the runner-up must be at least 15 minutes further away.
 *
 * The margin threshold assumes bookings are at least half an hour apart, which
 * is true of this diary (30/45/60/90-minute slots) — back-to-back 30s leave a
 * 30-minute margin, comfortably clear. A clinic running 15-minute slots would
 * sit exactly on the threshold and should lower it, or this gate stops
 * discriminating and starts rubber-stamping the earlier of two adjacent slots.
 *
 * Deliberately NOT a guard: a duration-ratio floor. Partial recordings are
 * normal, and three true matches here have recording/appointment ratios of 0.03,
 * 0.08 and 2.02 (recorder started late, stopped early, or ran across the end).
 * The old minimum-overlap guard — max(5 min, 25% of the appointment) — is gone
 * for the same reason: it rejected every zero-overlap late-running match on
 * sight. Its real intent was "a recording that bleeds 90 seconds into the next
 * slot belongs to the adjacent booking", and the ranking now handles that case
 * directly and more precisely, because such a recording starts far nearer its
 * own booking than the one it bleeds into.
 */

/** How far the recorder may start from a booking and still be that session. */
const MAX_START_DISTANCE_MS = 45 * 60_000;
/** How much nearer the winner must be than the runner-up to count as decided. */
const MIN_MARGIN_MS = 15 * 60_000;
/** Below this a recording is an artefact rather than a consultation. */
const MIN_RECORDING_MS = 60_000;

export async function correlateConversation(
  db: PoolClient,
  startsAt: string,
  endsAt: string,
): Promise<CorrelationResult> {
  const recStartMs = new Date(startsAt).getTime();
  const recDurMs = new Date(endsAt).getTime() - recStartMs;

  // Finiteness is checked explicitly because every comparison below is a `<` or
  // `>`, and NaN fails all of them — an unparseable timestamp would slide past
  // the distance and margin gates rather than being stopped by them.
  if (!Number.isFinite(recStartMs) || !Number.isFinite(recDurMs) || recDurMs < MIN_RECORDING_MS) {
    return { status: 'unmatched', reason: 'recording_too_short', candidateCount: 0 };
  }

  // Two exclusions, both misattribution guards:
  // - cancelled bookings: the slot may have been filled by someone else (a
  //   walk-in), and matching their recording to the cancelled client's chart is
  //   exactly the wrong-person error auto-matching must never make;
  // - appointments that already carry a recording: a second overlapping chunk
  //   (a split recording) must go to a human, not silently overwrite the
  //   first chunk's extracted note.
  //
  // Selected on `starts_at` proximity rather than range overlap, because an
  // appointment the recording never overlapped is precisely the case this has to
  // be able to see. The +/-3h window is deliberately much wider than
  // MAX_START_DISTANCE_MS so that the runner-up used for the margin test is a
  // real neighbouring booking and never an artefact of the query window. It also
  // reads straight down appointments_time_idx (starts_at, ends_at).
  //
  // overlap_seconds is still computed in SQL and still returned. It no longer
  // decides anything, but it is what the review queue shows a human, and on a
  // late-running match it is legitimately 0.
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
      WHERE starts_at BETWEEN $1::timestamptz - interval '3 hours'
                          AND $1::timestamptz + interval '3 hours'
        AND status <> 'cancelled'
        AND NOT EXISTS (SELECT 1 FROM conversations cv WHERE cv.appointment_id = a.id)
      ORDER BY starts_at`,
    [startsAt, endsAt],
  );

  if (rows.length === 0) {
    return { status: 'unmatched', reason: 'no_candidates', candidateCount: 0 };
  }

  // Ranked over the whole window, so the margin test sees the true nearest
  // neighbour even when that neighbour is itself too far away to be matchable.
  const ranked = rows
    .map((row) => ({ row, distanceMs: Math.abs(recStartMs - new Date(row.starts_at).getTime()) }))
    .sort((a, b) => a.distanceMs - b.distanceMs);

  const best = ranked[0];
  const candidate = best.row;
  // What a human would call "appointments this could plausibly have been".
  const plausibleCount = ranked.filter((r) => r.distanceMs <= MAX_START_DISTANCE_MS).length;
  // For the multi-session guard specifically, the meaningful count is how many
  // bookings the recording actually runs across — that abstention is about span,
  // not about start proximity, so plausibleCount would understate it.
  const overlappingCount = rows.filter((r) => r.overlap_seconds > 0).length;

  // Guard 2 — multi-session continuous recording. Checked before the distance
  // and margin gates: a recording spanning two consults needs the splitter, and
  // that is true however cleanly it happens to sit against its first booking.
  const apptDurMs =
    new Date(candidate.ends_at).getTime() - new Date(candidate.starts_at).getTime();
  if (recDurMs >= 35 * 60_000 && apptDurMs > 0 && recDurMs / apptDurMs > 1.5) {
    return { status: 'unmatched', reason: 'ambiguous', candidateCount: overlappingCount };
  }

  // Guard 3 — start distance.
  if (best.distanceMs > MAX_START_DISTANCE_MS) {
    logEvent('info', 'correlate', 'nearest appointment starts too far away', {
      starts_at: startsAt,
      ends_at: endsAt,
      appointment_id: candidate.id,
      distance_minutes: Math.round(best.distanceMs / 60_000),
      max_distance_minutes: MAX_START_DISTANCE_MS / 60_000,
    });
    return { status: 'unmatched', reason: 'start_too_far', candidateCount: 0 };
  }

  // Guard 4 — margin. A lone candidate has nothing to be confused with.
  const marginMs = ranked.length > 1 ? ranked[1].distanceMs - best.distanceMs : Infinity;
  if (marginMs < MIN_MARGIN_MS) {
    logEvent('info', 'correlate', 'nearest two appointments too close to call', {
      starts_at: startsAt,
      ends_at: endsAt,
      appointment_id: candidate.id,
      runner_up_appointment_id: ranked[1].row.id,
      margin_minutes: Math.round(marginMs / 60_000),
      min_margin_minutes: MIN_MARGIN_MS / 60_000,
    });
    return { status: 'unmatched', reason: 'margin_too_tight', candidateCount: plausibleCount };
  }

  return {
    status: 'matched',
    appointmentId: candidate.id,
    clientId: candidate.client_id,
    overlapSeconds: candidate.overlap_seconds,
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
        -- Two different exclusions that look alike. The first drops split
        -- CHILDREN, whose appointment a human chose during the split. The second
        -- drops split PARENTS, which stay 'unmatched' forever by design because
        -- their content now lives in the children — matching one would file the
        -- same consultation twice, under whoever the parent's window happened to
        -- land on. Under the old overlap rule a parent was safe by accident (its
        -- own appointments were already taken by its children, and nothing else
        -- overlapped, so it returned no_candidates); start-proximity ranking
        -- reaches further and would happily match it to a neighbouring booking.
        AND parent_conversation_id IS NULL
        AND NOT EXISTS (
              SELECT 1 FROM conversations child
               WHERE child.parent_conversation_id = conversations.id
            )
        -- 'split' is terminal. Without this line a parent slips through on the
        -- appointment_id IS NULL branch below, which is exactly how one gets
        -- matched to the client booked in the neighbouring slot.
        AND correlation_status <> 'split'
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
