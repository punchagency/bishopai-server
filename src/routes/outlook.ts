import { Router } from 'express';
import { logError, logEvent } from '../observability/logger';
import { requireAuth } from '../auth/middleware';
import {
  buildAuthorizeUrl,
  disconnectOutlook,
  exchangeCodeForTokens,
  getOutlookConnection,
  isOutlookAppConfigured,
  setPrimarySender,
} from '../integrations/outlook';

// The "Connect Outlook" (delegated OAuth) surface for WF3.
//
//   GET  /auth/outlook/status     → { available, connected, sender, ... }   (auth)
//   GET  /auth/outlook/start      → { url } to open Microsoft's consent      (auth)
//   POST /auth/outlook/disconnect → forget the connection                    (auth)
//   GET  /auth/outlook/callback   → exchanges the code, shows a done page     (OPEN)
//
// The backend runs on a PUBLIC url, so all the mutating/reading endpoints are
// gated by requireAuth (same guard as the rest of the dashboard API — a
// pass-through only while Nicole has login off). They're driven by the Electron
// renderer, which holds the session token. Only /callback stays open, because
// Microsoft redirects the system browser to it with no token; it's protected
// instead by the single-use, per-state PKCE `state` (an unknown state is
// rejected), so a party who can't authenticate to /start can't complete a
// connect. The refresh token never leaves the backend (integrations/outlook/oauth.ts).
export const outlookRouter = Router();

// HTML-escape untrusted values before interpolating them into a server-rendered
// page (the callback reflects Microsoft's `error_description` and the /me sender).
function esc(s: string): string {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// A minimal self-contained page shown in the browser after the handshake, so
// Nicole gets clear closure and returns to the app. Brand rust + system fonts.
function resultPage(opts: { ok: boolean; title: string; message: string }): string {
  const accent = opts.ok ? '#7f3110' : '#9b2c2c';
  const icon = opts.ok ? '✓' : '✕';
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${opts.ok ? 'Outlook connected' : 'Outlook connection failed'}</title>
<style>
  :root { color-scheme: light dark; }
  body { margin:0; min-height:100vh; display:flex; align-items:center; justify-content:center;
         font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;
         background:#faf7f4; color:#2a1d16; }
  @media (prefers-color-scheme: dark){ body{ background:#1a120e; color:#f2e9e2; } }
  .card { max-width:26rem; padding:2.5rem; text-align:center; }
  .badge { width:3.5rem; height:3.5rem; border-radius:999px; display:inline-flex; align-items:center;
           justify-content:center; font-size:1.8rem; color:#fff; background:${accent}; margin-bottom:1rem; }
  h1 { font-size:1.4rem; margin:0 0 .5rem; }
  p { line-height:1.5; opacity:.85; margin:0 0 1.5rem; }
  .hint { font-size:.85rem; opacity:.6; }
</style></head>
<body><div class="card">
  <div class="badge">${icon}</div>
  <h1>${esc(opts.title)}</h1>
  <p>${opts.message}</p>
  <p class="hint">You can close this window and return to Innerlume.</p>
</div></body></html>`;
}

// GET /auth/outlook/status — drives the Settings card + the WF3 dry-run badge.
outlookRouter.get('/status', requireAuth, async (_req, res) => {
  try {
    const conn = await getOutlookConnection();
    res.json(conn);
  } catch (err) {
    logError('outlook.status', 'status failed', err);
    res.status(500).json({ error: 'internal error' });
  }
});

// GET /auth/outlook/start — mint the Microsoft consent URL for the renderer to
// open in the system browser. Returns JSON (not a redirect) so it can be an
// authenticated fetch; the renderer then opens the returned Microsoft URL.
outlookRouter.get('/start', requireAuth, async (_req, res) => {
  if (!isOutlookAppConfigured()) {
    return res.status(503).json({ error: 'not_configured', message: 'Outlook is not set up on the server yet.' });
  }
  try {
    const url = await buildAuthorizeUrl();
    return res.json({ url });
  } catch (err) {
    logError('outlook.start', 'failed to build authorize url', err);
    return res.status(500).json({ error: 'internal error' });
  }
});

// GET /auth/outlook/callback — Microsoft redirects here with ?code&state (or ?error).
outlookRouter.get('/callback', async (req, res) => {
  const { code, state, error, error_description } = req.query as Record<string, string | undefined>;

  if (error) {
    logEvent('info', 'outlook.callback', 'consent declined or errored', { error });
    return res.status(400).send(
      resultPage({
        ok: false,
        title: 'Outlook wasn’t connected',
        message: error_description ? esc(error_description) : 'The Microsoft sign-in was cancelled or denied.',
      }),
    );
  }
  if (!code || !state) {
    return res.status(400).send(
      resultPage({ ok: false, title: 'Outlook wasn’t connected', message: 'The response from Microsoft was incomplete.' }),
    );
  }

  try {
    const { sender } = await exchangeCodeForTokens(code, state);
    return res.send(
      resultPage({
        ok: true,
        title: 'Outlook connected',
        message: `Re-engagement emails will send from <strong>${esc(sender)}</strong>.`,
      }),
    );
  } catch (err) {
    logError('outlook.callback', 'code exchange failed', err);
    return res.status(400).send(
      resultPage({
        ok: false,
        title: 'Outlook wasn’t connected',
        message: 'We couldn’t complete the connection. Please start again from Settings.',
      }),
    );
  }
});

// POST /auth/outlook/disconnect { sender? } — forget one mailbox (or all if
// sender omitted). Returns the updated connection.
outlookRouter.post('/disconnect', requireAuth, async (req, res) => {
  const sender = typeof req.body?.sender === 'string' ? req.body.sender : undefined;
  try {
    await disconnectOutlook(sender);
    res.json(await getOutlookConnection());
  } catch (err) {
    logError('outlook.disconnect', 'disconnect failed', err);
    res.status(500).json({ error: 'internal error' });
  }
});

// POST /auth/outlook/primary { sender } — choose which mailbox WF3 sends from.
outlookRouter.post('/primary', requireAuth, async (req, res) => {
  const sender = typeof req.body?.sender === 'string' ? req.body.sender.trim() : '';
  if (!sender) return res.status(400).json({ error: 'sender required' });
  try {
    await setPrimarySender(sender);
    return res.json(await getOutlookConnection());
  } catch (err) {
    if (err instanceof Error && /no connected Outlook mailbox/.test(err.message)) {
      return res.status(404).json({ error: err.message });
    }
    logError('outlook.primary', 'set primary failed', err);
    return res.status(500).json({ error: 'internal error' });
  }
});
