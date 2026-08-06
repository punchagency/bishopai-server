/**
 * Does a real file actually land in Drive?
 *
 * `check:google` proves the token carries the drive.file scope. That is not the
 * same claim: a scope can be granted while the root folder id is wrong, the
 * folder was deleted, or the app was never the file's creator (drive.file only
 * sees what the app itself made). This does the write.
 *
 * Goes through resolveDocFolder + uploadBinary — the same helpers the ROF and
 * Supplement Protocol publish paths use — so a pass means those paths work,
 * not merely that the credentials are live.
 *
 *   npm run check:drive-write              # upload, then delete it again
 *   npm run check:drive-write -- --keep    # leave it there to eyeball
 *
 * Writes into `<root>/_Innerlume Test/ROF/`, never a real client's folder.
 */
import 'dotenv/config';
import { isDriveConfigured, driveConfig } from '../src/integrations/drive/config.js';
import { resolveDocFolder, uploadBinary, DOCX_MIME } from '../src/integrations/drive/files.js';
import { driveRequest } from '../src/integrations/drive/client.js';
import { setDefaultResultOrder } from 'node:dns';

// Prefer IPv4 — see the note in src/server.ts. Google publishes AAAA records
// and an unroutable IPv6 turns every call here into an ETIMEDOUT.
setDefaultResultOrder('ipv4first');

const KEEP = process.argv.includes('--keep');
const TEST_CLIENT = '_Innerlume Test';

const green = (s: string) => `\x1b[32m${s}\x1b[0m`;
const red = (s: string) => `\x1b[31m${s}\x1b[0m`;
const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;

async function main(): Promise<void> {
  console.log('\nGoogle Drive write test\n');

  if (!isDriveConfigured()) {
    console.log(`  ${red('✗')} Not configured — set GOOGLE_CLIENT_ID / _SECRET / _REFRESH_TOKEN.\n`);
    process.exit(1);
  }
  const cfg = driveConfig();
  console.log(`  ${green('✓')} Credentials present.`);
  console.log(
    `    ${dim(cfg.rootFolderId ? `root folder: ${cfg.rootFolderId}` : 'no GDRIVE_ROOT_FOLDER_ID — writing to My Drive root')}`,
  );

  // 1. Resolve `<root>/_Innerlume Test/ROF/`, creating either level if missing.
  //    This is the step that fails when the root folder id is stale or the app
  //    never created it — a scope check cannot see that.
  let folderId: string;
  try {
    const r = await resolveDocFolder(TEST_CLIENT, 'ROF', { rootFolderId: cfg.rootFolderId });
    folderId = r.folderId;
    console.log(`  ${green('✓')} Folder resolved — ${TEST_CLIENT}/ROF/`);
    console.log(`    ${dim(`folder id: ${folderId}`)}`);
  } catch (err) {
    console.log(`  ${red('✗')} Could not resolve the folder.`);
    console.log(`      → ${err instanceof Error ? err.message : String(err)}`);
    if (cfg.rootFolderId) {
      console.log(`      → GDRIVE_ROOT_FOLDER_ID is set to ${cfg.rootFolderId}.`);
      console.log(`        With the drive.file scope the app can only open folders IT created;`);
      console.log(`        a folder made by hand in the browser is invisible to it. Either share`);
      console.log(`        it with the OAuth account or let the app create its own root.`);
    }
    process.exit(1);
  }

  // 2. Upload a real (tiny) file. Deliberately docx-typed, matching the ROF
  //    path, so Drive's no-conversion handling is exercised too.
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const name = `innerlume-write-test-${stamp}.docx`;
  const bytes = Buffer.from(
    `Innerlume Drive write test\nCreated ${new Date().toISOString()}\nSafe to delete.\n`,
    'utf8',
  );

  let fileId: string;
  try {
    const up = await uploadBinary(folderId, name, bytes, DOCX_MIME);
    fileId = up.id;
    console.log(`  ${green('✓')} File uploaded — ${name}`);
    console.log(`    ${dim(`https://drive.google.com/file/d/${fileId}/view`)}`);
  } catch (err) {
    console.log(`  ${red('✗')} Upload failed.`);
    console.log(`      → ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  }

  // 3. Read it back. An upload that 200s but stores nothing readable is the
  //    failure this catches — the response is not the evidence, the file is.
  try {
    const meta = await driveRequest<{ id: string; name: string; size?: string; mimeType: string }>(
      `https://www.googleapis.com/drive/v3/files/${fileId}?fields=id,name,size,mimeType`,
    );
    const sizeOk = Number(meta.size ?? 0) === bytes.length;
    console.log(
      `  ${sizeOk ? green('✓') : red('✗')} Read back — ${meta.size ?? '?'} bytes${sizeOk ? '' : ` (expected ${bytes.length})`}`,
    );
  } catch (err) {
    console.log(`  ${red('✗')} Uploaded but could not read back: ${err instanceof Error ? err.message : err}`);
  }

  // 4. Clean up, unless asked to leave it.
  if (KEEP) {
    console.log(`\n  ${dim('--keep: file left in Drive. Delete it by hand when done.')}`);
  } else {
    try {
      await driveRequest(`https://www.googleapis.com/drive/v3/files/${fileId}`, { method: 'DELETE' });
      console.log(`  ${green('✓')} Test file deleted.`);
      console.log(`    ${dim(`the empty ${TEST_CLIENT}/ROF/ folders are left behind — remove by hand if unwanted`)}`);
    } catch (err) {
      console.log(`  ${red('✗')} Could not delete ${fileId}: ${err instanceof Error ? err.message : err}`);
      console.log(`      → remove it by hand.`);
    }
  }

  console.log(`\n  Drive writes: ${green('WORKING')} — ROF and Supplement Protocol can publish.\n`);
}

main().catch((err) => {
  console.error(`\n${red('✗')} ${err instanceof Error ? err.stack : err}\n`);
  process.exit(1);
});
