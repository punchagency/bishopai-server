import { Router } from 'express';
import { z } from 'zod';
import { pool } from '../db/pool';
import { logError } from '../observability/logger';
import { approveAndCharge, closeCheckout, detectCheckout } from '../checkout/machine';
import { isQuickbooksConfigured } from '../integrations/quickbooks';

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

// POST /checkout/:id/approve — Nicole approves → charge → docs → PB mark.
checkoutRouter.post('/:id/approve', async (req, res) => {
  if (!isUuid(req.params.id)) return res.status(404).json({ error: 'not found' });
  const approvedBy = typeof req.body?.approved_by === 'string' ? req.body.approved_by : 'nicole';
  try {
    const result = await approveAndCharge(req.params.id, approvedBy);
    if (result.status === 'not_found') return res.status(404).json({ error: 'not found' });
    if (result.status === 'CHARGE_FAILED') return res.status(402).json(result); // payment required
    if (result.error) return res.status(409).json(result);
    return res.json(result);
  } catch (err) {
    logError('checkout.approve', 'approve failed', err, { id: req.params.id });
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
