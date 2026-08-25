/**
 * Score the live correlator against every recording whose appointment we already know.
 *
 * READ-ONLY. No writes, no LLM, no scheduler — safe to point at production.
 *
 * The premise: a conversation that already carries an `appointment_id` is a
 * labelled example. Replaying `correlateConversation` over it asks "would the
 * matcher, seeing this recording fresh today, land on the same appointment?"
 *
 * That is the number any change to matching has to beat, and it is the check
 * that was missing when the name-matching work landed: the transcript name
 * signal fires on 1 of 9 real recordings, which is not something you can see by
 * reading the diff. Run this BEFORE changing the correlator, and after.
 *
 * The labels are not uniformly strong, and the summary says so. Some were
 * assigned by an earlier version of this same correlator, which makes them
 * partly circular; the ones a human attached (or that the old overlap rule could
 * never have produced, such as a zero-overlap late-running session) are the
 * genuinely independent evidence.
 *
 * One wrinkle. `correlateConversation` excludes appointments that already carry a
 * recording — correct in production, but here the appointment under test is
 * "taken" by the very conversation we are replaying. The wrapper below re-admits
 * that one row and nothing else, so the matcher faces the choice it originally
 * faced. Everything else is the real code path.
 *
 *   npx tsx scripts/correlation-replay.mts
 *
 * Exits non-zero if any recording is matched to the WRONG appointment, so it can
 * gate a change. Abstentions are not failures — refusing to guess is the design.
 */
import 'dotenv/config';
import type { PoolClient } from 'pg';
import { pool } from '../src/db/pool';
import { correlateConversation } from '../src/correlation/correlate';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The real pool, with the conversation under test un-taking its own appointment. */
function replayClient(selfConversationId: string): PoolClient {
  if (!UUID.test(selfConversationId)) throw new Error(`not a uuid: ${selfConversationId}`);
  return {
    query: (sql: string, params?: unknown[]) =>
      pool.query(
        sql.replace(
          'WHERE cv.appointment_id = a.id',
          `WHERE cv.appointment_id = a.id AND cv.id <> '${selfConversationId}'`,
        ),
        params,
      ),
  } as unknown as PoolClient;
}

const { rows } = await pool.query<{
  id: string;
  starts_at: string;
  ends_at: string;
  appointment_id: string | null;
  correlation_status: string;
  client_name: string | null;
  minutes: number;
  start_offset: number | null;
  is_split_child: boolean;
  is_split_parent: boolean;
}>(
  `SELECT c.id, c.starts_at, c.ends_at, c.appointment_id, c.correlation_status,
          cl.name AS client_name,
          round(extract(epoch FROM (c.ends_at - c.starts_at)) / 60)::int AS minutes,
          round(extract(epoch FROM (c.starts_at - a.starts_at)) / 60)::int AS start_offset,
          (c.parent_conversation_id IS NOT NULL) AS is_split_child,
          EXISTS (SELECT 1 FROM conversations ch WHERE ch.parent_conversation_id = c.id) AS is_split_parent
     FROM conversations c
     LEFT JOIN appointments a ON a.id = c.appointment_id
     LEFT JOIN clients cl ON cl.id = a.client_id
    WHERE c.transcript IS NOT NULL
    ORDER BY c.appointment_id IS NULL, c.parent_conversation_id IS NOT NULL, c.starts_at`,
);

const labelled = rows.filter((r) => r.appointment_id);
const held = rows.filter((r) => !r.appointment_id);

let correct = 0;
let wrong = 0;
let abstained = 0;

console.log(`\n── replaying ${labelled.length} labelled recordings ─────────────────────────────`);
for (const c of labelled) {
  const res = await correlateConversation(replayClient(c.id), c.starts_at, c.ends_at);
  // A split child's appointment was attached by a human, which makes it the
  // strongest label we have — and its window came from that split rather than
  // from the recorder, which makes it a different regime worth reading apart.
  const tag = c.is_split_child ? 'split ' : 'whole ';
  const detail = `${tag}${String(c.minutes).padStart(3)}m rec, start ${String(c.start_offset ?? 0).padStart(4)}m vs booking`;

  if (res.status === 'matched' && res.appointmentId === c.appointment_id) {
    correct++;
    console.log(`  ✓ ${detail}  ${c.client_name}`);
  } else if (res.status === 'matched') {
    wrong++;
    const { rows: got } = await pool.query<{ name: string | null }>(
      `SELECT cl.name FROM appointments a LEFT JOIN clients cl ON cl.id = a.client_id WHERE a.id = $1`,
      [res.appointmentId],
    );
    console.log(`  ✗ ${detail}  ${c.client_name}  ->  MATCHED ${got[0]?.name ?? res.appointmentId}`);
  } else {
    abstained++;
    console.log(`  · ${detail}  ${c.client_name}  ->  abstained (${res.reason})`);
  }
}

console.log(`\n── ${held.length} recordings currently held ────────────────────────────────────`);
for (const c of held) {
  // Split parents are excluded from correlation upstream (see correlate.ts), so
  // replaying the matcher on one would report a match production never makes.
  if (c.is_split_parent) {
    console.log(`  = ${String(c.minutes).padStart(3)}m rec  [${c.correlation_status}]  split parent — superseded by its children, never re-correlated`);
    continue;
  }
  const res = await correlateConversation(replayClient(c.id), c.starts_at, c.ends_at);
  if (res.status === 'matched') {
    const { rows: got } = await pool.query<{ name: string | null }>(
      `SELECT cl.name FROM appointments a LEFT JOIN clients cl ON cl.id = a.client_id WHERE a.id = $1`,
      [res.appointmentId],
    );
    console.log(`  + ${String(c.minutes).padStart(3)}m rec  [${c.correlation_status}]  would now match ${got[0]?.name ?? res.appointmentId}`);
  } else {
    console.log(`  · ${String(c.minutes).padStart(3)}m rec  [${c.correlation_status}]  still held (${res.reason})`);
  }
}

console.log(`\n   correct ${correct}   wrong ${wrong}   abstained ${abstained}   (n=${labelled.length})`);
if (wrong > 0) console.log(`   ${wrong} recording(s) matched to the WRONG client — do not ship.`);
await pool.end();
process.exit(wrong > 0 ? 1 : 0);
