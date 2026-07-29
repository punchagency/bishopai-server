import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import {
  emulatorUp,
  installFirestore,
  uninstallFirestore,
  clearFirestore,
} from './firestore';
import type { IDatabase } from '../src/db/interfaces/repositories';
import type { Checkout } from '../src/db/interfaces/types';

const up = await emulatorUp();
const suite = up ? describe : describe.skip;
if (!up) {
  console.log('[checkout.firestore] Firestore emulator not running — skipping. Start: npm run firestore:emulator');
}

let machine: typeof import('../src/checkout/machine');

const APPT = 'appt-1';
const NOW = '2026-07-01T10:00:00.000Z';

const baseCheckout = (over: Partial<Checkout> = {}): Checkout => ({
  id: APPT,
  appointment_id: APPT,
  client_id: 'client-a',
  pb_appointment_id: 'pb-1',
  status: 'AWAITING_APPROVAL',
  summary_snapshot: {
    currency: 'USD',
    qb_invoice_id: 'mock-inv-appt-1',
    line_items: [{ label: 'Consultation', amount_cents: 15000 }],
    total_cents: 15000,
    fullscript_changes: [],
  },
  qb_invoice_id: 'mock-inv-appt-1',
  charge_attempts: 0,
  created_at: NOW,
  updated_at: NOW,
  ...over,
});

suite('checkout money path against Firestore', () => {
  let db: IDatabase;

  beforeAll(async () => {
    db = installFirestore();
    machine = await import('../src/checkout/machine');
  });

  afterAll(() => uninstallFirestore());

  beforeEach(async () => {
    await clearFirestore(db);
    await db.clients.save({
      id: 'client-a',
      name: 'Ada Client',
      email: 'ada@example.com',
      created_at: NOW,
      updated_at: NOW,
    });
    await db.appointments.save({
      id: APPT,
      client_id: 'client-a',
      pb_id: 'pb-1',
      starts_at: NOW,
      ends_at: '2026-07-01T11:00:00.000Z',
      status: 'completed',
      created_at: NOW,
      updated_at: NOW,
    });
  });

  // ---- Detection is idempotent -------------------------------------------

  it('detects once; a re-detection returns the same checkout', async () => {
    const first = await machine.detectCheckout(APPT);
    expect(first?.status).toBe('AWAITING_APPROVAL');

    const second = await machine.detectCheckout(APPT);
    expect(second?.checkoutId).toBe(first?.checkoutId);
    expect(await db.checkouts.listAll()).toHaveLength(1);
  });

  // The M5 finding: keying detection on pb_appointment_id let an appointment with
  // a null pb_id spawn two checkouts, and therefore two charges for one session.
  it('creates only one checkout for an appointment with no pb_id', async () => {
    await db.appointments.save({
      id: 'appt-nopb',
      client_id: 'client-a',
      pb_id: null,
      starts_at: NOW,
      ends_at: '2026-07-01T11:00:00.000Z',
      status: 'completed',
      created_at: NOW,
      updated_at: NOW,
    });

    await Promise.all([machine.detectCheckout('appt-nopb'), machine.detectCheckout('appt-nopb')]);
    const forAppt = (await db.checkouts.listAll()).filter((c) => c.appointment_id === 'appt-nopb');
    expect(forAppt).toHaveLength(1);
  });

  // ---- The CAS that the no-double-charge guarantee rests on ---------------

  it('transitions only from the expected state', async () => {
    await db.checkouts.save(baseCheckout());

    expect(await db.checkouts.transition(APPT, 'AWAITING_APPROVAL', 'CHARGING')).toBe(true);
    // Second attempt from the same `from` must lose — the row has moved on.
    expect(await db.checkouts.transition(APPT, 'AWAITING_APPROVAL', 'CHARGING')).toBe(false);
    expect((await db.checkouts.findById(APPT))?.status).toBe('CHARGING');
  });

  it('lets exactly one of two concurrent transitions win', async () => {
    await db.checkouts.save(baseCheckout());
    const results = await Promise.all([
      db.checkouts.transition(APPT, 'AWAITING_APPROVAL', 'CHARGING'),
      db.checkouts.transition(APPT, 'AWAITING_APPROVAL', 'CHARGING'),
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);
  });

  // ---- Approve: one charge, one approval ---------------------------------

  it('charges once and records one approval', async () => {
    await db.checkouts.save(baseCheckout());
    const r = await machine.approveAndCharge(APPT);

    expect(r.status).toBe('PB_MARKED');
    const approvals = await db.checkouts.listApprovalsByCheckout(APPT);
    expect(approvals).toHaveLength(1);
    expect(approvals[0]).toMatchObject({
      type: 'checkout',
      status: 'approved',
      amount_cents: 15000,
      approved_by: 'nicole',
    });
    // The approval is bound to the exact figure shown.
    expect(approvals[0].summary_hash).toBeTruthy();
  });

  it('does not charge twice when two approvals race', async () => {
    await db.checkouts.save(baseCheckout());

    const [a, b] = await Promise.all([
      machine.approveAndCharge(APPT),
      machine.approveAndCharge(APPT),
    ]);

    // One walks the machine; the other is told a charge is already in progress.
    const outcomes = [a.error, b.error];
    expect(outcomes.filter((e) => e === 'already in progress')).toHaveLength(1);

    // And crucially: exactly one approval, so exactly one authorization.
    expect(await db.checkouts.listApprovalsByCheckout(APPT)).toHaveLength(1);
  });

  it('refuses to approve a checkout that is not awaiting approval', async () => {
    await db.checkouts.save(baseCheckout({ status: 'CHARGED' }));
    const r = await machine.approveAndCharge(APPT);
    expect(r.error).toBe('not awaiting approval');
    expect(await db.checkouts.listApprovalsByCheckout(APPT)).toHaveLength(0);
  });

  it('refuses to approve without a frozen summary', async () => {
    await db.checkouts.save(baseCheckout({ summary_snapshot: null }));
    const r = await machine.approveAndCharge(APPT);
    expect(r.error).toBe('no summary to approve');
  });

  // ---- CHARGED and the outbox commit together ----------------------------

  it('commits CHARGED and the reconciliation intent together', async () => {
    await db.checkouts.save(baseCheckout());
    await machine.approveAndCharge(APPT);

    const recon = await db.checkouts.findReconciliationByCheckout(APPT);
    expect(recon).not.toBeNull();
    expect(recon).toMatchObject({
      checkout_id: APPT,
      amount_cents: 15000,
      idempotency_key: `checkout:${APPT}:payment`,
    });
    // A captured charge must never exist without its outbox row.
    const checkout = await db.checkouts.findById(APPT);
    expect(['CHARGED', 'DOCS_UPDATED', 'PB_MARKED']).toContain(checkout?.status);
  });

  // If the sweeper moved the row while a slow charge was succeeding, NO outbox row
  // may be written — the all-or-nothing transaction is what guarantees that.
  it('enqueues no reconciliation when the row is no longer CHARGING', async () => {
    await db.checkouts.save(baseCheckout({ status: 'CHARGE_REVIEW' }));

    const marked = await db.checkouts.markChargedWithReconciliation(
      APPT,
      { qb_txn_id: 'txn-1' },
      {
        id: APPT,
        checkout_id: APPT,
        amount_cents: 15000,
        currency: 'USD',
        status: 'PENDING',
        idempotency_key: `checkout:${APPT}:payment`,
        attempts: 0,
        next_attempt_at: NOW,
        created_at: NOW,
        updated_at: NOW,
      },
    );

    expect(marked).toBe(false);
    expect(await db.checkouts.findReconciliationByCheckout(APPT)).toBeNull();
    expect((await db.checkouts.findById(APPT))?.status).toBe('CHARGE_REVIEW');
  });

  it('enqueues the reconciliation only once', async () => {
    await db.checkouts.save(baseCheckout({ status: 'CHARGING' }));
    const recon = {
      id: APPT,
      checkout_id: APPT,
      amount_cents: 15000,
      currency: 'USD',
      status: 'PENDING' as const,
      idempotency_key: `checkout:${APPT}:payment`,
      attempts: 0,
      next_attempt_at: NOW,
      created_at: NOW,
      updated_at: NOW,
    };
    expect(await db.checkouts.markChargedWithReconciliation(APPT, {}, recon)).toBe(true);
    // Replaying from CHARGED is refused, so no second outbox row can appear.
    expect(await db.checkouts.markChargedWithReconciliation(APPT, {}, recon)).toBe(false);
  });

  // ---- Idempotency key semantics (M4) ------------------------------------

  it('keeps the first idempotency key within an attempt', async () => {
    await db.checkouts.save(baseCheckout());
    await db.checkouts.claimIdempotencyKey(APPT, 'key-one');
    await db.checkouts.claimIdempotencyKey(APPT, 'key-two');
    expect((await db.checkouts.findById(APPT))?.charge_idempotency_key).toBe('key-one');
  });

  it('mints a NEW key after a clean decline is reopened', async () => {
    await db.checkouts.save(
      baseCheckout({ status: 'CHARGE_FAILED', charge_idempotency_key: 'checkout:appt-1:charge:0' }),
    );

    expect(await machine.resetFailedCharge(APPT)).toEqual({ status: 'AWAITING_APPROVAL' });
    const after = await db.checkouts.findById(APPT);
    // Attempt bumped and key cleared → the next approve is a genuinely new charge,
    // not a replay of the decline.
    expect(after?.charge_attempts).toBe(1);
    expect(after?.charge_idempotency_key).toBeNull();
    expect(after?.qb_txn_id).toBeNull();
  });

  // The whole point of separating CHARGE_REVIEW from CHARGE_FAILED: money may
  // already have moved, so re-charging could double-charge.
  it('refuses to reopen a CHARGE_REVIEW checkout', async () => {
    await db.checkouts.save(baseCheckout({ status: 'CHARGE_REVIEW' }));
    const r = await machine.resetFailedCharge(APPT);
    expect(r.status).toBe('CHARGE_REVIEW');
    expect((await db.checkouts.findById(APPT))?.charge_attempts).toBe(0);
  });

  // ---- Stuck-charge sweeper ---------------------------------------------

  it('flags a charge stranded in CHARGING, and is idempotent', async () => {
    await db.checkouts.save(
      baseCheckout({ status: 'CHARGING', updated_at: '2026-06-01T00:00:00.000Z' }),
    );

    expect(await machine.sweepStuckCharges(60_000)).toEqual({ flagged: 1 });
    expect((await db.checkouts.findById(APPT))?.status).toBe('CHARGE_REVIEW');
    // Second sweep finds nothing left to flag.
    expect(await machine.sweepStuckCharges(60_000)).toEqual({ flagged: 0 });
  });

  it('leaves a recently-updated CHARGING row alone', async () => {
    await db.checkouts.save(baseCheckout({ status: 'CHARGING', updated_at: new Date().toISOString() }));
    expect(await machine.sweepStuckCharges(10 * 60_000)).toEqual({ flagged: 0 });
    expect((await db.checkouts.findById(APPT))?.status).toBe('CHARGING');
  });

  // ---- Close -------------------------------------------------------------

  it('closes only from PB_MARKED', async () => {
    await db.checkouts.save(baseCheckout({ status: 'CHARGED' }));
    expect((await machine.closeCheckout(APPT)).status).toBe('CHARGED');

    await db.checkouts.save(baseCheckout({ status: 'PB_MARKED' }));
    expect((await machine.closeCheckout(APPT)).status).toBe('CLOSED');
  });
});
