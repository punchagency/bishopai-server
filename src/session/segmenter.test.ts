import { describe, it, expect, vi } from 'vitest';
import {
  parseTurns,
  detectSessionBoundaries,
  renderTurnsForBoundaryPrompt,
  sliceTranscriptByTurnRange,
  type CalendarAppointment,
} from './segmenter';
import { prepareTurns } from './transcript';

vi.mock('../llm/providers', () => ({
  generateStructured: vi.fn(async () => ({ parsed: { boundary_turns: [] } })),
}));

/** A stretch of ordinary consultation: alternating turns, clinical vocabulary
 *  that deliberately includes the words a looser farewell regex used to trip on
 *  ("cut out", "done", "thanks", "four weeks"). */
function consult(count: number, startIdx: number, client = 'CLIENT (SPEAKER 01)'): string {
  const practitioner = [
    'And how are you feeling since we changed the dose?',
    'Good. Tell me about your digestion this week.',
    'Let me check your pulse points and K-27.',
    'What brings you the most trouble day to day?',
  ];
  const clientLines = [
    'I cut out gluten like you said and I feel done with it.',
    'Thanks, that makes sense to me.',
    'My sleep has been rough, maybe five hours a night.',
    'I did the magnesium at night, four weeks now.',
  ];
  return Array.from({ length: count }, (_, i) => {
    const idx = startIdx + i;
    return i % 2 === 0
      ? `#${idx} PRACTITIONER\n${practitioner[(i >> 1) % 4]}`
      : `#${idx} ${client}\n${clientLines[(i >> 1) % 4]}`;
  }).join('\n\n');
}

/** The handshake that actually ends one appointment and starts the next. */
function handover(startIdx: number, nextClient: string): string {
  return [
    `#${startIdx} PRACTITIONER\nAll right, I'll see you in four weeks. Take care.`,
    `#${startIdx + 1} SPEAKER 03\nHi, ${nextClient}, come on in and have a seat.`,
  ].join('\n\n');
}

const BOOKED = ['Anna Bartholomew', 'Steve Broderick', 'Maria Lopez'];

/** Where the next client is actually greeted. Read from the parsed turns rather
 *  than computed from the builder: adjacent same-speaker turns merge, so the
 *  handover's farewell folds into the preceding turn whenever the consultation
 *  before it happens to end on the practitioner. */
function greetingTurn(transcript: string): number {
  const turn = parseTurns(transcript).find((t) => /come on in and have a seat/i.test(t.text));
  if (!turn) throw new Error('handover greeting not found in transcript');
  return turn.index;
}

describe('segmenter', () => {
  const sampleTranscript = `#47 SPEAKER 02
Like, I'm gonna just not even start to figure it out.

#48 CLIENT (SPEAKER 01)
All right, I'll see you. For your four weeks. You're welcome. Introduce yourself, please.

#49 SPEAKER 02
Hi, Steve.`;

  describe('parseTurns', () => {
    it('numbers turns as prepareTurns + 1, so a turn number is portable', () => {
      // The invariant that keeps the splitter and the review pane talking about
      // the same turn. Two independent parsers drifted here: different bases AND
      // different merging, so the gap grew through the document.
      const transcript = `Nicole: Hi there, come on in and have a seat.
Marta: Thanks, good to be here.
Nicole: How has your sleep been?
Marta: Rough. Maybe five hours.
Marta: And my digestion is off.
Nicole: All right, I'll see you in four weeks.`;

      const prepared = prepareTurns(transcript);
      const segmenterTurns = parseTurns(transcript);

      expect(segmenterTurns).toHaveLength(prepared.length);
      for (let i = 0; i < prepared.length; i++) {
        expect(segmenterTurns[i].index).toBe(prepared[i].index + 1);
        expect(segmenterTurns[i].text).toBe(prepared[i].text);
      }
    });

    it('reads #N headers, including parenthesised diarization labels', () => {
      const turns = parseTurns(sampleTranscript);
      expect(turns).toHaveLength(3);
      expect(turns[0].index).toBe(1);
      expect(turns[1].speaker).toBe('CLIENT (SPEAKER 01)');
      expect(turns[2].text).toBe('Hi, Steve.');
    });

    it.each([
      ['all-caps labels', 'NICOLE: Hi there.\nANNA: Hello back.\nNICOLE: How is your sleep?'],
      ['spaced diarization labels', 'SPEAKER 02: Hi there.\nSPEAKER 01: Hello.\nSPEAKER 02: Go on.'],
      ['Otter-style exports', 'Speaker 2: And what were you feeling?\nSpeaker 1: Tired.\nSpeaker 2: Since when?'],
    ])('reads %s', (_label, transcript) => {
      expect(parseTurns(transcript)).toHaveLength(3);
    });

    it('does not invent speakers from prose that happens to contain a colon', () => {
      const turns = parseTurns(`Nicole: How is your sleep?
Marta: Rough lately.
Nicole: Protocol: magnesium at night.
Marta: Note: I felt bloated after.
Nicole: So here is the thing: you were tired all week.
Marta: Day 3: worse than before.
Nicole: See https://fullscript.com/x for the link.`);

      expect(turns.map((t) => t.speaker)).toEqual(
        expect.arrayContaining(['Nicole', 'Marta']),
      );
      for (const phantom of ['Protocol', 'Note', 'So here is the thing', 'Day 3', 'https']) {
        expect(turns.map((t) => t.speaker)).not.toContain(phantom);
      }
    });

    it('gives one speaker one role across the recording', () => {
      // attributeSpeakers scores each turn alone, so a single voice can come back
      // PRACTITIONER on a question and CLIENT on the answer. A diarization-shift
      // signal built on that reads one person as two.
      const turns = parseTurns(consult(20, 1));
      const rolesPerSpeaker = new Map<string, Set<string>>();
      for (const t of turns) {
        if (!rolesPerSpeaker.has(t.speaker)) rolesPerSpeaker.set(t.speaker, new Set());
        rolesPerSpeaker.get(t.speaker)!.add(t.role ?? 'UNKNOWN');
      }
      for (const roles of rolesPerSpeaker.values()) expect(roles.size).toBe(1);
    });
  });

  describe('detectSessionBoundaries', () => {
    it('keeps a single-client 242-turn consultation as one session', async () => {
      const segments = await detectSessionBoundaries(consult(242, 1), BOOKED);
      expect(segments).toHaveLength(1);
      expect(segments[0].from_turn).toBe(1);
      expect(segments[0].to_turn).toBe(242);
    });

    it('splits a genuine two-client recording at the handover', async () => {
      const transcript = [consult(150, 1), handover(151, 'Steve'), consult(92, 153)].join('\n\n');
      const segments = await detectSessionBoundaries(transcript, BOOKED);

      expect(segments).toHaveLength(2);
      expect(segments[1].from_turn).toBe(152);
      expect(segments[1].client_name_hint).toBe('Steve Broderick');
    });

    // Two appointments are two appointments however unevenly they divide. A
    // proportional floor (n/3) allowed a boundary only in the middle third, so
    // both of these came back as one session.
    it('splits when the first client ran long (45/17)', async () => {
      const transcript = [consult(45, 1), handover(46, 'Steve'), consult(15, 48)].join('\n\n');
      const segments = await detectSessionBoundaries(transcript, BOOKED);

      expect(segments).toHaveLength(2);
      expect(segments[1].from_turn).toBe(greetingTurn(transcript));
    });

    it('splits when recording started mid-appointment (15/45)', async () => {
      const transcript = [consult(15, 1), handover(16, 'Steve'), consult(45, 18)].join('\n\n');
      const segments = await detectSessionBoundaries(transcript, BOOKED);

      expect(segments).toHaveLength(2);
      expect(segments[1].from_turn).toBe(greetingTurn(transcript));
    });

    it('finds all three of three back-to-back appointments', async () => {
      const transcript = [
        consult(60, 1),
        handover(61, 'Steve'),
        consult(60, 63),
        handover(123, 'Maria'),
        consult(60, 125),
      ].join('\n\n');
      const segments = await detectSessionBoundaries(transcript, BOOKED);

      expect(segments).toHaveLength(3);
      expect(segments.map((s) => s.from_turn)).toEqual([1, 62, 124]);
      expect(segments[1].client_name_hint).toBe('Steve Broderick');
      expect(segments[2].client_name_hint).toBe('Maria Lopez');
    });

    it('never emits a session shorter than the minimum', async () => {
      // A goodbye at the very end of a recording is the practitioner closing the
      // door, not a consultation.
      const transcript = [consult(60, 1), handover(61, 'Steve')].join('\n\n');
      const segments = await detectSessionBoundaries(transcript, BOOKED);

      for (const s of segments) expect(s.to_turn - s.from_turn + 1).toBeGreaterThanOrEqual(12);
    });

    it('covers every turn exactly once, with no gaps or overlaps', async () => {
      const transcript = [consult(60, 1), handover(61, 'Steve'), consult(60, 63)].join('\n\n');
      const segments = await detectSessionBoundaries(transcript, BOOKED);
      const total = parseTurns(transcript).length;

      expect(segments[0].from_turn).toBe(1);
      expect(segments[segments.length - 1].to_turn).toBe(total);
      for (let i = 1; i < segments.length; i++) {
        expect(segments[i].from_turn).toBe(segments[i - 1].to_turn + 1);
      }
    });

    it('says so when it cannot find turns, rather than claiming one confident session', async () => {
      const segments = await detectSessionBoundaries('one unbroken wall of text with no labels at all');
      expect(segments).toHaveLength(1);
      expect(segments[0].detection_note).toMatch(/could not detect speaker turns/i);
      expect(segments[0].confidence_score).toBeLessThan(50);
    });

    it('survives client names containing regex metacharacters', async () => {
      await expect(
        detectSessionBoundaries(sampleTranscript, ["Jay (Sub) O'Connor [Special]"]),
      ).resolves.toBeDefined();
    });

    it('does not match a client name inside a longer word', async () => {
      const segments = await detectSessionBoundaries(
        `#1 PRACTITIONER\nShe announced that she cannot come today.`,
        ['Ann Bartholomew'],
      );
      expect(segments[0].client_name_hint).toBeFalsy();
    });

    it('uses multi-signal transcript evidence to assign appointments and flag time disagreement', async () => {
      const transcript = [
        '#1 PRACTITIONER\nHi Steve, welcome in! Good to see you today.',
        '#2 CLIENT\nThanks Nicole, my back has been feeling much better.',
      ].join('\n\n');

      const appts: CalendarAppointment[] = [
        {
          id: 'appt_mary',
          starts_at: '2026-08-25T10:00:00Z',
          ends_at: '2026-08-25T10:30:00Z',
          client_name: 'Mary Waters',
          overlap_seconds: 1200,
        },
        {
          id: 'appt_steve',
          starts_at: '2026-08-25T10:30:00Z',
          ends_at: '2026-08-25T11:00:00Z',
          client_name: 'Steve Broderick',
          overlap_seconds: 300,
        },
      ];

      // Recording window overlaps Mary's slot (20m) more than Steve's (5m), but transcript directly addresses Steve.
      const recStartMs = new Date('2026-08-25T10:00:00Z').getTime();
      const recEndMs = new Date('2026-08-25T10:35:00Z').getTime();

      const segments = await detectSessionBoundaries(
        transcript,
        ['Mary Waters', 'Steve Broderick'],
        appts,
        recStartMs,
        recEndMs,
      );

      expect(segments[0].suggested_appointment_id).toBe('appt_steve');
      expect(segments[0].client_name_hint).toBe('Steve Broderick');
      // "strongly" was dropped from the wording: the note now fires only when
      // name evidence actually outranked the calendar, and a single surname
      // mention winning that comparison is not a strong claim.
      expect(segments[0].time_disagreement_note).toMatch(/Transcript evidence points to Steve Broderick/i);
    });

    it('treats a client who shares the practitioner name as the client', async () => {
      // "Nicole" as a booked client must not be force-labelled the practitioner.
      const transcript = [consult(30, 1, 'Nicole'), handover(31, 'Steve'), consult(30, 33)].join('\n\n');
      const turns = parseTurns(transcript);
      const segments = await detectSessionBoundaries(transcript, ['Nicole Waters', 'Steve Broderick']);

      expect(turns.length).toBeGreaterThan(0);
      expect(segments.length).toBeGreaterThanOrEqual(2);
    });
  });

  describe('sliceTranscriptByTurnRange', () => {
    it('returns exactly the requested turns', () => {
      const sliced = sliceTranscriptByTurnRange(sampleTranscript, 3, 3);
      expect(sliced).toContain('Hi, Steve.');
      expect(sliced).not.toContain('figure it out');
    });

    it('round-trips a range back to the same turn count', () => {
      const transcript = consult(40, 1);
      const sliced = sliceTranscriptByTurnRange(transcript, 10, 25);
      expect(parseTurns(sliced)).toHaveLength(16);
    });
  });
});

describe('renderTurnsForBoundaryPrompt', () => {
  const longTranscript = Array.from({ length: 200 }, (_, i) =>
    i % 2 === 0
      ? `SPEAKER_00: Let us keep the magnesium where it is and review it next time. Turn ${i}.`
      : `SPEAKER_01: That sounds right to me, I have been taking it with food. Turn ${i}.`,
  ).join('\n');

  it('sends every turn, including the middle of a long recording', () => {
    // The bug this replaces: head-50 + tail-50 with the middle discarded, which
    // made a boundary anywhere in the middle undetectable — the model was never
    // shown the turns it would have to point at.
    const turns = parseTurns(longTranscript);
    const { lines } = renderTurnsForBoundaryPrompt(turns);

    expect(lines).toHaveLength(turns.length);
    expect(lines.join('\n')).not.toContain('turns omitted');
    for (const idx of [1, 60, 100, 140, turns.length]) {
      expect(lines.some((l) => l.startsWith(`#${idx} `))).toBe(true);
    }
  });

  it('uses the widest cap when the transcript fits, which is every real one', () => {
    const { cap, fits } = renderTurnsForBoundaryPrompt(parseTurns(longTranscript));
    expect(fits).toBe(true);
    expect(cap).toBe(240);
  });

  it('narrows turn text rather than dropping turns when the ceiling is tight', () => {
    const turns = parseTurns(longTranscript);
    const tight = renderTurnsForBoundaryPrompt(turns, 900);

    // Still every turn — a short handover line survives narrowing intact, which
    // is the whole point: boundaries live in short turns, budget is eaten by long ones.
    expect(tight.lines).toHaveLength(turns.length);
    expect(tight.cap).toBeLessThan(240);
  });

  it('reports fits=false rather than silently dropping turns it cannot fit', () => {
    const turns = parseTurns(longTranscript);
    const impossible = renderTurnsForBoundaryPrompt(turns, 10);
    expect(impossible.fits).toBe(false);
    expect(impossible.lines).toHaveLength(turns.length);
  });
});

// Regressions from the 2026-08-27 review. Each of these reproduced a real
// misbehaviour before the fix in the same commit; the comments say what.
describe('segmenter regressions (2026-08-27)', () => {
  const REC_START = Date.parse('2026-08-27T10:00:00Z');
  const REC_END = Date.parse('2026-08-27T11:00:00Z');
  const APPTS = [
    {
      id: 'appt-steve',
      starts_at: '2026-08-27T10:00:00Z',
      ends_at: '2026-08-27T10:30:00Z',
      client_name: 'Steve Broderick',
      overlap_seconds: 1800,
    },
    {
      id: 'appt-jodi',
      starts_at: '2026-08-27T10:30:00Z',
      ends_at: '2026-08-27T11:00:00Z',
      client_name: 'Jodi Hess',
      overlap_seconds: 1800,
    },
  ];

  /** Two back-to-back consultations where the practitioner speaks both halves
   *  of the handover — no client says anything between the goodbye and the
   *  hello. This is the ordinary shape of a back-to-back recording. */
  function backToBack(): string {
    const t: string[] = ['NICOLE: Hi Steve, come on in and have a seat.', 'STEVE: Thanks, good to be back.'];
    for (let i = 0; i < 8; i++) {
      t.push(`NICOLE: Let's review your magnesium dose, point ${i}.`);
      t.push(`STEVE: That sounds right to me, point ${i}.`);
    }
    // Passing mentions of the OTHER client, by full name — a referral, say.
    t.push('NICOLE: Jodi Hess mentioned the same reflux issue last week.');
    t.push('STEVE: Oh, Jodi Hess? Small world.');
    t.push('NICOLE: All right Steve, see you next month. Take care.');
    t.push('NICOLE: Hi Jodi, welcome, have a seat.');
    t.push('JODI: Hi, thanks.');
    for (let i = 0; i < 10; i++) {
      t.push(`NICOLE: And how has the sleep been, week ${i}?`);
      t.push(`JODI: Better, week ${i}.`);
    }
    t.push('NICOLE: Great. Take care, bye.');
    return t.join('\n');
  }

  it('puts the incoming client\'s greeting in the incoming client\'s segment', async () => {
    // mergeAdjacentTurns used to fuse "see you next month" and "Hi Jodi" into a
    // single turn, because both are NICOLE. A boundary is a turn index, so once
    // they are one turn there is no index between them: the greeting — a direct
    // address, and the strongest identity signal there is — ended up inside the
    // OUTGOING client's segment.
    const segments = await detectSessionBoundaries(
      backToBack(), ['Steve Broderick', 'Jodi Hess'], APPTS, REC_START, REC_END, 'Nicole',
    );
    expect(segments).toHaveLength(2);
    expect(segments[1].snippet).toMatch(/Hi Jodi/);
    expect(segments[0].snippet).not.toMatch(/Hi Jodi/);
  });

  it('does not swap the two clients', async () => {
    // The end-to-end symptom of the merge above, compounded by a greedy
    // assignment: BOTH segments came back on the other client's appointment,
    // and the disagreement note argued confidently for the wrong one.
    const segments = await detectSessionBoundaries(
      backToBack(), ['Steve Broderick', 'Jodi Hess'], APPTS, REC_START, REC_END, 'Nicole',
    );
    expect(segments[0].suggested_appointment_id).toBe('appt-steve');
    expect(segments[1].suggested_appointment_id).toBe('appt-jodi');
    expect(segments[0].client_name_hint).toBe('Steve Broderick');
    expect(segments[1].client_name_hint).toBe('Jodi Hess');
  });

  it('declines to assign an appointment there is no evidence for', async () => {
    // A single session, and a second appointment that merely brushes the end of
    // the recording. That appointment used to be handed to whichever segment
    // was left over, on a composite score of ~17 out of a possible ~9000.
    const t = ['NICOLE: Hi Steve, come on in.', 'STEVE: Thanks.'];
    for (let i = 0; i < 14; i++) {
      t.push(`NICOLE: How is the magnesium going, week ${i}?`);
      t.push(`STEVE: Fine, week ${i}.`);
    }
    const brushing = [
      APPTS[0],
      {
        id: 'appt-stranger',
        starts_at: '2026-08-27T10:59:00Z',
        ends_at: '2026-08-27T11:30:00Z',
        client_name: 'Someone Else',
        overlap_seconds: 60,
      },
    ];
    const segments = await detectSessionBoundaries(
      t.join('\n'), ['Steve Broderick', 'Someone Else'], brushing, REC_START, REC_END, 'Nicole',
    );
    expect(segments).toHaveLength(1);
    expect(segments[0].suggested_appointment_id).toBe('appt-steve');
    // And nothing anywhere claims the stranger.
    expect(segments.map((s) => s.suggested_appointment_id)).not.toContain('appt-stranger');
  });

  it('lets the better-evidenced segment win an appointment both want', async () => {
    // Best match, never first match. Segment 1 names Jodi in passing; segment 2
    // is addressed to her directly. Ordered assignment gave it to segment 1
    // because segment 1 asked first.
    const segments = await detectSessionBoundaries(
      backToBack(), ['Steve Broderick', 'Jodi Hess'], APPTS, REC_START, REC_END, 'Nicole',
    );
    // Segment 1 mentions "Jodi Hess" twice by full name; segment 2 is greeted
    // as "Hi Jodi". The direct address must win.
    expect(segments[1].suggested_appointment_id).toBe('appt-jodi');
  });

  it('does not let a segment run shorter than the stated minimum', async () => {
    // `turns.length - turnIdx >= MIN_SEGMENT_TURNS` was off by one: a segment
    // from `turnIdx` to the last turn holds `length - turnIdx + 1` turns, so a
    // 12-turn floor quietly demanded 13.
    const segments = await detectSessionBoundaries(
      backToBack(), ['Steve Broderick', 'Jodi Hess'], APPTS, REC_START, REC_END, 'Nicole',
    );
    for (const s of segments) {
      expect(s.to_turn - s.from_turn + 1).toBeGreaterThanOrEqual(12);
    }
  });
});
