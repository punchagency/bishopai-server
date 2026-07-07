import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { chargeCard, interpretChargeResponse } from './index';
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
