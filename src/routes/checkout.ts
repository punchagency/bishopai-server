import { Router } from 'express';
import { z } from 'zod';
import { getDatabase } from '../db/index.js';
import { logError } from '../observability/logger';
import { approveAndCharge, closeCheckout, detectCheckout, resetFailedCharge } from '../checkout/machine';
import { reconcileCheckout } from '../checkout/reconcile';
import { syncCustomerMappings } from '../checkout/customerSync';
import { setQboCustomerId } from '../checkout/customerMap';
import { isQuickbooksConfigured } from '../integrations/quickbooks';
import { recordAudit } from '../audit/log';
import { isDocId } from '../db/ids.js';

// WF2 dashboard surface: post-session charges awaiting approval, and the unified
// confirmation. Nicole has two actions — approve the charge, confirm the close —
// the middle (charge → docs → PB mark) is the system's. Guarded by requireAuth
// (mounted in server.ts). Charges are dry-run until QuickBooks is configured.
export const checkoutRouter = Router();

// Path ids are Firestore document ids, not uuids — the port mints deterministic
// ones (`appt_…`, `client_…`, `${clientId}__${nameKey}`). Gating on uuid shape
// here would 404 every PB-synced record; see isDocId.
const isUuid = isDocId;

// GET /checkout — checkouts with their frozen summary + status.
checkoutRouter.get('/', async (_req, res) => {
  try {
    const db = getDatabase();
    const all = await db.checkouts.listAll();
    const rows = all.sort((a, b) => b.updated_at.localeCompare(a.updated_at));

    // Two LEFT JOINs become parallel gets by known ref (§3.4) — one per distinct
    // client and appointment, deduped so a client with several checkouts is
    // fetched once.
    const clientIds = [...new Set(rows.map((c) => c.client_id).filter((id): id is string => !!id))];
    const appointmentIds = [
      ...new Set(rows.map((c) => c.appointment_id).filter((id): id is string => !!id)),
    ];
    const [clients, appointments] = await Promise.all([
      Promise.all(clientIds.map(async (id) => [id, await db.clients.findById(id)] as const)),
      Promise.all(
        appointmentIds.map(async (id) => [id, await db.appointments.findById(id)] as const),
      ),
    ]);
    const clientById = new Map(clients);
    const appointmentById = new Map(appointments);

    const checkouts = rows.map((ch) => ({
      id: ch.id,
      status: ch.status,
      summary_snapshot: ch.summary_snapshot ?? null,
      qb_txn_id: ch.qb_txn_id ?? null,
      updated_at: ch.updated_at,
      client_name: ch.client_id ? (clientById.get(ch.client_id)?.name ?? null) : null,
      starts_at: ch.appointment_id
        ? (appointmentById.get(ch.appointment_id)?.starts_at ?? null)
        : null,
    }));
    res.json({ quickbooks_configured: isQuickbooksConfigured(), checkouts });
  } catch (err) {
    logError('checkout.list', 'list failed', err);
    res.status(500).json({ error: 'internal error' });
  }
});

// POST /checkout/detect { appointment_id } — create a checkout for an
// appointment (also invoked by the PB session-complete webhook).
const detectSchema = z.object({ appointment_id: z.string() });
checkoutRouter.post('/detect', async (req, res) => {
  const parsed = detectSchema.safeParse(req.body);
  if (!parsed.success || !isUuid(parsed.data.appointment_id)) {
    return res.status(400).json({ error: 'invalid payload' });
  }
  try {
    const result = await detectCheckout(parsed.data.appointment_id);
    if (!result) return res.status(404).json({ error: 'appointment not found' });
    return res.json(result);
  } catch (err) {
    logError('checkout.detect', 'detect failed', err);
    return res.status(500).json({ error: 'internal error' });
  }
});

// Card details for the charge (Option A — backend tokenizes). PCI note: the PAN
// arrives over TLS, is tokenized inside chargeCard, and is NEVER persisted or
// logged. Basic shape validation only; QuickBooks does the real card validation.
const cardSchema = z.object({
  number: z.string().regex(/^\d{12,19}$/, 'invalid card number'),
  expMonth: z.string().regex(/^\d{1,2}$/),
  expYear: z.string().regex(/^\d{4}$/),
  cvc: z.string().regex(/^\d{3,4}$/),
  name: z.string().max(200).optional(),
  address: z.record(z.string(), z.string()).optional(),
});
const approveSchema = z.object({
  approved_by: z.string().max(200).optional(),
  token: z.string().max(4096).optional(),
  card: cardSchema.optional(),
});

// POST /checkout/:id/approve — Nicole approves → charge → docs → PB mark.
// Body may carry a payment source: `token` (preferred) or `card` (tokenized
// server-side). Optional in dry-run; required once QuickBooks is live.
checkoutRouter.post('/:id/approve', async (req, res) => {
  if (!isUuid(req.params.id)) return res.status(404).json({ error: 'not found' });
  const parsed = approveSchema.safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).json({ error: 'invalid payload' }); // never echo the card
  const { approved_by, token, card } = parsed.data;
  try {
    const result = await approveAndCharge(req.params.id, { approvedBy: approved_by ?? 'nicole', token, card });
    if (result.status === 'not_found') return res.status(404).json({ error: 'not found' });
    if (result.status === 'CHARGE_FAILED') return res.status(402).json(result); // payment required — retryable
    // Outcome unknown (crash / ambiguous provider response): money MAY have moved.
    // 202 Accepted, not an error code — the truth is pending human verification.
    if (result.status === 'CHARGE_REVIEW') return res.status(202).json(result);
    if (result.error) return res.status(409).json(result);
    return res.json(result);
  } catch (err) {
    logError('checkout.approve', 'approve failed', err, { id: req.params.id }); // err carries no card data
    return res.status(500).json({ error: 'internal error' });
  }
});

// POST /checkout/:id/retry-charge — reopen a cleanly-declined checkout so Nicole
// can approve again with another card. Refused for CHARGE_REVIEW (money may have
// moved — a re-charge could double-charge; that needs manual QuickBooks review).
checkoutRouter.post('/:id/retry-charge', async (req, res) => {
  if (!isUuid(req.params.id)) return res.status(404).json({ error: 'not found' });
  try {
    const result = await resetFailedCharge(req.params.id);
    if (result.status === 'not_found') return res.status(404).json({ error: 'not found' });
    if (result.status !== 'AWAITING_APPROVAL') {
      return res.status(409).json({ error: 'not retryable in current status', status: result.status });
    }
    return res.json(result);
  } catch (err) {
    logError('checkout.retry', 'retry-charge failed', err, { id: req.params.id });
    return res.status(500).json({ error: 'internal error' });
  }
});

// GET /checkout/reconciliations — the reconciliation ledger / dead-letter surface.
// Optional ?status=NEEDS_REVIEW to see only the payments that need a human.
checkoutRouter.get('/reconciliations', async (req, res) => {
  const status = typeof req.query.status === 'string' ? req.query.status : null;
  try {
    const db = getDatabase();
    const rows = await db.checkouts.listReconciliations(status);

    // `LEFT JOIN checkout … LEFT JOIN clients` — the reconciliation's document
    // id IS the checkout id, so the first hop is a direct get rather than a
    // query, and the second is one get per distinct client.
    const checkouts = new Map(
      await Promise.all(
        [...new Set(rows.map((r) => r.checkout_id))].map(
          async (id) => [id, await db.checkouts.findById(id)] as const,
        ),
      ),
    );
    const clientIds = [
      ...new Set(
        rows
          .map((r) => checkouts.get(r.checkout_id)?.client_id)
          .filter((id): id is string => !!id),
      ),
    ];
    const clientById = new Map(
      await Promise.all(clientIds.map(async (id) => [id, await db.clients.findById(id)] as const)),
    );

    const reconciliations = rows.map((r) => {
      const clientId = checkouts.get(r.checkout_id)?.client_id ?? null;
      return {
        id: r.id,
        checkout_id: r.checkout_id,
        status: r.status,
        amount_cents: r.amount_cents,
        currency: r.currency,
        invoice_id: r.invoice_id ?? null,
        customer_id: r.customer_id ?? null,
        provider_txn_id: r.provider_txn_id ?? null,
        accounting_payment_id: r.accounting_payment_id ?? null,
        attempts: r.attempts,
        last_error: r.last_error ?? null,
        next_attempt_at: r.next_attempt_at,
        updated_at: r.updated_at,
        client_name: clientId ? (clientById.get(clientId)?.name ?? null) : null,
      };
    });
    res.json({ quickbooks_configured: isQuickbooksConfigured(), reconciliations });
  } catch (err) {
    logError('checkout.reconciliations', 'list failed', err);
    res.status(500).json({ error: 'internal error' });
  }
});

// POST /checkout/reconciliations/:id/retry — re-drive a NEEDS_REVIEW/FAILED row
// now (e.g. after adding the customer mapping). Idempotent: never double-records.
checkoutRouter.post('/reconciliations/:id/retry', async (req, res) => {
  if (!isUuid(req.params.id)) return res.status(404).json({ error: 'not found' });
  try {
    const db = getDatabase();
    const reset = await db.checkouts.retryReconciliation(req.params.id);
    if (!reset) return res.status(409).json({ error: 'not retryable in current status' });
    await reconcileCheckout(reset.checkout_id);
    // Re-read: reconcileCheckout is what moved it on from PENDING.
    const after = await db.checkouts.findReconciliationByCheckout(reset.checkout_id);
    return res.json({
      status: after?.status ?? null,
      last_error: after?.last_error ?? null,
      accounting_payment_id: after?.accounting_payment_id ?? null,
    });
  } catch (err) {
    logError('checkout.reconciliations', 'retry failed', err, { id: req.params.id });
    return res.status(500).json({ error: 'internal error' });
  }
});

// --- client → QuickBooks customer mapping -----------------------------------

// GET /checkout/customer-map — every client with its mapping (unmapped first).
checkoutRouter.get('/customer-map', async (_req, res) => {
  try {
    const db = getDatabase();
    // Both collections whole, then joined in memory: the mapping table has one
    // row per client at most, so this is two reads of the same small set rather
    // than a per-client lookup.
    const [clients, maps] = await Promise.all([db.clients.listAll(), db.checkouts.listQboMaps()]);
    const mapByClient = new Map(maps.map((m) => [m.client_id, m]));

    const rows = clients
      .map((c) => {
        const map = mapByClient.get(c.id);
        return {
          client_id: c.id,
          client_name: c.name,
          email: c.email ?? null,
          qbo_customer_id: map?.qbo_customer_id ?? null,
          updated_at: map?.updated_at ?? null,
        };
      })
      // `ORDER BY (m.qbo_customer_id IS NULL) DESC, c.name` — unmapped first,
      // because those are the ones needing Nicole's attention.
      .sort((a, b) => {
        const aUnmapped = a.qbo_customer_id === null;
        const bUnmapped = b.qbo_customer_id === null;
        if (aUnmapped !== bUnmapped) return aUnmapped ? -1 : 1;
        return a.client_name.localeCompare(b.client_name);
      });
    res.json({ quickbooks_configured: isQuickbooksConfigured(), clients: rows });
  } catch (err) {
    logError('checkout.customer_map', 'list failed', err);
    res.status(500).json({ error: 'internal error' });
  }
});

// POST /checkout/customer-map/sync — pull QBO customers and auto-map unambiguous
// exact matches; report ambiguous/unmatched for manual resolution.
checkoutRouter.post('/customer-map/sync', async (_req, res) => {
  try {
    const report = await syncCustomerMappings();
    if (!report.ok) return res.status(400).json(report);
    await recordAudit({ entityType: 'customer_map', entityId: 'sync', action: 'customer_map.synced', actor: 'nicole', summary: `Synced from QuickBooks — ${report.mapped.length} mapped, ${report.ambiguous.length} ambiguous, ${report.unmatched.length} unmatched`, metadata: { mapped: report.mapped.length, ambiguous: report.ambiguous.length, unmatched: report.unmatched.length } });
    return res.json(report);
  } catch (err) {
    logError('checkout.customer_map', 'sync failed', err);
    return res.status(500).json({ error: 'internal error' });
  }
});

// PUT /checkout/customer-map/:clientId { qbo_customer_id } — manual set/override.
const mapSchema = z.object({ qbo_customer_id: z.string().regex(/^[A-Za-z0-9-]+$/, 'invalid id').max(64) });
checkoutRouter.put('/customer-map/:clientId', async (req, res) => {
  if (!isUuid(req.params.clientId)) return res.status(404).json({ error: 'not found' });
  const parsed = mapSchema.safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).json({ error: 'invalid payload' });
  try {
    const exists = await getDatabase().clients.findById(req.params.clientId);
    if (!exists) return res.status(404).json({ error: 'client not found' });
    await setQboCustomerId(req.params.clientId, parsed.data.qbo_customer_id);
    await recordAudit({ entityType: 'customer_map', entityId: req.params.clientId, action: 'customer_map.set', actor: 'nicole', summary: `Mapped client to QuickBooks customer #${parsed.data.qbo_customer_id}`, metadata: { qbo_customer_id: parsed.data.qbo_customer_id } });
    return res.json({ client_id: req.params.clientId, qbo_customer_id: parsed.data.qbo_customer_id });
  } catch (err) {
    logError('checkout.customer_map', 'set failed', err, { client_id: req.params.clientId });
    return res.status(500).json({ error: 'internal error' });
  }
});

// DELETE /checkout/customer-map/:clientId — remove a mapping (to re-sync/fix it).
checkoutRouter.delete('/customer-map/:clientId', async (req, res) => {
  if (!isUuid(req.params.clientId)) return res.status(404).json({ error: 'not found' });
  try {
    await getDatabase().checkouts.deleteQboMap(req.params.clientId);
    await recordAudit({ entityType: 'customer_map', entityId: req.params.clientId, action: 'customer_map.cleared', actor: 'nicole', summary: 'Removed the QuickBooks customer mapping' });
    return res.json({ ok: true });
  } catch (err) {
    logError('checkout.customer_map', 'delete failed', err, { client_id: req.params.clientId });
    return res.status(500).json({ error: 'internal error' });
  }
});

// POST /checkout/:id/close — Nicole's final confirm.
checkoutRouter.post('/:id/close', async (req, res) => {
  if (!isUuid(req.params.id)) return res.status(404).json({ error: 'not found' });
  try {
    const result = await closeCheckout(req.params.id);
    if (result.status === 'not_found') return res.status(404).json({ error: 'not found' });
    return res.json(result);
  } catch (err) {
    logError('checkout.close', 'close failed', err, { id: req.params.id });
    return res.status(500).json({ error: 'internal error' });
  }
});
