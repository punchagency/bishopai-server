import crypto from 'node:crypto';
import type { PoolClient } from 'pg';
import { pool } from '../db/pool';
import { logEvent, logError } from '../observability/logger';
import { chargeCard } from '../integrations/quickbooks';
import { publishApproved } from '../session/publish';

// WF2 checkout state machine (§6). The one money flow, so every transition is an
// atomic guarded UPDATE (never restarts a charge), the charge carries a stable
// idempotency key, and the approval is bound to the exact figure Nicole saw via
// a summary hash. Charges are dry-run until QuickBooks is configured — the state
// machine and all guarantees run identically either way.
//
//   DETECTED → SUMMARY_READY → AWAITING_APPROVAL → CHARGING → CHARGED
//            → DOCS_UPDATED → PB_MARKED → CLOSED    (CHARGING → CHARGE_FAILED)

const SESSION_FEE_CENTS = Number(process.env.CHECKOUT_SESSION_FEE_CENTS ?? 15000);
const SUPPLEMENT_CENTS = Number(process.env.CHECKOUT_SUPPLEMENT_CENTS ?? 2500);

export interface LineItem {
  label: string;
  amount_cents: number;
}
export interface CheckoutSummary {
  currency: string;
  qb_invoice_id: string;
  line_items: LineItem[];
  total_cents: number;
  fullscript_changes: string[];
}

/**
 * Bind an approval to the exact figure shown. Canonicalised over the fields that
 * matter (currency, total, line items) so it's stable regardless of JSONB key
 * ordering when the snapshot round-trips through Postgres.
 */
export function summaryHash(s: CheckoutSummary): string {
  const canon = `${s.currency}|${s.total_cents}|${s.line_items.map((l) => `${l.label}:${l.amount_cents}`).join(',')}`;
  return crypto.createHash('sha256').update(canon).digest('hex');
}

/** Assemble a frozen summary from the appointment's client + supplements (mock
 *  QB invoice + Fullscript changes). This is what Nicole approves — not a live re-pull. */
export async function assembleSummary(appointmentId: string): Promise<CheckoutSummary | null> {
  const appt = await pool.query<{ client_id: string | null }>(
    `SELECT client_id FROM appointments WHERE id = $1`,
    [appointmentId],
  );
  if (appt.rowCount === 0) return null;
  const clientId = appt.rows[0].client_id;

  const supps = clientId
    ? (await pool.query<{ name: string }>(`SELECT name FROM supplements WHERE client_id = $1 ORDER BY name`, [clientId])).rows
    : [];

  const line_items: LineItem[] = [
    { label: 'Consultation', amount_cents: SESSION_FEE_CENTS },
    ...supps.map((s) => ({ label: s.name, amount_cents: SUPPLEMENT_CENTS })),
  ];
  const total_cents = line_items.reduce((sum, l) => sum + l.amount_cents, 0);
  return {
    currency: 'USD',
    qb_invoice_id: `mock-inv-${appointmentId.slice(0, 8)}`,
    line_items,
    total_cents,
    fullscript_changes: supps.map((s) => s.name),
  };
}

/** Atomic guarded transition. Returns true only if the row was in `from`. */
async function transition(db: PoolClient | typeof pool, id: string, from: string, to: string): Promise<boolean> {
  const r = await db.query(`UPDATE checkout SET status = $3 WHERE id = $1 AND status = $2`, [id, from, to]);
  return r.rowCount === 1;
}

export interface DetectResult {
  checkoutId: string;
  status: string;
}

/**
 * DETECTED → AWAITING_APPROVAL. Idempotent on pb_appointment_id (unique), so a
 * re-detection (PB retry) returns the existing checkout untouched.
 */
export async function detectCheckout(appointmentId: string): Promise<DetectResult | null> {
  const appt = await pool.query<{ client_id: string | null; pb_id: string | null }>(
    `SELECT client_id, pb_id FROM appointments WHERE id = $1`,
    [appointmentId],
  );
  if (appt.rowCount === 0) return null;
  const { client_id, pb_id } = appt.rows[0];

  // Claim (or find) the checkout row.
  const ins = await pool.query<{ id: string; status: string }>(
    `INSERT INTO checkout (appointment_id, client_id, pb_appointment_id, status)
          VALUES ($1, $2, $3, 'DETECTED')
     ON CONFLICT (pb_appointment_id) WHERE pb_appointment_id IS NOT NULL DO NOTHING
       RETURNING id, status`,
    [appointmentId, client_id, pb_id],
  );
  let checkoutId: string;
  if (ins.rowCount === 1) {
    checkoutId = ins.rows[0].id;
  } else {
    const existing = await pool.query<{ id: string; status: string }>(
      `SELECT id, status FROM checkout WHERE pb_appointment_id = $1`,
      [pb_id],
    );
    if (existing.rowCount === 0) return null;
    // Already past detection — return as-is (idempotent).
    return { checkoutId: existing.rows[0].id, status: existing.rows[0].status };
  }

  // Assemble the frozen snapshot and move to AWAITING_APPROVAL.
  const summary = await assembleSummary(appointmentId);
  if (summary) {
    await pool.query(
      `UPDATE checkout SET summary_snapshot = $2, qb_invoice_id = $3, status = 'AWAITING_APPROVAL'
        WHERE id = $1 AND status = 'DETECTED'`,
      [checkoutId, JSON.stringify(summary), summary.qb_invoice_id],
    );
  }
  logEvent('info', 'checkout.detect', 'checkout ready for approval', { checkout_id: checkoutId });
  return { checkoutId, status: 'AWAITING_APPROVAL' };
}

export interface ApproveResult {
  status: string;
  qbTxnId?: string;
  error?: string;
}

/**
 * Nicole's Approve → the system half (charge → docs → PB mark). Writes the
 * approval (bound to the summary hash), claims the charge with a stable
 * idempotency key, then walks the automated states. Money state is never
 * coupled to the PB write: a PB-mark failure leaves the charge captured.
 */
export async function approveAndCharge(checkoutId: string, approvedBy = 'nicole'): Promise<ApproveResult> {
  const row = await pool.query<{ status: string; summary_snapshot: CheckoutSummary | null; appointment_id: string | null }>(
    `SELECT status, summary_snapshot, appointment_id FROM checkout WHERE id = $1`,
    [checkoutId],
  );
  if (row.rowCount === 0) return { status: 'not_found' };
  const { status, summary_snapshot, appointment_id } = row.rows[0];
  if (status !== 'AWAITING_APPROVAL') return { status, error: 'not awaiting approval' };
  if (!summary_snapshot) return { status, error: 'no summary to approve' };

  const hash = summaryHash(summary_snapshot);

  // Claim: AWAITING_APPROVAL → CHARGING (atomic). If we lose the race, stop.
  const db = await pool.connect();
  try {
    await db.query('BEGIN');
    if (!(await transition(db, checkoutId, 'AWAITING_APPROVAL', 'CHARGING'))) {
      await db.query('ROLLBACK');
      return { status: 'CHARGING', error: 'already in progress' };
    }
    await db.query(
      `INSERT INTO approvals (checkout_id, type, amount_cents, currency, summary_hash, status, approved_by, approved_at)
            VALUES ($1, 'checkout', $2, $3, $4, 'approved', $5, now())`,
      [checkoutId, summary_snapshot.total_cents, summary_snapshot.currency, hash, approvedBy],
    );
    await db.query('COMMIT');
  } catch (err) {
    await db.query('ROLLBACK');
    logError('checkout.approve', 'approval failed', err, { checkout_id: checkoutId });
    return { status, error: 'approval failed' };
  } finally {
    db.release();
  }

  // Charge (idempotent). The key is stable per checkout, so a retry never
  // double-charges. Persist the key first as a second guard.
  const idempotencyKey = `checkout:${checkoutId}:charge`;
  await pool.query(`UPDATE checkout SET charge_idempotency_key = $2 WHERE id = $1 AND charge_idempotency_key IS NULL`, [
    checkoutId,
    idempotencyKey,
  ]);

  const charge = await chargeCard({
    amountCents: summary_snapshot.total_cents,
    currency: summary_snapshot.currency,
    idempotencyKey,
    invoiceId: summary_snapshot.qb_invoice_id,
  });

  if (!charge.ok) {
    await transition(pool, checkoutId, 'CHARGING', 'CHARGE_FAILED');
    logEvent('warn', 'checkout.charge', 'charge failed', { checkout_id: checkoutId, error: charge.error });
    return { status: 'CHARGE_FAILED', error: charge.error };
  }

  await pool.query(`UPDATE checkout SET qb_txn_id = $2, status = 'CHARGED' WHERE id = $1 AND status = 'CHARGING'`, [
    checkoutId,
    charge.txnId ?? null,
  ]);

  // Docs update (Drive) — publishApproved is dry-run until Drive is configured.
  // Money state is already CHARGED; a Drive failure does not un-capture it.
  const apptRows = await pool.query<{ sheet_id: string | null; protocol_id: string | null }>(
    `SELECT
       (SELECT id FROM appointment_sheets WHERE appointment_id = $1 LIMIT 1) AS sheet_id,
       (SELECT id FROM protocols WHERE appointment_id = $1 LIMIT 1) AS protocol_id`,
    [appointment_id],
  );
  const { sheet_id, protocol_id } = apptRows.rows[0] ?? {};
  await Promise.allSettled([
    sheet_id ? publishApproved('appointment_sheets', sheet_id) : Promise.resolve(),
    protocol_id ? publishApproved('protocols', protocol_id) : Promise.resolve(),
  ]);
  await transition(pool, checkoutId, 'CHARGED', 'DOCS_UPDATED');

  // PB billing write-back — dry-run until PB REST API beta is confirmed (Open Item #2).
  await transition(pool, checkoutId, 'DOCS_UPDATED', 'PB_MARKED');
  logEvent('info', 'checkout.pb', '[dry-run] would mark billing complete via PB REST API', {
    checkout_id: checkoutId,
  });

  return { status: 'PB_MARKED', qbTxnId: charge.txnId };
}

/** Nicole's final Confirm: PB_MARKED → CLOSED. */
export async function closeCheckout(checkoutId: string): Promise<{ status: string }> {
  const ok = await transition(pool, checkoutId, 'PB_MARKED', 'CLOSED');
  if (ok) logEvent('info', 'checkout.close', 'checkout closed', { checkout_id: checkoutId });
  const r = await pool.query<{ status: string }>(`SELECT status FROM checkout WHERE id = $1`, [checkoutId]);
  return { status: r.rows[0]?.status ?? 'not_found' };
}
