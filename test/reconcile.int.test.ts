import { describe, it, expect, beforeEach, afterEach, afterAll } from 'vitest';
import { pool } from '../src/db/pool';
import {
  enqueueReconciliation,
  reconcileCheckout,
  processDueReconciliations,
  backoffMs,
} from '../src/checkout/reconcile';
import { setQboCustomerId } from '../src/checkout/customerMap';
import { buildPaymentBody } from '../src/integrations/quickbooks/payment';

// Reconciliation engine: durable outbox, idempotent enqueue, dry-run recording,
// dead-letter on missing mapping (live), transient backoff, and cap→dead-letter.
// DB-gated (uses real tables + guarded transitions).
const dbUp = await pool
  .query('SELECT 1')
  .then(() => true)
  .catch(() => false);

const suite = dbUp ? describe : describe.skip;

async function makeCheckout(opts: { invoiceId?: string | null; withClient?: boolean } = {}) {
  const clientId = opts.withClient
    ? (await pool.query<{ id: string }>(`INSERT INTO clients (name) VALUES ('Recon Test') RETURNING id`)).rows[0].id
    : null;
  const ch = await pool.query<{ id: string }>(
    `INSERT INTO checkout (client_id, status, qb_invoice_id) VALUES ($1, 'CHARGED', $2) RETURNING id`,
    [clientId, opts.invoiceId ?? 'mock-inv-abc'],
  );
  return { checkoutId: ch.rows[0].id, clientId };
}

async function enqueue(checkoutId: string, invoiceId: string | null, customerId: string | null) {
  const db = await pool.connect();
  try {
    await enqueueReconciliation(db, {
      checkoutId,
      invoiceId,
      customerId,
      amountCents: 17500,
      currency: 'USD',
      providerTxnId: 'txn-1',
    });
  } finally {
    db.release();
  }
}

const rowFor = (checkoutId: string) =>
  pool
    .query(`SELECT * FROM payment_reconciliation WHERE checkout_id = $1`, [checkoutId])
    .then((r) => r.rows[0]);

suite('payment reconciliation engine (integration)', () => {
  const saved = { ...process.env };
  const created: string[] = [];

  beforeEach(() => {
    // Default: QuickBooks not configured → dry-run everything.
    delete process.env.QB_CLIENT_ID;
    delete process.env.QB_CLIENT_SECRET;
    delete process.env.QB_REFRESH_TOKEN;
    delete process.env.QB_REALM_ID;
  });
  afterEach(async () => {
    process.env = { ...saved };
    for (const id of created.splice(0)) {
      await pool.query(`DELETE FROM checkout WHERE id = $1`, [id]); // cascades to reconciliation
    }
    await pool.query(`DELETE FROM clients WHERE name = 'Recon Test'`);
  });
  afterAll(async () => {
    await pool.end();
  });

  it('enqueue is idempotent (one row per checkout)', async () => {
    const { checkoutId } = await makeCheckout();
    created.push(checkoutId);
    await enqueue(checkoutId, 'mock-inv-abc', null);
    await enqueue(checkoutId, 'mock-inv-abc', null); // replay
    const r = await pool.query(`SELECT count(*)::int AS n FROM payment_reconciliation WHERE checkout_id = $1`, [checkoutId]);
    expect(r.rows[0].n).toBe(1);
  });

  it('records a dry-run payment (unconfigured) → RECORDED with a synthetic id', async () => {
    const { checkoutId } = await makeCheckout();
    created.push(checkoutId);
    await enqueue(checkoutId, 'mock-inv-abc', null);
    await reconcileCheckout(checkoutId);
    const row = await rowFor(checkoutId);
    expect(row.status).toBe('RECORDED');
    expect(row.accounting_payment_id).toBe(`dry-run-pmt-checkout:${checkoutId}:payment`);
  });

  it('dead-letters in live mode when the customer mapping is missing', async () => {
    const { checkoutId } = await makeCheckout({ invoiceId: 'inv-real-1', withClient: true });
    created.push(checkoutId);
    await enqueue(checkoutId, 'inv-real-1', null);
    process.env.QB_CLIENT_ID = 'cid';
    process.env.QB_CLIENT_SECRET = 'sec';
    process.env.QB_REFRESH_TOKEN = 'rt';
    process.env.QB_REALM_ID = 'realm';
    await reconcileCheckout(checkoutId);
    const row = await rowFor(checkoutId);
    expect(row.status).toBe('NEEDS_REVIEW');
    expect(row.last_error).toMatch(/customer mapping/);
  });

  it('resolves the customer from the mapping table and records (injected accounting write)', async () => {
    const { checkoutId, clientId } = await makeCheckout({ invoiceId: 'inv-real-2', withClient: true });
    created.push(checkoutId);
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
    expect(row.status).toBe('RECORDED');
    expect(row.accounting_payment_id).toBe('PMT-1');
    expect(row.customer_id).toBe('QBO-42'); // persisted back
  });

  it('backs off and retries on transient failure, then dead-letters after the cap', async () => {
    const { checkoutId } = await makeCheckout();
    created.push(checkoutId);
    await enqueue(checkoutId, 'mock-inv-abc', 'QBO-1');
    const transient = { record: async () => ({ ok: false as const, error: 'HTTP 503' }) };

    // First failure → FAILED, attempts=1, next_attempt_at in the future.
    await reconcileCheckout(checkoutId, transient);
    let row = await rowFor(checkoutId);
    expect(row.status).toBe('FAILED');
    expect(row.attempts).toBe(1);
    expect(new Date(row.next_attempt_at).getTime()).toBeGreaterThan(Date.now());

    // Not due yet → the worker leaves it alone.
    expect((await processDueReconciliations(10, transient)).processed).toBe(0);

    // Force it due and exhaust attempts → NEEDS_REVIEW.
    await pool.query(`UPDATE payment_reconciliation SET attempts = 7, next_attempt_at = now() WHERE checkout_id = $1`, [checkoutId]);
    await reconcileCheckout(checkoutId, transient);
    row = await rowFor(checkoutId);
    expect(row.status).toBe('NEEDS_REVIEW');
    expect(row.last_error).toMatch(/gave up after 8/);
  });

  it('dead-letters immediately on a permanent (4xx) failure without retrying', async () => {
    const { checkoutId } = await makeCheckout();
    created.push(checkoutId);
    await enqueue(checkoutId, 'mock-inv-abc', 'QBO-1');
    await reconcileCheckout(checkoutId, {
      record: async () => ({ ok: false, error: 'HTTP 400 invalid', permanent: true }),
    });
    const row = await rowFor(checkoutId);
    expect(row.status).toBe('NEEDS_REVIEW');
    expect(row.attempts).toBe(0); // never entered the backoff loop
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
