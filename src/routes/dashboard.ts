import { Router } from 'express';
import { pool } from '../db/pool';
import { logError } from '../observability/logger';
import { recentActivity } from '../audit/log';

// Consolidated data for the dashboard Overview: headline counts, a recent
// activity feed (pulls from audit_log so it's unified with the Activity view),
// and the upcoming appointments. One round-trip so the landing view paints fast.
export const dashboardRouter = Router();

dashboardRouter.get('/overview', async (_req, res) => {
  try {
    const [stats, auditRows, upcoming] = await Promise.all([
      pool.query(
        `SELECT
           (SELECT count(*) FROM appointments a
             WHERE EXISTS (SELECT 1 FROM appointment_sheets s
                            WHERE s.appointment_id = a.id AND s.status IN ('draft','in_review'))
                OR EXISTS (SELECT 1 FROM protocols p
                            WHERE p.appointment_id = a.id AND p.status IN ('draft','in_review'))) AS awaiting_review,
           (SELECT count(*) FROM conversations WHERE appointment_id IS NULL)              AS unmatched,
           (SELECT count(*) FROM appointments  WHERE starts_at > now())                   AS upcoming,
           (SELECT count(*) FROM approvals     WHERE approved_at::date = now()::date)     AS approved_today,
           (SELECT count(*) FROM refills
             WHERE status IN ('pending','notified','snoozed'))                            AS refills_due,
           (SELECT count(*) FROM leads   WHERE status IN ('new','contacted','nurturing')) AS leads_active,
           (SELECT count(*) FROM checkout WHERE status NOT IN ('CLOSED','CHARGE_FAILED')) AS checkouts_awaiting`,
      ),
      recentActivity(12),
      pool.query(
        `SELECT a.starts_at, a.status, c.name AS client_name
           FROM appointments a
      LEFT JOIN clients c ON c.id = a.client_id
          WHERE a.starts_at > now()
       ORDER BY a.starts_at ASC
          LIMIT 8`,
      ),
    ]);

    const activity = auditRows.map((r) => ({
      ts: r.created_at,
      kind: r.action.includes('approved') || r.action.includes('captured') ? 'approval' : 'conversation',
      text: r.summary,
    }));

    res.json({
      stats: stats.rows[0],
      recent_activity: activity,
      upcoming: upcoming.rows,
    });
  } catch (err) {
    logError('dashboard.overview', 'overview query failed', err);
    res.status(500).json({ error: 'internal error' });
  }
});
