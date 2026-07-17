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
import { pool } from '../src/db/pool.js';
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
  await pool.query(
    `DELETE FROM conversations WHERE client_id IN (SELECT id FROM clients WHERE name = $1)`,
    [clientName],
  );
  await pool.query(
    `DELETE FROM appointments WHERE client_id IN (SELECT id FROM clients WHERE name = $1)`,
    [clientName],
  );
  await pool.query(`DELETE FROM clients WHERE name = $1`, [clientName]);
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

  const { rows: [{ id: clientId }] } = await pool.query<{ id: string }>(
    `INSERT INTO clients (name, email) VALUES ($1, $2) RETURNING id`,
    [c.clientName, c.email],
  );

  const { rows: [{ id: appointmentId }] } = await pool.query<{ id: string }>(
    `INSERT INTO appointments (client_id, pb_id, starts_at, ends_at, status)
     VALUES ($1, $2, $3, $4, 'completed') RETURNING id`,
    [clientId, `demo-otter-${clientId}`, start.toISOString(), end.toISOString()],
  );

  const { conversationId, correlation } = await ingestConversation({
    bee_id: `demo-otter-${clientId}`,
    starts_at: new Date(start.getTime() + 2 * 60_000).toISOString(),
    ends_at: new Date(end.getTime() - 2 * 60_000).toISOString(),
    transcript,
  });

  if (correlation.status !== 'matched') {
    await pool.query(
      `UPDATE conversations SET appointment_id = $1, client_id = $2, correlation_status = 'manual' WHERE id = $3`,
      [appointmentId, clientId, conversationId],
    );
  }

  console.log('Extracting session note (LLM call)…');
  await processConversation(conversationId);

  const { rows: protocolRows } = await pool.query<{ id: string; content_json: unknown }>(
    `SELECT id, content_json FROM protocols WHERE appointment_id = $1`,
    [appointmentId],
  );
  if (protocolRows.length === 0) {
    console.log('No protocol was created (extraction may have failed) — skipping publish.');
    return;
  }
  const protocolId = protocolRows[0].id;
  console.log('Extracted note:', JSON.stringify(protocolRows[0].content_json, null, 2));

  await pool.query(`UPDATE appointment_sheets SET status = 'approved' WHERE appointment_id = $1`, [appointmentId]);
  await pool.query(`UPDATE protocols SET status = 'approved' WHERE id = $1`, [protocolId]);

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
  console.log(`Seeding ${CLIENTS.length} Otter.ai transcripts as demo clients (LLM: ${llmConfig.provider})…`);
  for (let i = 0; i < CLIENTS.length; i++) {
    await seedOne(CLIENTS[i], i);
  }
  await pool.end();
  console.log('\nDone.');
}

main().catch((err) => {
  console.error('Seed failed:', err);
  process.exit(1);
});
