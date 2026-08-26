import { describe, it, expect } from 'vitest';
import { countFindings } from './unprocessed';

// The shape of a note produced by a run where every stage was refused. Taken
// from appointment_sheets 1e334f76 (Devin Brooks, 2026-08-24) — the run that
// prompted this file. It is 885 bytes of valid JSON and holds nothing.
const REFUSED_RUN = {
  goals: [],
  concerns: [],
  evidence: [],
  extraction: {
    gaps: [
      { to: null, from: null, stage: 'narrative', to_turn: 101, from_turn: 0 },
      { to: null, from: null, stage: 'protocol', to_turn: 148, from_turn: 0 },
    ],
    model: 'gemini-3.6-flash',
    partial: ['narrative', 'assessments', 'nrt', 'protocol'],
    provider: 'google',
    attribution_coverage: 1,
  },
  follow_ups: [],
  assessments: [],
  supplements: [],
  protocol_changes: [],
};

describe('countFindings', () => {
  it('reads a fully-refused run as empty despite a kilobyte of JSON', () => {
    // The whole point. `length(content_json)` says 885 and every automated
    // check says the note parsed fine; only the content fields say it is blank.
    expect(countFindings(REFUSED_RUN)).toBe(0);
  });

  it('does not count evidence or extraction metadata as findings', () => {
    // Both grow with the SIZE of the transcript rather than with what was found
    // in it, so a note carrying gap markers for six dropped stages and nothing
    // else would otherwise look like the richest note in the queue.
    expect(
      countFindings({
        ...REFUSED_RUN,
        evidence: [{ path: 'concerns.0', turn: 27, quote: 'anything' }],
      }),
    ).toBe(0);
  });

  it('counts a finding buried in an object of null slots', () => {
    // Why this walks instead of summing array lengths: a session whose only
    // finding is one NRT reading has six empty arrays. Summing them calls it
    // blank and offers to re-extract a note that is already correct.
    const nrtOnly = {
      ...REFUSED_RUN,
      nrt: {
        k27: null,
        pulse0: 'weak',
        priority1: null,
        stressors: [],
        foundation: null,
        body_scan: { art_cell: null, scan_cell: null },
      },
    };
    expect(countFindings(nrtOnly)).toBe(1);
  });

  it('ignores blank strings, which is what a cleared slot looks like', () => {
    expect(countFindings({ ...REFUSED_RUN, concerns: ['', '   '] })).toBe(0);
    expect(countFindings({ ...REFUSED_RUN, concerns: ['', 'hormonal brain fog'] })).toBe(1);
  });

  it('counts every leaf of a real finding, not just the item', () => {
    const withSupp = {
      ...REFUSED_RUN,
      supplements: [{ name: 'Beta Plus', dose: '2 caps', schedule: null }],
    };
    expect(countFindings(withSupp)).toBe(2);
  });

  it('survives a missing or malformed note', () => {
    // A matched conversation with no sheet row at all reaches this as null.
    expect(countFindings(null)).toBe(0);
    expect(countFindings(undefined)).toBe(0);
    expect(countFindings('not a note')).toBe(0);
    expect(countFindings({})).toBe(0);
  });
});
