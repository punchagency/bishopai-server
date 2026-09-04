import type { PoolClient } from 'pg';
import { pool } from '../db/pool';
import { logEvent } from '../observability/logger';
import { scoreNameMatch, overlapSeconds } from '../correlation/nameMatch';
import { backoffMinutes } from './extractionPolicy';
import {
  detectSessionBoundaries,
  parseTurns,
  type SessionBoundarySegment,
} from './segmenter';

// The multi-session boundary detector, run ONCE and stored — not on demand.
//
// `GET /review/unmatched/:id/segments` used to run all of this synchronously
// every time the splitter modal opened: a candidate query, name scoring, an LLM
// pass over the whole transcript, a re-parse for the turn snapshot. On an
// hour-long recording that is a 20-60s wait, paid, repeated on every reopen, and
// it only started when Nicole went looking for it.
//
// `computeSegmentation` is that same work, lifted out so the route and the
// background drain both call it. `runSegmentation` is the drain's entry point:
// it claims the row on a lease, stores the proposal in `proposed_segments`, and
// leaves `segmentation_status = 'done'` so the modal can open pre-filled and
// instant.

export const SEGMENTATION_MAX_ATTEMPTS = Number(
  process.env.SEGMENTATION_MAX_ATTEMPTS ?? 3,
);

/** What the splitter needs to render a proposed split without doing any work. */
export interface SegmentationResult {
  segments: SessionBoundarySegment[];
  candidates: SegmentationCandidate[];
  turns: SegmentationTurn[];
  /** ISO — when the proposal was computed, so a stale one can be spotted. */
  computed_at: string;
}

export interface SegmentationCandidate {
  id: string;
  starts_at: string;
  ends_at: string;
  client_id: string | null;
  client_name: string | null;
  name_mentions: number;
  name_matched_on: 'full' | 'last' | 'first' | null;
  overlap_seconds: number;
}

export interface SegmentationTurn {
  index: number;
  speaker: string;
  role: string;
  text: string;
}

interface ConvRow {
  id: string;
  starts_at: string;
  ends_at: string;
  transcript: string | null;
}

interface ClaimedRow extends ConvRow {
  /** Attempts already spent, BEFORE this run — indexes the backoff table. */
  segmentation_attempts: number;
}

/**
 * Detect the session boundaries in one recording and match each to an
 * appointment candidate. Pure read — nothing is written here.
 *
 * `db` is optional so the route (which has no transaction) and the drain (which
 * holds a claimed row) can both call it against the shared pool.
 */
export async function computeSegmentation(
  conv: ConvRow,
  db: Pick<PoolClient, 'query'> = pool,
): Promise<SegmentationResult> {
  const { starts_at: cs, ends_at: ce } = conv;
  const transcriptText = conv.transcript ?? '';

  // The same candidate set the /candidates endpoint offers: not-cancelled,
  // not-already-taken appointments whose window comes within a couple of hours
  // of the recording, nearest start first.
  const candRes = await db.query<{
    id: string;
    starts_at: string;
    ends_at: string;
    client_id: string | null;
    client_name: string | null;
  }>(
    `SELECT a.id, a.starts_at, a.ends_at, a.client_id, c.name AS client_name
       FROM appointments a
  LEFT JOIN clients c ON c.id = a.client_id
      WHERE a.status <> 'cancelled'
        AND NOT EXISTS (SELECT 1 FROM conversations cv WHERE cv.appointment_id = a.id)
        AND a.starts_at <= ($2::timestamptz + INTERVAL '2 hours')
        AND a.ends_at   >= ($1::timestamptz - INTERVAL '2 hours')
   ORDER BY abs(extract(epoch FROM (a.starts_at - $1::timestamptz)))
      LIMIT 12`,
    [cs, ce],
  );

  const candidates: SegmentationCandidate[] = candRes.rows.map((a) => {
    const name = scoreNameMatch(transcriptText, a.client_name);
    return {
      id: a.id,
      starts_at: a.starts_at,
      ends_at: a.ends_at,
      client_id: a.client_id,
      client_name: a.client_name,
      name_mentions: name.mentions,
      name_matched_on: name.matchedOn,
      overlap_seconds: overlapSeconds(cs, ce, a.starts_at, a.ends_at),
    };
  });

  const segments = await detectSessionBoundaries(
    transcriptText,
    candidates.map((c) => c.client_name).filter((n): n is string => !!n),
    candidates.map((c) => ({
      id: c.id,
      starts_at: c.starts_at,
      ends_at: c.ends_at,
      client_name: c.client_name,
      overlap_seconds: c.overlap_seconds,
    })),
    new Date(cs).getTime(),
    new Date(ce).getTime(),
  );

  // The turn list the boundaries were computed from travels with them — the
  // renderer draws its markers off `from_turn`, and that only lines up if both
  // sides parsed the transcript the same way.
  const turns: SegmentationTurn[] = parseTurns(transcriptText).map((t) => ({
    index: t.index,
    speaker: t.speaker,
    role: t.role ?? 'UNKNOWN',
    text: t.text,
  }));

  return { segments, candidates, turns, computed_at: new Date().toISOString() };
}

const LEASE_MINUTES = Number(process.env.EXTRACTION_LEASE_MINUTES ?? 10);

/**
 * Compute and store the segmentation for one held recording.
 *
 * Claims the row on a lease so two drains can't both work it, computes, writes
 * the proposal to `proposed_segments`, and settles `segmentation_status`. A
 * failure bumps the attempt count and backs off; past the cap it stays 'failed'
 * and the modal falls back to the live path.
 *
 * No-ops (returns false) if the row is not claimable — already done, running
 * elsewhere, no longer held, or out of attempts.
 */
export async function runSegmentation(conversationId: string): Promise<boolean> {
  const claim = await pool.query<ClaimedRow>(
    `UPDATE conversations
        SET segmentation_status = 'processing',
            segmentation_leased_at = now(),
            updated_at = now()
      WHERE id = $1
        AND correlation_status = 'needs_review'
        AND transcript IS NOT NULL
        AND segmentation_status IN ('pending', 'failed')
        AND segmentation_attempts < $2
        AND (segmentation_next_attempt_at IS NULL OR segmentation_next_attempt_at <= now())
    RETURNING id, starts_at, ends_at, transcript, segmentation_attempts`,
    [conversationId, SEGMENTATION_MAX_ATTEMPTS],
  );
  if (claim.rowCount === 0) return false;
  const conv = claim.rows[0];

  try {
    const result = await computeSegmentation(conv);
    await pool.query(
      `UPDATE conversations
          SET segmentation_status = 'done',
              proposed_segments = $2::jsonb,
              segmentation_error = NULL,
              segmentation_leased_at = NULL,
              updated_at = now()
        WHERE id = $1 AND segmentation_status = 'processing'`,
      [conv.id, JSON.stringify(result)],
    );
    logEvent('info', 'session.segmentation', 'proposal computed', {
      conversation_id: conv.id,
      segment_count: result.segments.length,
    });
    return true;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // Capped, escalating backoff keyed on attempts spent so far (1 → 5 → 15
    // min), mirroring markExtractionFailed. detectSessionBoundaries swallows its
    // own model errors and degrades to the deterministic scorer, so a failure
    // here is a real fault (a DB blip, a bad transcript) worth spacing out —
    // not a rate limit, which the queue's allowanceStatus() check keeps us from
    // even attempting.
    await pool.query(
      `UPDATE conversations
          SET segmentation_status = 'failed',
              segmentation_attempts = segmentation_attempts + 1,
              segmentation_error = $2,
              segmentation_leased_at = NULL,
              segmentation_next_attempt_at = now() + ($3 || ' minutes')::interval,
              updated_at = now()
        WHERE id = $1 AND segmentation_status = 'processing'`,
      [conv.id, message.slice(0, 2000), String(backoffMinutes(conv.segmentation_attempts))],
    );
    logEvent('warn', 'session.segmentation', 'proposal failed', {
      conversation_id: conv.id,
      error: message,
    });
    return false;
  }
}

/**
 * Return rows stranded in `processing` past their lease to `failed`, counting an
 * attempt — same crash-recovery contract as reclaimStuckExtractions.
 */
export async function reclaimStuckSegmentations(): Promise<{ reclaimed: number }> {
  const r = await pool.query<{ id: string }>(
    `UPDATE conversations
        SET segmentation_status = 'failed',
            segmentation_attempts = segmentation_attempts + 1,
            segmentation_error = COALESCE(segmentation_error,
              'segmentation lease expired — process died mid-flight'),
            segmentation_next_attempt_at = now(),
            segmentation_leased_at = NULL,
            updated_at = now()
      WHERE segmentation_status = 'processing'
        AND COALESCE(segmentation_leased_at, updated_at) < now() - ($1 || ' minutes')::interval
    RETURNING id`,
    [String(LEASE_MINUTES)],
  );
  return { reclaimed: r.rowCount ?? 0 };
}
