import { describe, it, expect } from 'vitest';
import { parseDailyDose, dailyUnits, computeRunOut } from './project';

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

  it('takes the high end of a range — that client empties the bottle first', () => {
    expect(parseDailyDose('1-2 caps daily')).toBe(2);
    expect(parseDailyDose('1 to 2 capsules twice daily')).toBe(4);
  });

  it('reads fractional doses', () => {
    expect(parseDailyDose('1/2 tab daily')).toBe(0.5);
    expect(parseDailyDose('½ tablet twice daily')).toBe(1);
    expect(parseDailyDose('half a tablet daily')).toBe(0.5);
  });

  it('reads longhand twice-a-day phrasing and qid', () => {
    expect(parseDailyDose('1 cap morning and night')).toBe(2);
    expect(parseDailyDose('2 caps am and pm')).toBe(4);
    expect(parseDailyDose('1 tab qid')).toBe(4);
  });

  it('never returns <= 0', () => {
    expect(parseDailyDose('0 caps')).toBe(1);
  });
});

describe('dailyUnits', () => {
  it('sums the per-slot Daily Schedule — each stated slot is one dosing', () => {
    expect(dailyUnits({ dose: '2 caps daily', schedule: { uponWaking: '2 caps', beforeBed: '1 cap' } })).toBe(3);
  });

  it('counts a slot with no number as one unit', () => {
    expect(dailyUnits({ dose: null, schedule: { breakfast: 'with food', dinner: 'with food' } })).toBe(2);
  });

  it('falls back to the dose text when no slot was stated', () => {
    expect(dailyUnits({ dose: '2 caps twice daily', schedule: { lunch: '  ', dinner: null } })).toBe(4);
    expect(dailyUnits({ dose: '1 cap bid', schedule: null })).toBe(2);
  });

  it('prefers the schedule over the dose text when they disagree', () => {
    // "1 cap daily" but the grid says morning AND night: the grid is what Nicole
    // wrote into the protocol, so the bottle empties twice as fast as the text.
    expect(dailyUnits({ dose: '1 cap daily', schedule: { uponWaking: '1 cap', beforeBed: '1 cap' } })).toBe(2);
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

  it('projects off the schedule grid rather than the dose text', () => {
    // 90 caps, 2 upon waking + 1 before bed = 3/day → 30 days.
    const r = computeRunOut({
      dose: '2 caps daily',
      qty: 90,
      start_date: '2026-01-01',
      schedule: { uponWaking: '2 caps', beforeBed: '1 cap' },
    });
    expect(r).toEqual({ dueDate: '2026-01-31', perDay: 3, daysSupply: 30 });
  });

  it('accepts a Date start_date', () => {
    const r = computeRunOut({ dose: '1 cap daily', qty: 10, start_date: new Date('2026-05-01T00:00:00Z') });
    expect(r.dueDate).toBe('2026-05-11');
  });
});
