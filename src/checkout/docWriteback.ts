import { pool } from '../db/pool';
import { logEvent } from '../observability/logger';

// WF2 doc write-backs: after a charge, stamp the outcome onto the internal
// Appointment Sheet (payment status/amount/refs) and refresh the client-facing
// Protocol's supplement list from the current plan. Both write into the docs'
// `content_json`, so the subsequent Drive publish re-renders them with the new
// content. Best-effort and idempotent (re-running overwrites the same keys).

export interface CheckoutOutcome {
  status: string; // paid | dry-run | failed
  amountCents: number;
  currency: string;
  qbTxnId?: string | null;
  qbInvoiceId?: string | null;
  note?: string | null;
}

export async function recordCheckoutOutcome(appointmentId: string | null, outcome: CheckoutOutcome): Promise<void> {
  if (!appointmentId) return;

  const billing = {
    status: outcome.status,
    amount_cents: outcome.amountCents,
    currency: outcome.currency,
    qb_txn_id: outcome.qbTxnId ?? null,
    qb_invoice_id: outcome.qbInvoiceId ?? null,
    note: outcome.note ?? null,
    paid_at: new Date().toISOString(),
  };

  // Internal sheet: stamp the billing outcome.
  await pool.query(
    `UPDATE appointment_sheets
        SET content_json = jsonb_set(coalesce(content_json, '{}'::jsonb), '{billing}', $2::jsonb, true)
      WHERE appointment_id = $1`,
    [appointmentId, JSON.stringify(billing)],
  );

  // Client-facing protocol: refresh its supplement list from the current plan
  // (the `supplements` table is the source of truth, kept current by WF1).
  const cr = await pool.query<{ client_id: string | null }>(`SELECT client_id FROM appointments WHERE id = $1`, [appointmentId]);
  const clientId = cr.rows[0]?.client_id ?? null;
  if (clientId) {
    const supps = (
      await pool.query<{ name: string; dose: string | null; qty: number | null }>(
        `SELECT name, dose, qty FROM supplements WHERE client_id = $1 ORDER BY name`,
        [clientId],
      )
    ).rows;
    const asNote = supps.map((s) => ({ name: s.name, dose: s.dose ?? null, quantity: s.qty ?? null, change: 'continue' as const }));
    await pool.query(
      `UPDATE protocols
          SET content_json = jsonb_set(coalesce(content_json, '{}'::jsonb), '{supplements}', $2::jsonb, true)
        WHERE appointment_id = $1`,
      [appointmentId, JSON.stringify(asNote)],
    );
  }

  logEvent('info', 'checkout.docs', 'recorded checkout outcome on docs', {
    appointment_id: appointmentId,
    status: outcome.status,
  });
}
