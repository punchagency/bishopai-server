#!/usr/bin/env node
/**
 * Exchange a QuickBooks authorization code for a refresh token.
 *
 * Intuit's redirect hands you a short-lived (~10 min) authorization code, NOT a
 * refresh token — the code is single-use and must be traded in for one. That is
 * what this does.
 *
 *   npm run qb-auth -- --code <auth-code> --realm <realmId> --redirect <uri>
 *
 * The redirect URI must be byte-for-byte the one registered on the Intuit app and
 * used in the authorize request. A mismatch is the #1 cause of invalid_grant.
 *
 * Reads QB_CLIENT_ID / QB_CLIENT_SECRET from .env. Prints the values to paste back
 * into .env. Nothing is written for you — these are credentials, you place them.
 */
import 'dotenv/config';

const TOKEN_URL =
  process.env.QB_OAUTH_TOKEN_URL ?? 'https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer';

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 ? process.argv[i + 1] : undefined;
}

const code = arg('code');
const realm = arg('realm');
const redirect = arg('redirect') ?? process.env.QB_REDIRECT_URI;

const clientId = process.env.QB_CLIENT_ID;
const clientSecret = process.env.QB_CLIENT_SECRET;

const die = (msg) => {
  console.error(`\n  ${msg}\n`);
  process.exit(1);
};

if (!clientId || !clientSecret) die('Set QB_CLIENT_ID and QB_CLIENT_SECRET in .env first.');

// `--url` prints the authorize link instead of exchanging. Codes expire in ~10
// minutes and are single-use, so you will need to mint fresh ones more than once.
if (process.argv.includes('--url')) {
  if (!redirect) die('Missing --redirect <redirect URI> (or set QB_REDIRECT_URI in .env)');
  const url = new URL('https://appcenter.intuit.com/connect/oauth2');
  url.searchParams.set('client_id', clientId);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('redirect_uri', redirect);
  // Accounting reads invoices; payment charges the card. Both are needed for WF2.
  url.searchParams.set('scope', 'com.intuit.quickbooks.accounting com.intuit.quickbooks.payment');
  url.searchParams.set('state', 'bishopai');
  console.log('\n  1. Open this while logged into Nicole\'s QuickBooks:\n');
  console.log(`  ${url}\n`);
  console.log('  2. Approve. You land on your redirect URI with ?code=...&realmId=...');
  console.log('  3. Within ~10 minutes, run:\n');
  console.log('     npm run qb-auth -- --code <code> --realm <realmId>\n');
  process.exit(0);
}

if (!code) die('Missing --code <authorization code>. Run with --url to mint a fresh one.');
if (!redirect) die('Missing --redirect <redirect URI> (or set QB_REDIRECT_URI in .env)');

// The client secret and an auth code are both opaque blobs, and pasting one where
// the other belongs is an easy, confusing mistake — it fails as a generic
// invalid_grant. Catch it here where we can actually say what went wrong.
if (code === clientSecret) {
  die('That is your QB_CLIENT_SECRET, not an authorization code. Run with --url to get a real one.');
}

const body = new URLSearchParams({
  grant_type: 'authorization_code',
  code,
  redirect_uri: redirect,
});

const res = await fetch(TOKEN_URL, {
  method: 'POST',
  headers: {
    accept: 'application/json',
    'content-type': 'application/x-www-form-urlencoded',
    // Intuit wants the client id/secret as HTTP Basic, not in the form body.
    authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`,
  },
  body,
});

const text = await res.text();
if (!res.ok) {
  console.error(`\n  Exchange failed (${res.status}): ${text}\n`);
  if (text.includes('invalid_grant')) {
    console.error('  invalid_grant almost always means one of:');
    console.error('    - the code expired (they live ~10 minutes) → re-authorize and retry fast');
    console.error('    - the code was already used (single-use) → re-authorize');
    console.error('    - --redirect does not EXACTLY match the URI registered on the Intuit app\n');
  }
  process.exit(1);
}

const tok = JSON.parse(text);

console.log('\n  Success. Paste these into server/.env:\n');
console.log(`QB_REFRESH_TOKEN=${tok.refresh_token}`);
if (realm) console.log(`QB_REALM_ID=${realm}`);
else console.log('QB_REALM_ID=   # <- the ?realmId=... value from the redirect URL');
console.log('\n  Notes:');
console.log(`    - access token expires in ${tok.expires_in}s; the backend mints new ones itself.`);
console.log(`    - this refresh token is valid ~${Math.round((tok.x_refresh_token_expires_in ?? 8726400) / 86400)} days,`);
console.log('      and the backend rotates + persists it to integration_state from here on.');
console.log('    - the authorization code you just used is now spent.\n');
