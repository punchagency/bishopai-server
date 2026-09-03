import { Router } from 'express';
import { logError } from '../observability/logger';
import { isPbConfigured } from '../integrations/pb/config';
import { isDriveConfigured } from '../integrations/drive/config';
import { isQuickbooksConfigured } from '../integrations/quickbooks/config';
import { getOutlookConnection } from '../integrations/outlook';

export const integrationsRouter = Router();

/**
 * GET /integrations/status — one answer for "what is actually hooked up?"
 *
 * The welcome guide used to hardcode four of these as "in progress, Richmond is
 * setting this up". That was true when it was written and quietly wrong
 * afterwards: three of the four went live and the guide kept saying otherwise,
 * so the first thing a new user read about the app was out of date.
 *
 * Each flag is the same signal the feature screens already use, so the guide
 * cannot contradict Checkout's dry-run badge or the Outlook card in Settings.
 * Pocket is deliberately NOT here — /pocket/status answers a different and
 * harder question (is anything actually arriving), and the guide already has it.
 */
integrationsRouter.get('/status', async (_req, res) => {
  // Outlook is the one that needs a lookup: the app can be configured while no
  // mailbox has actually completed the OAuth handshake, and only the second of
  // those means mail can go out.
  let outlookConnected = false;
  try {
    const conn = await getOutlookConnection();
    outlookConnected = !!conn.connected;
  } catch (err) {
    logError('integrations.status', 'outlook lookup failed', err);
  }

  return res.json({
    practice_better: isPbConfigured(),
    google_drive: isDriveConfigured(),
    outlook: outlookConnected,
    quickbooks: isQuickbooksConfigured(),
  });
});
