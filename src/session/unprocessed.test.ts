import { describe, it, expect } from 'vitest';
import { classify, countFindings, tooShortForAppointment } from './unprocessed';

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

// An empty note has two causes, and they used to be told as one story.
//
// `findings === 0` was classified 'blank' and the UI said "Every part of this
// session was skipped — nothing was read." That is a claim about WHY, asserted
// without checking whether anything had been skipped. It was true of the notes
// it was written for (four quota casualties from 2026-08-24, every stage
// dropped) and it is close to the only case that can no longer happen, because
// extract.ts now throws when every stage fails and a total loss lands in
// 'failed' instead of 'done'.
describe('why a note is empty', () => {
  const listReason = (findings: number, partial: string[]) =>
    classify('done', null, findings, partial);

  it('says the reading failed when stages dropped', () => {
    // The shape of all four stranded production rows: every stage in `partial`,
    // most of them twice (once for how it ran, once for producing nothing).
    expect(
      listReason(0, [
        'assessments',
        'narrative',
        'protocol:chunked-fallback',
        'nrt:chunked-fallback',
        'protocol',
        'nrt',
      ]),
    ).toBe('unread');
  });

  it('does not claim a failure when every stage ran and found nothing', () => {
    // A short visit, a rescheduling, a recorder that caught the wrong part of
    // the day. Telling Nicole this "was never read" sends her to re-run an
    // extraction that will correctly produce nothing again, on an allowance of
    // twenty requests a day.
    expect(listReason(0, [])).toBe('blank');
  });

  it('still calls a half-read note with findings incomplete', () => {
    expect(listReason(3, ['nrt'])).toBe('incomplete');
  });

  it('leaves a real note out of the list entirely', () => {
    expect(listReason(12, [])).toBeNull();
  });
});

// Catching a recording that cannot be the session it is filed against.
//
// The case this comes from: a 27-minute Amber Stack recording was split into a
// 16,882-character session and a 695-character tail — "Have fun. Hello.", two
// minutes of gym chat, a bathroom break — and the tail was filed as a session
// of its own on a SEPARATE 60-minute appointment. Nothing in the product said
// it was 3% of a booking. It sat in the list as a fourth session waiting to be
// read, and separating it from the real ones took reading the transcript by
// hand and diffing it against the parent recording.
describe('too short to be this session', () => {
  const HOUR = 3600;

  it('flags the Amber Stack tail', () => {
    // 2 minutes of a 60-minute appointment, 695 characters.
    expect(tooShortForAppointment(120, HOUR, 695)).toBe(true);
  });

  it('leaves a real session alone', () => {
    // 25 minutes of a 30-minute booking.
    expect(tooShortForAppointment(1500, 1800, 16882)).toBe(false);
  });

  it('does not flag a short session that still said plenty', () => {
    // Ten minutes of an hour — low coverage, but 9k characters of transcript is
    // a real consultation that ran short, not a fragment. Either signal alone
    // would call this a problem; both together do not.
    expect(tooShortForAppointment(600, HOUR, 9000)).toBe(false);
  });

  it('does not flag a brief recording of a brief booking', () => {
    // 4 minutes of a 5-minute check-in: thin transcript, but it covers the
    // whole appointment, which is the thing that matters.
    expect(tooShortForAppointment(240, 300, 900)).toBe(false);
  });

  it('says nothing when it cannot tell', () => {
    // No appointment end time, or no recording duration. Silence beats a guess:
    // this is shown to a human as a reason to check, and a false one spent on a
    // correct recording is how a warning stops being read.
    expect(tooShortForAppointment(120, null, 695)).toBe(false);
    expect(tooShortForAppointment(null, HOUR, 695)).toBe(false);
    expect(tooShortForAppointment(120, 0, 695)).toBe(false);
  });
});
