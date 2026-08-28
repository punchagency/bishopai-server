import { describe, it, expect, afterAll, beforeEach, vi } from 'vitest';
import { pool } from '../src/db/pool';
import {
  drainExtractionQueue,
  enqueueExtraction,
  queueOrder,
  resetQueueForTests,
} from '../src/session/queue';
import { closeAllowance, resetAllowanceForTests } from '../src/llm/allowance';
import * as processModule from '../src/session/process';

// Integration: the "Not extracted" tab is a queue, and this is the drain.
//
// Three things are being pinned down, all of which were broken by the absence of
// a queue rather than by any single bug:
//
//   1. `pending` gets drained. Nothing swept it before — processDueExtractions
//      looked only at `failed`, and the sole thing that moved a row out of
//      `pending` was a `void processConversation(id)` at the call site. A row
//      whose caller died between the INSERT and that line stayed pending
//      forever: matched, transcribed, and never looked at.
//   2. One at a time. Extraction fans out to four parallel stages internally;
//      running two sessions concurrently on top of that is a race to spend a
//      20-request daily cap.
//   3. A spent allowance stops the batch, not just the row. The row-level fix
//      (markExtractionFailed parking instead of laddering) is already tested in
//      quota-park.int.test.ts, but a loop that keeps pulling the next row still
//      pays one request per session to be told what the first one learned.

const dbUp = await pool
  .query('SELECT 1')
  .then(() => true)
  .catch(() => false);

const suite = dbUp ? describe : describe.skip;

suite('the extraction queue (integration, real Postgres)', () => {
  afterAll(async () => {
    await pool.query(`DELETE FROM conversations WHERE source_id LIKE 'queue-%'`).catch(() => {});
    await pool.end();
  });

  beforeEach(async () => {
    vi.restoreAllMocks();
    resetQueueForTests();
    resetAllowanceForTests();
    await pool.query(`DELETE FROM conversations WHERE source_id LIKE 'queue-%'`);
  });

  /** A matched, transcribed conversation — the only kind the queue may claim. */
  async function seed(
    tag: string,
    opts: { status?: string; attempts?: number; nextAt?: string | null; minutesAgo?: number } = {},
  ): Promise<string> {
    const appt = await pool.query<{ id: string }>(
      `INSERT INTO appointments (starts_at, ends_at, status)
            VALUES (now(), now() + interval '1 hour', 'scheduled') RETURNING id`,
    );
    const r = await pool.query<{ id: string }>(
      `INSERT INTO conversations
              (source_id, source, starts_at, ends_at, transcript, appointment_id,
               correlation_status, extraction_status, extraction_attempts,
               extraction_next_attempt_at, updated_at)
            VALUES ($1, 'manual', now(), now(), 'Nicole: hello. Client: hi.', $2,
                    'matched', $3, $4, $5, now() - ($6 || ' minutes')::interval)
       RETURNING id`,
      [
        `queue-${tag}`,
        appt.rows[0].id,
        opts.status ?? 'pending',
        opts.attempts ?? 0,
        opts.nextAt ?? null,
        String(opts.minutesAgo ?? 0),
      ],
    );
    return r.rows[0].id;
  }

  it('drains a pending row that nothing else would ever have picked up', async () => {
    const id = await seed('stranded');
    // Exactly the state a crash between the INSERT and the fire-and-forget call
    // used to leave behind, permanently.
    expect(await queueOrder()).toContain(id);

    const spy = vi.spyOn(processModule, 'processConversation').mockResolvedValue();
    const { processed } = await drainExtractionQueue();

    expect(spy).toHaveBeenCalledWith(id);
    expect(processed).toBe(1);
  });

  it('takes them one at a time, oldest waiting first', async () => {
    const second = await seed('newer', { minutesAgo: 1 });
    const first = await seed('older', { minutesAgo: 30 });

    const running: string[] = [];
    let concurrent = 0;
    let peak = 0;
    vi.spyOn(processModule, 'processConversation').mockImplementation(async (id: string) => {
      peak = Math.max(peak, ++concurrent);
      await new Promise((r) => setTimeout(r, 10));
      running.push(id);
      concurrent--;
      // Take it out of the queue the way a real run would, so the loop's
      // re-query makes progress instead of serving the same row forever.
      await pool.query(`UPDATE conversations SET extraction_status = 'done' WHERE id = $1`, [id]);
    });

    // Two callers, as two webhooks arriving together would be. The second must
    // join the drain already running rather than start a parallel one.
    await Promise.all([drainExtractionQueue(), drainExtractionQueue()]);

    expect(peak).toBe(1);
    expect(running).toEqual([first, second]);
  });

  it('stops the whole batch when the allowance is spent, instead of paying per row to find out', async () => {
    await seed('spent-a', { minutesAgo: 30 });
    await seed('spent-b', { minutesAgo: 20 });
    await seed('spent-c', { minutesAgo: 10 });

    let calls = 0;
    vi.spyOn(processModule, 'processConversation').mockImplementation(async () => {
      calls++;
      // The first session discovers the cap is gone — which in production is
      // generateStructured closing the gate on the provider's 429.
      closeAllowance('quotaId: GenerateRequestsPerDayPerProjectPerModel-FreeTier');
      await pool.query(
        `UPDATE conversations SET extraction_status = 'failed',
                extraction_next_attempt_at = now() + interval '8 hours'
          WHERE source_id = 'queue-spent-a'`,
      );
    });

    const { processed, parked } = await drainExtractionQueue();

    // One request spent learning the day is over — not three.
    expect(calls).toBe(1);
    expect(processed).toBe(1);
    expect(parked).toBe(true);
  });

  it('does not offer rows the retry sweep has already given up on', async () => {
    const dead = await seed('dead', { status: 'failed', attempts: 4 });
    const live = await seed('live', { status: 'failed', attempts: 1 });
    const order = await queueOrder();
    expect(order).toContain(live);
    expect(order).not.toContain(dead);
  });

  it('leaves a parked row alone until its next attempt comes due', async () => {
    const parked = await seed('parked', {
      status: 'failed',
      attempts: 0,
      nextAt: new Date(Date.now() + 8 * 3_600_000).toISOString(),
    });
    expect(await queueOrder()).not.toContain(parked);
  });

  it('never claims a held or split recording, whatever its extraction status', async () => {
    const appt = await pool.query<{ id: string }>(
      `INSERT INTO appointments (starts_at, ends_at, status)
            VALUES (now(), now() + interval '1 hour', 'scheduled') RETURNING id`,
    );
    const r = await pool.query<{ id: string }>(
      `INSERT INTO conversations
              (source_id, source, starts_at, ends_at, transcript, appointment_id,
               correlation_status, extraction_status)
            VALUES ('queue-held', 'manual', now(), now(), 'x', $1, 'needs_review', 'pending')
       RETURNING id`,
      [appt.rows[0].id],
    );
    // A held recording is waiting on a decision about WHOSE it is. Extracting it
    // would file clinical content against a client nobody has confirmed.
    expect(await queueOrder()).not.toContain(r.rows[0].id);
  });

  it('picks up a row enqueued while a drain was already finishing', async () => {
    const first = await seed('wake-first');
    let late: string | null = null;

    const seen: string[] = [];
    vi.spyOn(processModule, 'processConversation').mockImplementation(async (id: string) => {
      seen.push(id);
      await pool.query(`UPDATE conversations SET extraction_status = 'done' WHERE id = $1`, [id]);
      if (late === null) {
        // Arrives mid-drain: the enqueuer sees a drain in flight and trusts it.
        // If that drain has already run its last query, the row is lost — which
        // is what the wake flag exists to prevent.
        late = await seed('wake-late');
        enqueueExtraction(late);
      }
    });

    await drainExtractionQueue();
    // Give the setImmediate re-drain a turn, in case the wake landed in the gap.
    await new Promise((r) => setImmediate(r));
    await drainExtractionQueue();

    expect(seen).toContain(first);
    expect(seen).toContain(late);
  });
});
