import { pool } from '../db/pool';
import { logEvent } from '../observability/logger';

// WF3 first-appointment conversion: a client who came exactly once and hasn't
// rebooked. Treated like the cancelled flow (7d/14d), with an incentive on the
// 14-day step to encourage them to return or commit to a plan. Disjoint from the
// maintenance track by definition — maintenance requires 2+ completed sessions,
// this requires exactly one — so a client can't land on both.
//
// Identification (this pass) seeds `first_appointment` leads that the hourly
// reengagement runner then nudges. Runs on a daily cron.

// How long after the single session before we nudge — gives the client a few
// days to rebook on their own first.
const AFTER_DAYS = Number(process.env.FIRST_APPT_AFTER_DAYS ?? 3);

export interface FirstAppointmentResult {
  scanned: number; // one-session clients past the wait with no rebooking
  enrolled: number;
  skipped: number; // already had an active lead — not double-enrolled
}

interface EligibleClient {
  id: string;
  email: string;
  name: string | null;
  first_session: string;
}

/**
 * Scan for one-and-done clients and enroll the ones not already in an active
 * sequence. Idempotent across runs (skips any client with an active lead), so a
 * daily re-run never stacks duplicates or fights an in-flight cadence.
 */
export async function enrollFirstAppointmentClients(): Promise<FirstAppointmentResult> {
  const { rows } = await pool.query<EligibleClient>(
    `SELECT c.id, c.email, c.name, max(a.ends_at) AS first_session
       FROM clients c
       JOIN appointments a ON a.client_id = c.id AND a.status = 'completed'
      WHERE c.email IS NOT NULL
      GROUP BY c.id, c.email, c.name
     HAVING count(*) = 1
        AND max(a.ends_at) < now() - ($1 || ' days')::interval
        AND NOT EXISTS (
              SELECT 1 FROM appointments f
               WHERE f.client_id = c.id
                 AND f.starts_at > now()
                 AND f.status <> 'cancelled'
            )`,
    [String(AFTER_DAYS)],
  );

  let enrolled = 0;
  let skipped = 0;

  for (const c of rows) {
    const db = await pool.connect();
    try {
      await db.query('BEGIN');

      const active = await db.query<{ id: string }>(
        `SELECT id FROM leads
          WHERE lower(email) = lower($1) AND status NOT IN ('closed', 'booked')
          LIMIT 1`,
        [c.email],
      );
      if (active.rowCount) {
        await db.query('COMMIT');
        skipped++;
        continue;
      }

      const ins = await db.query<{ id: string }>(
        `INSERT INTO leads (source, email, status) VALUES ('first_appointment', $1, 'first_appointment') RETURNING id`,
        [c.email],
      );
      const firstSession = new Date(c.first_session).toISOString().slice(0, 10);
      await db.query(
        `INSERT INTO lead_activity (lead_id, type, detail) VALUES ($1, 'first_appointment', $2)`,
        [ins.rows[0].id, `first-appointment conversion — ${c.name ?? 'client'}, first session ${firstSession}`],
      );
      await db.query('COMMIT');
      enrolled++;
    } catch (err) {
      await db.query('ROLLBACK');
      throw err;
    } finally {
      db.release();
    }
  }

  logEvent('info', 'reengagement.first_appointment', 'first-appointment enrollment pass complete', {
    after_days: AFTER_DAYS,
    scanned: rows.length,
    enrolled,
    skipped,
  });
  return { scanned: rows.length, enrolled, skipped };
}
