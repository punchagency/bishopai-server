import { Router } from 'express';
import { pool } from '../db/pool';
import { logError } from '../observability/logger';
import {
  isPocketConfigured,
  isPocketWebhookConfigured,
  isSchedulerEnabled,
  pocketPollConfig,
} from '../integrations/pocket/config';

export const pocketRouter = Router();

/**
 * GET /pocket/status — is the recorder actually feeding us?
 *
 * This exists because retiring the Bee courier removed the only thing on
 * Nicole's screen that said "your sessions are being captured". Configuration
 * alone doesn't answer that — a key can be set and a webhook destination
 * missing, or both fine and the pendant flat — so the useful signal is when a
 * recording last actually arrived, not what the environment says.
 *
 * `healthy` is deliberately about ingest, not credentials: something landed
 * recently, so whatever the config looks like, it works.
 */
pocketRouter.get('/status', async (_req, res) => {
  const poll = pocketPollConfig();
  try {
    const { rows } = await pool.query<{
      last_recording_at: string | null;
      last_24h: string;
      unmatched: string;
    }>(
      `SELECT max(created_at)                                         AS last_recording_at,
              count(*) FILTER (WHERE created_at > now() - interval '24 hours') AS last_24h,
              count(*) FILTER (
                WHERE appointment_id IS NULL
                  AND coalesce(correlation_status, '') NOT IN ('split', 'discarded')
              )                                                       AS unmatched
         FROM conversations
        WHERE source = 'pocket'`,
    );
    const r = rows[0];
    const lastRecordingAt = r?.last_recording_at ?? null;

    res.json({
      configured: isPocketConfigured(),
      webhookVerified: isPocketWebhookConfigured(),
      // Configured AND actually running. Reporting config alone once claimed the
      // backstop was ON while SCHEDULER_ENABLED decided whether it ever ticked.
      pollEnabled: poll.enabled && isSchedulerEnabled(),
      pollLookbackDays: poll.lookbackDays,
      lastRecordingAt,
      recordingsLast24h: Number(r?.last_24h ?? 0),
      unmatched: Number(r?.unmatched ?? 0),
      // A week is roughly "at least one working day of sessions ago" for this
      // practice — long enough not to cry wolf over a quiet weekend.
      healthy: !!lastRecordingAt && Date.now() - new Date(lastRecordingAt).getTime() < 7 * 86_400_000,
    });
  } catch (err) {
    logError('pocket.status', 'status query failed', err);
    res.status(500).json({ error: 'internal error' });
  }
});
