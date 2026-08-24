/**
 * Baseline: what does detectSessionBoundaries() actually find today?
 *
 * Read-only. Runs the real segmenter (heuristic matrix + LLM fallback) over
 * every recording currently on hold, and prints its proposed boundaries next to
 * what the cheap deterministic restart detector finds. Anything measured here is
 * the number a change has to beat.
 */
import 'dotenv/config';
import { pool } from '../src/db/pool';
import { detectSessionBoundaries, parseTurns } from '../src/session/segmenter';
import { findSessionRestart } from '../src/session/transcript';

const { rows } = await pool.query<{
  id: string;
  transcript: string;
  starts_at: string;
  ends_at: string;
}>(
  `SELECT id, transcript, starts_at, ends_at
     FROM conversations
    WHERE correlation_status = 'needs_review' AND transcript IS NOT NULL
    ORDER BY starts_at DESC`,
);

for (const r of rows) {
  const turns = parseTurns(r.transcript);
  const appts = await pool.query<{ name: string; overlap_seconds: number; starts_at: string; ends_at: string }>(
    `SELECT (SELECT name FROM clients WHERE id = a.client_id) AS name,
            a.starts_at, a.ends_at,
            GREATEST(0, EXTRACT(EPOCH FROM (
              LEAST(a.ends_at, $2::timestamptz) - GREATEST(a.starts_at, $1::timestamptz)
            )))::int AS overlap_seconds
       FROM appointments a
      WHERE tstzrange(a.starts_at, a.ends_at) && tstzrange($1::timestamptz, $2::timestamptz)`,
    [r.starts_at, r.ends_at],
  );

  const started = Date.now();
  const segments = await detectSessionBoundaries(
    r.transcript,
    appts.rows.map((a) => a.name).filter(Boolean),
    appts.rows.map((a) => ({
      client_name: a.name,
      starts_at: a.starts_at,
      ends_at: a.ends_at,
      overlap_seconds: a.overlap_seconds,
    })) as never,
    new Date(r.starts_at).getTime(),
    new Date(r.ends_at).getTime(),
  );
  const ms = Date.now() - started;

  console.log(`\n=== ${r.id.slice(0, 8)}  ${turns.length} turns  calendar=${appts.rowCount} appts  (${ms}ms)`);
  console.log(`    restart detector : ${findSessionRestart(r.transcript) ?? 'none'}`);
  console.log(`    segmenter        : ${segments.length} segment(s)`);
  for (const s of segments as never as Array<Record<string, unknown>>) {
    console.log(`      ${JSON.stringify(s).slice(0, 200)}`);
  }
}

await pool.end();
