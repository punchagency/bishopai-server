/**
 * What do we actually know about WHO each half of a held recording belongs to?
 *
 * Read-only. For every recording on hold, this splits it at the detected
 * handover and, for each resulting segment, prints the three kinds of evidence
 * the system could use to name a client:
 *
 *   1. TIME    — appointments overlapping that segment's own window, rather
 *                than the whole recording's. This is the only signal the
 *                correlator uses today, and on a back-to-back day it is often
 *                the same client for both halves, which is no evidence at all.
 *   2. NAME    — a name spoken inside that segment, in a greeting position
 *                ("Hi, Steve") or anywhere at all, cross-referenced against
 *                clients booked that day.
 *   3. NEITHER — said plainly, so it is obvious when only a human can decide.
 *
 * Segment windows are interpolated from turn position, exactly as
 * handleSplitConversation does, so what this prints is what a split would produce.
 */
import 'dotenv/config';
import { pool } from '../src/db/pool';
import { parseTurns } from '../src/session/segmenter';
import { findSessionRestart } from '../src/session/transcript';

interface Row {
  id: string;
  transcript: string;
  starts_at: string;
  ends_at: string;
  correlation_hold_reason: string | null;
}

const { rows } = await pool.query<Row>(
  `SELECT id, transcript, starts_at, ends_at, correlation_hold_reason
     FROM conversations
    WHERE correlation_status = 'needs_review' AND transcript IS NOT NULL
    ORDER BY starts_at DESC`,
);

const clients = await pool.query<{ id: string; name: string }>(`SELECT id, name FROM clients`);
const firstNames = new Map<string, string[]>();
for (const c of clients.rows) {
  const first = c.name.trim().split(/\s+/)[0]?.toLowerCase();
  if (!first || first.length < 3) continue;
  firstNames.set(first, [...(firstNames.get(first) ?? []), c.name]);
}

const fmt = (iso: string): string => new Date(iso).toISOString().slice(11, 19);

for (const r of rows) {
  const turns = parseTurns(r.transcript);
  const restart = findSessionRestart(r.transcript);
  console.log(`\n=== ${r.id.slice(0, 8)}  ${fmt(r.starts_at)}–${fmt(r.ends_at)}  ${turns.length} turns`);
  console.log(`    hold: ${r.correlation_hold_reason}`);

  const ranges: [number, number][] = restart
    ? [
        [1, restart - 1],
        [restart, turns.length],
      ]
    : [[1, turns.length]];

  const pStart = new Date(r.starts_at).getTime();
  const durMs = new Date(r.ends_at).getTime() - pStart;

  for (const [from, to] of ranges) {
    const segStart = new Date(pStart + Math.round(((from - 1) / turns.length) * durMs));
    const segEnd = new Date(pStart + Math.round((to / turns.length) * durMs));
    console.log(`\n  -- segment turns ${from}-${to}   ${fmt(segStart.toISOString())}–${fmt(segEnd.toISOString())}`);

    const appts = await pool.query<{ name: string; starts_at: string; ends_at: string; secs: number }>(
      `SELECT (SELECT name FROM clients WHERE id = a.client_id) AS name,
              a.starts_at, a.ends_at,
              EXTRACT(EPOCH FROM (LEAST(a.ends_at, $2::timestamptz) - GREATEST(a.starts_at, $1::timestamptz)))::int AS secs
         FROM appointments a
        WHERE tstzrange(a.starts_at, a.ends_at) && tstzrange($1::timestamptz, $2::timestamptz)
        ORDER BY a.starts_at`,
      [segStart.toISOString(), segEnd.toISOString()],
    );
    if (appts.rowCount === 0) console.log('     TIME  : no appointment overlaps this segment');
    for (const a of appts.rows) {
      console.log(`     TIME  : ${a.name} ${fmt(a.starts_at)}–${fmt(a.ends_at)} (${Math.round(a.secs / 60)}m overlap)`);
    }
    const distinct = new Set(appts.rows.map((a) => a.name));
    if (distinct.size === 1 && appts.rowCount! > 1) {
      console.log(`     TIME  : ^ all ${appts.rowCount} slots are the SAME client — time cannot distinguish`);
    }

    const text = turns.slice(from - 1, to).map((t) => t.text).join(' ');
    const hits = new Set<string>();
    for (const m of text.matchAll(/\b(?:hi|hello|hey|welcome|bye|thanks|thank you)[,!]?\s+([A-Z][a-z]{2,})\b/g)) {
      hits.add(`${m[1]} (greeting position)`);
    }
    for (const [first, full] of firstNames) {
      if (new RegExp(`\\b${first}\\b`, 'i').test(text)) hits.add(`${full.join(' / ')} (mentioned)`);
    }
    console.log(hits.size ? `     NAME  : ${[...hits].join('; ')}` : '     NAME  : nothing spoken');
  }
}

await pool.end();
