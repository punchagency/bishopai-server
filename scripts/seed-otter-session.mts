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
import { randomUUID } from 'node:crypto';
import { getDatabase } from '../src/db/index.js';
import { supplementDocId } from '../src/db/ids.js';
import { normalizeSupplementName } from '../src/session/supplementName.js';
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
  // No FK cascades any more (§7 of firebaseplan.md), so each collection is
  // cleared explicitly. Local demo script, tiny data set — a scan is fine here.
  const db = getDatabase();
  const conv = await db.conversations.findById('otter-demo-1');
  if (conv) {
    if (conv.appointment_id) await db.conversations.releaseAppointment(conv.appointment_id);
    await db.conversations.delete(conv.id);
  }
  for (const appt of await db.appointments.listAll()) {
    if (!appt.pb_id?.startsWith('otter-demo-')) continue;
    await db.sessionNotes.deleteSessionDocs(appt.id);
    await db.appointments.delete(appt.id);
  }
  for (const client of (await db.clients.listAll()).filter((c) => c.name === CLIENT_NAME)) {
    for (const supp of await db.refills.listSupplementsByClient(client.id)) {
      await db.refills.deleteSupplement(client.id, supp.name_key);
    }
    await db.clients.delete(client.id);
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main(): Promise<void> {
  console.log(`\n🌱  Seeding Otter.ai session (LLM: ${llmConfig.provider})…\n`);

  const transcript = readFileSync(TRANSCRIPT_PATH, 'utf8');
  console.log(`📄  Transcript loaded (${transcript.length} chars)`);

  await clearDemo();
  console.log('🗑   Cleared previous demo rows');

  // 1. Client
  const db = getDatabase();
  const stamp = new Date().toISOString();
  const clientId = randomUUID();
  await db.clients.save({
    id: clientId,
    name: CLIENT_NAME,
    email: CLIENT_EMAIL,
    created_at: stamp,
    updated_at: stamp,
  });
  console.log(`👤  Client created: ${CLIENT_NAME} (${clientId})`);

  // 2. Past appointment (completed)
  const { appointment: past } = await db.appointments.upsertByPbId('otter-demo-past', {
    client_id: clientId,
    client_name: CLIENT_NAME,
    starts_at: SESSION_START,
    ends_at: SESSION_END,
    status: 'completed',
  });
  const apptId = past.id;
  console.log(`📅  Past appointment created (${SESSION_START.slice(0, 10)})`);

  // 3. Return / upcoming appointment
  await db.appointments.upsertByPbId('otter-demo-return', {
    client_id: clientId,
    client_name: CLIENT_NAME,
    starts_at: RETURN_START,
    ends_at: RETURN_END,
    status: 'confirmed',
  });
  console.log(`📅  Return appointment created (${RETURN_START.slice(0, 10)})`);

  // 4. Supplements
  for (const s of SUPPLEMENTS) {
    const nameKey = normalizeSupplementName(s.name) || s.name.trim().toLowerCase();
    await db.refills.saveSupplement({
      id: supplementDocId(clientId, nameKey),
      client_id: clientId,
      name: s.name,
      name_key: nameKey,
      dose: s.dose,
      qty: s.qty,
      start_date: new Date(now - 3 * DAY).toISOString().slice(0, 10),
      source: 'notes',
      created_at: stamp,
      updated_at: stamp,
    });
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
    await db.conversations.claimAppointment({
      id: apptId,
      conversation_id: conversationId,
      claimed_at: new Date().toISOString(),
    });
    const stray = await db.conversations.findById(conversationId);
    await db.conversations.save({
      ...stray!,
      appointment_id: apptId,
      client_id: clientId,
      correlation_status: 'manual',
    });
    await processConversation(conversationId);
    console.log('✅  Manually matched + extraction complete — draft sheet + protocol in Review Queue');
  }

  // 6. Summary — the session docs are read by ref off the appointment, which is
  // what the three-table count becomes now that the id IS the appointment id.
  const docs = await db.sessionNotes.findSessionDocs(apptId);
  const supplements = await db.refills.listSupplementsByClient(clientId);
  console.log(`
─────────────────────────────────────────
  Client ID  : ${clientId}
  Sheets     : ${docs.sheet ? 1 : 0}  (status: draft → open Review Queue to approve)
  Protocols  : ${docs.protocol ? 1 : 0}
  Supplements: ${supplements.length}
  Return visit: ${RETURN_START.slice(0, 10)} (click "Prep brief" in Schedule)
─────────────────────────────────────────
  `);
}

main().catch((err) => {
  console.error('❌ Seed failed:', err);
  process.exit(1);
});
