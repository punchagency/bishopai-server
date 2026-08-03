/**
 * Seed the 3 real Otter.ai transcripts sitting in the project root as 3 demo
 * clients, run them through extraction, approve the resulting protocol, and
 * publish the client documents (ROF/Supplement/Flow Sheet) — to Nicole's real
 * Google Drive (now that creds are configured) AND to the local
 * DEMO_OUTPUT_DIR folder, so there are tangible local artifacts too.
 *
 * Client names are prefixed "DEMO - " so they're unmistakable in Drive next
 * to her real client folders.
 *
 * Idempotent: deletes prior "DEMO - Otter %" rows before re-inserting.
 *
 * Usage:
 *   NODE_OPTIONS=--dns-result-order=ipv4first \
 *   ./node_modules/.bin/tsx scripts/seed-otter-transcripts.mts
 */
import 'dotenv/config';
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { randomUUID } from 'node:crypto';
import { getDatabase } from '../src/db/index.js';
import { ingestConversation } from '../src/conversations/ingest.js';
import { processConversation } from '../src/session/process.js';
import { publishClientTemplates } from '../src/session/publishTemplates.js';
import { llmConfig } from '../src/llm/config.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(__dirname, '../..');

interface TranscriptClient {
  clientName: string;
  email: string;
  file: string;
}

const CLIENTS: TranscriptClient[] = [
  {
    clientName: 'DEMO - Otter Client 1 (Check-In)',
    email: 'demo.otter1@example.com',
    file: 'Health and Wellness Check-In_otter.ai.txt',
  },
  {
    clientName: 'DEMO - Otter Client 2 (Update + Review)',
    email: 'demo.otter2@example.com',
    file: 'Health Update and Supplement Review_otter.ai.txt',
  },
  {
    clientName: 'DEMO - Otter Client 3 (Consultation)',
    email: 'demo.otter3@example.com',
    file: 'Health Supplement Consultation_otter.ai.txt',
  },
];

const DAY = 86_400_000;

async function clearDemo(clientName: string): Promise<void> {
  // Written out because there are no FK cascades any more (§7 of firebaseplan.md).
  const db = getDatabase();
  for (const client of (await db.clients.listAll()).filter((c) => c.name === clientName)) {
    for (const conv of await db.conversations.listAll()) {
      if (conv.client_id !== client.id) continue;
      if (conv.appointment_id) await db.conversations.releaseAppointment(conv.appointment_id);
      await db.conversations.delete(conv.id);
    }
    for (const appt of await db.appointments.listByClient(client.id)) {
      await db.sessionNotes.deleteSessionDocs(appt.id);
      await db.appointments.delete(appt.id);
    }
    await db.clients.delete(client.id);
  }
}

async function seedOne(c: TranscriptClient, index: number): Promise<void> {
  const transcriptPath = resolve(PROJECT_ROOT, c.file);
  const transcript = readFileSync(transcriptPath, 'utf8');
  console.log(`\n=== ${c.clientName} ===`);
  console.log(`Transcript loaded: ${c.file} (${transcript.length} chars)`);

  await clearDemo(c.clientName);

  const sessionsAgo = 3 + index; // spread past sessions across a few days
  const start = new Date(Date.now() - sessionsAgo * DAY);
  const end = new Date(start.getTime() + 45 * 60_000);

  const db = getDatabase();
  const stamp = new Date().toISOString();
  const clientId = randomUUID();
  await db.clients.save({
    id: clientId,
    name: c.clientName,
    email: c.email,
    created_at: stamp,
    updated_at: stamp,
  });

  const { appointment } = await db.appointments.upsertByPbId(`demo-otter-${clientId}`, {
    client_id: clientId,
    client_name: c.clientName,
    starts_at: start.toISOString(),
    ends_at: end.toISOString(),
    status: 'completed',
  });
  const appointmentId = appointment.id;

  const { conversationId, correlation } = await ingestConversation({
    bee_id: `demo-otter-${clientId}`,
    starts_at: new Date(start.getTime() + 2 * 60_000).toISOString(),
    ends_at: new Date(end.getTime() - 2 * 60_000).toISOString(),
    transcript,
  });

  if (correlation.status !== 'matched') {
    await db.conversations.claimAppointment({
      id: appointmentId,
      conversation_id: conversationId,
      claimed_at: new Date().toISOString(),
    });
    const stray = await db.conversations.findById(conversationId);
    await db.conversations.save({
      ...stray!,
      appointment_id: appointmentId,
      client_id: clientId,
      correlation_status: 'manual',
    });
  }

  console.log('Extracting session note (LLM call)…');
  await processConversation(conversationId);

  const protocol = await db.sessionNotes.findProtocolByAppointment(appointmentId);
  if (!protocol) {
    console.log('No protocol was created (extraction may have failed) — skipping publish.');
    return;
  }
  const protocolId = protocol.id;
  console.log('Extracted note:', JSON.stringify(protocol.content_json, null, 2));

  const sheet = await db.sessionNotes.findSheetByAppointment(appointmentId);
  if (sheet) await db.sessionNotes.saveSheet({ ...sheet, status: 'approved' });
  await db.sessionNotes.saveProtocol({ ...protocol, status: 'approved' });

  console.log('Publishing client templates (real Drive + local demo folder)…');
  try {
    const result = await publishClientTemplates(protocolId);
    console.log('Publish result:', result);
  } catch (err) {
    // Best-effort, matching how the review route fires this off the request
    // path (void ... .catch(...)) — one doc failing (e.g. Sheets API disabled)
    // must not stop the other clients in this batch, and ROF/Supplement above
    // already landed for real by this point.
    console.error('Publish failed (continuing to next client):', (err as Error).message ?? err);
  }
}

async function main(): Promise<void> {
  // Optional substring filters, so a single client can be re-run after a
  // transient extraction failure. Re-running all three is not free: on Groq's
  // free tier a full pass is a meaningful slice of the 100k daily token budget,
  // and the two that already extracted cleanly would be redone for nothing.
  // Each client is cleared and rebuilt independently, so this stays idempotent.
  //
  //   node --import tsx scripts/seed-otter-transcripts.mts "Client 3"
  const filters = process.argv.slice(2);
  const selected = CLIENTS.map((c, i) => ({ c, i })).filter(
    ({ c }) => filters.length === 0 || filters.some((f) => c.clientName.includes(f)),
  );
  if (selected.length === 0) {
    console.error(`No transcript matched ${JSON.stringify(filters)}. Known clients:`);
    for (const c of CLIENTS) console.error(`  ${c.clientName}`);
    process.exit(1);
  }

  console.log(`Seeding ${selected.length} Otter.ai transcript(s) as demo clients (LLM: ${llmConfig.provider})…`);
  // The original index is passed through, not the position in the filtered list,
  // so a client keeps the same session date whether it is seeded alone or with
  // the others — otherwise a re-run would silently move its appointment.
  for (const { c, i } of selected) {
    await seedOne(c, i);
  }
  console.log('\nDone.');
}

main().catch((err) => {
  console.error('Seed failed:', err);
  process.exit(1);
});
