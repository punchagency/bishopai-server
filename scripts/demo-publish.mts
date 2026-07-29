/**
 * One-off: (re)publish Nicole's three client templates for specific protocols,
 * driving the SAME path an in-app Approve uses (publishClientTemplates). Used to
 * retry a publish that failed on a transient Drive network error, without having
 * to un-approve and re-approve in the UI. Renders from each protocol's stored
 * note, so it works whether the protocol is draft or approved.
 */
import 'dotenv/config';
import { pool } from '../src/db/pool.js';
import { publishClientTemplates } from '../src/session/publishTemplates.js';
import { isDriveConfigured } from '../src/integrations/drive/index.js';

const PROTOCOL_IDS = [
  '9e06b9c6-f046-4feb-90ae-682c4a2f87ff', // Marta Reyes (Jul 18)
  'b6fb093d-d5da-47a0-821b-d26703918fab', // Lena Petrov
  '59bb9156-bd11-4259-a17f-1b7f7a8a256a', // Maya Chen
];

async function main() {
  console.log(`Drive configured: ${isDriveConfigured()} (false = local demo-output only)\n`);
  for (const id of PROTOCOL_IDS) {
    process.stdout.write(`Publishing ${id} ... `);
    try {
      const r = await publishClientTemplates(id);
      console.log('ok', JSON.stringify(r));
    } catch (err) {
      console.log('FAILED:', err instanceof Error ? err.message : String(err));
    }
  }
  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
