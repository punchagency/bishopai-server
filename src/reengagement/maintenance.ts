import { pool } from '../db/pool';
import { logEvent } from '../observability/logger';

// WF3 maintenance reactivation: identify established clients who've gone quiet —
// 2+ completed sessions (so this is a maintenance-phase client, not a one-visit
// conversion case — those go to the first-appointment track), whose most recent
// completed session is older than the gap threshold and who have no upcoming
// booking — and enroll them into the maintenance cadence (mirrors the cancelled
// 7d/14d track). Deactivation at 5 months is handled by the shared cadence.
//
// Identification (this pass) is separate from sending: it seeds `maintenance`
// leads that the hourly reengagement runner then nudges. Runs on a daily cron.

// How long since the last session before a client counts as maintenance-phase.
const GAP_DAYS = Number(process.env.MAINTENANCE_GAP_DAYS ?? 90);

export interface MaintenanceResult {
  scanned: number; // clients past the session-gap with no upcoming booking
  enrolled: number; // new maintenance leads created
  skipped: number; // already had an active lead (any track) — not double-enrolled
}

interface EligibleClient {
  id: string;
  email: string;
  name: string | null;
  last_session: string;
}

/**
 * Scan for maintenance-phase clients and enroll the ones not already in an
 * active sequence. Idempotent across runs: a client with any active lead (their
 * email, status not closed/booked) is skipped, so a daily re-run never stacks
 * duplicate maintenance leads or fights an in-flight cadence.
 */
export async function enrollMaintenanceClients(): Promise<MaintenanceResult> {
  const { rows } = await pool.query<EligibleClient>(
    `SELECT c.id, c.email, c.name, max(a.ends_at) AS last_session
       FROM clients c
       JOIN appointments a ON a.client_id = c.id AND a.status = 'completed'
      WHERE c.email IS NOT NULL
      GROUP BY c.id, c.email, c.name
     HAVING count(*) >= 2
        AND max(a.ends_at) < now() - ($1 || ' days')::interval
        AND NOT EXISTS (
              SELECT 1 FROM appointments f
               WHERE f.client_id = c.id
                 AND f.starts_at > now()
                 AND f.status <> 'cancelled'
            )`,
    [String(GAP_DAYS)],
  );

  let enrolled = 0;
  let skipped = 0;

  for (const c of rows) {
    const db = await pool.connect();
    try {
      await db.query('BEGIN');

      // Already being re-engaged on any active track? Don't double-enroll.
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
        `INSERT INTO leads (source, email, status) VALUES ('maintenance', $1, 'maintenance') RETURNING id`,
        [c.email],
      );
      const lastSession = new Date(c.last_session).toISOString().slice(0, 10);
      await db.query(
        `INSERT INTO lead_activity (lead_id, type, detail) VALUES ($1, 'maintenance', $2)`,
        [ins.rows[0].id, `maintenance re-engagement — ${c.name ?? 'client'}, last session ${lastSession}`],
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

  logEvent('info', 'reengagement.maintenance', 'maintenance enrollment pass complete', {
    gap_days: GAP_DAYS,
    scanned: rows.length,
    enrolled,
    skipped,
  });
  return { scanned: rows.length, enrolled, skipped };
}
