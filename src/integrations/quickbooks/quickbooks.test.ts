import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { chargeCard, interpretChargeResponse, toRequestId } from './index';
import { normalizeInvoice } from './invoice';

// Pure-logic unit tests (no network/DB): the dry-run gate, the status-aware
// charge interpretation, and the invoice normalization (esp. filtering the
// synthetic subtotal line).

describe('chargeCard dry-run gate', () => {
  const saved = { ...process.env };
  beforeEach(() => {
    delete process.env.QB_CLIENT_ID;
    delete process.env.QB_CLIENT_SECRET;
    delete process.env.QB_REFRESH_TOKEN;
    delete process.env.QB_REALM_ID;
  });
  afterEach(() => {
    process.env = { ...saved };
  });

  it('dry-runs (deterministic synthetic id, CAPTURED) when QB is not configured', async () => {
    const res = await chargeCard({ amountCents: 15000, currency: 'USD', idempotencyKey: 'checkout:c1:charge' });
    expect(res).toEqual({ ok: true, dryRun: true, status: 'CAPTURED', txnId: 'dry-run-txn-checkout:c1:charge' });
  });
});

describe('interpretChargeResponse', () => {
  it('treats CAPTURED / AUTHORIZED as success', () => {
    expect(interpretChargeResponse({ id: 'EMU1', status: 'CAPTURED' })).toMatchObject({ ok: true, txnId: 'EMU1', status: 'CAPTURED' });
    expect(interpretChargeResponse({ id: 'EMU2', status: 'AUTHORIZED' })).toMatchObject({ ok: true, status: 'AUTHORIZED' });
  });

  it('treats DECLINED as a failure even though it carries an id', () => {
    const res = interpretChargeResponse({ id: 'EMU3', status: 'DECLINED' });
    expect(res.ok).toBe(false);
    expect(res.txnId).toBe('EMU3');
    expect(res.error).toBe('charge declined');
  });

  it('fails closed on a missing/unknown status', () => {
    expect(interpretChargeResponse({ id: 'EMU4' }).ok).toBe(false);
  });
});

describe('normalizeInvoice', () => {
  it('keeps only sales-item lines (drops the synthetic subtotal) and uses TotalAmt', () => {
    const inv = normalizeInvoice({
      Id: '130',
      DocNumber: '1037',
      TotalAmt: 362.07,
      Balance: 362.07,
      CurrencyRef: { value: 'USD' },
      CustomerRef: { name: 'Sonnenschein Family Store', value: '24' },
      Line: [
        {
          Description: 'Rock Fountain',
          DetailType: 'SalesItemLineDetail',
          Amount: 275.0,
          SalesItemLineDetail: { Qty: 1, UnitPrice: 275, ItemRef: { name: 'Rock Fountain', value: '5' } },
        },
        {
          Description: 'Fountain Pump',
          DetailType: 'SalesItemLineDetail',
          Amount: 12.75,
          SalesItemLineDetail: { Qty: 1, UnitPrice: 12.75, ItemRef: { name: 'Pump', value: '11' } },
        },
        { DetailType: 'SubTotalLineDetail', Amount: 287.75 }, // synthetic — must be dropped
      ],
    });

    expect(inv.id).toBe('130');
    expect(inv.totalCents).toBe(36207);
    expect(inv.customerName).toBe('Sonnenschein Family Store');
    expect(inv.lines).toHaveLength(2);
    expect(inv.lines[0]).toEqual({
      description: 'Rock Fountain',
      amountCents: 27500,
      qty: 1,
      unitPriceCents: 27500,
      itemName: 'Rock Fountain',
    });
    // Summing the kept lines must not include the subtotal row.
    expect(inv.lines.reduce((s, l) => s + l.amountCents, 0)).toBe(28775);
  });
});

describe('toRequestId', () => {
  // Intuit rejects a request-id over 50 chars with PMT-4000. Our real keys are 52
  // and 58 chars, so this is not hypothetical — before the fix, every live charge
  // failed. Dry-run never caught it because dry-run never sends the header.
  const CHECKOUT_KEY = `checkout:${'0'.repeat(8)}-0000-0000-0000-${'0'.repeat(12)}:charge`;

  it('folds an over-long key under Intuit\'s 50-char cap', () => {
    expect(CHECKOUT_KEY.length).toBeGreaterThan(50);
    expect(toRequestId(CHECKOUT_KEY).length).toBeLessThanOrEqual(50);
    expect(toRequestId(`${CHECKOUT_KEY}:token`).length).toBeLessThanOrEqual(50);
  });

  it('is deterministic — a retry must reuse the same id or it double-charges', () => {
    expect(toRequestId(CHECKOUT_KEY)).toBe(toRequestId(CHECKOUT_KEY));
  });

  it('keeps the charge and tokenize ids distinct', () => {
    expect(toRequestId(CHECKOUT_KEY)).not.toBe(toRequestId(`${CHECKOUT_KEY}:token`));
  });

  it('passes a short key through untouched, so ids stay readable when they fit', () => {
    expect(toRequestId('short-key')).toBe('short-key');
  });
});
