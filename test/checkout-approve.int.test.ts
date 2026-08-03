import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll } from 'vitest';
import {
  emulatorUp,
  installFirestore,
  uninstallFirestore,
  clearFirestore,
} from './firestore';
import { seedCheckout } from './fixtures';
import type { IDatabase } from '../src/db/interfaces/repositories';
import { approveAndCharge, sweepStuckCharges, resetFailedCharge } from '../src/checkout/machine';
import { processDueReconciliations } from '../src/checkout/reconcile';

// End-to-end machine wiring: approve → (dry-run) charge → CHARGED + reconciliation
// intent committed atomically → inline reconcile records the payment. Confirms the
// charge can never exist without a reconciliation row, and the happy path settles
// it. Emulator-gated.
const up = await emulatorUp();
const suite = up ? describe : describe.skip;
if (!up) {
  console.log('[checkout-approve.int] Firestore emulator not running — skipping. Start: npm run firestore:emulator');
}

const summary = {
  currency: 'USD',
  qb_invoice_id: 'mock-inv-e2e',
  line_items: [{ label: 'Consultation', amount_cents: 15000 }],
  total_cents: 15000,
  fullscript_changes: [],
};

suite('approveAndCharge → reconciliation wiring (integration)', () => {
  const saved = { ...process.env };
  let db: IDatabase;

  beforeAll(() => {
    db = installFirestore('checkout-approve-int');
  });
  afterAll(() => uninstallFirestore());

  beforeEach(async () => {
    await clearFirestore(db);
    delete process.env.QB_CLIENT_ID; // dry-run
    delete process.env.QB_CLIENT_SECRET;
    delete process.env.QB_REFRESH_TOKEN;
    delete process.env.QB_REALM_ID;
  });
  afterEach(() => {
    process.env = { ...saved };
  });

  it('marks the checkout paid AND records the reconciliation in one flow', async () => {
    const { id: checkoutId } = await seedCheckout(db, {
      status: 'AWAITING_APPROVAL',
      summary_snapshot: summary,
      qb_invoice_id: 'mock-inv-e2e',
    });

    const result = await approveAndCharge(checkoutId);
    expect(result.status).toBe('PB_MARKED');
    expect(result.qbTxnId).toBe(`dry-run-txn-checkout:${checkoutId}:charge:0`);

    // The reconciliation intent exists and was settled inline (dry-run).
    const recon = await db.checkouts.findReconciliationByCheckout(checkoutId);
    expect(recon).not.toBeNull();
    expect(recon!.status).toBe('RECORDED');
    expect(recon!.provider_txn_id).toBe(`dry-run-txn-checkout:${checkoutId}:charge:0`);
    expect(recon!.accounting_payment_id).toBe(`dry-run-pmt-checkout:${checkoutId}:payment`);
    expect(recon!.amount_cents).toBe(15000);
  });

  it('re-approving after completion does not create a second reconciliation', async () => {
    const { id: checkoutId } = await seedCheckout(db, {
      status: 'AWAITING_APPROVAL',
      summary_snapshot: summary,
      qb_invoice_id: 'mock-inv-e2e',
    });

    await approveAndCharge(checkoutId);
    const second = await approveAndCharge(checkoutId); // not AWAITING_APPROVAL anymore
    expect(second.error).toBeDefined();

    // The reconciliation's document id IS the checkout id, which is what makes
    // enqueue idempotent — a second one cannot exist by construction, so this
    // asserts the ledger as a whole holds exactly one row for this checkout.
    const all = await db.checkouts.listReconciliations();
    expect(all.filter((r) => r.checkout_id === checkoutId)).toHaveLength(1);
  });

  // M1 — a charge stranded in CHARGING by a crash is flagged, not left silent.
  it('sweeps a charge stuck in CHARGING to CHARGE_REVIEW', async () => {
    const { id: checkoutId } = await seedCheckout(db, {
      status: 'CHARGING',
      summary_snapshot: summary,
      qb_invoice_id: 'mock-inv-stuck',
    });

    // Negative age → cutoff in the future, so this fresh CHARGING row qualifies.
    const { flagged } = await sweepStuckCharges(-60_000);
    expect(flagged).toBeGreaterThanOrEqual(1);

    const after = await db.checkouts.findById(checkoutId);
    expect(after!.status).toBe('CHARGE_REVIEW');
  });

  // M4 — a cleanly-declined charge can be retried, as a genuinely NEW charge.
  it('reopens a CHARGE_FAILED checkout and the retry uses a fresh idempotency key', async () => {
    const { id: checkoutId } = await seedCheckout(db, {
      status: 'CHARGE_FAILED',
      summary_snapshot: summary,
      qb_invoice_id: 'mock-inv-retry',
      charge_idempotency_key: 'checkout:seed:charge:0',
    });

    const reset = await resetFailedCharge(checkoutId);
    expect(reset.status).toBe('AWAITING_APPROVAL');

    const row = await db.checkouts.findById(checkoutId);
    expect(row!.charge_attempts).toBe(1);
    expect(row!.charge_idempotency_key).toBeNull(); // cleared, so the retry mints a new one

    // The retry charge (dry-run) uses attempt 1's key — a new charge, not a replay.
    const result = await approveAndCharge(checkoutId);
    expect(result.qbTxnId).toBe(`dry-run-txn-checkout:${checkoutId}:charge:1`);

    // And CHARGE_REVIEW is NOT retryable (money may have moved).
    const charged = await db.checkouts.findById(checkoutId);
    await db.checkouts.save({ ...charged!, status: 'CHARGE_REVIEW' });
    const refused = await resetFailedCharge(checkoutId);
    expect(refused.status).toBe('CHARGE_REVIEW'); // unchanged
  });

  // M2 — a reconciliation stuck in RECORDING (crashed mid-record) is reclaimed.
  it('reclaims a RECORDING reconciliation whose lease has expired', async () => {
    const { id: checkoutId } = await seedCheckout(db, {
      status: 'CHARGED',
      summary_snapshot: summary,
      qb_invoice_id: 'mock-inv-lease',
    });

    // A row claimed into RECORDING 20 minutes ago and never advanced. There is no
    // updated_at trigger here — the field is written explicitly by whoever writes
    // the document — so the stale lease is simply stated.
    const twentyMinutesAgo = new Date(Date.now() - 20 * 60_000).toISOString();
    await db.checkouts.saveReconciliation({
      id: checkoutId, // document id == checkout_id
      checkout_id: checkoutId,
      invoice_id: 'mock-inv-lease',
      amount_cents: 15000,
      currency: 'USD',
      idempotency_key: `checkout:${checkoutId}:payment`,
      status: 'RECORDING',
      attempts: 0,
      next_attempt_at: new Date().toISOString(),
      created_at: twentyMinutesAgo,
      updated_at: twentyMinutesAgo,
    });

    const { processed } = await processDueReconciliations();
    expect(processed).toBeGreaterThanOrEqual(1);

    const after = await db.checkouts.findReconciliationByCheckout(checkoutId);
    expect(after!.status).toBe('RECORDED'); // reclaimed and completed (dry-run)
  });
});
