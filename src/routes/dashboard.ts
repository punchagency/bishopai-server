import { Router } from 'express';
import { pool } from '../db/pool';
import { logError } from '../observability/logger';
import { recentActivity } from '../audit/log';
import { listUnprocessed } from '../session/unprocessed';

// Consolidated data for the dashboard Overview: headline counts, a recent
// activity feed (pulls from audit_log so it's unified with the Activity view),
// and the upcoming appointments. One round-trip so the landing view paints fast.
export const dashboardRouter = Router();

dashboardRouter.get('/overview', async (_req, res) => {
  try {
    const [stats, auditRows, upcoming, unprocessed] = await Promise.all([
      pool.query(
        `SELECT
           (SELECT count(*) FROM appointments a
             WHERE EXISTS (SELECT 1 FROM appointment_sheets s
                            WHERE s.appointment_id = a.id AND s.status IN ('draft','in_review'))
                OR EXISTS (SELECT 1 FROM protocols p
                            WHERE p.appointment_id = a.id AND p.status IN ('draft','in_review'))) AS awaiting_review,
           (SELECT count(*) FROM conversations WHERE appointment_id IS NULL AND coalesce(correlation_status, '') <> 'split') AS unmatched,
           (SELECT count(*) FROM conversations
             WHERE appointment_id IS NOT NULL
               AND extraction_status IN ('pending','processing','failed'))                AS processing,
           (SELECT count(*) FROM appointments  WHERE starts_at > now())                   AS upcoming,
           (SELECT count(*) FROM approvals     WHERE approved_at::date = now()::date)     AS approved_today,
           (SELECT count(*) FROM refills
             WHERE status = 'pending' AND due_date IS NOT NULL AND (due_date - current_date) <= 14) AS refills_due,
           (SELECT count(*) FROM leads   WHERE status NOT IN ('closed','booked','replied')) AS leads_active,
           (SELECT count(*) FROM outbound_emails WHERE state = 'pending')                AS engagement_pending,
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
      // Counted through the same function the list uses, not a SQL lookalike.
      // Whether a note is "blank" is a judgement across eight fields of three
      // shapes (see countFindings); a second approximation of it here would
      // drift from the list and put a badge on a section with nothing in it.
      listUnprocessed(),
    ]);

    const activity = auditRows.map((r) => ({
      ts: r.created_at,
      kind: r.action.includes('approved') || r.action.includes('captured') ? 'approval' : 'conversation',
      text: r.summary,
    }));

    // `awaiting_review` counts every appointment holding a draft, which now
    // over-counts by exactly the sessions moved into "Not extracted" — a badge
    // promising four drafts that the list then declines to show is worse than
    // no badge. Subtract the ones that actually carry a draft document; a row
    // still queued or mid-extraction has none and was never in that count.
    const movedOut = unprocessed.filter((u) => u.sheet_id).length;
    const awaiting = Math.max(0, Number(stats.rows[0].awaiting_review) - movedOut);

    res.json({
      stats: {
        ...stats.rows[0],
        awaiting_review: awaiting,
        unprocessed: unprocessed.length,
      },
      recent_activity: activity,
      upcoming: upcoming.rows,
    });
  } catch (err) {
    logError('dashboard.overview', 'overview query failed', err);
    res.status(500).json({ error: 'internal error' });
  }
});
