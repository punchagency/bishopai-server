import { Router } from 'express';
import { z } from 'zod';
import { pool } from '../db/pool';
import { logError } from '../observability/logger';
import { approveAndCharge, closeCheckout, detectCheckout, resetFailedCharge } from '../checkout/machine';
import { reconcileCheckout } from '../checkout/reconcile';
import { syncCustomerMappings } from '../checkout/customerSync';
import { setQboCustomerId } from '../checkout/customerMap';
import { isQuickbooksConfigured } from '../integrations/quickbooks';
import { recordAudit } from '../audit/log';

// WF2 dashboard surface: post-session charges awaiting approval, and the unified
// confirmation. Nicole has two actions — approve the charge, confirm the close —
// the middle (charge → docs → PB mark) is the system's. Guarded by requireAuth
// (mounted in server.ts). Charges are dry-run until QuickBooks is configured.
export const checkoutRouter = Router();

const isUuid = (id: string) => z.uuid().safeParse(id).success;

// GET /checkout — checkouts with their frozen summary + status.
checkoutRouter.get('/', async (_req, res) => {
  try {
    const r = await pool.query(
      `SELECT ch.id, ch.status, ch.summary_snapshot, ch.qb_txn_id, ch.updated_at,
              c.name AS client_name, a.starts_at
         FROM checkout ch
    LEFT JOIN clients c ON c.id = ch.client_id
    LEFT JOIN appointments a ON a.id = ch.appointment_id
     ORDER BY ch.updated_at DESC`,
    );
    res.json({ quickbooks_configured: isQuickbooksConfigured(), checkouts: r.rows });
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
    const r = await pool.query(
      `SELECT pr.id, pr.checkout_id, pr.status, pr.amount_cents, pr.currency, pr.invoice_id,
              pr.customer_id, pr.provider_txn_id, pr.accounting_payment_id, pr.attempts,
              pr.last_error, pr.next_attempt_at, pr.updated_at, c.name AS client_name
         FROM payment_reconciliation pr
    LEFT JOIN checkout ch ON ch.id = pr.checkout_id
    LEFT JOIN clients c ON c.id = ch.client_id
        WHERE ($1::text IS NULL OR pr.status = $1)
     ORDER BY pr.updated_at DESC`,
      [status],
    );
    res.json({ quickbooks_configured: isQuickbooksConfigured(), reconciliations: r.rows });
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
    const upd = await pool.query(
      `UPDATE payment_reconciliation SET status = 'PENDING', next_attempt_at = now(), attempts = 0
        WHERE id = $1 AND status IN ('FAILED', 'NEEDS_REVIEW') RETURNING checkout_id`,
      [req.params.id],
    );
    if (upd.rowCount === 0) return res.status(409).json({ error: 'not retryable in current status' });
    await reconcileCheckout(upd.rows[0].checkout_id);
    const r = await pool.query(`SELECT status, last_error, accounting_payment_id FROM payment_reconciliation WHERE id = $1`, [req.params.id]);
    return res.json(r.rows[0]);
  } catch (err) {
    logError('checkout.reconciliations', 'retry failed', err, { id: req.params.id });
    return res.status(500).json({ error: 'internal error' });
  }
});

// --- client → QuickBooks customer mapping -----------------------------------

// GET /checkout/customer-map — every client with its mapping (unmapped first).
checkoutRouter.get('/customer-map', async (_req, res) => {
  try {
    const r = await pool.query(
      `SELECT c.id AS client_id, c.name AS client_name, c.email, m.qbo_customer_id, m.updated_at
         FROM clients c
    LEFT JOIN client_qbo_map m ON m.client_id = c.id
     ORDER BY (m.qbo_customer_id IS NULL) DESC, c.name`,
    );
    res.json({ quickbooks_configured: isQuickbooksConfigured(), clients: r.rows });
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
    const exists = await pool.query(`SELECT 1 FROM clients WHERE id = $1`, [req.params.clientId]);
    if (exists.rowCount === 0) return res.status(404).json({ error: 'client not found' });
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
    await pool.query(`DELETE FROM client_qbo_map WHERE client_id = $1`, [req.params.clientId]);
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
