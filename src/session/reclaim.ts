import { pool } from '../db/pool';
import { logEvent } from '../observability/logger';
import { drainExtractionQueue } from './queue';
import { RateLimitError } from '../llm/errors';
import { MAX_ATTEMPTS, LEASE_MINUTES } from './extractionPolicy';

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

// Re-exported so the many existing importers of `./reclaim` keep working; the
// numbers themselves now live in ./extractionPolicy, where the queue can read
// them without importing this file.
export { LEASE_MINUTES, MAX_ATTEMPTS, backoffMinutes } from './extractionPolicy';

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
export async function processDueExtractions(): Promise<RetryResult> {
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

  // Drain through the queue rather than re-deriving "what is due" here.
  //
  // This used to run its own SELECT over `failed` rows only, which is how
  // `pending` came to have no sweeper at all: the one status every conversation
  // starts in was invisible to the one job whose purpose is rescuing stranded
  // work. A row whose fire-and-forget call never fired — the process died on the
  // line after the INSERT — sat `pending` forever, matched and transcribed and
  // never once looked at.
  //
  // `limit` is no longer a row cap. The queue drains until it is empty or the
  // allowance is spent, and stopping after twenty rows with the twenty-first
  // sitting due would just mean waiting five minutes to do the obvious thing.
  const { processed, parked } = await drainExtractionQueue();
  const retried = processed;
  if (retried > 0) logEvent('info', 'session.extract', 'drained due extractions', { retried });
  if (parked) {
    logEvent('info', 'session.extract', 'extraction paused until the allowance resets', {
      drained_first: retried,
    });
  }
  return { retried, deadLettered };
}

/**
 * Where a spent daily allowance parks until it is worth trying again.
 *
 * Google's free tier resets at midnight Pacific, not at midnight UTC and not on
 * a rolling 24h window, so the wait is "until the next local midnight" rather
 * than any fixed interval. Postgres does the timezone arithmetic; this is only
 * the zone to do it in.
 */
const QUOTA_RESET_TZ = process.env.LLM_QUOTA_RESET_TZ ?? 'America/Los_Angeles';

/**
 * Record a failure with its backoff. Called by processConversation.
 *
 * `cause` is the original typed error, and it is what separates two failures
 * that look identical once flattened to a string:
 *
 *   - A stage that broke — retry it, on the usual ladder, and count the attempt
 *     so four of them dead-letter to needs_review for a human.
 *   - A day's allowance that is simply spent — nothing was extracted, nothing
 *     was even attempted in the sense that matters, and the provider will
 *     refuse identically for the rest of the day.
 *
 * The second one must not burn attempts. Counting it means a quota outage
 * dead-letters healthy sessions to needs_review having never once reached the
 * model, and the 1/5/15/60-minute ladder spends four more requests against the
 * cap that refused — the same amplification that produced seven blank notes on
 * 2026-08-24, moved one layer out. So it parks until the reset instead, with
 * the counter untouched.
 */
export async function markExtractionFailed(
  conversationId: string,
  error: string,
  raw: string | null,
  cause?: unknown,
): Promise<void> {
  const spent = cause instanceof RateLimitError && cause.exhausted;
  if (spent) {
    logEvent('warn', 'session.extract', 'daily model allowance spent — parked until it resets', {
      conversation_id: conversationId,
      reset_tz: QUOTA_RESET_TZ,
    });
  }
  await pool
    .query(
      spent
        ? `UPDATE conversations
              SET extraction_status = 'failed',
                  extraction_error = $2,
                  extraction_raw = $3,
                  extraction_next_attempt_at =
                    (date_trunc('day', now() AT TIME ZONE $4) + interval '1 day') AT TIME ZONE $4,
                  updated_at = now()
            WHERE id = $1`
        : `UPDATE conversations
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
      spent
        ? [conversationId, error.slice(0, 2000), raw?.slice(0, 4096) ?? null, QUOTA_RESET_TZ]
        : [conversationId, error.slice(0, 2000), raw?.slice(0, 4096) ?? null],
    )
    .catch(() => {
      /* best-effort; the original error is already logged */
    });
}
