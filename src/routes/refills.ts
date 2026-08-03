import { Router } from 'express';
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { getDatabase } from '../db/index.js';
import { logError, logEvent } from '../observability/logger';
import { fullscriptDispensaryUrl } from '../integrations/fullscript';
import { computeAdherence, suggestedMonths } from '../refills/adherence';
import { computeRunOut, dailyUnits, type DoseSchedule } from '../refills/project';
import { recordAudit } from '../audit/log';
import { sendEmail, resolveOutlookAccess } from '../integrations/outlook';
import { isDocId } from '../db/ids.js';

// WF4 dashboard surface: the daily refill digest (who's running low, tiered by
// urgency) plus Nicole's actions — snooze, skip, or bulk-send the orders to
// Fullscript. Due dates are produced by the nightly projection (src/refills).
// No auth yet — consistent with the rest of the review surface.
export const refillsRouter = Router();

// Path ids are Firestore document ids, not uuids — the port mints deterministic
// ones (`appt_…`, `client_…`, `${clientId}__${nameKey}`). Gating on uuid shape
// here would 404 every PB-synced record; see isDocId.
const isUuid = isDocId;

// Tier thresholds (days until run-out). Kept here so the API and UI agree.
const SOON_DAYS = 14;

// ---------------------------------------------------------------------------
// GET /refills/digest — open refills, soonest first, with days_left + tier.
// ---------------------------------------------------------------------------
refillsRouter.get('/digest', async (_req, res) => {
  try {
    const db = getDatabase();
    const open = (await db.refills.listByStatuses(['pending', 'notified', 'snoozed'])).filter(
      (rf) => !!rf.due_date, // `AND rf.due_date IS NOT NULL`
    );

    // The two LEFT JOINs and the LATERAL become three batched lookups: the
    // supplements and clients by known ref, and every order for this set in one
    // pass (§3.4). Nothing here is a per-row query against an unindexed field.
    const [supplements, clients, orders] = await Promise.all([
      Promise.all(
        [...new Set(open.map((rf) => rf.supplement_id))].map(
          async (id) => [id, await db.refills.findSupplementById(id)] as const,
        ),
      ),
      Promise.all(
        [...new Set(open.map((rf) => rf.client_id))].map(
          async (id) => [id, await db.clients.findById(id)] as const,
        ),
      ),
      db.refills.listOrdersForRefills(open.map((rf) => rf.id)),
    ]);
    const suppById = new Map(supplements);
    const clientById = new Map(clients);

    // `ORDER BY ro.sent_at DESC NULLS LAST LIMIT 1`, per refill — the most
    // recent successful send is the one whose link the card shows.
    const latestSent = new Map<string, (typeof orders)[number]>();
    for (const o of orders) {
      if (o.status !== 'sent' || !o.refill_id) continue;
      const prev = latestSent.get(o.refill_id);
      if (!prev || (o.sent_at ?? '') > (prev.sent_at ?? '')) latestSent.set(o.refill_id, o);
    }

    // `(rf.due_date - current_date)` was computed in pg; there is no such
    // expression here, so the day difference is computed in UTC against the
    // same yyyy-mm-dd strings the projection writes.
    const today = new Date().toISOString().slice(0, 10);
    const daysBetween = (from: string, to: string) =>
      Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);

    // Surface the dosing maths the projection ran on: how many units a day the
    // dose works out to and how long the bottle lasts at that rate. It's what
    // makes a due date checkable at a glance rather than a number to trust.
    const items = open.map((rf) => {
      const supp = suppById.get(rf.supplement_id) ?? null;
      const order = latestSent.get(rf.id) ?? null;
      const daysLeft = daysBetween(today, rf.due_date);
      const { perDay, daysSupply } = computeRunOut({
        dose: supp?.dose ?? rf.dose ?? null,
        qty: supp?.qty ?? null,
        schedule: supp?.schedule ?? null,
        start_date: supp?.start_date ?? null,
        units_per_dose: supp?.units_per_dose ?? null,
        doses_per_day: supp?.doses_per_day ?? null,
      });
      return {
        id: rf.id,
        due_date: rf.due_date,
        status: rf.status,
        days_left: daysLeft,
        client_id: rf.client_id,
        client_name: clientById.get(rf.client_id)?.name ?? rf.client_name ?? null,
        supplement_name: supp?.name ?? rf.supplement_name,
        dose: supp?.dose ?? rf.dose ?? null,
        qty: supp?.qty ?? null,
        schedule: supp?.schedule ?? null,
        start_date: supp?.start_date ?? null,
        reminders_cancelled_at: rf.reminders_cancelled_at ?? null,
        fullscript_plan_id: order?.fullscript_order_id ?? null,
        invitation_url: order?.invitation_url ?? null,
        per_day: perDay,
        days_supply: daysSupply,
        tier: tierFor(daysLeft),
      };
    });
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

/**
 * Bottles to reorder for `months` of supply. One bottle per month is only right
 * when the bottle happens to hold a month at the stated dose: 120 caps taken 4/day
 * is 30 days, but taken 1/day it is four months. With the dose known we can size
 * the order properly; without a bottle count (qty) we fall back to one per month.
 */
export function bottlesFor(months: number, perDay: number, qty: number | null): number {
  const m = months > 0 ? Math.floor(months) : 1;
  if (!qty || qty <= 0 || !perDay || perDay <= 0) return Math.max(1, m);
  return Math.max(1, Math.ceil((m * 30 * perDay) / qty));
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
    const db = getDatabase();
    const refill = await db.refills.findById(req.params.id);
    if (!refill) return res.status(404).json({ error: 'not found' });

    // `coalesce(due_date, current_date) + N days`, in UTC on the yyyy-mm-dd
    // strings the projection writes.
    const base = refill.due_date || new Date().toISOString().slice(0, 10);
    const dueDate = new Date(Date.parse(`${base}T00:00:00Z`) + days * 86_400_000)
      .toISOString()
      .slice(0, 10);
    await db.refills.save({
      ...refill,
      status: 'snoozed',
      due_date: dueDate,
      updated_at: new Date().toISOString(),
    });
    await recordAudit({ entityType: 'refill', entityId: req.params.id, action: 'refill.snoozed', actor: 'nicole', summary: `Refill snoozed ${days} days`, metadata: { days } });
    return res.json({ id: refill.id, status: 'snoozed', due_date: dueDate });
  } catch (err) {
    logError('refills.snooze', 'snooze failed', err, { id: req.params.id });
    return res.status(500).json({ error: 'internal error' });
  }
});

refillsRouter.post('/:id/skip', async (req, res) => {
  if (!isUuid(req.params.id)) return res.status(404).json({ error: 'not found' });
  try {
    const db = getDatabase();
    const refill = await db.refills.findById(req.params.id);
    if (!refill) return res.status(404).json({ error: 'not found' });
    await db.refills.save({ ...refill, status: 'closed', updated_at: new Date().toISOString() });
    await recordAudit({ entityType: 'refill', entityId: req.params.id, action: 'refill.skipped', actor: 'nicole', summary: 'Refill closed for this cycle' });
    return res.json({ id: refill.id, status: 'closed' });
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
    const db = getDatabase();
    // Resolve the refills into order lines (client + supplement + patient email
    // + dose/qty for the Fullscript dosage). `WHERE rf.id = ANY(...)` becomes
    // parallel gets by id, and the two LEFT JOINs likewise (§3.4); a refill id
    // that no longer exists is simply dropped, as the SQL did.
    type OrderLine = {
      id: string;
      client_id: string | null;
      client_name: string | null;
      client_email: string | null;
      supplement_name: string | null;
      dose: string | null;
      qty: number | null;
      schedule: DoseSchedule | null;
    };
    const found = (
      await Promise.all(refill_ids.map((id) => db.refills.findById(id)))
    ).filter((rf): rf is NonNullable<typeof rf> => rf !== null);

    const [lineClients, lineSupplements] = await Promise.all([
      Promise.all(
        [...new Set(found.map((rf) => rf.client_id))].map(
          async (id) => [id, await db.clients.findById(id)] as const,
        ),
      ),
      Promise.all(
        [...new Set(found.map((rf) => rf.supplement_id))].map(
          async (id) => [id, await db.refills.findSupplementById(id)] as const,
        ),
      ),
    ]);
    const lineClientById = new Map(lineClients);
    const lineSuppById = new Map(lineSupplements);

    const rows: OrderLine[] = found.map((rf) => {
      const client = lineClientById.get(rf.client_id) ?? null;
      const supp = lineSuppById.get(rf.supplement_id) ?? null;
      return {
        id: rf.id,
        client_id: rf.client_id,
        client_name: client?.name ?? rf.client_name ?? null,
        client_email: client?.email ?? null,
        supplement_name: supp?.name ?? rf.supplement_name ?? null,
        dose: supp?.dose ?? rf.dose ?? null,
        qty: supp?.qty ?? null,
        schedule: (supp?.schedule ?? null) as DoseSchedule | null,
      };
    });
    if (rows.length === 0) return res.status(404).json({ error: 'no matching refills' });

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
        perDay: number;
      }>;
    };

    const groupedByEmail = new Map<string, GroupedClientRefills>();
    const noEmailRefills: OrderLine[] = [];
    const monthsCache = new Map<string, number>();

    for (const row of rows) {
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
        perDay: dailyUnits(row),
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
    // Every refill_orders insert becomes a saveOrder with an explicit id — the
    // pg table generated one, Firestore needs it up front.
    const orderStamp = () => new Date().toISOString();

    // 1. Process refills for clients with no email
    for (const row of noEmailRefills) {
      await db.refills.saveOrder({
        id: randomUUID(),
        batch_id: batchId,
        client_id: row.client_id,
        refill_id: row.id,
        supplement_name: row.supplement_name,
        status: 'failed',
        error: 'no client email on file',
        created_at: orderStamp(),
      });
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
        const bottles = bottlesFor(r.months, r.perDay, r.qty);
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
          const now = orderStamp();
          await db.refills.saveOrder({
            id: randomUUID(),
            batch_id: batchId,
            client_id: group.clientId,
            refill_id: r.refillId,
            supplement_name: r.supplementName,
            status: 'sent',
            invitation_url: dispensaryUrl,
            sent_at: now,
            created_at: now,
          });
          results.push({
            refill_id: r.refillId,
            client_name: group.clientName,
            supplement_name: r.supplementName,
            ok: true,
            invitation_url: dispensaryUrl,
          });
        } else {
          await db.refills.saveOrder({
            id: randomUUID(),
            batch_id: batchId,
            client_id: group.clientId,
            refill_id: r.refillId,
            supplement_name: r.supplementName,
            status: 'failed',
            error: sendError || 'email delivery failed',
            created_at: orderStamp(),
          });
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

    // `UPDATE refills SET status='notified' WHERE id = ANY(...)` — the refills
    // are already in hand from the lookup above, so this is a write per id
    // rather than a re-read.
    const foundById = new Map(found.map((rf) => [rf.id, rf]));
    await Promise.all(
      sentRefillIds.map(async (id) => {
        const rf = foundById.get(id);
        if (!rf) return;
        await db.refills.save({ ...rf, status: 'notified', updated_at: new Date().toISOString() });
      }),
    );

    // Audit the bulk action.
    const approvedAt = new Date().toISOString();
    await db.sessionNotes.saveApproval({
      id: randomUUID(),
      type: 'refill_bulk_send',
      payload_json: { batch_id: batchId, count: rows.length },
      status: 'approved',
      approved_by: approved_by || 'nicole',
      approved_at: approvedAt,
      created_at: approvedAt,
    });

    const ok = results.filter((r) => r.ok).length;
    logEvent('info', 'refills.orders', 'bulk refill send via email', { batch_id: batchId, count: rows.length, ok });
    return res.json({ batch_id: batchId, sent: ok, failed: results.length - ok, results });
  } catch (err) {
    logError('refills.orders', 'bulk send failed', err, { batch_id: batchId });
    return res.status(500).json({ error: 'internal error' });
  }
});
