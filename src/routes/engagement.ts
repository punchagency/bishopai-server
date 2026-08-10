import { Router } from 'express';
import { z } from 'zod';
import { pool } from '../db/pool';
import { logError, logEvent } from '../observability/logger';
import { nextCadenceAction, nextScheduledStep, trackNameFor, type LeadState } from '../reengagement/cadence';
import { runReengagement, sendIndividualLeadEmail } from '../reengagement/runner';
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
              l.cadence_cancelled_at,
              (SELECT count(*) FROM lead_activity a WHERE a.lead_id = l.id) AS activity_count,
              (SELECT max(a.occurred_at) FROM lead_activity a WHERE a.lead_id = l.id) AS last_activity
         FROM leads l
     ORDER BY l.updated_at DESC`,
    );
    // Batch-fetch all template overrides in a single query so we don't make
    // one DB round-trip per lead when resolving next_subject and next_body.
    const ovr = await pool.query<{ track: string; step: string; subject: string; body: string }>(  
      `SELECT track, step, subject, body FROM email_templates`,
    );
    const ovrMap = new Map(ovr.rows.map((o) => [`${o.track}:${o.step}`, o]));

    const now = new Date();
    const leads = r.rows.map((row) => {
      const state: LeadState = {
        status: row.status,
        created_at: new Date(row.created_at),
        last_touch: row.last_touch ? new Date(row.last_touch) : null,
        sentSteps: row.sequence_state?.sent ?? [],
        cadenceCancelled: row.cadence_cancelled_at !== null,
      };
      const action = nextCadenceAction(state, now);
      const scheduled = nextScheduledStep(state, now);
      const trackName = trackNameFor(row.status);
      const draft = scheduled ? row.sequence_state?.drafts?.[scheduled.step] : null;
      const override = scheduled ? ovrMap.get(`${trackName}:${scheduled.step}`) : null;
      const next_subject = draft?.subject ?? override?.subject ?? scheduled?.subject ?? null;
      const next_body = draft?.body ?? override?.body ?? scheduled?.body ?? null;
      return {
        ...row,
        sent_steps: row.sequence_state?.sent ?? [],
        next_action: action.kind,
        next_step: action.kind === 'send' ? action.step : (scheduled?.step ?? null),
        next_subject,
        next_body,
        next_send_at: scheduled?.sendAt?.toISOString() ?? null,
        is_custom_draft: !!draft,
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

// POST /engagement/leads/:id/send — send an email immediately to this lead
// (optionally with custom subject and body edited by Nicole before sending).
const sendPayload = z.object({
  step: z.string().optional(),
  subject: z.string().min(1).max(500).optional(),
  body: z.string().min(1).max(5000).optional(),
});
engagementRouter.post('/leads/:id/send', async (req, res) => {
  if (!isUuid(req.params.id)) return res.status(404).json({ error: 'not found' });
  const parsed = sendPayload.safeParse(req.body ?? {});
  if (!parsed.success) {
    return res.status(400).json({ error: 'invalid payload', details: parsed.error.flatten() });
  }
  try {
    const result = await sendIndividualLeadEmail(req.params.id, parsed.data);
    if (!result.ok) {
      return res.status(400).json({ error: result.error ?? 'Failed to send email' });
    }
    await recordAudit({
      entityType: 'lead',
      entityId: req.params.id,
      action: 'lead.email_sent',
      actor: 'nicole',
      summary: `Email sent to lead — ${result.subject}`,
      metadata: { step: result.step, subject: result.subject },
    });
    return res.json(result);
  } catch (err) {
    logError('engagement.send_individual', 'send failed', err, { id: req.params.id });
    return res.status(500).json({ error: 'internal error' });
  }
});

// PUT /engagement/leads/:id/draft — save a customized draft for a lead's upcoming email
const draftPayload = z.object({
  step: z.string().min(1).max(100),
  subject: z.string().min(1).max(500),
  body: z.string().min(1).max(5000),
});
engagementRouter.put('/leads/:id/draft', async (req, res) => {
  if (!isUuid(req.params.id)) return res.status(404).json({ error: 'not found' });
  const parsed = draftPayload.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'invalid payload', details: parsed.error.flatten() });
  }
  const { step, subject, body } = parsed.data;
  try {
    const r = await pool.query(
      `UPDATE leads
          SET sequence_state = jsonb_set(
                coalesce(sequence_state, '{}'::jsonb),
                ARRAY['drafts', $2::text],
                jsonb_build_object('subject', $3::text, 'body', $4::text, 'updated_at', now()::text)
              )
        WHERE id = $1
    RETURNING id`,
      [req.params.id, step, subject, body],
    );
    if (r.rowCount === 0) return res.status(404).json({ error: 'not found' });
    return res.json({ lead_id: req.params.id, step, subject, body, is_custom_draft: true });
  } catch (err) {
    logError('engagement.draft', 'draft save failed', err, { id: req.params.id });
    return res.status(500).json({ error: 'internal error' });
  }
});

// DELETE /engagement/leads/:id/draft/:step — clear custom draft for this lead's step
engagementRouter.delete('/leads/:id/draft/:step', async (req, res) => {
  if (!isUuid(req.params.id)) return res.status(404).json({ error: 'not found' });
  const { id, step } = req.params;
  try {
    const r = await pool.query(
      `UPDATE leads
          SET sequence_state = sequence_state #- ARRAY['drafts', $2::text]
        WHERE id = $1
    RETURNING id`,
      [id, step],
    );
    if (r.rowCount === 0) return res.status(404).json({ error: 'not found' });
    return res.json({ lead_id: id, step, reset: true });
  } catch (err) {
    logError('engagement.draft_delete', 'draft delete failed', err, { id });
    return res.status(500).json({ error: 'internal error' });
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

// GET /engagement/queue — all leads with a pending send, ordered by when the
// step fires, with full subject + body resolved against templates. Used by the
// Queue tab so Nicole can scan and cancel without opening each lead.
engagementRouter.get('/queue', async (_req, res) => {
  try {
    const r = await pool.query(
      `SELECT l.id, l.email, l.status, l.sequence_state, l.last_touch, l.created_at, l.cadence_cancelled_at
         FROM leads l
        WHERE l.status NOT IN ('closed', 'booked', 'replied')`,
    );
    // Batch-fetch all overrides up front — one DB hit instead of N.
    const ovr = await pool.query<{ track: string; step: string; subject: string; body: string }>(
      `SELECT track, step, subject, body FROM email_templates`,
    );
    const ovrMap = new Map(ovr.rows.map((o) => [`${o.track}:${o.step}`, o]));

    const now = new Date();
    const items: unknown[] = [];
    for (const row of r.rows) {
      const state: LeadState = {
        status: row.status,
        created_at: new Date(row.created_at),
        last_touch: row.last_touch ? new Date(row.last_touch) : null,
        sentSteps: row.sequence_state?.sent ?? [],
        cadenceCancelled: row.cadence_cancelled_at !== null,
      };
      const scheduled = nextScheduledStep(state, now);
      if (!scheduled) continue;
      const trackName = trackNameFor(row.status);
      const draft = row.sequence_state?.drafts?.[scheduled.step];
      const override = ovrMap.get(`${trackName}:${scheduled.step}`);
      const subject = draft?.subject ?? override?.subject ?? scheduled.subject;
      const body = draft?.body ?? override?.body ?? scheduled.body;
      items.push({
        lead_id: row.id,
        email: row.email,
        status: row.status,
        track: trackName,
        step: scheduled.step,
        subject,
        body,
        send_at: scheduled.sendAt.toISOString(),
        is_custom_draft: !!draft,
      });
    }
    // Sort by send_at ascending (soonest first).
    (items as { send_at: string }[]).sort((a, b) => a.send_at.localeCompare(b.send_at));
    return res.json({ queue: items });
  } catch (err) {
    logError('engagement.queue', 'queue query failed', err);
    return res.status(500).json({ error: 'internal error' });
  }
});

// GET /engagement/sent — paginated send log, newest first.
engagementRouter.get('/sent', async (req, res) => {
  const rawLimit = Number(req.query.limit);
  const rawOffset = Number(req.query.offset);
  const limit = Math.min(Number.isFinite(rawLimit) && rawLimit > 0 ? rawLimit : 50, 200);
  const offset = Number.isFinite(rawOffset) && rawOffset >= 0 ? rawOffset : 0;
  try {
    const { rows } = await pool.query(
      `SELECT s.id, s.lead_id, s.track, s.step, s.to_email, s.subject, s.body,
              s.dry_run, s.ok, s.error, s.sent_at
         FROM email_send_log s
        ORDER BY s.sent_at DESC
        LIMIT $1 OFFSET $2`,
      [limit, offset],
    );
    const { rows: total } = await pool.query<{ count: string }>(`SELECT count(*) FROM email_send_log`);
    return res.json({ sent: rows, total: Number(total[0]?.count ?? 0) });
  } catch (err) {
    logError('engagement.sent', 'sent log query failed', err);
    return res.status(500).json({ error: 'internal error' });
  }
});

// GET /engagement/leads/:id/history — per-lead send log, newest first.
engagementRouter.get('/leads/:id/history', async (req, res) => {
  if (!isUuid(req.params.id)) return res.status(404).json({ error: 'not found' });
  try {
    const { rows } = await pool.query(
      `SELECT id, track, step, to_email, subject, body, dry_run, ok, error, sent_at
         FROM email_send_log
        WHERE lead_id = $1
        ORDER BY sent_at DESC
        LIMIT 100`,
      [req.params.id],
    );
    return res.json({ history: rows });
  } catch (err) {
    logError('engagement.history', 'history query failed', err);
    return res.status(500).json({ error: 'internal error' });
  }
});
