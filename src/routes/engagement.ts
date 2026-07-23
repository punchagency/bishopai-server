import { Router } from 'express';
import { z } from 'zod';
import { pool } from '../db/pool';
import { logError, logEvent } from '../observability/logger';
import { nextCadenceAction, type LeadState } from '../reengagement/cadence';
import { runReengagement } from '../reengagement/runner';
import { getOutlookConnection } from '../integrations/outlook';
import { recordAudit } from '../audit/log';

// WF3 dashboard surface: the lead list with each lead's next cadence step, the
// live site-activity feed (lead_activity), and Nicole's actions — stop the
// automation, mark a reply, or run the cadence pass now. Guarded by requireAuth
// (mounted in server.ts) like the rest of the dashboard API.
export const engagementRouter = Router();

const isUuid = (id: string) => z.uuid().safeParse(id).success;

// GET /engagement/leads — leads + computed next action + activity summary.
engagementRouter.get('/leads', async (_req, res) => {
  try {
    const r = await pool.query(
      `SELECT l.id, l.source, l.email, l.status, l.sequence_state, l.last_touch, l.created_at,
              (SELECT count(*) FROM lead_activity a WHERE a.lead_id = l.id) AS activity_count,
              (SELECT max(a.occurred_at) FROM lead_activity a WHERE a.lead_id = l.id) AS last_activity
         FROM leads l
     ORDER BY l.updated_at DESC`,
    );
    const now = new Date();
    const leads = r.rows.map((row) => {
      const state: LeadState = {
        status: row.status,
        created_at: new Date(row.created_at),
        last_touch: row.last_touch ? new Date(row.last_touch) : null,
        sentSteps: row.sequence_state?.sent ?? [],
      };
      const action = nextCadenceAction(state, now);
      return {
        ...row,
        sent_steps: row.sequence_state?.sent ?? [],
        next_action: action.kind,
        next_step: action.kind === 'send' ? action.step : null,
      };
    });
    const outlook = await getOutlookConnection();
    res.json({ outlook_configured: outlook.connected, outlook_sender: outlook.sender, leads });
  } catch (err) {
    logError('engagement.leads', 'leads query failed', err);
    res.status(500).json({ error: 'internal error' });
  }
});

// GET /engagement/activity — recent site/lead activity feed.
engagementRouter.get('/activity', async (_req, res) => {
  try {
    const r = await pool.query(
      `SELECT a.id, a.type, a.path, a.detail, a.occurred_at, l.email AS lead_email
         FROM lead_activity a
    LEFT JOIN leads l ON l.id = a.lead_id
     ORDER BY a.occurred_at DESC
        LIMIT 30`,
    );
    res.json({ activity: r.rows });
  } catch (err) {
    logError('engagement.activity', 'activity query failed', err);
    res.status(500).json({ error: 'internal error' });
  }
});

// POST /engagement/leads/:id/stop — take a lead out of the automation.
engagementRouter.post('/leads/:id/stop', async (req, res) => {
  if (!isUuid(req.params.id)) return res.status(404).json({ error: 'not found' });
  try {
    const r = await pool.query(`UPDATE leads SET status = 'closed' WHERE id = $1 RETURNING id, status`, [
      req.params.id,
    ]);
    if (r.rowCount === 0) return res.status(404).json({ error: 'not found' });
    await recordAudit({ entityType: 'lead', entityId: req.params.id, action: 'lead.stopped', actor: 'nicole', summary: 'Lead removed from the re-engagement automation' });
    return res.json(r.rows[0]);
  } catch (err) {
    logError('engagement.stop', 'stop failed', err, { id: req.params.id });
    return res.status(500).json({ error: 'internal error' });
  }
});

// POST /engagement/leads/:id/reply — a lead replied: stop automation + flag it
// to Nicole (records a 'reply' activity). Would be driven by Graph inbox polling.
engagementRouter.post('/leads/:id/reply', async (req, res) => {
  if (!isUuid(req.params.id)) return res.status(404).json({ error: 'not found' });
  const detail = typeof req.body?.detail === 'string' ? req.body.detail.slice(0, 500) : null;
  const db = await pool.connect();
  try {
    await db.query('BEGIN');
    const r = await db.query(`UPDATE leads SET status = 'replied' WHERE id = $1 RETURNING id, status`, [
      req.params.id,
    ]);
    if (r.rowCount === 0) {
      await db.query('ROLLBACK');
      return res.status(404).json({ error: 'not found' });
    }
    await db.query(`INSERT INTO lead_activity (lead_id, type, detail) VALUES ($1, 'reply', $2)`, [
      req.params.id,
      detail,
    ]);
    await db.query('COMMIT');
    return res.json(r.rows[0]);
  } catch (err) {
    await db.query('ROLLBACK');
    logError('engagement.reply', 'reply failed', err, { id: req.params.id });
    return res.status(500).json({ error: 'internal error' });
  } finally {
    db.release();
  }
});

// POST /engagement/run — run the cadence pass now (the scheduler runs it on a
// cron; this lets Nicole/dev trigger it on demand).
engagementRouter.post('/run', async (_req, res) => {
  try {
    const result = await runReengagement();
    logEvent('info', 'engagement.run', 'manual cadence run', { ...result });
    await recordAudit({ entityType: 'lead', entityId: 'cadence', action: 'cadence.run', actor: 'nicole', summary: `Re-engagement cadence run — ${result.sent ?? 0} sent, ${result.deactivated ?? 0} deactivated`, metadata: { ...result } });
    return res.json(result);
  } catch (err) {
    logError('engagement.run', 'manual run failed', err);
    return res.status(500).json({ error: 'internal error' });
  }
});
