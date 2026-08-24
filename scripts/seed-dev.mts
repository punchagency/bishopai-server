#!/usr/bin/env node
/**
 * Reconstitute a realistic development database in one command.
 *
 * The point is that a dev database should be REPRODUCIBLE, not synchronised.
 * Two machines that each run this get the same data without a hosted database,
 * a public TCP proxy, or a dump passed between laptops — and without either of
 * them touching production. Drift stops being a problem because the data is
 * disposable and regenerating it costs seconds.
 *
 * What it seeds, and why this scenario specifically: the 2026-08-20 recordings
 * that were filed under the wrong clients. One recording holds three
 * consecutive consultations; the other straddles two booked appointments. They
 * are the regression cases for the multi-session safety gate, so having them in
 * every dev database is worth more than any amount of synthetic data.
 *
 * Transcripts are the real audio, de-identified — names are pseudonymised
 * consistently with the calendar seeded here, because the gate's name signal
 * only fires when a spoken name matches a client booked nearby.
 *
 * Idempotent: removes its own rows first. Runs entirely offline (no LLM calls,
 * no extraction) — it seeds the CORRELATION state, which is what the gate acts
 * on.
 *
 * Usage: npm run seed:dev
 */
import 'dotenv/config';
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { pool } from '../src/db/pool.js';
import { ingestConversation } from '../src/conversations/ingest.js';

const here = dirname(fileURLToPath(import.meta.url));
const fixture = (n: string) => readFileSync(resolve(here, '../test/fixtures/transcripts', n), 'utf8');

const DAY = '2026-08-20';
const t = (hhmm: string) => `${DAY}T${hhmm}:00.000Z`;

/** The calendar shape is the other half of the bug — a recording that starts
 *  before its slot ends and runs into the next one. Reproduce it exactly. */
const CLIENTS = [
  { name: 'DEV - Marcus Bell',   appt: [t('19:00'), t('19:30')] },
  { name: 'DEV - Jana Holt',     appt: [t('19:30'), t('21:00')] },
  { name: 'DEV - Priya Raman',   appt: [t('21:00'), t('21:30')] },
  { name: 'DEV - Nadia Okonkwo', appt: [t('15:30'), t('16:00')] },
];

const RECORDINGS = [
  {
    // Three consultations in one 41-minute file, four diarized speakers, and it
    // names Marcus Bell while overlapping Jana Holt's slot far more.
    source_id: 'dev-multisession-three-clients',
    file: 'multisession-three-clients.txt',
    window: [t('19:27'), t('20:08')],
  },
  {
    // Straddles Jana Holt and Priya Raman closely enough that both clear the
    // overlap guard — two right answers, so the matcher must not pick one.
    source_id: 'dev-spans-two-appointments',
    file: 'spans-two-appointments.txt',
    window: [t('20:36'), t('21:36')],
  },
];

const db = await pool.connect();
try {
  await db.query('BEGIN');
  await db.query(`DELETE FROM conversations WHERE source_id LIKE 'dev-%'`);
  await db.query(`DELETE FROM appointments WHERE client_id IN (SELECT id FROM clients WHERE name LIKE 'DEV - %')`);
  await db.query(`DELETE FROM clients WHERE name LIKE 'DEV - %'`);

  for (const c of CLIENTS) {
    const { rows } = await db.query<{ id: string }>(
      `INSERT INTO clients (name) VALUES ($1) RETURNING id`, [c.name]);
    await db.query(
      `INSERT INTO appointments (client_id, starts_at, ends_at, status)
       VALUES ($1, $2, $3, 'completed')`,
      [rows[0].id, c.appt[0], c.appt[1]]);
  }
  await db.query('COMMIT');
} catch (err) {
  await db.query('ROLLBACK');
  throw err;
} finally {
  db.release();
}

// Through the REAL ingest path, so what lands is whatever the current gate and
// matcher actually decide — not a hand-written answer that can drift from them.
for (const r of RECORDINGS) {
  const res = await ingestConversation({
    source_id: r.source_id,
    source: 'pocket',
    starts_at: r.window[0],
    ends_at: r.window[1],
    transcript: fixture(r.file),
  });
  const held = res.hold ? ` HELD: ${res.hold.reasons.join('; ')}` : '';
  console.log(`${r.source_id}\n  -> ${res.correlation.status}${held}`);
}

const summary = await pool.query(
  `SELECT correlation_status, count(*)::int AS n FROM conversations
    WHERE source_id LIKE 'dev-%' GROUP BY 1 ORDER BY 1`);
console.log('\nseeded conversations:', summary.rows.map((r) => `${r.correlation_status}=${r.n}`).join(' '));
await pool.end();
