/**
 * Seed the Otter.ai "Health Supplement Consultation" recording as a real
 * client + appointment + conversation in the local DB.
 *
 * Creates:
 *   - Client:       "Demo Patient" (name placeholder — change below)
 *   - Appointment:  completed, 3 days ago (so the review queue picks it up)
 *   - Return visit: booked for tomorrow (so the brief button is live)
 *   - Conversation: the Otter.ai transcript, matched to the appointment
 *   - Supplements:  the protocol discussed in the session
 *
 * Then runs processConversation() → Claude/Groq extracts the note →
 * draft Appointment Sheet + Protocol land in the review queue.
 *
 * Idempotent: deletes rows with name "Demo Patient" before re-inserting.
 *
 * Usage:
 *   NODE_OPTIONS=--dns-result-order=ipv4first \
 *   ./node_modules/.bin/tsx scripts/seed-otter-session.mts
 */
import 'dotenv/config';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { pool } from '../src/db/pool.js';
import { ingestConversation } from '../src/conversations/ingest.js';
import { processConversation } from '../src/session/process.js';
import { llmConfig } from '../src/llm/config.js';

// ── Config ────────────────────────────────────────────────────────────────────
const CLIENT_NAME  = 'Demo Patient';
const CLIENT_EMAIL = 'demo.patient@example.com';
const TRANSCRIPT_PATH = resolve(
  '/home/val/Projects/BishopAI/Health Supplement Consultation_otter.ai.txt',
);

// Session was ~13 min, placed 3 days ago so it shows as a completed past visit.
const DAY = 86_400_000;
const now = Date.now();
const SESSION_START = new Date(now - 3 * DAY).toISOString();
const SESSION_END   = new Date(now - 3 * DAY + 13 * 60_000).toISOString();

// Return visit tomorrow — this is what the "Prep brief" button in the Schedule
// view briefs for.
const RETURN_START = new Date(now + 1 * DAY).toISOString();
const RETURN_END   = new Date(now + 1 * DAY + 60 * 60_000).toISOString();

// Supplements discussed in the session (as best as the garbled transcript allows)
const SUPPLEMENTS = [
  { name: 'TMI',                    dose: 'as prescribed',  qty: null },
  { name: 'Equifem',                dose: '1 cap daily',    qty: 30   },
  { name: 'Livatrip Plus',          dose: '2 caps daily',   qty: 60   },
  { name: 'Cytosine PTHPT',         dose: '1-2 caps daily', qty: 60   }, // pituitary/hypothalamus
  { name: 'Beta Plus',              dose: 'as prescribed',  qty: null  }, // bile salts, gallbladder
  { name: 'Bio B Complex',          dose: 'as prescribed',  qty: null  }, // B vitamin
  { name: 'Adrenal Support',        dose: 'as prescribed',  qty: null  }, // adrenal cortex support
];

// ── Helpers ───────────────────────────────────────────────────────────────────
async function clearDemo(): Promise<void> {
  await pool.query(`DELETE FROM conversations WHERE bee_id = 'otter-demo-1'`);
  await pool.query(`DELETE FROM appointments  WHERE pb_id  LIKE 'otter-demo-%'`);
  await pool.query(`DELETE FROM clients       WHERE name   = $1`, [CLIENT_NAME]);
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main(): Promise<void> {
  console.log(`\n🌱  Seeding Otter.ai session (LLM: ${llmConfig.provider})…\n`);

  const transcript = readFileSync(TRANSCRIPT_PATH, 'utf8');
  console.log(`📄  Transcript loaded (${transcript.length} chars)`);

  await clearDemo();
  console.log('🗑   Cleared previous demo rows');

  // 1. Client
  const { rows: [{ id: clientId }] } = await pool.query<{ id: string }>(
    `INSERT INTO clients (name, email) VALUES ($1, $2) RETURNING id`,
    [CLIENT_NAME, CLIENT_EMAIL],
  );
  console.log(`👤  Client created: ${CLIENT_NAME} (${clientId})`);

  // 2. Past appointment (completed)
  const { rows: [{ id: apptId }] } = await pool.query<{ id: string }>(
    `INSERT INTO appointments (client_id, pb_id, starts_at, ends_at, status)
     VALUES ($1, 'otter-demo-past', $2, $3, 'completed') RETURNING id`,
    [clientId, SESSION_START, SESSION_END],
  );
  console.log(`📅  Past appointment created (${SESSION_START.slice(0, 10)})`);

  // 3. Return / upcoming appointment
  await pool.query(
    `INSERT INTO appointments (client_id, pb_id, starts_at, ends_at, status)
     VALUES ($1, 'otter-demo-return', $2, $3, 'confirmed')`,
    [clientId, RETURN_START, RETURN_END],
  );
  console.log(`📅  Return appointment created (${RETURN_START.slice(0, 10)})`);

  // 4. Supplements
  for (const s of SUPPLEMENTS) {
    await pool.query(
      `INSERT INTO supplements (client_id, name, dose, qty, start_date, source)
       VALUES ($1, $2, $3, $4, $5, 'notes')`,
      [clientId, s.name, s.dose, s.qty, new Date(now - 3 * DAY).toISOString().slice(0, 10)],
    );
  }
  console.log(`💊  ${SUPPLEMENTS.length} supplements added`);

  // 5. Ingest the Otter transcript as a conversation overlapping the appointment
  console.log('\n⏳  Ingesting transcript + running extraction (this calls the LLM)…\n');
  const { conversationId, correlation } = await ingestConversation({
    bee_id:     'otter-demo-1',
    starts_at:  new Date(new Date(SESSION_START).getTime() + 2 * 60_000).toISOString(),
    ends_at:    new Date(new Date(SESSION_END).getTime()   - 1 * 60_000).toISOString(),
    transcript,
  });

  console.log(`💬  Conversation ingested (${conversationId}), correlation: ${correlation.status}`);

  if (correlation.status === 'matched') {
    await processConversation(conversationId);
    console.log('✅  Extraction complete — draft sheet + protocol are in the Review Queue');
  } else {
    // If correlation didn't auto-match, manually link it.
    await pool.query(
      `UPDATE conversations
          SET appointment_id = $1, client_id = $2, correlation_status = 'manual'
        WHERE id = $3`,
      [apptId, clientId, conversationId],
    );
    await processConversation(conversationId);
    console.log('✅  Manually matched + extraction complete — draft sheet + protocol in Review Queue');
  }

  // 6. Summary
  const counts = await pool.query(`
    SELECT
      (SELECT count(*) FROM appointment_sheets WHERE client_id = $1) AS sheets,
      (SELECT count(*) FROM protocols          WHERE client_id = $1) AS protocols,
      (SELECT count(*) FROM supplements        WHERE client_id = $1) AS supplements
  `, [clientId]);

  const c = counts.rows[0];
  console.log(`
─────────────────────────────────────────
  Client ID  : ${clientId}
  Sheets     : ${c.sheets}  (status: draft → open Review Queue to approve)
  Protocols  : ${c.protocols}
  Supplements: ${c.supplements}
  Return visit: ${RETURN_START.slice(0, 10)} (click "Prep brief" in Schedule)
─────────────────────────────────────────
  `);

  await pool.end();
}

main().catch((err) => {
  console.error('❌ Seed failed:', err);
  process.exit(1);
});
