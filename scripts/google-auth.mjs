// One-command Google OAuth: opens the consent screen, catches the redirect on a
// local loopback server, exchanges the code, and prints GOOGLE_REFRESH_TOKEN.
// No extra deps. Prereq: GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET in server/.env
// (from an OAuth client of type "Desktop app" — loopback redirect is allowed).
//
// Run:  npm run google-auth        (from server/)
import 'dotenv/config';
import http from 'node:http';
import { spawn } from 'node:child_process';

const PORT = Number(process.env.GOOGLE_AUTH_PORT ?? 4571);
const REDIRECT = `http://localhost:${PORT}/oauth2callback`;
// drive.file: create/open the client's Drive docs. spreadsheets: append blocks to
// the native Appointment Flow Sheet via the Sheets API. Both granted in one consent.
const SCOPE =
  process.env.GOOGLE_AUTH_SCOPE ??
  'https://www.googleapis.com/auth/drive.file https://www.googleapis.com/auth/spreadsheets';
const clientId = process.env.GOOGLE_CLIENT_ID;
const clientSecret = process.env.GOOGLE_CLIENT_SECRET;

if (!clientId || !clientSecret) {
  console.error('Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in server/.env first (see google-drive-setup.md).');
  process.exit(1);
}

const authUrl =
  'https://accounts.google.com/o/oauth2/v2/auth?' +
  new URLSearchParams({
    client_id: clientId,
    redirect_uri: REDIRECT,
    response_type: 'code',
    scope: SCOPE,
    access_type: 'offline', // required to get a refresh token
    prompt: 'consent', // force a refresh token even on re-auth
  }).toString();

const server = http.createServer(async (req, res) => {
  if (!req.url?.startsWith('/oauth2callback')) {
    res.writeHead(404);
    return res.end();
  }
  const params = new URL(req.url, REDIRECT).searchParams;
  const code = params.get('code');
  const err = params.get('error');
  if (err || !code) {
    res.end(`Authorization failed: ${err ?? 'no code'}`);
    console.error(`\nAuthorization failed: ${err ?? 'no code'}`);
    server.close();
    return process.exit(1);
  }
  try {
    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uri: REDIRECT,
        grant_type: 'authorization_code',
      }).toString(),
    });
    const data = await tokenRes.json();
    if (!data.refresh_token) {
      res.end('No refresh_token returned — revoke prior access at myaccount.google.com/permissions and retry.');
      console.error('\nNo refresh_token in response:', data);
      server.close();
      return process.exit(1);
    }
    res.end('Google Drive authorized. Close this tab and return to the terminal.');
    console.log('\n✅ Success. Add this line to server/.env:\n');
    console.log(`GOOGLE_REFRESH_TOKEN=${data.refresh_token}\n`);
    server.close();
    process.exit(0);
  } catch (e) {
    res.end(`Token exchange failed: ${e.message}`);
    console.error('\nToken exchange failed:', e);
    server.close();
    process.exit(1);
  }
});

server.listen(PORT, () => {
  console.log(`\nSign in as Nicole and approve — opening your browser. If it doesn't open, visit:\n\n${authUrl}\n`);
  const opener = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
  spawn(opener, [authUrl], { stdio: 'ignore', detached: true }).on('error', () => {});
});
