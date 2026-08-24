import { describe, it, expect } from 'vitest';
import {
  parseTurns,
  detectSessionBoundaries,
  renderTurnsForBoundaryPrompt,
  sliceTranscriptByTurnRange,
} from './segmenter';
import { prepareTurns } from './transcript';

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
