import { pool } from '../db/pool';
import { logEvent, logError } from '../observability/logger';
import { sendEmail } from '../integrations/outlook';
import { nextCadenceAction, type LeadState } from './cadence';

// WF3 cadence pass (run by the scheduler): evaluate every active lead, send the
// due step (dry-run until Outlook is configured), and advance its sequence
// state. Cold leads past the deactivation window are closed out. Pure decision
// logic lives in cadence.ts; this is the DB + send side.

export interface ReengagementResult {
  scanned: number;
  sent: number;
  deactivated: number;
  skipped: number; // due to send but no email on file
}

interface LeadRow {
  id: string;
  email: string | null;
  status: string;
  sequence_state: { sent?: string[] } | null;
  last_touch: string | null;
  created_at: string;
}

export async function runReengagement(now: Date = new Date()): Promise<ReengagementResult> {
  const { rows } = await pool.query<LeadRow>(
    `SELECT id, email, status, sequence_state, last_touch, created_at
       FROM leads
      WHERE status NOT IN ('closed', 'booked')`,
  );

  let sent = 0;
  let deactivated = 0;
  let skipped = 0;

  for (const row of rows) {
    const state: LeadState = {
      status: row.status,
      created_at: new Date(row.created_at),
      last_touch: row.last_touch ? new Date(row.last_touch) : null,
      sentSteps: row.sequence_state?.sent ?? [],
    };
    const action = nextCadenceAction(state, now);

    try {
      if (action.kind === 'deactivate') {
        await pool.query(`UPDATE leads SET status = 'closed' WHERE id = $1`, [row.id]);
        deactivated++;
      } else if (action.kind === 'send') {
        if (!row.email) {
          skipped++;
          continue;
        }
        await sendEmail({ to: row.email, subject: action.subject, body: action.body });
        await pool.query(
          `INSERT INTO messages (lead_id, channel, body, sent_at, status)
                VALUES ($1, 'email', $2, now(), 'sent')`,
          [row.id, `${action.subject}\n\n${action.body}`],
        );
        // Advance sequence state + status, and stamp last_touch.
        const nextStatus = row.status === 'cancelled' ? 'cancelled' : row.status === 'new' ? 'contacted' : 'nurturing';
        await pool.query(
          `UPDATE leads
              SET sequence_state = jsonb_set(
                    coalesce(sequence_state, '{}'::jsonb), '{sent}',
                    coalesce(sequence_state->'sent', '[]'::jsonb) || to_jsonb($2::text)),
                  last_touch = now(),
                  status = $3
            WHERE id = $1`,
          [row.id, action.step, nextStatus],
        );
        sent++;
      }
    } catch (err) {
      logError('reengagement.run', 'cadence step failed', err, { lead_id: row.id, action: action.kind });
    }
  }

  logEvent('info', 'reengagement.run', 'cadence pass complete', {
    scanned: rows.length,
    sent,
    deactivated,
    skipped,
  });
  return { scanned: rows.length, sent, deactivated, skipped };
}
