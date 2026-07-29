import { pool } from '../db/pool';
import { logEvent } from '../observability/logger';
import { processConversation } from './process';

// Extraction crash recovery + retry, modelled on the WF2 reconciliation outbox
// (checkout/reconcile.ts) because the failure mode is the same shape: durable
// work claimed by a process that can die holding it.
//
// Before this, `processing` was terminal. The claim in processConversation only
// ever picks up 'pending' or 'failed', so a row set to 'processing' and then
// abandoned — deploy, OOM, hung provider call — stayed there forever. Nothing
// swept it, and the only symptom was an appointment that quietly never got a
// sheet. `failed` was barely better: retried only if a human happened to
// re-match the conversation.

/** How long a claim may go unfinished before we assume its owner died. */
const LEASE_MINUTES = Number(process.env.EXTRACTION_LEASE_MINUTES ?? 10);
/** Attempts before a conversation stops retrying and asks for a human. */
const MAX_ATTEMPTS = Number(process.env.EXTRACTION_MAX_ATTEMPTS ?? 4);
/** Capped backoff. Index by attempt count; past the end, use the last. */
const BACKOFF_MINUTES = [1, 5, 15, 60];

export function backoffMinutes(attempts: number): number {
  return BACKOFF_MINUTES[Math.min(attempts, BACKOFF_MINUTES.length - 1)];
}

export interface ReclaimResult {
  reclaimed: number;
}

/**
 * Return conversations stuck in `processing` past their lease to `failed`, so
 * the retry sweep below can pick them up. Counts as an attempt — a call that
 * hangs until the lease expires is a failure, and letting it retry forever for
 * free would just hang forever, repeatedly.
 */
export async function reclaimStuckExtractions(): Promise<ReclaimResult> {
  const r = await pool.query<{ id: string }>(
    `UPDATE conversations
        SET extraction_status = 'failed',
            extraction_attempts = extraction_attempts + 1,
            extraction_error = COALESCE(extraction_error,
              'extraction lease expired — process died mid-flight'),
            extraction_next_attempt_at = now(),
            updated_at = now()
      WHERE extraction_status = 'processing'
        AND COALESCE(extraction_leased_at, updated_at) < now() - ($1 || ' minutes')::interval
    RETURNING id`,
    [String(LEASE_MINUTES)],
  );
  const reclaimed = r.rowCount ?? 0;
  if (reclaimed > 0) {
    logEvent('warn', 'session.extract', 'reclaimed stuck extractions', {
      reclaimed,
      lease_minutes: LEASE_MINUTES,
      ids: r.rows.map((x) => x.id),
    });
  }
  return { reclaimed };
}

export interface RetryResult {
  retried: number;
  deadLettered: number;
}

/**
 * Drive due retries, and dead-letter the ones that have exhausted their
 * attempts. `needs_review` is a real state, not a silent give-up: the dashboard
 * surfaces it, because "this recording never extracted" is something Nicole must
 * see rather than discover when an appointment sheet is missing.
 */
export async function processDueExtractions(limit = 20): Promise<RetryResult> {
  const dead = await pool.query(
    `UPDATE conversations
        SET extraction_status = 'needs_review', updated_at = now()
      WHERE extraction_status = 'failed'
        AND extraction_attempts >= $1
    RETURNING id`,
    [MAX_ATTEMPTS],
  );
  const deadLettered = dead.rowCount ?? 0;
  if (deadLettered > 0) {
    logEvent('error', 'session.extract', 'extraction exhausted retries — needs review', {
      count: deadLettered,
      ids: dead.rows.map((r: { id: string }) => r.id),
      max_attempts: MAX_ATTEMPTS,
    });
  }

  // Only rows that are actually processable: matched, transcribed, and due.
  const due = await pool.query<{ id: string }>(
    `SELECT id FROM conversations
      WHERE extraction_status = 'failed'
        AND extraction_attempts < $1
        AND appointment_id IS NOT NULL
        AND transcript IS NOT NULL
        AND (extraction_next_attempt_at IS NULL OR extraction_next_attempt_at <= now())
      ORDER BY extraction_next_attempt_at NULLS FIRST
      LIMIT $2`,
    [MAX_ATTEMPTS, limit],
  );

  let retried = 0;
  for (const row of due.rows) {
    // Sequential on purpose: these are paid LLM calls and a backlog should drain
    // steadily rather than stampede the provider after an outage.
    await processConversation(row.id);
    retried++;
  }
  if (retried > 0) logEvent('info', 'session.extract', 'retried failed extractions', { retried });
  return { retried, deadLettered };
}

/** Record a failure with its backoff. Called by processConversation. */
export async function markExtractionFailed(
  conversationId: string,
  error: string,
  raw: string | null,
): Promise<void> {
  await pool
    .query(
      `UPDATE conversations
          SET extraction_status = 'failed',
              extraction_attempts = extraction_attempts + 1,
              extraction_error = $2,
              extraction_raw = $3,
              extraction_next_attempt_at =
                now() + (CASE
                  WHEN extraction_attempts + 1 >= 4 THEN 60
                  WHEN extraction_attempts + 1 = 3 THEN 15
                  WHEN extraction_attempts + 1 = 2 THEN 5
                  ELSE 1 END || ' minutes')::interval,
              updated_at = now()
        WHERE id = $1`,
      [conversationId, error.slice(0, 2000), raw?.slice(0, 4096) ?? null],
    )
    .catch(() => {
      /* best-effort; the original error is already logged */
    });
}
