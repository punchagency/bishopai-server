import type { Job } from '../types';
import { pool } from '../../db/pool';
import { logEvent } from '../../observability/logger';
import { triggerPocketPoll } from '../../integrations/pocket/poller';
import { isPocketConfigured } from '../../integrations/pocket/config';

// Appointment-end trigger for Pocket polling.
//
// Every 5 minutes, checks whether any appointment ended in the last 5 minutes
// that doesn't yet have a matching Pocket conversation. If so, fires a delayed
// poll — Pocket typically finishes transcription ~1–2 min after the recording
// stops, so the 90s delay gives it breathing room.
//
// This catches the case where:
//   - PB's session-complete webhook never fires (not configured, or Nicole
//     just lets the appointment run its course without marking it)
//   - The recording exists in Pocket but the cron backstop hasn't ticked yet

export const pocketPostSessionJob: Job = {
  name: 'pocket.post_session',
  schedule: process.env.CRON_POCKET_POST_SESSION ?? '*/5 * * * *',
  async run() {
    if (!isPocketConfigured()) return;

    const { rows } = await pool.query<{ appointment_id: string }>(
      `SELECT a.id AS appointment_id
         FROM appointments a
        WHERE a.ends_at BETWEEN now() - interval '5 minutes' AND now()
          AND NOT EXISTS (
            SELECT 1 FROM conversations c
             WHERE c.appointment_id = a.id
               AND c.source = 'pocket'
               AND c.transcript IS NOT NULL
               AND c.transcript <> ''
          )`,
    );

    if (rows.length > 0) {
      logEvent('info', 'pocket.post_session', 'appointments ended without transcript — triggering poll', {
        count: rows.length,
        appointment_ids: rows.map((r) => r.appointment_id),
      });
      // 90s delay: give Pocket time to finish transcription
      setTimeout(() => void triggerPocketPoll('appointment_ended'), 90_000);
    }
  },
};
