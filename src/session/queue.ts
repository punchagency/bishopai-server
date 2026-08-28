import { pool } from '../db/pool';
import { allowanceStatus } from '../llm/allowance';
import { logEvent } from '../observability/logger';
import { processConversation } from './process';
import { MAX_ATTEMPTS } from './reclaim';

// The extraction queue.
//
// There wasn't one. Eight call sites — two webhooks, the correlation sweep, the
// re-match path, four review actions — each did `void processConversation(id)`
// the moment a transcript became matched, and that was the whole scheduler:
// fire-and-forget, unordered, unbounded, with no record that the work had been
// asked for. It produced three distinct problems.
//
//   Nothing drained `pending`. processConversation is the only thing that moves
//   a row out of it, and the only thing that calls processConversation is the
//   `void` above. If the process died between the INSERT and that call — a
//   deploy, a crash, a throw on the line before — the row stayed `pending`
//   forever. processDueExtractions swept `failed` and `processing`; `pending`
//   had no sweeper at all, so the one state every conversation starts in was
//   the one state nothing could rescue.
//
//   Nothing bounded the fan-out. Two recordings arriving together ran two
//   extractions at once, each of which fans out to four stages in parallel, each
//   of which may chunk. Against a 20-requests-per-day allowance that is not
//   parallelism, it is a race to spend the cap.
//
//   Nothing was visible. Work that exists only as an unawaited promise cannot be
//   listed, positioned, or waited on, so the "Not extracted" tab could only ever
//   show wreckage after the fact — never "this one is third in line".
//
// So: the conversations table IS the queue (it already has the lease, the
// attempt counter, the backoff and the dead-letter — everything but a drain),
// and this file is the drain. One row at a time, oldest first, stopping the
// moment the day's allowance is gone.

export interface DrainResult {
  processed: number;
  /** True when the drain stopped early because the allowance is spent. */
  parked: boolean;
}

/** A row waiting for, or currently having, its turn. */
export interface QueueEntry {
  conversation_id: string;
  /** 1-based place in line among rows that are eligible and waiting. Null for a
   *  row that is running (it is not in line, it is at the front) or parked with
   *  a future next-attempt time. */
  position: number | null;
}

/**
 * Rows the drain would process, in the order it would take them.
 *
 * Eligibility deliberately mirrors processConversation's claiming UPDATE rather
 * than paraphrasing it: a row this returns and that then refuses to be claimed
 * is a queue that counts work it cannot do, and the position numbers it shows
 * Nicole would be wrong by however many of those are ahead of her.
 *
 * FIFO on when the row became eligible, not on when the session happened. A
 * retry that came due at 09:00 goes before a recording that landed at 09:05,
 * because it has already been waiting — ordering by session date instead would
 * let a busy morning starve yesterday's failure indefinitely.
 */
export async function queueOrder(): Promise<string[]> {
  const r = await pool.query<{ id: string }>(
    `SELECT id FROM conversations
      WHERE appointment_id IS NOT NULL
        AND transcript IS NOT NULL
        AND correlation_status NOT IN ('needs_review', 'split')
        AND extraction_status IN ('pending', 'failed')
        AND extraction_attempts < $1
        AND (extraction_next_attempt_at IS NULL OR extraction_next_attempt_at <= now())
      ORDER BY COALESCE(extraction_next_attempt_at, updated_at) ASC, starts_at ASC`,
    [MAX_ATTEMPTS],
  );
  return r.rows.map((x) => x.id);
}

/** Place in line for every row waiting, for the UI to render as "3rd in line". */
export async function queuePositions(): Promise<Map<string, number>> {
  const ids = await queueOrder();
  return new Map(ids.map((id, i) => [id, i + 1]));
}

let draining: Promise<DrainResult> | null = null;
let wakeRequested = false;

/**
 * Ask for the queue to be drained. Returns immediately; the work happens in the
 * background.
 *
 * This replaces `void processConversation(id)` at every call site. The id is
 * taken for logging only — the row is already `pending` in the database by the
 * time anyone calls this, and the drain finds it there. That indirection is the
 * point: the queue's contents live in Postgres, so a caller that crashes
 * immediately after asking has still successfully asked.
 */
export function enqueueExtraction(conversationId: string): void {
  logEvent('info', 'session.queue', 'extraction requested', {
    conversation_id: conversationId,
  });
  void drainExtractionQueue().catch(() => {
    /* drainExtractionQueue logs its own failures; the scheduler retries */
  });
}

/**
 * Process the queue, one conversation at a time, until it is empty.
 *
 * Single-flight per process: a second caller joins the drain already running
 * rather than starting a parallel one. Sequential inside, for the same reason
 * processDueExtractions always was — these are paid, rate-limited calls, and a
 * backlog should drain steadily rather than stampede a provider that has just
 * come back.
 */
export function drainExtractionQueue(): Promise<DrainResult> {
  if (draining) {
    // Someone enqueued work while a drain was in flight. The loop re-queries
    // after every row, so their row will be picked up by the drain already
    // running — but only if that drain hasn't already decided it is finished,
    // which is what the flag guards.
    wakeRequested = true;
    return draining;
  }

  draining = (async (): Promise<DrainResult> => {
    const result: DrainResult = { processed: 0, parked: false };
    try {
      do {
        wakeRequested = false;
        for (const id of await queueOrder()) {
          // Checked per row, not once per drain: the allowance can run out on
          // the row we just finished, and the whole reason this gate exists is
          // that discovering that again costs another request. Stopping the
          // loop here is what turns "every remaining session pays to be told
          // no" into one refusal for the batch.
          const allowance = allowanceStatus();
          if (!allowance.open) {
            result.parked = true;
            logEvent('info', 'session.queue', 'drain paused — daily allowance spent', {
              processed: result.processed,
              resumes_at: allowance.resetsAt?.toISOString() ?? null,
            });
            return result;
          }
          // processConversation claims the row atomically and no-ops if someone
          // else got there first, so a stale id from the query above is safe.
          await processConversation(id);
          result.processed++;
        }
      } while (wakeRequested);
    } catch (err) {
      logEvent('error', 'session.queue', 'drain failed', {
        processed: result.processed,
        error: err instanceof Error ? err.message : String(err),
      });
    } finally {
      draining = null;
      // A nudge that landed in the gap between the loop deciding it was done
      // and this line would otherwise be lost — the enqueuer saw a non-null
      // `draining` and trusted a drain that was already exiting.
      if (wakeRequested) {
        wakeRequested = false;
        setImmediate(() => void drainExtractionQueue().catch(() => {}));
      }
    }
    if (result.processed > 0) {
      logEvent('info', 'session.queue', 'drain complete', { processed: result.processed });
    }
    return result;
  })();

  return draining;
}

/** Tests only: the single-flight latch is module state and would otherwise leak
 *  a half-finished drain from one test into the next. */
export function resetQueueForTests(): void {
  draining = null;
  wakeRequested = false;
}
