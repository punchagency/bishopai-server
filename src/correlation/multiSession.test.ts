import { describe, it, expect } from 'vitest';
import {
  assessMultiSessionRisk,
  foreignClientNames,
  speakerLabelCount,
} from './multiSession';

// The shapes in this file are taken from the two real recordings of 2026-08-20,
// both of which the correlator filed under a single client at full confidence
// and both of which were wrong. Every threshold here exists because one of them
// cleared the previous check.

const twoSpeaker = [
  'SPEAKER_00: How have you been sleeping?',
  'SPEAKER_01: Badly, I wake around two in the morning.',
  'SPEAKER_00: Every night, or some nights?',
  'SPEAKER_01: Most nights.',
].join('\n');

const fourSpeaker = [
  twoSpeaker,
  'SPEAKER_02: You can come on up and lay on your back.',
  'SPEAKER_03: My knee has been swelling since March.',
].join('\n');

describe('speaker-count signal', () => {
  it('counts distinct diarized labels', () => {
    expect(speakerLabelCount(twoSpeaker)).toBe(2);
    expect(speakerLabelCount(fourSpeaker)).toBe(4);
  });

  it('clears an ordinary two-party consultation', () => {
    const risk = assessMultiSessionRisk({
      transcript: twoSpeaker,
      candidates: [{ appointmentId: 'a', clientName: 'Jenn Hazzard', overlapSeconds: 1300 }],
      matchedClientName: 'Jenn Hazzard',
    });
    expect(risk.hold).toBe(false);
  });

  it('tolerates a third label — one speaker splitting when the room changes', () => {
    // The client moves to the treatment table, mic distance changes, and the
    // diarizer opens a new label for a voice it already had. Routine, and NOT
    // grounds to stop a session reaching its chart.
    const risk = assessMultiSessionRisk({
      transcript: `${twoSpeaker}\nSPEAKER_02: Come on up, lay on your back.`,
      candidates: [{ appointmentId: 'a', clientName: 'Jenn Hazzard', overlapSeconds: 1300 }],
      matchedClientName: 'Jenn Hazzard',
    });
    expect(risk.hold).toBe(false);
  });

  it('holds at four labels', () => {
    const risk = assessMultiSessionRisk({
      transcript: fourSpeaker,
      candidates: [{ appointmentId: 'a', clientName: 'Steve Broderick', overlapSeconds: 1800 }],
      matchedClientName: 'Steve Broderick',
    });
    expect(risk.hold).toBe(true);
    expect(risk.reasons.join(' ')).toMatch(/4 distinct speakers/);
  });
});

describe('spanned-appointments signal', () => {
  it('holds a recording that covers two booked slots', () => {
    // REC-B: 20:36–21:36 across Jodi 19:30–21:00 and Carissa 21:00–21:30. Both
    // clear the overlap guard, so the matcher had two right answers and picked
    // one.
    const risk = assessMultiSessionRisk({
      transcript: twoSpeaker,
      candidates: [
        { appointmentId: 'jodi', clientName: 'Jodi Hess', overlapSeconds: 1413 },
        { appointmentId: 'carissa', clientName: 'Carissa Lauer', overlapSeconds: 1800 },
      ],
      matchedClientName: 'Jodi Hess',
    });
    expect(risk.hold).toBe(true);
    expect(risk.reasons.join(' ')).toMatch(/spans 2 booked appointments/);
  });

  it('ignores a neighbour that merely bleeds over the boundary', () => {
    // 148 seconds of the adjacent slot is the recorder being started early, not
    // a second consultation. Holding on this would hold nearly every session.
    const risk = assessMultiSessionRisk({
      transcript: twoSpeaker,
      candidates: [
        { appointmentId: 'jodi', clientName: 'Jodi Hess', overlapSeconds: 2329 },
        { appointmentId: 'steve', clientName: 'Steve Broderick', overlapSeconds: 148 },
      ],
      matchedClientName: 'Jodi Hess',
    });
    expect(risk.reasons.join(' ')).not.toMatch(/spans/);
  });
});

describe('foreign-name signal', () => {
  it('fires when the transcript names a different client booked nearby', () => {
    // The exact 2026-08-20 misfiling: a recording naming Steve Broderick, filed
    // under Jodi Hess.
    const risk = assessMultiSessionRisk({
      transcript: 'SPEAKER_00: When I saw your name pop up today — Steven Broderick, requesting a session.\nSPEAKER_01: That is me.',
      candidates: [
        { appointmentId: 'jodi', clientName: 'Jodi Hess', overlapSeconds: 2329 },
        { appointmentId: 'steve', clientName: 'Steve Broderick', overlapSeconds: 148 },
      ],
      matchedClientName: 'Jodi Hess',
    });
    expect(risk.hold).toBe(true);
    expect(risk.reasons.join(' ')).toMatch(/names another client/);
  });

  it('does not fire on the name of the client it is being filed under', () => {
    expect(foreignClientNames('Good to see you Jodi.', 'Jodi Hess', ['Jodi Hess'])).toEqual([]);
  });

  it('does not fire on a short or absent first name', () => {
    // A two-letter first name matches far too much ordinary speech to be
    // evidence of anything.
    expect(foreignClientNames('We can go over that.', 'Jodi Hess', ['Jo Ng'])).toEqual([]);
  });

  it('matches whole words only', () => {
    // "Stevenson" is not "Steve"; a substring match here would flag a surname,
    // a street, or a supplement brand as a second client in the room.
    expect(foreignClientNames('I read that in Stevenson.', 'Jodi Hess', ['Steve Broderick'])).toEqual([]);
  });
});

describe('gate behaviour overall', () => {
  it('clears everything when there is no transcript yet', () => {
    // Pocket delivers audio before words. Nothing can be extracted from a row
    // with no transcript anyway, and the gate runs again when the words land.
    const risk = assessMultiSessionRisk({
      transcript: null,
      candidates: [
        { appointmentId: 'a', clientName: 'A', overlapSeconds: 1800 },
        { appointmentId: 'b', clientName: 'B', overlapSeconds: 1800 },
      ],
      matchedClientName: 'A',
    });
    expect(risk.hold).toBe(false);
  });

  it('reports every signal that fired, not just the first', () => {
    const risk = assessMultiSessionRisk({
      transcript: `${fourSpeaker}\nSPEAKER_00: Steven, good to see you.`,
      candidates: [
        { appointmentId: 'jodi', clientName: 'Jodi Hess', overlapSeconds: 2329 },
        { appointmentId: 'steve', clientName: 'Steve Broderick', overlapSeconds: 1800 },
      ],
      matchedClientName: 'Jodi Hess',
    });
    expect(risk.reasons).toHaveLength(3);
  });
});

describe('session-restart signal', () => {
  // Recording 92f683ed (2026-08-21) is the case that motivated this signal: two
  // consecutive clients, TWO diarized labels because the second client inherited
  // SPEAKER_01, no client named aloud, and — on the day — a single overlapping
  // appointment would have been enough to file it. Every other signal here is
  // structurally blind to it.
  const filler = (n: number): string[] =>
    Array.from({ length: n }, (_, i) =>
      i % 2 === 0
        ? `SPEAKER_00: Keep the magnesium going and we will look again. Line ${i}.`
        : `SPEAKER_01: Okay, that makes sense. Line ${i}.`,
    );

  const backToBack = [
    ...filler(160),
    'SPEAKER_00: So five thirty the twenty-third.',
    'SPEAKER_01: Five thirty. No problem. Thanks.',
    'SPEAKER_00: Have fun. Hello.',
    'SPEAKER_01: Hi.',
    'SPEAKER_00: How are you?',
  ].join('\n');

  it('holds a two-label, unnamed, single-appointment recording that no other signal catches', () => {
    expect(speakerLabelCount(backToBack)).toBeLessThan(4);

    const risk = assessMultiSessionRisk({
      transcript: backToBack,
      candidates: [{ appointmentId: 'a1', clientName: 'Amber Stack', overlapSeconds: 1259 }],
      matchedClientName: 'Amber Stack',
    });

    expect(risk.hold).toBe(true);
    expect(risk.reasons).toHaveLength(1);
    expect(risk.reasons[0]).toMatch(/second consultation appears to begin at turn \d+/);
  });

  it('leaves an ordinary single consultation alone', () => {
    const ordinary = [
      'SPEAKER_00: Hi, come on in. How are you today?',
      "SPEAKER_01: Good, thanks.",
      ...filler(120),
    ].join('\n');

    const risk = assessMultiSessionRisk({
      transcript: ordinary,
      candidates: [{ appointmentId: 'a1', clientName: 'Amber Stack', overlapSeconds: 1500 }],
      matchedClientName: 'Amber Stack',
    });

    expect(risk.hold).toBe(false);
    expect(risk.reasons).toEqual([]);
  });
});
