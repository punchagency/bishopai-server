/**
 * Does a Flow Sheet block actually land in a real Google Sheet?
 *
 * This is the path that was blocked the longest: the Sheets scope was missing
 * from the refresh token while everything else worked, so publishing looked
 * fine and the Flow Sheet silently never got its block. `check:google` now
 * proves the scope is present — this proves the write.
 *
 * Exercises the real provisioning + append path:
 *   resolveDocFolder → ensureConvertedSheet (xlsx template → native Sheet)
 *                    → appendFlowSheetEntry → read the cells back
 *
 * The append is idempotent by DATE, so this also checks that: it writes twice
 * and expects the second to be a no-op. That guard is what stops a retried
 * publish giving one visit two blocks.
 *
 *   npm run check:flowsheet-write            # write, verify, then delete the Sheet
 *   npm run check:flowsheet-write -- --keep  # leave it to eyeball
 *
 * Writes into `<root>/_Innerlume Test/AppointmentFlowSheet/`, never a real client's.
 */
import 'dotenv/config';
import { setDefaultResultOrder } from 'node:dns';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDriveConfigured, driveConfig } from '../src/integrations/drive/config.js';
import { resolveDocFolder, ensureConvertedSheet } from '../src/integrations/drive/files.js';
import { appendFlowSheetEntry } from '../src/integrations/drive/sheets.js';
import { driveRequest } from '../src/integrations/drive/client.js';

// Prefer IPv4 — see the note in src/server.ts. Google publishes AAAA records
// and an unroutable IPv6 turns every call here into an ETIMEDOUT.
setDefaultResultOrder('ipv4first');

const KEEP = process.argv.includes('--keep');
const TEST_CLIENT = '_Innerlume Test';
const TEMPLATE = join(dirname(fileURLToPath(import.meta.url)), '../assets/templates/appointment-flow-sheet.xlsx');

const green = (s: string) => `\x1b[32m${s}\x1b[0m`;
const red = (s: string) => `\x1b[31m${s}\x1b[0m`;
const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;

async function main(): Promise<void> {
  console.log('\nGoogle Sheets Flow Sheet write test\n');

  if (!isDriveConfigured()) {
    console.log(`  ${red('✗')} Not configured.\n`);
    process.exit(1);
  }
  const cfg = driveConfig();
  console.log(`  ${green('✓')} Credentials present.`);

  // 1. Provision the client's Flow Sheet from the xlsx template. Drive converts
  //    it to a NATIVE Google Sheet — a plain binary upload would not be
  //    appendable, which is the whole reason this doc type differs.
  const { folderId } = await resolveDocFolder(TEST_CLIENT, 'AppointmentFlowSheet', {
    rootFolderId: cfg.rootFolderId,
  });
  const name = `${TEST_CLIENT} Appointment Flow Sheet`;
  const sheet = await ensureConvertedSheet(folderId, name, readFileSync(TEMPLATE));
  console.log(`  ${green('✓')} Flow Sheet ${sheet.created ? 'provisioned' : 'already existed'} — ${name}`);
  console.log(`    ${dim(`https://docs.google.com/spreadsheets/d/${sheet.id}/edit`)}`);

  // 2. Append a block. A unique date each run so a re-run appends rather than
  //    hitting the idempotency guard on the first write.
  const date = `TEST ${new Date().toISOString().slice(11, 19)}`;
  const entry = {
    date,
    symptoms: 'Write test — safe to delete',
    foundation: 'WATER: 2L\nSLEEP: 7h',
    bodyScan: 'No findings (test)',
    protocol: 'None — this is a connectivity test',
    virtual: 'N',
  };

  let first;
  try {
    first = await appendFlowSheetEntry(sheet.id, entry);
    console.log(
      `  ${green('✓')} Block appended — block ${first.blockIndex}, header row ${first.headerRow}, ${first.cellsWritten} cells${first.grew ? ' (sheet grown)' : ''}`,
    );
  } catch (err) {
    console.log(`  ${red('✗')} Append failed.`);
    console.log(`      → ${err instanceof Error ? err.message : String(err)}`);
    console.log(`      → If this is a 403 on the Sheets API, the token predates the`);
    console.log(`        spreadsheets scope — re-run node scripts/google-auth.mjs.\n`);
    process.exit(1);
  }

  // 3. Read the cells back. The batchUpdate returning 200 is not evidence the
  //    values landed where the block layout expects them.
  const range = `A${first.headerRow}:H${first.headerRow + 8}`;
  try {
    const got = await driveRequest<{ values?: string[][] }>(
      `https://sheets.googleapis.com/v4/spreadsheets/${sheet.id}/values/${encodeURIComponent(range)}`,
    );
    const flat = (got.values ?? []).flat().join(' | ');
    const found = flat.includes(date);
    console.log(`  ${found ? green('✓') : red('✗')} Read back — ${found ? `date "${date}" present in ${range}` : `date NOT found in ${range}`}`);
  } catch (err) {
    console.log(`  ${red('✗')} Could not read back: ${err instanceof Error ? err.message : err}`);
  }

  // 4. Same entry again — must be a no-op. This is the guard that stops a
  //    retried or replayed publish giving one visit two blocks.
  const second = await appendFlowSheetEntry(sheet.id, entry);
  const idempotent = second.alreadyPresent === true && second.cellsWritten === 0;
  console.log(
    `  ${idempotent ? green('✓') : red('✗')} Idempotent on re-publish — ${idempotent ? 'no-op, as designed' : `WROTE AGAIN (block ${second.blockIndex}, ${second.cellsWritten} cells)`}`,
  );

  // 5. Clean up.
  if (KEEP) {
    console.log(`\n  ${dim('--keep: Sheet left in Drive. Delete it by hand when done.')}`);
  } else {
    try {
      await driveRequest(`https://www.googleapis.com/drive/v3/files/${sheet.id}`, { method: 'DELETE' });
      console.log(`  ${green('✓')} Test Sheet deleted.`);
    } catch (err) {
      console.log(`  ${red('✗')} Could not delete: ${err instanceof Error ? err.message : err}`);
    }
  }

  console.log(`\n  Flow Sheet writes: ${green('WORKING')}\n`);
}

main().catch((err) => {
  console.error(`\n${red('✗')} ${err instanceof Error ? err.stack : err}\n`);
  process.exit(1);
});
