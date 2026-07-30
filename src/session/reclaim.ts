import { getDatabase } from '../db/index.js';
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
//
// Under Cloud Functions this matters MORE, not less: an instance can be torn
// down mid-call at any time, so "the process died holding a claim" stops being
// an outage-only event and becomes routine.

/** How long a claim may go unfinished before we assume its owner died. */
const LEASE_MINUTES = Number(process.env.EXTRACTION_LEASE_MINUTES ?? 10);
/** Attempts before a conversation stops retrying and asks for a human. */
const MAX_ATTEMPTS = Number(process.env.EXTRACTION_MAX_ATTEMPTS ?? 4);
/** Capped backoff. Index by attempt count; past the end, use the last. */
const BACKOFF_MINUTES = [1, 5, 15, 60];

export function backoffMinutes(attempts: number): number {
  return BACKOFF_MINUTES[Math.min(attempts, BACKOFF_MINUTES.length - 1)];
}

const minutesFromNow = (minutes: number): string =>
  new Date(Date.now() + minutes * 60_000).toISOString();

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
  const db = getDatabase();
  const cutoff = new Date(Date.now() - LEASE_MINUTES * 60_000).toISOString();
  const stuck = await db.conversations.listStuckExtractions(cutoff);

  const ids: string[] = [];
  for (const row of stuck) {
    const attempts = (row.extraction_attempts ?? 0) + 1;
    // Guarded, not a blind write: between the query and here another worker may
    // have finished the very call this is about to declare dead.
    const moved = await db.conversations.transitionExtraction(row.id, ['processing'], {
      extraction_status: 'failed',
      extraction_attempts: attempts,
      extraction_error:
        row.extraction_error ?? 'extraction lease expired — process died mid-flight',
      // Always written, never left absent: listDueExtractions ranges on this
      // field, and Firestore drops documents that lack it from the result (§3.5),
      // so a reclaimed row with no next-attempt time would never be retried.
      extraction_next_attempt_at: new Date().toISOString(),
      extraction_leased_at: null,
    });
    if (moved) ids.push(row.id);
  }

  if (ids.length > 0) {
    logEvent('warn', 'session.extract', 'reclaimed stuck extractions', {
      reclaimed: ids.length,
      lease_minutes: LEASE_MINUTES,
      ids,
    });
  }
  return { reclaimed: ids.length };
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
  const db = getDatabase();

  const exhausted = await db.conversations.listExhaustedExtractions(MAX_ATTEMPTS);
  const deadIds: string[] = [];
  for (const row of exhausted) {
    const moved = await db.conversations.transitionExtraction(row.id, ['failed'], {
      extraction_status: 'needs_review',
    });
    if (moved) deadIds.push(row.id);
  }
  if (deadIds.length > 0) {
    logEvent('error', 'session.extract', 'extraction exhausted retries — needs review', {
      count: deadIds.length,
      ids: deadIds,
      max_attempts: MAX_ATTEMPTS,
    });
  }

  // Only rows that are actually processable: matched, transcribed, and due.
  const due = await db.conversations.listDueExtractions(
    new Date().toISOString(),
    MAX_ATTEMPTS,
    limit,
  );

  let retried = 0;
  for (const row of due) {
    // Sequential on purpose: these are paid LLM calls and a backlog should drain
    // steadily rather than stampede the provider after an outage.
    await processConversation(row.id);
    retried++;
  }
  if (retried > 0) logEvent('info', 'session.extract', 'retried failed extractions', { retried });
  return { retried, deadLettered: deadIds.length };
}

/** Record a failure with its backoff. Called by processConversation. */
export async function markExtractionFailed(
  conversationId: string,
  error: string,
  raw: string | null,
): Promise<void> {
  try {
    const db = getDatabase();
    const row = await db.conversations.findById(conversationId);
    if (!row) return;
    const prior = row.extraction_attempts ?? 0;
    const attempts = prior + 1;
    await db.conversations.transitionExtraction(
      conversationId,
      // 'pending' is included because a claim that failed before its transition
      // landed leaves the row where it started, and that failure still counts.
      ['processing', 'failed', 'pending'],
      {
        extraction_status: 'failed',
        extraction_attempts: attempts,
        extraction_error: error.slice(0, 2000),
        extraction_raw: raw?.slice(0, 4096) ?? null,
        // backoffMinutes is indexed by the PRIOR attempt count, matching the
        // `CASE WHEN extraction_attempts + 1 = n` ladder it replaces: the first
        // failure waits 1 minute, then 5, 15, and 60.
        extraction_next_attempt_at: minutesFromNow(backoffMinutes(prior)),
        extraction_leased_at: null,
      },
    );
  } catch {
    /* best-effort; the original error is already logged */
  }
}
