import { Router } from 'express';
import { getDatabase } from '../db/index.js';
import { logError } from '../observability/logger';
import { recentActivity } from '../audit/log';

// Consolidated data for the dashboard Overview: headline counts, a recent
// activity feed (pulls from audit_log so it's unified with the Activity view),
// and the upcoming appointments. One round-trip so the landing view paints fast.
export const dashboardRouter = Router();

dashboardRouter.get('/overview', async (_req, res) => {
  try {
    const db = getDatabase();
    const now = new Date();
    const nowIso = now.toISOString();
    // `approved_at::date = now()::date` was a LOCAL-day comparison in pg. Kept
    // as a half-open range from local midnight so the tile still means "today",
    // not "the last 24 hours".
    const midnight = new Date(now);
    midnight.setHours(0, 0, 0, 0);
    const sinceIso = midnight.toISOString();

    // Seven count() aggregations — each reads zero documents, where the pg
    // version scanned seven tables. They are independent, so they go in
    // parallel alongside the activity feed and the upcoming list.
    const [
      awaitingReview,
      unmatched,
      upcomingCount,
      approvedToday,
      refillsDue,
      leadsActive,
      checkoutsAwaiting,
      auditRows,
      upcoming,
    ] = await Promise.all([
      db.sessionNotes.countAwaitingReview(),
      db.conversations.countUnmatched(),
      db.appointments.countUpcoming(nowIso),
      db.sessionNotes.countApprovalsSince(sinceIso),
      db.refills.countByStatuses(['pending', 'notified', 'snoozed']),
      db.reengagement.countLeadsByStatuses(['new', 'contacted', 'nurturing']),
      db.checkouts.countAwaiting(),
      recentActivity(12),
      db.appointments.listUpcoming(nowIso, 8),
    ]);

    const activity = auditRows.map((r) => ({
      ts: r.created_at,
      kind: r.action.includes('approved') || r.action.includes('captured') ? 'approval' : 'conversation',
      text: r.summary,
    }));

    res.json({
      stats: {
        awaiting_review: awaitingReview,
        unmatched,
        upcoming: upcomingCount,
        approved_today: approvedToday,
        refills_due: refillsDue,
        leads_active: leadsActive,
        checkouts_awaiting: checkoutsAwaiting,
      },
      recent_activity: activity,
      // `LEFT JOIN clients` becomes the denormalized client_name (§3.4).
      upcoming: upcoming.map((a) => ({
        starts_at: a.starts_at,
        status: a.status,
        client_name: a.client_name ?? null,
      })),
    });
  } catch (err) {
    logError('dashboard.overview', 'overview query failed', err);
    res.status(500).json({ error: 'internal error' });
  }
});
