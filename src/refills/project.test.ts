import { describe, it, expect } from 'vitest';
import { parseDailyDose, computeRunOut } from './project';

describe('parseDailyDose', () => {
  it('defaults to 1/day for empty or bare-strength doses', () => {
    expect(parseDailyDose(null)).toBe(1);
    expect(parseDailyDose('')).toBe(1);
    expect(parseDailyDose('400mg')).toBe(1);
  });

  it('multiplies unit count by frequency', () => {
    expect(parseDailyDose('2 caps daily')).toBe(2);
    expect(parseDailyDose('1 tablet twice daily')).toBe(2);
    expect(parseDailyDose('2 capsules twice daily')).toBe(4);
    expect(parseDailyDose('3 caps three times daily')).toBe(9);
  });

  it('reads shorthand frequencies (bid/tid) and x-notation', () => {
    expect(parseDailyDose('1 cap bid')).toBe(2);
    expect(parseDailyDose('1 tab tid')).toBe(3);
    expect(parseDailyDose('2 caps 2x')).toBe(4);
  });

  it('handles every-other-day as half a unit/day', () => {
    expect(parseDailyDose('1 cap every other day')).toBe(0.5);
  });

  it('never returns <= 0', () => {
    expect(parseDailyDose('0 caps')).toBe(1);
  });
});

describe('computeRunOut', () => {
  it('projects run-out = start + floor(qty / perDay) days', () => {
    // 60 caps, 2/day → 30 days → 2026-01-01 + 30 = 2026-01-31
    expect(computeRunOut({ dose: '2 caps daily', qty: 60, start_date: '2026-01-01' })).toEqual({
      dueDate: '2026-01-31',
      perDay: 2,
      daysSupply: 30,
    });
  });

  it('uses 1/day when the dose carries no frequency', () => {
    // 30 units, 1/day → 30 days
    const r = computeRunOut({ dose: '400mg', qty: 30, start_date: '2026-03-01' });
    expect(r.dueDate).toBe('2026-03-31');
    expect(r.daysSupply).toBe(30);
  });

  it('cannot project without qty or start_date', () => {
    expect(computeRunOut({ dose: '2 caps daily', qty: null, start_date: '2026-01-01' }).dueDate).toBeNull();
    expect(computeRunOut({ dose: '2 caps daily', qty: 60, start_date: null }).dueDate).toBeNull();
    expect(computeRunOut({ dose: '2 caps daily', qty: 0, start_date: '2026-01-01' }).dueDate).toBeNull();
  });

  it('accepts a Date start_date', () => {
    const r = computeRunOut({ dose: '1 cap daily', qty: 10, start_date: new Date('2026-05-01T00:00:00Z') });
    expect(r.dueDate).toBe('2026-05-11');
  });
});
