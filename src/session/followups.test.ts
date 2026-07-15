import { describe, it, expect } from 'vitest';
import { dueDateFrom, followUpTexts, normalizeFollowUps } from './followups';

describe('normalizeFollowUps', () => {
  it('reads the legacy bare-string form as an undated follow-up', () => {
    // Notes extracted before tasks existed are already in the DB as plain strings.
    expect(normalizeFollowUps(['Recheck in 4 weeks'])).toEqual([
      { text: 'Recheck in 4 weeks', dueInDays: null },
    ]);
  });

  it('reads the object form', () => {
    expect(normalizeFollowUps([{ text: 'Recheck B12', due_in_days: 28 }])).toEqual([
      { text: 'Recheck B12', dueInDays: 28 },
    ]);
  });

  it('handles a mixed array and drops empties', () => {
    expect(normalizeFollowUps(['  ', { text: 'A', due_in_days: null }, 'B'])).toEqual([
      { text: 'A', dueInDays: null },
      { text: 'B', dueInDays: null },
    ]);
  });

  it('followUpTexts gives the render path plain strings from either shape', () => {
    expect(followUpTexts([{ text: 'A', due_in_days: 7 }, 'B'])).toEqual(['A', 'B']);
    expect(followUpTexts(undefined)).toEqual([]);
  });
});

describe('dueDateFrom', () => {
  const session = new Date('2026-07-01T14:00:00Z');

  it('anchors the due date to the session, not to now', () => {
    // A note approved days late still means "four weeks from the appointment".
    expect(dueDateFrom(session, 28)).toBe('2026-07-29');
  });

  it('returns null when no timeframe was spoken — an undated task is correct', () => {
    expect(dueDateFrom(session, null)).toBeNull();
  });

  it('crosses month boundaries', () => {
    expect(dueDateFrom(new Date('2026-07-20T00:00:00Z'), 30)).toBe('2026-08-19');
  });
});
