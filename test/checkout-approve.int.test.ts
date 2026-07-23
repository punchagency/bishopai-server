import { describe, it, expect, beforeEach, afterEach, afterAll } from 'vitest';
import { pool } from '../src/db/pool';
import { approveAndCharge, sweepStuckCharges, resetFailedCharge } from '../src/checkout/machine';
import { processDueReconciliations } from '../src/checkout/reconcile';

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
    expect(result.qbTxnId).toBe(`dry-run-txn-checkout:${checkoutId}:charge:0`);

    // The reconciliation intent exists and was settled inline (dry-run).
    const recon = await pool.query(`SELECT * FROM payment_reconciliation WHERE checkout_id = $1`, [checkoutId]);
    expect(recon.rowCount).toBe(1);
    expect(recon.rows[0].status).toBe('RECORDED');
    expect(recon.rows[0].provider_txn_id).toBe(`dry-run-txn-checkout:${checkoutId}:charge:0`);
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

  // M1 — a charge stranded in CHARGING by a crash is flagged, not left silent.
  it('sweeps a charge stuck in CHARGING to CHARGE_REVIEW', async () => {
    const ch = await pool.query<{ id: string }>(
      `INSERT INTO checkout (status, summary_snapshot, qb_invoice_id)
            VALUES ('CHARGING', $1, 'mock-inv-stuck') RETURNING id`,
      [JSON.stringify(summary)],
    );
    const checkoutId = ch.rows[0].id;
    created.push(checkoutId);

    // Negative age → cutoff in the future, so this fresh CHARGING row qualifies.
    const { flagged } = await sweepStuckCharges(-60_000);
    expect(flagged).toBeGreaterThanOrEqual(1);

    const after = await pool.query<{ status: string }>(`SELECT status FROM checkout WHERE id = $1`, [checkoutId]);
    expect(after.rows[0].status).toBe('CHARGE_REVIEW');
  });

  // M4 — a cleanly-declined charge can be retried, as a genuinely NEW charge.
  it('reopens a CHARGE_FAILED checkout and the retry uses a fresh idempotency key', async () => {
    const ch = await pool.query<{ id: string }>(
      `INSERT INTO checkout (status, summary_snapshot, qb_invoice_id, charge_idempotency_key)
            VALUES ('CHARGE_FAILED', $1, 'mock-inv-retry', $2) RETURNING id`,
      [JSON.stringify(summary), 'checkout:seed:charge:0'],
    );
    const checkoutId = ch.rows[0].id;
    created.push(checkoutId);

    const reset = await resetFailedCharge(checkoutId);
    expect(reset.status).toBe('AWAITING_APPROVAL');

    const row = await pool.query<{ charge_attempts: number; charge_idempotency_key: string | null }>(
      `SELECT charge_attempts, charge_idempotency_key FROM checkout WHERE id = $1`, [checkoutId]);
    expect(row.rows[0].charge_attempts).toBe(1);
    expect(row.rows[0].charge_idempotency_key).toBeNull(); // cleared, so the retry mints a new one

    // The retry charge (dry-run) uses attempt 1's key — a new charge, not a replay.
    const result = await approveAndCharge(checkoutId);
    expect(result.qbTxnId).toBe(`dry-run-txn-checkout:${checkoutId}:charge:1`);

    // And CHARGE_REVIEW is NOT retryable (money may have moved).
    await pool.query(`UPDATE checkout SET status = 'CHARGE_REVIEW' WHERE id = $1`, [checkoutId]);
    const refused = await resetFailedCharge(checkoutId);
    expect(refused.status).toBe('CHARGE_REVIEW'); // unchanged
  });

  // M2 — a reconciliation stuck in RECORDING (crashed mid-record) is reclaimed.
  it('reclaims a RECORDING reconciliation whose lease has expired', async () => {
    const ch = await pool.query<{ id: string }>(
      `INSERT INTO checkout (status, summary_snapshot, qb_invoice_id)
            VALUES ('CHARGED', $1, 'mock-inv-lease') RETURNING id`,
      [JSON.stringify(summary)],
    );
    const checkoutId = ch.rows[0].id;
    created.push(checkoutId);

    // A row claimed into RECORDING 20 minutes ago and never advanced. Insert sets
    // updated_at directly (the trigger only fires on UPDATE), so the lease is stale.
    await pool.query(
      `INSERT INTO payment_reconciliation
         (checkout_id, invoice_id, amount_cents, currency, idempotency_key, status, next_attempt_at, updated_at)
       VALUES ($1, 'mock-inv-lease', 15000, 'USD', $2, 'RECORDING', now(), now() - interval '20 minutes')`,
      [checkoutId, `checkout:${checkoutId}:payment`],
    );

    const { processed } = await processDueReconciliations();
    expect(processed).toBeGreaterThanOrEqual(1);

    const after = await pool.query<{ status: string }>(
      `SELECT status FROM payment_reconciliation WHERE checkout_id = $1`, [checkoutId]);
    expect(after.rows[0].status).toBe('RECORDED'); // reclaimed and completed (dry-run)
  });
});
