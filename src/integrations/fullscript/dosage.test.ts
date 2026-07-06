import { describe, it, expect } from 'vitest';
import { parseFullscriptDosage } from './dosage';

describe('parseFullscriptDosage', () => {
  it('parses count, frequency, format, and days-supply duration', () => {
    // 60 caps at 2/day (twice daily × 1 cap? no — "2 caps nightly" = 2/day) → 30 days.
    expect(parseFullscriptDosage('2 caps nightly', 60)).toEqual({
      amount: '2',
      frequency: 'every night',
      format: 'capsule',
      duration: '30',
      time_of_day: ['bedtime'],
    });
  });

  it('handles ranges and twice-daily', () => {
    // "1-2 tablets twice daily": perDay uses the leading count (2) × 2 = ... parseDailyDose
    // takes unit count 1 → 1×2 = 2/day; 60/2 = 30 days.
    expect(parseFullscriptDosage('1-2 tablets twice daily', 60)).toMatchObject({
      amount: '1-2',
      frequency: 'twice per day',
      format: 'tablet',
    });
  });

  it('maps softgels and morning timing', () => {
    expect(parseFullscriptDosage('1 softgel each morning', 90)).toMatchObject({
      amount: '1',
      frequency: 'every morning',
      format: 'gel',
      time_of_day: ['morning'],
      duration: '90',
    });
  });

  it('does not mistake a strength (mg) for a count, and omits unknown fields', () => {
    const d = parseFullscriptDosage('400mg daily', 30);
    expect(d?.amount).toBeUndefined(); // "400" is a strength, not a count
    expect(d?.frequency).toBe('once per day');
    expect(d?.format).toBeUndefined();
  });

  it('returns undefined when nothing is parseable', () => {
    expect(parseFullscriptDosage('', null)).toBeUndefined();
    expect(parseFullscriptDosage(null, null)).toBeUndefined();
  });

  it('omits duration when qty is missing', () => {
    const d = parseFullscriptDosage('1 cap daily', null);
    expect(d).toMatchObject({ amount: '1', frequency: 'once per day', format: 'capsule' });
    expect(d?.duration).toBeUndefined();
  });
});
