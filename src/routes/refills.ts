import { Router } from 'express';
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { pool } from '../db/pool';
import { logError, logEvent } from '../observability/logger';
import { fullscriptDispensaryUrl } from '../integrations/fullscript';
import { computeAdherence, suggestedMonths } from '../refills/adherence';
import { recordAudit } from '../audit/log';
import { sendEmail, resolveOutlookAccess } from '../integrations/outlook';

// WF4 dashboard surface: the daily refill digest (who's running low, tiered by
// urgency) plus Nicole's actions — snooze, skip, or bulk-send the orders to
// Fullscript. Due dates are produced by the nightly projection (src/refills).
// No auth yet — consistent with the rest of the review surface.
export const refillsRouter = Router();

const isUuid = (id: string) => z.uuid().safeParse(id).success;

// Tier thresholds (days until run-out). Kept here so the API and UI agree.
const SOON_DAYS = 14;

// ---------------------------------------------------------------------------
// GET /refills/digest — open refills, soonest first, with days_left + tier.
// ---------------------------------------------------------------------------
refillsRouter.get('/digest', async (_req, res) => {
  try {
    const r = await pool.query(
      `SELECT rf.id, rf.due_date, rf.status,
              (rf.due_date - current_date) AS days_left,
              c.id AS client_id, c.name AS client_name,
              s.name AS supplement_name, s.dose, s.qty,
              o.fullscript_order_id AS fullscript_plan_id, o.invitation_url
         FROM refills rf
    LEFT JOIN clients c ON c.id = rf.client_id
    LEFT JOIN supplements s ON s.id = rf.supplement_id
    LEFT JOIN LATERAL (
           SELECT fullscript_order_id, invitation_url
             FROM refill_orders ro
            WHERE ro.refill_id = rf.id AND ro.status = 'sent'
         ORDER BY ro.sent_at DESC NULLS LAST
            LIMIT 1
         ) o ON true
        WHERE rf.status IN ('pending', 'notified', 'snoozed')
          AND rf.due_date IS NOT NULL
     ORDER BY rf.due_date ASC`,
    );
    const items = r.rows.map((row) => ({
      ...row,
      tier: tierFor(row.days_left),
    }));
    const outlookAccess = await resolveOutlookAccess().catch(() => null);
    const isConfigured = !!outlookAccess;
    res.json({ fullscript_configured: isConfigured, refills: items });
  } catch (err) {
    logError('refills.digest', 'digest query failed', err);
    res.status(500).json({ error: 'internal error' });
  }
});

function tierFor(daysLeft: number | null): 'overdue' | 'soon' | 'coming' {
  if (daysLeft === null) return 'coming';
  if (daysLeft < 0) return 'overdue';
  if (daysLeft <= SOON_DAYS) return 'soon';
  return 'coming';
}

// ---------------------------------------------------------------------------
// POST /refills/:id/snooze  — push the reminder out (default 14 days).
// POST /refills/:id/skip    — close it out for this cycle.
// ---------------------------------------------------------------------------
const snoozeSchema = z.object({ days: z.number().int().min(1).max(180).optional() });

refillsRouter.post('/:id/snooze', async (req, res) => {
  if (!isUuid(req.params.id)) return res.status(404).json({ error: 'not found' });
  const parsed = snoozeSchema.safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).json({ error: 'invalid payload' });
  const days = parsed.data.days ?? 14;
  try {
    const r = await pool.query(
      `UPDATE refills
          SET status = 'snoozed', due_date = coalesce(due_date, current_date) + ($2 || ' days')::interval
        WHERE id = $1
    RETURNING id, status, due_date`,
      [req.params.id, String(days)],
    );
    if (r.rowCount === 0) return res.status(404).json({ error: 'not found' });
    await recordAudit({ entityType: 'refill', entityId: req.params.id, action: 'refill.snoozed', actor: 'nicole', summary: `Refill snoozed ${days} days`, metadata: { days } });
    return res.json(r.rows[0]);
  } catch (err) {
    logError('refills.snooze', 'snooze failed', err, { id: req.params.id });
    return res.status(500).json({ error: 'internal error' });
  }
});

refillsRouter.post('/:id/skip', async (req, res) => {
  if (!isUuid(req.params.id)) return res.status(404).json({ error: 'not found' });
  try {
    const r = await pool.query(
      `UPDATE refills SET status = 'closed' WHERE id = $1 RETURNING id, status`,
      [req.params.id],
    );
    if (r.rowCount === 0) return res.status(404).json({ error: 'not found' });
    await recordAudit({ entityType: 'refill', entityId: req.params.id, action: 'refill.skipped', actor: 'nicole', summary: 'Refill closed for this cycle' });
    return res.json(r.rows[0]);
  } catch (err) {
    logError('refills.skip', 'skip failed', err, { id: req.params.id });
    return res.status(500).json({ error: 'internal error' });
  }
});

// ---------------------------------------------------------------------------
// POST /refills/orders — bulk-send selected refills to Fullscript. Creates one
// refill_orders row per refill (grouped under a batch_id), forwards them
// (dry-run until Fullscript is configured), records per-order outcome, and
// marks the sent refills 'notified'. Audited via the approvals table.
// ---------------------------------------------------------------------------
const bulkSchema = z.object({
  refill_ids: z.array(z.string()).min(1),
  approved_by: z.string().optional(),
});

refillsRouter.post('/orders', async (req, res) => {
  const parsed = bulkSchema.safeParse(req.body);
  if (!parsed.success || !parsed.data.refill_ids.every(isUuid)) {
    return res.status(400).json({ error: 'invalid payload' });
  }
  const { refill_ids, approved_by } = parsed.data;
  const batchId = randomUUID();

  try {
    // Resolve the refills into order lines (client + supplement + patient email
    // + dose/qty for the Fullscript dosage).
    const info = await pool.query<{
      id: string;
      client_id: string | null;
      client_name: string | null;
      client_email: string | null;
      supplement_name: string | null;
      dose: string | null;
      qty: number | null;
    }>(
      `SELECT rf.id, rf.client_id, c.name AS client_name, c.email AS client_email,
              s.name AS supplement_name, s.dose, s.qty
         FROM refills rf
    LEFT JOIN clients c ON c.id = rf.client_id
    LEFT JOIN supplements s ON s.id = rf.supplement_id
        WHERE rf.id = ANY($1::uuid[])`,
      [refill_ids],
    );
    if (info.rowCount === 0) return res.status(404).json({ error: 'no matching refills' });

    // Group the refills by client email so we can send consolidated emails.
    // For clients with no email, we fail them.
    type GroupedClientRefills = {
      clientId: string | null;
      clientName: string;
      clientEmail: string | null;
      refills: Array<{
        refillId: string;
        supplementName: string;
        dose: string | null;
        qty: number | null;
        months: number;
      }>;
    };

    const groupedByEmail = new Map<string, GroupedClientRefills>();
    const noEmailRefills: typeof info.rows = [];
    const monthsCache = new Map<string, number>();

    for (const row of info.rows) {
      if (!row.client_email) {
        noEmailRefills.push(row);
        continue;
      }
      const emailKey = row.client_email.trim().toLowerCase();
      let group = groupedByEmail.get(emailKey);
      if (!group) {
        group = {
          clientId: row.client_id,
          clientName: row.client_name ?? 'Client',
          clientEmail: row.client_email,
          refills: [],
        };
        groupedByEmail.set(emailKey, group);
      }

      // Adherence bundling: default to multi-month based on adherence history.
      let months = 1;
      if (row.client_id) {
        if (!monthsCache.has(row.client_id)) {
          monthsCache.set(row.client_id, suggestedMonths(await computeAdherence(row.client_id)));
        }
        months = monthsCache.get(row.client_id)!;
      }

      group.refills.push({
        refillId: row.id,
        supplementName: row.supplement_name ?? 'supplement',
        dose: row.dose,
        qty: row.qty,
        months,
      });
    }

    const results: Array<{
      refill_id: string;
      client_name: string;
      supplement_name: string;
      ok: boolean;
      error?: string;
      invitation_url?: string;
    }> = [];

    const dispensaryUrl = fullscriptDispensaryUrl();

    // 1. Process refills for clients with no email
    for (const row of noEmailRefills) {
      await pool.query(
        `INSERT INTO refill_orders (batch_id, client_id, refill_id, supplement_name, status, error)
              VALUES ($1, $2, $3, $4, 'failed', 'no client email on file')`,
        [batchId, row.client_id, row.id, row.supplement_name],
      );
      results.push({
        refill_id: row.id,
        client_name: row.client_name ?? 'Unknown client',
        supplement_name: row.supplement_name ?? 'supplement',
        ok: false,
        error: 'no client email on file',
      });
    }

    // 2. Process grouped clients (send one consolidated email per client)
    for (const [email, group] of groupedByEmail.entries()) {
      const suppStrings = group.refills.map(r => {
        const bottles = r.months && r.months > 0 ? Math.floor(r.months) : 1;
        const bottleStr = `${bottles} bottle${bottles > 1 ? 's' : ''}`;
        return `• ${r.supplementName} - ${r.dose ?? 'dosage not specified'} (Recommended: ${bottleStr})`;
      }).join('\n');

      const clientFirst = group.clientName.split(' ')[0] || 'there';
      const emailBody = `Hi ${clientFirst},\n\nThis is a friendly reminder from Innerlume Healing that the following supplement(s) from your protocol are running low:\n\n${suppStrings}\n\nTo purchase your refills, please place an order via your Practice Better client portal or visit our Fullscript dispensary at:\n${dispensaryUrl}\n\nBest regards,\nNicole & the Innerlume Healing Team`;

      let sendOk = false;
      let sendError = '';
      try {
        const emailRes = await sendEmail({
          to: email,
          subject: 'Refill Reminder: Your Innerlume Supplements',
          body: emailBody,
        });
        sendOk = emailRes.ok;
        sendError = emailRes.error ?? '';
      } catch (err) {
        sendOk = false;
        sendError = err instanceof Error ? err.message : String(err);
      }

      for (const r of group.refills) {
        if (sendOk) {
          await pool.query(
            `INSERT INTO refill_orders (batch_id, client_id, refill_id, supplement_name, status, invitation_url, sent_at)
                  VALUES ($1, $2, $3, $4, 'sent', $5, now())`,
            [batchId, group.clientId, r.refillId, r.supplementName, dispensaryUrl],
          );
          results.push({
            refill_id: r.refillId,
            client_name: group.clientName,
            supplement_name: r.supplementName,
            ok: true,
            invitation_url: dispensaryUrl,
          });
        } else {
          await pool.query(
            `INSERT INTO refill_orders (batch_id, client_id, refill_id, supplement_name, status, error)
                  VALUES ($1, $2, $3, $4, 'failed', $5)`,
            [batchId, group.clientId, r.refillId, r.supplementName, sendError || 'email delivery failed'],
          );
          results.push({
            refill_id: r.refillId,
            client_name: group.clientName,
            supplement_name: r.supplementName,
            ok: false,
            error: sendError || 'email delivery failed',
          });
        }
      }
    }

    const sentRefillIds = results
      .filter((r) => r.ok)
      .map((r) => r.refill_id);

    if (sentRefillIds.length > 0) {
      await pool.query(`UPDATE refills SET status = 'notified' WHERE id = ANY($1::uuid[])`, [
        sentRefillIds,
      ]);
    }

    // Audit the bulk action.
    await pool.query(
      `INSERT INTO approvals (type, payload_json, status, approved_by, approved_at)
            VALUES ('refill_bulk_send', $1, 'approved', $2, now())`,
      [JSON.stringify({ batch_id: batchId, count: info.rows.length }), approved_by || 'nicole'],
    );

    const ok = results.filter((r) => r.ok).length;
    logEvent('info', 'refills.orders', 'bulk refill send via email', { batch_id: batchId, count: info.rows.length, ok });
    return res.json({ batch_id: batchId, sent: ok, failed: results.length - ok, results });
  } catch (err) {
    logError('refills.orders', 'bulk send failed', err, { batch_id: batchId });
    return res.status(500).json({ error: 'internal error' });
  }
});
