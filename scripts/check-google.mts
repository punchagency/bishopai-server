/**
 * Is Google Drive + Sheets actually usable right now?
 *
 * The Flow Sheet append is the one publish path that can fail while everything
 * else succeeds, and it did so silently for a long time. Two independent things
 * must both be true, and neither is visible from inside the app:
 *
 *   1. The refresh token carries BOTH scopes (drive.file AND spreadsheets).
 *      A token minted before the spreadsheets scope was added still works
 *      perfectly for Drive, so nothing looks broken until a Sheets call 403s.
 *   2. The Sheets API is enabled on the Google Cloud project. That is a console
 *      setting, not a credential problem, so no amount of re-authorising fixes
 *      it — which is exactly why it's confusing to debug.
 *
 * Usage: npm run check:google
 */
import 'dotenv/config';

const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.file';
const SHEETS_SCOPE = 'https://www.googleapis.com/auth/spreadsheets';

const ok = (m: string): void => console.log(`  \x1b[32m✓\x1b[0m ${m}`);
const bad = (m: string): void => console.log(`  \x1b[31m✗\x1b[0m ${m}`);
const fix = (m: string): void => console.log(`      → ${m}`);

async function main(): Promise<void> {
  console.log('\nGoogle Drive + Sheets\n');

  const id = process.env.GOOGLE_CLIENT_ID;
  const secret = process.env.GOOGLE_CLIENT_SECRET;
  const refresh = process.env.GOOGLE_REFRESH_TOKEN;

  if (!id || !secret || !refresh) {
    bad('Not configured — every publish runs in dry-run mode.');
    fix('Set GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET / GOOGLE_REFRESH_TOKEN (see google-drive-setup.md).');
    return;
  }
  ok('Credentials present.');

  const tok = (await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: id,
      client_secret: secret,
      refresh_token: refresh,
      grant_type: 'refresh_token',
    }),
  }).then((r) => r.json())) as { access_token?: string; scope?: string; error?: string };

  if (!tok.access_token) {
    bad(`Refresh token rejected (${tok.error ?? 'unknown error'}).`);
    fix('Re-authorise: node scripts/google-auth.mjs');
    return;
  }
  ok('Refresh token valid.');

  const scopes = (tok.scope ?? '').split(/\s+/);
  const hasDrive = scopes.includes(DRIVE_SCOPE);
  const hasSheets = scopes.includes(SHEETS_SCOPE);

  if (hasDrive) ok('Drive scope granted — ROF and Supplement Protocol can be written.');
  else bad('Drive scope MISSING — no document can be written at all.');

  if (hasSheets) {
    ok('Sheets scope granted.');
  } else {
    bad('Sheets scope MISSING — the Flow Sheet cannot be appended to.');
    fix('The auth script already requests it; this token predates that.');
    fix('Re-authorise: node scripts/google-auth.mjs');
    fix('Then replace GOOGLE_REFRESH_TOKEN in .env with the new token.');
  }

  // Probing a deliberately non-existent sheet separates "API disabled" (403 with
  // a console link) from "working, but no such sheet" (404). A 404 is a pass.
  const probe = await fetch('https://sheets.googleapis.com/v4/spreadsheets/probe-nonexistent', {
    headers: { authorization: `Bearer ${tok.access_token}` },
  });
  const body = (await probe.json()) as { error?: { message?: string } };
  const message = body.error?.message ?? '';

  let apiReady = false;
  if (probe.status === 404) {
    ok('Sheets API is enabled and reachable.');
    apiReady = true;
  } else if (probe.status === 403 && /has not been used|is disabled/i.test(message)) {
    bad('Sheets API is DISABLED on the Google Cloud project.');
    fix('Enable it in the console, then give it a minute to propagate:');
    const link = /https:\/\/console\.developers\.google\.com\S+/.exec(message);
    fix(link ? link[0] : 'https://console.cloud.google.com/apis/library/sheets.googleapis.com');
  } else if (probe.status === 403) {
    bad(`Sheets API refused the token: ${message || probe.status}`);
  } else {
    ok(`Sheets API reachable (HTTP ${probe.status}).`);
    apiReady = true;
  }

  const ready = hasDrive && hasSheets && apiReady;
  console.log(
    `\n  Flow Sheet writes: ${
      ready ? '\x1b[32mREADY\x1b[0m' : '\x1b[31mBLOCKED\x1b[0m — fix the ✗ items above'
    }\n`,
  );
}

main().catch((err) => {
  console.error('check failed:', err);
  process.exit(1);
});
