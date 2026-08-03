import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll } from 'vitest';
import {
  emulatorUp,
  installFirestore,
  uninstallFirestore,
  clearFirestore,
} from './firestore';
import { seedClient, seedCheckout } from './fixtures';
import type { IDatabase } from '../src/db/interfaces/repositories';
import {
  buildReconciliation,
  reconcileCheckout,
  processDueReconciliations,
  backoffMs,
} from '../src/checkout/reconcile';
import { setQboCustomerId } from '../src/checkout/customerMap';
import { buildPaymentBody } from '../src/integrations/quickbooks/payment';

// Reconciliation engine: durable outbox, idempotent enqueue, dry-run recording,
// dead-letter on missing mapping (live), transient backoff, and cap -> dead-letter.
const up = await emulatorUp();
const suite = up ? describe : describe.skip;
if (!up) {
  console.log('[reconcile.int] Firestore emulator not running - skipping. Start: npm run firestore:emulator');
}

suite('payment reconciliation engine (integration)', () => {
  const saved = { ...process.env };
  let db: IDatabase;

  beforeAll(() => {
    db = installFirestore('reconcile-int');
  });
  afterAll(() => uninstallFirestore());

  beforeEach(async () => {
    await clearFirestore(db);
    // Default: QuickBooks not configured -> dry-run everything.
    delete process.env.QB_CLIENT_ID;
    delete process.env.QB_CLIENT_SECRET;
    delete process.env.QB_REFRESH_TOKEN;
    delete process.env.QB_REALM_ID;
  });
  afterEach(() => {
    process.env = { ...saved };
  });

  async function makeCheckout(opts: { invoiceId?: string | null; withClient?: boolean } = {}) {
    const clientId = opts.withClient ? (await seedClient(db, { name: 'Recon Test' })).id : null;
    const checkout = await seedCheckout(db, {
      client_id: clientId,
      status: 'CHARGED',
      qb_invoice_id: opts.invoiceId ?? 'mock-inv-abc',
    });
    return { checkoutId: checkout.id, clientId };
  }

  // The intent is built by the money path and committed with the CHARGED
  // transition; here it is written directly, since these tests are about what
  // happens to the row afterwards. saveReconciliation keys on the checkout id,
  // which is what makes the enqueue idempotent.
  const enqueue = (checkoutId: string, invoiceId: string | null, customerId: string | null) =>
    db.checkouts.saveReconciliation(
      buildReconciliation({
        checkoutId,
        invoiceId,
        customerId,
        amountCents: 17500,
        currency: 'USD',
        providerTxnId: 'txn-1',
      }),
    );

  const rowFor = (checkoutId: string) => db.checkouts.findReconciliationByCheckout(checkoutId);

  it('enqueue is idempotent (one row per checkout)', async () => {
    const { checkoutId } = await makeCheckout();
    await enqueue(checkoutId, 'mock-inv-abc', null);
    await enqueue(checkoutId, 'mock-inv-abc', null); // replay
    const all = await db.checkouts.listReconciliations();
    expect(all.filter((r) => r.checkout_id === checkoutId)).toHaveLength(1);
  });

  it('records a dry-run payment (unconfigured) -> RECORDED with a synthetic id', async () => {
    const { checkoutId } = await makeCheckout();
    await enqueue(checkoutId, 'mock-inv-abc', null);
    await reconcileCheckout(checkoutId);
    const row = await rowFor(checkoutId);
    expect(row!.status).toBe('RECORDED');
    expect(row!.accounting_payment_id).toBe(`dry-run-pmt-checkout:${checkoutId}:payment`);
  });

  it('dead-letters in live mode when the customer mapping is missing', async () => {
    const { checkoutId } = await makeCheckout({ invoiceId: 'inv-real-1', withClient: true });
    await enqueue(checkoutId, 'inv-real-1', null);
    process.env.QB_CLIENT_ID = 'cid';
    process.env.QB_CLIENT_SECRET = 'sec';
    process.env.QB_REFRESH_TOKEN = 'rt';
    process.env.QB_REALM_ID = 'realm';
    await reconcileCheckout(checkoutId);
    const row = await rowFor(checkoutId);
    expect(row!.status).toBe('NEEDS_REVIEW');
    expect(row!.last_error).toMatch(/customer mapping/);
  });

  it('resolves the customer from the mapping and records (injected accounting write)', async () => {
    const { checkoutId, clientId } = await makeCheckout({ invoiceId: 'inv-real-2', withClient: true });
    await setQboCustomerId(clientId!, 'QBO-42');
    await enqueue(checkoutId, 'inv-real-2', null); // customer id unknown at enqueue
    process.env.QB_CLIENT_ID = 'cid';
    process.env.QB_CLIENT_SECRET = 'sec';
    process.env.QB_REFRESH_TOKEN = 'rt';
    process.env.QB_REALM_ID = 'realm';

    let seenCustomer = '';
    await reconcileCheckout(checkoutId, {
      record: async (input) => {
        seenCustomer = input.customerId;
        return { ok: true, paymentId: 'PMT-1' };
      },
    });
    expect(seenCustomer).toBe('QBO-42');
    const row = await rowFor(checkoutId);
    expect(row!.status).toBe('RECORDED');
    expect(row!.accounting_payment_id).toBe('PMT-1');
    expect(row!.customer_id).toBe('QBO-42'); // persisted back
  });

  it('backs off and retries on transient failure, then dead-letters after the cap', async () => {
    const { checkoutId } = await makeCheckout();
    await enqueue(checkoutId, 'mock-inv-abc', 'QBO-1');
    const transient = { record: async () => ({ ok: false as const, error: 'HTTP 503' }) };

    // First failure -> FAILED, attempts=1, next_attempt_at in the future.
    await reconcileCheckout(checkoutId, transient);
    let row = await rowFor(checkoutId);
    expect(row!.status).toBe('FAILED');
    expect(row!.attempts).toBe(1);
    expect(new Date(row!.next_attempt_at).getTime()).toBeGreaterThan(Date.now());

    // Not due yet -> the worker leaves it alone.
    expect((await processDueReconciliations(10, transient)).processed).toBe(0);

    // Force it due and exhaust attempts -> NEEDS_REVIEW.
    await db.checkouts.saveReconciliation({
      ...row!,
      attempts: 7,
      next_attempt_at: new Date().toISOString(),
    });
    await reconcileCheckout(checkoutId, transient);
    row = await rowFor(checkoutId);
    expect(row!.status).toBe('NEEDS_REVIEW');
    expect(row!.last_error).toMatch(/gave up after 8/);
  });

  it('dead-letters immediately on a permanent (4xx) failure without retrying', async () => {
    const { checkoutId } = await makeCheckout();
    await enqueue(checkoutId, 'mock-inv-abc', 'QBO-1');
    await reconcileCheckout(checkoutId, {
      record: async () => ({ ok: false, error: 'HTTP 400 invalid', permanent: true }),
    });
    const row = await rowFor(checkoutId);
    expect(row!.status).toBe('NEEDS_REVIEW');
    // The claim is now the single place that counts a try, so one attempt is
    // recorded — the pg version counted only retryable failures and left this at
    // 0. What "without retrying" means either way is that the backoff loop was
    // never entered: exactly one try, and no future retry scheduled.
    expect(row!.attempts).toBe(1);
    expect(new Date(row!.next_attempt_at).getTime()).toBeLessThanOrEqual(Date.now());
  });

  it('backoffMs grows and is capped', () => {
    expect(backoffMs(0)).toBeGreaterThanOrEqual(60_000);
    expect(backoffMs(1)).toBeGreaterThan(backoffMs(0));
    expect(backoffMs(50)).toBeLessThanOrEqual(6 * 60 * 60_000 * 1.25);
  });
});

describe('buildPaymentBody', () => {
  it('links the payment amount to the invoice', () => {
    const body = buildPaymentBody({ invoiceId: 'inv-9', customerId: 'C-3', amountCents: 36207, currency: 'USD', idempotencyKey: 'k' });
    expect(body).toEqual({
      TotalAmt: 362.07,
      CustomerRef: { value: 'C-3' },
      Line: [{ Amount: 362.07, LinkedTxn: [{ TxnId: 'inv-9', TxnType: 'Invoice' }] }],
    });
  });
});
