import express from 'express';
import { healthRouter } from './routes/health';
import { webhooksRouter } from './routes/webhooks';
import { reviewRouter } from './routes/review';
import { refillsRouter } from './routes/refills';
import { engagementRouter } from './routes/engagement';
import { checkoutRouter } from './routes/checkout';
import { auditRouter } from './routes/audit';
import { dashboardRouter } from './routes/dashboard';
import { consentsRouter } from './routes/consents';
import { authRouter } from './routes/auth';
import { outlookRouter } from './routes/outlook';
import { appointmentsRouter } from './routes/appointments';
import { tasksRouter } from './routes/tasks';
import { clientsRouter } from './routes/clients';
import { remindersRouter } from './routes/reminders';
import { pocketRouter } from './routes/pocket';
import { templatesRouter } from './routes/templates';
import { requireAuth } from './auth/middleware';

// Build the Express app (routes + middleware) without listening. server.ts adds
// the listen + lifecycle; tests can mount this directly against an ephemeral port.
export function createApp(): express.Express {
  const app = express();

  // CORS. The dashboard is an Electron renderer on a different origin (the
  // electron-vite dev server, or file:// in a packaged build) than this backend,
  // so browsers block its fetches without these headers. We use Bearer tokens,
  // not cookies, so a wildcard origin is safe and there are no credentials to
  // leak. Answer the preflight for the Authorization / JSON content-type headers.
  app.use((req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'authorization, content-type, x-webhook-secret, pb-signature');
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    return next();
  });

  // Capture the raw body so PB webhook signatures (HMAC over the exact bytes)
  // can be verified — express.json() otherwise discards it after parsing.
  //
  // The `limit` must stay comfortably above MAX_TRANSCRIPT_CHARS (200k chars,
  // ~200KB, plus JSON escaping and any multi-byte characters). The default is
  // only 100KB, which would 413 a long session transcript — from the manual
  // import or a Pocket webhook — before it ever reached a handler.
  app.use(express.json({ limit: '1mb', verify: (req, _res, buf) => ((req as { rawBody?: Buffer }).rawBody = buf) }));

  app.use('/health', healthRouter);
  app.use('/webhooks', webhooksRouter); // inbound webhooks carry their own secret/signature
  app.use('/auth', authRouter);
  // Outlook connect flow — open: the OAuth handshake is driven by the system
  // browser (no dashboard token), and the refresh token stays server-side.
  app.use('/auth/outlook', outlookRouter);
  // The dashboard API is guarded by requireAuth — a pass-through when Nicole has
  // login turned off (default), token-gated when she turns it on in Settings.
  app.use('/review', requireAuth, reviewRouter);
  app.use('/refills', requireAuth, refillsRouter);
  app.use('/reminders', requireAuth, remindersRouter);
  app.use('/engagement', requireAuth, engagementRouter);
  app.use('/checkout', requireAuth, checkoutRouter);
  app.use('/dashboard', requireAuth, dashboardRouter);
  app.use('/consents', requireAuth, consentsRouter);
  app.use('/appointments', requireAuth, appointmentsRouter);
  app.use('/tasks', requireAuth, tasksRouter);
  app.use('/clients', requireAuth, clientsRouter);
  app.use('/audit', requireAuth, auditRouter);
  app.use('/pocket', requireAuth, pocketRouter);
  app.use('/templates', requireAuth, templatesRouter);

  return app;
}
