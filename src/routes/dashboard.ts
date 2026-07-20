import { Router } from 'express';
import { pool } from '../db/pool';
import { logError } from '../observability/logger';

// Consolidated data for the dashboard Overview: headline counts, a recent
// activity feed (assembled across approvals / conversations / drafts), and the
// upcoming appointments. One round-trip so the landing view paints fast.
export const dashboardRouter = Router();

dashboardRouter.get('/overview', async (_req, res) => {
  try {
    const [stats, activity, upcoming] = await Promise.all([
      pool.query(
        `SELECT
           -- Count SESSIONS, not documents. A sheet and a protocol are the same
           -- note approved together, so summing both counted every visit twice
           -- and left the badge disagreeing with the list it links to.
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
      pool.query(
        `SELECT ts, kind, text FROM (
             SELECT approved_at AS ts, 'approval' AS kind,
                    ('Approved ' || replace(type, '_', ' ')) AS text
               FROM approvals
             UNION ALL
             SELECT created_at AS ts, 'conversation' AS kind,
                    ('Bee conversation ' || coalesce(correlation_status, 'ingested')) AS text
               FROM conversations
             UNION ALL
             SELECT s.updated_at AS ts, 'draft' AS kind,
                    ('Session note drafted for ' || coalesce(c.name, 'a client')) AS text
               FROM appointment_sheets s
          LEFT JOIN clients c ON c.id = s.client_id
         ) feed
         WHERE ts IS NOT NULL
         ORDER BY ts DESC
         LIMIT 12`,
      ),
      pool.query(
        `SELECT a.starts_at, a.status, c.name AS client_name
           FROM appointments a
      LEFT JOIN clients c ON c.id = a.client_id
          WHERE a.starts_at > now()
       ORDER BY a.starts_at ASC
          LIMIT 8`,
      ),
    ]);
    res.json({
      stats: stats.rows[0],
      recent_activity: activity.rows,
      upcoming: upcoming.rows,
    });
  } catch (err) {
    logError('dashboard.overview', 'overview query failed', err);
    res.status(500).json({ error: 'internal error' });
  }
});
