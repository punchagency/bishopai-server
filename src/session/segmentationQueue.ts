import { pool } from '../db/pool';
import { allowanceStatus } from '../llm/allowance';
import { logEvent } from '../observability/logger';
import { runSegmentation, SEGMENTATION_MAX_ATTEMPTS } from './segmentation';

// The segmentation queue — the split, pre-staged.
//
// A sibling of the extraction queue (session/queue.ts) with the same shape: the
// conversations row is the queue, this file is the drain. One recording at a
// time, oldest hold first, stopping the moment the day's model allowance is
// spent.
//
// It runs AHEAD of extraction. A held recording cannot be extracted until a
// human has split it, so spending one model call to pre-compute that split is
// never competing with a note that could otherwise be written — and the sooner
// the proposal exists, the sooner Nicole's job is "confirm" instead of "start".
// scheduler/jobs/extraction.ts drains this before processDueExtractions on every
// tick; enqueueSegmentation gives an immediate first pass at ingest.

interface DrainResult {
  processed: number;
  parked: boolean;
}

let draining: Promise<DrainResult> | null = null;
let wakeRequested = false;

/** Rows the drain would take, in order: held, transcribed, not yet proposed,
 *  still within their attempt budget and past any backoff. */
async function queueOrder(): Promise<string[]> {
  const r = await pool.query<{ id: string }>(
    `SELECT id FROM conversations
      WHERE correlation_status = 'needs_review'
        AND appointment_id IS NULL
        AND transcript IS NOT NULL
        AND segmentation_status IN ('pending', 'failed')
        AND segmentation_attempts < $1
        AND (segmentation_next_attempt_at IS NULL OR segmentation_next_attempt_at <= now())
      ORDER BY COALESCE(segmentation_next_attempt_at, updated_at) ASC, starts_at ASC`,
    [SEGMENTATION_MAX_ATTEMPTS],
  );
  return r.rows.map((x) => x.id);
}

/**
 * Ask for a held recording to be segmented. Fire-and-forget: the row is already
 * marked `pending` in the database, so a caller that dies right after this has
 * still successfully asked — the periodic drain finds it.
 */
export function enqueueSegmentation(conversationId: string): void {
  logEvent('info', 'session.segmentation', 'segmentation requested', {
    conversation_id: conversationId,
  });
  void drainSegmentationQueue().catch(() => {
    /* drainSegmentationQueue logs its own failures; the tick retries */
  });
}

/**
 * Process the segmentation queue one recording at a time until it is empty or
 * the daily allowance is spent. Single-flight per process: a second caller joins
 * the drain already running.
 */
export function drainSegmentationQueue(): Promise<DrainResult> {
  if (draining) {
    wakeRequested = true;
    return draining;
  }

  draining = (async (): Promise<DrainResult> => {
    const result: DrainResult = { processed: 0, parked: false };
    try {
      do {
        wakeRequested = false;
        for (const id of await queueOrder()) {
          const allowance = allowanceStatus();
          if (!allowance.open) {
            result.parked = true;
            logEvent('info', 'session.segmentation', 'drain paused — daily allowance spent', {
              processed: result.processed,
              resumes_at: allowance.resetsAt?.toISOString() ?? null,
            });
            return result;
          }
          const ran = await runSegmentation(id);
          if (ran) result.processed++;
        }
      } while (wakeRequested);
    } catch (err) {
      logEvent('error', 'session.segmentation', 'drain failed', {
        processed: result.processed,
        error: err instanceof Error ? err.message : String(err),
      });
    } finally {
      draining = null;
      if (wakeRequested) {
        wakeRequested = false;
        setImmediate(() => void drainSegmentationQueue().catch(() => {}));
      }
    }
    if (result.processed > 0) {
      logEvent('info', 'session.segmentation', 'drain complete', { processed: result.processed });
    }
    return result;
  })();

  return draining;
}
