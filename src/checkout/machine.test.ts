import { describe, it, expect } from 'vitest';
import { summaryHash, type CheckoutSummary } from './machine';

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
