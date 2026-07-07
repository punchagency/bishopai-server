import { describe, it, expect, beforeEach, afterEach, afterAll } from 'vitest';
import { pool } from '../src/db/pool';
import { approveAndCharge } from '../src/checkout/machine';

// End-to-end machine wiring: approve → (dry-run) charge → CHARGED + reconciliation
// intent committed atomically → inline reconcile records the payment. Confirms the
// charge can never exist without a reconciliation row, and the happy path settles
// it. DB-gated.
const dbUp = await pool
  .query('SELECT 1')
  .then(() => true)
  .catch(() => false);

const suite = dbUp ? describe : describe.skip;

const summary = {
  currency: 'USD',
  qb_invoice_id: 'mock-inv-e2e',
  line_items: [{ label: 'Consultation', amount_cents: 15000 }],
  total_cents: 15000,
  fullscript_changes: [],
};

suite('approveAndCharge → reconciliation wiring (integration)', () => {
  const saved = { ...process.env };
  const created: string[] = [];

  beforeEach(() => {
    delete process.env.QB_CLIENT_ID; // dry-run
    delete process.env.QB_CLIENT_SECRET;
    delete process.env.QB_REFRESH_TOKEN;
    delete process.env.QB_REALM_ID;
  });
  afterEach(async () => {
    process.env = { ...saved };
    for (const id of created.splice(0)) await pool.query(`DELETE FROM checkout WHERE id = $1`, [id]);
  });
  afterAll(async () => {
    await pool.end();
  });

  it('marks the checkout paid AND records the reconciliation in one flow', async () => {
    const ch = await pool.query<{ id: string }>(
      `INSERT INTO checkout (status, summary_snapshot, qb_invoice_id)
            VALUES ('AWAITING_APPROVAL', $1, 'mock-inv-e2e') RETURNING id`,
      [JSON.stringify(summary)],
    );
    const checkoutId = ch.rows[0].id;
    created.push(checkoutId);

    const result = await approveAndCharge(checkoutId);
    expect(result.status).toBe('PB_MARKED');
    expect(result.qbTxnId).toBe(`dry-run-txn-checkout:${checkoutId}:charge`);

    // The reconciliation intent exists and was settled inline (dry-run).
    const recon = await pool.query(`SELECT * FROM payment_reconciliation WHERE checkout_id = $1`, [checkoutId]);
    expect(recon.rowCount).toBe(1);
    expect(recon.rows[0].status).toBe('RECORDED');
    expect(recon.rows[0].provider_txn_id).toBe(`dry-run-txn-checkout:${checkoutId}:charge`);
    expect(recon.rows[0].accounting_payment_id).toBe(`dry-run-pmt-checkout:${checkoutId}:payment`);
    expect(recon.rows[0].amount_cents).toBe(15000);
  });

  it('re-approving after completion does not create a second reconciliation', async () => {
    const ch = await pool.query<{ id: string }>(
      `INSERT INTO checkout (status, summary_snapshot, qb_invoice_id)
            VALUES ('AWAITING_APPROVAL', $1, 'mock-inv-e2e') RETURNING id`,
      [JSON.stringify(summary)],
    );
    const checkoutId = ch.rows[0].id;
    created.push(checkoutId);

    await approveAndCharge(checkoutId);
    const second = await approveAndCharge(checkoutId); // not AWAITING_APPROVAL anymore
    expect(second.error).toBeDefined();

    const n = await pool.query(`SELECT count(*)::int AS n FROM payment_reconciliation WHERE checkout_id = $1`, [checkoutId]);
    expect(n.rows[0].n).toBe(1);
  });
});
