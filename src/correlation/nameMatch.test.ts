import { describe, it, expect } from 'vitest';
import { scoreNameMatch, nameSignalRank, overlapSeconds } from './nameMatch';

const TRANSCRIPT =
  "Nicole: Okay Marta, let's go through what brought you in today. " +
  'Marta: The big one is fatigue. ' +
  'Nicole: Marta, how has your sleep been?';

describe('scoreNameMatch', () => {
  it('counts first-name mentions', () => {
    const s = scoreNameMatch(TRANSCRIPT, 'Marta Reyes');
    expect(s.matchedOn).toBe('first');
    expect(s.mentions).toBe(3);
  });

  it('prefers a full-name hit over a first-name hit', () => {
    const s = scoreNameMatch('Nicole: Marta Reyes is here for her follow-up. Marta, come in.', 'Marta Reyes');
    expect(s.matchedOn).toBe('full');
    expect(s.mentions).toBe(1);
  });

  it('falls back to the surname when the first name is never said', () => {
    const s = scoreNameMatch('Nicole: Ms Reyes, how did the protocol go?', 'Marta Reyes');
    expect(s.matchedOn).toBe('last');
    expect(s.mentions).toBe(1);
  });

  it('reports nothing when the name is absent', () => {
    expect(scoreNameMatch(TRANSCRIPT, 'Dana Kim')).toEqual({ mentions: 0, matchedOn: null });
  });

  it('strips demo prefixes and parentheticals from the stored name', () => {
    // The seeded clients carry qualifiers nobody says out loud.
    const s = scoreNameMatch(TRANSCRIPT, 'DEMO - Marta Reyes (multi-session)');
    expect(s.matchedOn).toBe('first');
    expect(s.mentions).toBe(3);
  });

  it('does not match a name fragment inside another word', () => {
    // "Al" inside "also", "Ann" inside "announced" — a substring match here
    // would rank the wrong client top of the list on pure noise.
    expect(scoreNameMatch('Nicole: also we announced the new plan.', 'Al Anderson').mentions).toBe(0);
  });

  it('ignores name parts too short to be evidence', () => {
    expect(scoreNameMatch('Nicole: Jo is doing well.', 'Jo Ng')).toEqual({ mentions: 0, matchedOn: null });
  });

  it('handles missing input without throwing', () => {
    expect(scoreNameMatch(null, 'Marta Reyes').mentions).toBe(0);
    expect(scoreNameMatch(TRANSCRIPT, null).mentions).toBe(0);
    expect(scoreNameMatch('', '').mentions).toBe(0);
  });
});

describe('nameSignalRank', () => {
  it('lets the match FORM dominate the mention count', () => {
    // One "Marta Reyes" must outrank five bare "Reyes" — otherwise a chatty
    // surname reference beats an unambiguous full-name identification.
    const full = nameSignalRank({ mentions: 1, matchedOn: 'full' });
    const last = nameSignalRank({ mentions: 5, matchedOn: 'last' });
    expect(full).toBeGreaterThan(last);
  });

  it('breaks ties on mentions within the same form', () => {
    expect(nameSignalRank({ mentions: 4, matchedOn: 'first' })).toBeGreaterThan(
      nameSignalRank({ mentions: 1, matchedOn: 'first' }),
    );
  });

  it('ranks no match at zero', () => {
    expect(nameSignalRank({ mentions: 0, matchedOn: null })).toBe(0);
  });
});

describe('overlapSeconds', () => {
  const t = (h: number, m: number) => `2026-07-05T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00Z`;

  it('measures a partial overlap', () => {
    // Recording 15:35–16:20 against a 16:15–17:00 booking: 5 minutes.
    expect(overlapSeconds(t(15, 35), t(16, 20), t(16, 15), t(17, 0))).toBe(300);
  });

  it('is zero for adjacent windows that never overlap', () => {
    expect(overlapSeconds(t(15, 0), t(15, 45), t(15, 45), t(16, 30))).toBe(0);
  });

  it('is zero for disjoint windows', () => {
    expect(overlapSeconds(t(9, 0), t(9, 30), t(14, 0), t(15, 0))).toBe(0);
  });
});
