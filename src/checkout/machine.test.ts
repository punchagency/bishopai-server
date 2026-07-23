import { describe, it, expect } from 'vitest';
import { summaryHash, pickTargetInvoice, summaryFromInvoice, type CheckoutSummary } from './machine';
import type { Invoice } from '../integrations/quickbooks';

const base: CheckoutSummary = {
  currency: 'USD',
  qb_invoice_id: 'mock-inv-1',
  line_items: [
    { label: 'Consultation', amount_cents: 15000 },
    { label: 'Magnesium', amount_cents: 2500 },
  ],
  total_cents: 17500,
  fullscript_changes: ['Magnesium'],
};

describe('summaryHash — binds approval to the exact figure', () => {
  it('is stable for the same figures', () => {
    expect(summaryHash(base)).toBe(summaryHash({ ...base }));
  });

  it('is independent of unrelated fields / JSONB key order (qb_invoice_id, fullscript_changes)', () => {
    const reordered: CheckoutSummary = {
      fullscript_changes: ['different'],
      total_cents: 17500,
      line_items: base.line_items,
      qb_invoice_id: 'mock-inv-999',
      currency: 'USD',
    };
    expect(summaryHash(reordered)).toBe(summaryHash(base));
  });

  it('changes when the total changes', () => {
    expect(summaryHash({ ...base, total_cents: 18000 })).not.toBe(summaryHash(base));
  });

  it('changes when a line item amount changes', () => {
    const tampered = { ...base, line_items: [{ label: 'Consultation', amount_cents: 99999 }, base.line_items[1]] };
    expect(summaryHash(tampered)).not.toBe(summaryHash(base));
  });

  it('changes when the currency changes', () => {
    expect(summaryHash({ ...base, currency: 'CAD' })).not.toBe(summaryHash(base));
  });
});

const inv = (id: string, txnDate: string, balanceCents: number, totalCents = 20000): Invoice => ({
  id,
  totalCents,
  balanceCents,
  currency: 'USD',
  txnDate,
  lines: [{ description: 'Consultation', amountCents: 15000 }, { description: 'Magnesium', amountCents: 5000 }],
});

describe('pickTargetInvoice — which invoice the charge settles', () => {
  it('returns null for no invoices', () => {
    expect(pickTargetInvoice([])).toBeNull();
  });

  it('prefers the most recent UNPAID invoice', () => {
    const chosen = pickTargetInvoice([
      inv('old-unpaid', '2026-06-01', 20000),
      inv('new-paid', '2026-07-05', 0),
      inv('mid-unpaid', '2026-07-01', 20000),
    ]);
    expect(chosen?.id).toBe('mid-unpaid'); // newest among unpaid
  });

  it('returns null when every invoice is already paid (never settle a paid one)', () => {
    // Charging against a paid invoice would overpay it / post a credit; the
    // caller falls through to the computed summary instead.
    expect(pickTargetInvoice([inv('a', '2026-06-01', 0), inv('b', '2026-07-05', 0)])).toBeNull();
  });
});

describe('summaryFromInvoice — sources the frozen figure from QBO', () => {
  it('uses TotalAmt for the total (not summed lines) and maps line labels', () => {
    // Lines sum to 20000 but TotalAmt is 21500 (e.g. tax) — the total must be authoritative.
    const invoice: Invoice = { ...inv('inv-9', '2026-07-06', 21500, 21500) };
    const summary = summaryFromInvoice(invoice, ['Magnesium']);
    expect(summary.qb_invoice_id).toBe('inv-9');
    expect(summary.total_cents).toBe(21500);
    expect(summary.line_items).toEqual([
      { label: 'Consultation', amount_cents: 15000 },
      { label: 'Magnesium', amount_cents: 5000 },
    ]);
    expect(summary.fullscript_changes).toEqual(['Magnesium']);
  });

  it('falls back to itemName then a default label', () => {
    const invoice: Invoice = {
      id: 'inv-x',
      totalCents: 5000,
      balanceCents: 5000,
      lines: [{ amountCents: 3000, itemName: 'Zinc' }, { amountCents: 2000 }],
    };
    expect(summaryFromInvoice(invoice, []).line_items).toEqual([
      { label: 'Zinc', amount_cents: 3000 },
      { label: 'Item', amount_cents: 2000 },
    ]);
  });
});
