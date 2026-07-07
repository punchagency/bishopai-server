import { Router } from 'express';
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { pool } from '../db/pool';
import { logError, logEvent } from '../observability/logger';
import { sendBulkRefillOrders, isFullscriptConfigured, type RefillOrderLine } from '../integrations/fullscript';
import { computeAdherence, suggestedMonths } from '../refills/adherence';

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
    res.json({ fullscript_configured: isFullscriptConfigured(), refills: items });
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

    // Stage one refill_orders row per refill (status 'queued'). Track which
    // refill each order came from so we can flip the right ones to 'notified'.
    const lines: RefillOrderLine[] = [];
    const orderToRefill = new Map<string, string>();
    const monthsCache = new Map<string, number>(); // client_id → suggested bottles
    for (const row of info.rows) {
      const ins = await pool.query<{ id: string }>(
        `INSERT INTO refill_orders (batch_id, client_id, refill_id, supplement_name, status)
              VALUES ($1, $2, $3, $4, 'queued')
           RETURNING id`,
        [batchId, row.client_id, row.id, row.supplement_name],
      );
      orderToRefill.set(ins.rows[0].id, row.id);

      // Adherence bundling: proven, reliable clients default to a multi-month order.
      let months = 1;
      if (row.client_id) {
        if (!monthsCache.has(row.client_id)) monthsCache.set(row.client_id, suggestedMonths(await computeAdherence(row.client_id)));
        months = monthsCache.get(row.client_id)!;
      }

      lines.push({
        orderId: ins.rows[0].id,
        clientName: row.client_name ?? 'Unknown client',
        clientEmail: row.client_email,
        supplementName: row.supplement_name ?? 'supplement',
        dose: row.dose,
        qty: row.qty,
        months,
      });
    }

    // Forward the batch as Fullscript treatment plans (dry-run until configured).
    const results = await sendBulkRefillOrders(lines, { batchId });

    // Persist each order's outcome + flip successfully-sent refills to 'notified'.
    for (const r of results) {
      if (r.ok) {
        await pool.query(
          `UPDATE refill_orders SET status = 'sent', fullscript_order_id = $2, invitation_url = $3, sent_at = now() WHERE id = $1`,
          [r.orderId, r.fullscriptPlanId ?? null, r.invitationUrl ?? null],
        );
      } else {
        await pool.query(`UPDATE refill_orders SET status = 'failed', error = $2 WHERE id = $1`, [
          r.orderId,
          r.error ?? 'unknown error',
        ]);
      }
    }
    const sentRefillIds = results
      .filter((r) => r.ok)
      .map((r) => orderToRefill.get(r.orderId))
      .filter((v): v is string => !!v);
    if (sentRefillIds.length > 0) {
      await pool.query(`UPDATE refills SET status = 'notified' WHERE id = ANY($1::uuid[])`, [
        [...new Set(sentRefillIds)],
      ]);
    }

    // Audit the bulk action.
    await pool.query(
      `INSERT INTO approvals (type, payload_json, status, approved_by, approved_at)
            VALUES ('refill_bulk_send', $1, 'approved', $2, now())`,
      [JSON.stringify({ batch_id: batchId, count: lines.length }), approved_by || 'nicole'],
    );

    // Enrich each result with the refill/client/supplement it came from, so the
    // dashboard can show per-refill outcomes (and the Fullscript plan link).
    const metaByRefill = new Map(info.rows.map((r) => [r.id, r]));
    const enriched = results.map((r) => {
      const refillId = orderToRefill.get(r.orderId);
      const meta = refillId ? metaByRefill.get(refillId) : undefined;
      return {
        refill_id: refillId ?? null,
        client_name: meta?.client_name ?? null,
        supplement_name: meta?.supplement_name ?? null,
        ok: r.ok,
        error: r.error ?? null,
        invitation_url: r.invitationUrl ?? null,
        fullscript_plan_id: r.fullscriptPlanId ?? null,
      };
    });

    const ok = results.filter((r) => r.ok).length;
    logEvent('info', 'refills.orders', 'bulk refill send', { batch_id: batchId, count: lines.length, ok });
    return res.json({ batch_id: batchId, sent: ok, failed: results.length - ok, results: enriched });
  } catch (err) {
    logError('refills.orders', 'bulk send failed', err, { batch_id: batchId });
    return res.status(500).json({ error: 'internal error' });
  }
});
