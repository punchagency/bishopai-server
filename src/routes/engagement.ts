import { Router } from 'express';
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { getDatabase } from '../db/index.js';
import { logError, logEvent } from '../observability/logger';
import { nextCadenceAction, type LeadState } from '../reengagement/cadence';
import { runReengagement } from '../reengagement/runner';
import { getOutlookConnection } from '../integrations/outlook';
import { recordAudit } from '../audit/log';
import { isDocId } from '../db/ids.js';

// WF3 dashboard surface: the lead list with each lead's next cadence step, the
// live site-activity feed (lead_activity), and Nicole's actions — stop the
// automation, mark a reply, or run the cadence pass now. Guarded by requireAuth
// (mounted in server.ts) like the rest of the dashboard API.
export const engagementRouter = Router();

// Path ids are Firestore document ids, not uuids — the port mints deterministic
// ones (`appt_…`, `client_…`, `${clientId}__${nameKey}`). Gating on uuid shape
// here would 404 every PB-synced record; see isDocId.
const isUuid = isDocId;

// GET /engagement/leads — leads + computed next action + activity summary.
engagementRouter.get('/leads', async (_req, res) => {
  try {
    const db = getDatabase();
    const all = await db.reengagement.listLeads();
    // `ORDER BY l.updated_at DESC`, in memory — a solo practice's lead list is
    // small, and sorting here avoids excluding leads that predate the column
    // (Firestore drops documents missing an orderBy field entirely, §3.5).
    const rows = all.sort((a, b) => (b.updated_at ?? '').localeCompare(a.updated_at ?? ''));
    // Replaces the two correlated subqueries — see summarizeActivity.
    const activity = await db.reengagement.summarizeActivity(rows.map((l) => l.id));

    const now = new Date();
    const leads = rows.map((row) => {
      const state: LeadState = {
        status: row.status,
        created_at: new Date(row.created_at),
        last_touch: row.last_touch ? new Date(row.last_touch) : null,
        sentSteps: row.sequence_state?.sent ?? [],
        cadenceCancelled: (row.cadence_cancelled_at ?? null) !== null,
      };
      const action = nextCadenceAction(state, now);
      const summary = activity.get(row.id) ?? { count: 0, last_activity: null };
      return {
        id: row.id,
        source: row.source ?? null,
        email: row.email,
        status: row.status,
        sequence_state: row.sequence_state,
        last_touch: row.last_touch ?? null,
        created_at: row.created_at,
        cadence_cancelled_at: row.cadence_cancelled_at ?? null,
        activity_count: summary.count,
        last_activity: summary.last_activity,
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
    const db = getDatabase();
    const rows = await db.reengagement.listActivityFeed(30);

    // `LEFT JOIN leads` for the address. Parallel gets by known ref (§3.4), one
    // per distinct lead — anonymous rows have no lead_id and simply get null.
    const leadIds = [...new Set(rows.map((a) => a.lead_id).filter((id): id is string => !!id))];
    const emails = new Map(
      await Promise.all(
        leadIds.map(async (id) => {
          const lead = await db.reengagement.findLeadById(id);
          return [id, lead?.email ?? null] as const;
        }),
      ),
    );

    res.json({
      activity: rows.map((a) => ({
        id: a.id,
        type: a.type,
        path: a.path ?? null,
        detail: a.detail ?? null,
        occurred_at: a.occurred_at,
        lead_email: a.lead_id ? (emails.get(a.lead_id) ?? null) : null,
      })),
    });
  } catch (err) {
    logError('engagement.activity', 'activity query failed', err);
    res.status(500).json({ error: 'internal error' });
  }
});

// POST /engagement/leads/:id/stop — take a lead out of the automation.
engagementRouter.post('/leads/:id/stop', async (req, res) => {
  if (!isUuid(req.params.id)) return res.status(404).json({ error: 'not found' });
  try {
    const db = getDatabase();
    const lead = await db.reengagement.findLeadById(req.params.id);
    if (!lead) return res.status(404).json({ error: 'not found' });
    await db.reengagement.saveLead({ ...lead, status: 'closed', updated_at: new Date().toISOString() });
    await recordAudit({ entityType: 'lead', entityId: req.params.id, action: 'lead.stopped', actor: 'nicole', summary: 'Lead removed from the re-engagement automation' });
    return res.json({ id: lead.id, status: 'closed' });
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
  try {
    const now = new Date().toISOString();
    // Status flip + activity row land together or not at all — see
    // markLeadReplied for why that pairing matters.
    const lead = await getDatabase().reengagement.markLeadReplied(req.params.id, {
      id: randomUUID(),
      lead_id: req.params.id,
      type: 'reply',
      path: null,
      detail,
      occurred_at: now,
      created_at: now,
    });
    if (!lead) return res.status(404).json({ error: 'not found' });
    return res.json({ id: lead.id, status: lead.status });
  } catch (err) {
    logError('engagement.reply', 'reply failed', err, { id: req.params.id });
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
