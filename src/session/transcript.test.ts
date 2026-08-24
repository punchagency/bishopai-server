import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  attributeSpeakers,
  attributionCoverage,
  chunkTurns,
  compactForNarrative,
  findSessionRestart,
  mergeAdjacentTurns,
  parseTranscript,
  prepareTranscript,
  prepareTurns,
  renderTurns,
} from './transcript';

const fixture = (name: string): string =>
  readFileSync(resolve(__dirname, '../../test/fixtures/transcripts', name), 'utf8');

describe('parseTranscript', () => {
  it('reads the Otter shape: speaker line, timestamp, then the utterance', () => {
    const turns = parseTranscript('Speaker 1 0:02\nHello there.\n\nSpeaker 2 1:30\nHi back.');
    expect(turns).toHaveLength(2);
    expect(turns[0]).toMatchObject({ speaker: 'Speaker 1', startSeconds: 2, text: 'Hello there.' });
    expect(turns[1]).toMatchObject({ speaker: 'Speaker 2', startSeconds: 90, text: 'Hi back.' });
  });

  it('handles hh:mm:ss and bracketed leading stamps', () => {
    const turns = parseTranscript('[01:02:03] Nicole\nLong session.');
    expect(turns[0].startSeconds).toBe(3723);
  });

  it('degrades to one turn rather than losing unstructured input', () => {
    // A transcript from a source with no speaker lines must still extract.
    const turns = parseTranscript('just a wall of text with no speakers at all');
    expect(turns).toHaveLength(1);
    expect(turns[0].text).toContain('wall of text');
  });

  it('does not treat a sentence ending in a colon as a speaker change', () => {
    const turns = parseTranscript('Speaker 1 0:01\nHere is the thing:\nit continues.');
    expect(turns).toHaveLength(1);
    expect(turns[0].text).toContain('it continues');
  });
});

describe('mergeAdjacentTurns', () => {
  it('glues consecutive same-speaker fragments back together', () => {
    const turns = parseTranscript(
      'Speaker 1 0:01\nFirst part.\n\nSpeaker 1 0:05\nSecond part.\n\nSpeaker 2 0:10\nOther person.',
    );
    const merged = mergeAdjacentTurns(turns);
    expect(merged).toHaveLength(2);
    expect(merged[0].text).toBe('First part. Second part.');
  });

  it('does not glue across a long gap — the same label minutes later is not one utterance', () => {
    const turns = parseTranscript('Speaker 1 0:01\nEarly.\n\nSpeaker 1 5:00\nMuch later.');
    expect(mergeAdjacentTurns(turns)).toHaveLength(2);
  });
});

describe('attributeSpeakers', () => {
  it('labels the muscle-testing script as the practitioner', () => {
    const turns = attributeSpeakers(
      parseTranscript('Speaker 2 0:42\nClose your eyes. Pinky thumb together. Add your ring finger.'),
    );
    expect(turns[0].role).toBe('PRACTITIONER');
  });

  it('labels first-person symptom narration as the client', () => {
    const turns = attributeSpeakers(
      parseTranscript("Speaker 3 0:22\nI've been having that hormonal migraine and my sleep is awful."),
    );
    expect(turns[0].role).toBe('CLIENT');
  });

  it('uses the second/first person lean, not just keywords', () => {
    // Neither sentence hits a keyword list; the pronouns alone must carry it.
    const turns = attributeSpeakers(
      parseTranscript(
        'Speaker 1 0:01\nAnd what were you feeling when you noticed your energy shift?\n\n' +
          'Speaker 2 0:20\nWell I noticed it around when I started, and mine got worse for me.',
      ),
    );
    expect(turns[0].role).toBe('PRACTITIONER');
    expect(turns[1].role).toBe('CLIENT');
  });

  it('refuses to attribute when the transcript has too many labels to trust', () => {
    // Otter emits up to TEN labels for a two-person session. A bare backchannel
    // under an untrustworthy label must stay UNKNOWN rather than be assigned
    // confidently to the wrong person.
    const src = Array.from({ length: 8 }, (_, i) => `Speaker ${i + 1} 0:0${i}\nYeah.`).join('\n\n');
    const turns = attributeSpeakers(parseTranscript(src));
    expect(turns.every((t) => t.role === 'UNKNOWN')).toBe(true);
  });

  it('attributes most of the WORDS on the real transcripts', () => {
    // Turn count overstates the gap — most UNKNOWN turns are one-word
    // backchannels carrying no clinical content. Words are what matter.
    for (const name of [
      'health-supplement-consultation.txt',
      'health-and-wellness-check-in.txt',
      'health-update-and-supplement-review.txt',
    ]) {
      const prepared = prepareTranscript(fixture(name));
      expect(attributionCoverage(prepared.turns)).toBeGreaterThan(0.75);
      // Both parties must be found — a session attributed entirely to one side
      // is the failure mode that put practitioner words in `concerns`.
      const roles = new Set(prepared.turns.map((t) => t.role));
      expect(roles.has('PRACTITIONER')).toBe(true);
      expect(roles.has('CLIENT')).toBe(true);
    }
  });
});

describe('compactForNarrative', () => {
  it('drops turns that are almost entirely the hand-position script', () => {
    const turns = parseTranscript(
      'Speaker 1 0:42\nClose your eyes. Pinky thumb together. Add your ring finger. Open your hand.\n\n' +
        'Speaker 1 1:00\nThe gallbladder is showing stress and we will support it today.',
    );
    const kept = compactForNarrative(turns);
    expect(kept).toHaveLength(1);
    expect(kept[0].text).toContain('gallbladder');
  });
});

describe('chunkTurns', () => {
  it('never splits a turn, and overlaps consecutive chunks', () => {
    const turns = parseTranscript(
      Array.from({ length: 12 }, (_, i) => `Speaker 1 0:${String(i).padStart(2, '0')}\n${'word '.repeat(60)}`).join('\n\n'),
    );
    const chunks = chunkTurns(turns, { targetTokens: 200, overlapTurns: 2 });
    expect(chunks.length).toBeGreaterThan(1);
    // Every original turn appears whole in some chunk.
    for (const t of turns) {
      expect(chunks.some((c) => c.turns.some((ct) => ct.text === t.text))).toBe(true);
    }
    // Consecutive chunks share turns — a finding on a boundary is seen whole.
    const first = new Set(chunks[0].turns.map((t) => t.charOffset));
    expect(chunks[1].turns.some((t) => first.has(t.charOffset))).toBe(true);
  });

  it('carries the time range so a chunk knows where it sits in the session', () => {
    const turns = parseTranscript('Speaker 1 1:00\nA.\n\nSpeaker 2 2:00\nB.');
    const [chunk] = chunkTurns(turns, { targetTokens: 10_000 });
    expect(chunk.startSeconds).toBe(60);
    expect(chunk.endSeconds).toBe(120);
    expect(chunk.total).toBe(1);
  });

  it('keeps an over-budget single turn intact rather than cutting it', () => {
    const turns = parseTranscript(`Speaker 1 0:01\n${'word '.repeat(5000)}`);
    const chunks = chunkTurns(turns, { targetTokens: 100 });
    expect(chunks).toHaveLength(1);
  });
});

describe('inline speaker transcripts', () => {
  // The shape the live recorder actually produces: label and utterance on one
  // line, no timestamp. This used to fall through to the single-turn fallback,
  // which silently attributed a whole two-person session to one speaker and
  // still reported 100% attribution coverage.
  const pocket = [
    'SPEAKER_00: And it flares up here and there. It is this inflammation.',
    'SPEAKER_01: Left side.',
    'SPEAKER_00: In my neck, my upper back.',
    'SPEAKER_01: How long has that been going on?',
  ].join('\n');

  it('splits a label-prefixed transcript into real turns', () => {
    const turns = parseTranscript(pocket);
    expect(turns).toHaveLength(4);
    expect(turns[1].speaker).toBe('SPEAKER_01');
    expect(turns[1].text).toBe('Left side.');
  });

  it('keeps the utterance out of the speaker label', () => {
    const turns = parseTranscript(pocket);
    expect(turns[0].text.startsWith('SPEAKER_00')).toBe(false);
  });

  it('reads a named-speaker transcript whose turns wrap across lines', () => {
    const wrapped = [
      'Nicole: Talk to me about where you are.',
      '',
      'Marta: Energy is genuinely good now. The afternoon crash is gone.',
      'No headaches at all in the last two weeks.',
      '',
      'Nicole: Pulse 0 is 68 and even.',
    ].join('\n');
    const turns = parseTranscript(wrapped);
    expect(turns.map((t) => t.speaker)).toEqual(['Nicole', 'Marta', 'Nicole']);
    // The unlabelled continuation line belongs to the turn above it.
    expect(turns[1].text).toContain('No headaches at all');
  });

  it('does not split prose on an ordinary mid-sentence colon', () => {
    // "Stressors are food" fits the label pattern but is a clause, not a name —
    // splitting here would cut a clinical finding in half.
    const prose = [
      'Speaker 1 0:02',
      'Here is the thing: I have been tired.',
      'Stressors are food: dairy only now.',
      'Stressors are food: gluten as well.',
    ].join('\n');
    const turns = parseTranscript(prose);
    expect(turns).toHaveLength(1);
    expect(turns[0].text).toContain('dairy only now');
  });

  it('leaves a dictated single-paragraph summary as one turn', () => {
    const summary = 'David reports bloating after meals, plus some joint aches.';
    expect(parseTranscript(summary)).toHaveLength(1);
  });
});

describe('merge cap', () => {
  const many = (n: number, words: number) =>
    Array.from({ length: n }, () => `SPEAKER_00: ${'word '.repeat(words).trim()}`).join('\n');

  it('stops merging before a turn becomes a wall of text', () => {
    // No timestamps, so the gap guard reads every gap as 0 and cannot brake.
    // Without the word cap these 10 turns glue into one 300-word turn, which is
    // the wide matching window span verification exists to avoid.
    const turns = mergeAdjacentTurns(parseTranscript(many(10, 30)));
    expect(turns.length).toBeGreaterThan(1);
    for (const t of turns) {
      expect(t.text.split(/\s+/).length).toBeLessThanOrEqual(120);
    }
  });

  it('still glues the short fragments merging exists for', () => {
    // The point of merging: "Yeah." / "Okay." carry no attribution signal alone.
    const turns = mergeAdjacentTurns(
      parseTranscript(['SPEAKER_00: Yeah.', 'SPEAKER_00: Okay.', 'SPEAKER_00: Right.'].join('\n')),
    );
    expect(turns).toHaveLength(1);
    expect(turns[0].text).toBe('Yeah. Okay. Right.');
  });

  it('never splits a single source turn, however long', () => {
    // A cap on MERGING only. Splitting a real utterance would invent a boundary
    // mid-sentence, and half an utterance reads as a complete statement.
    const long = 'word '.repeat(300).trim();
    const turns = mergeAdjacentTurns(
      parseTranscript([`SPEAKER_00: ${long}`, 'SPEAKER_01: Okay.', `SPEAKER_00: ${long}`].join('\n')),
    );
    expect(turns).toHaveLength(3);
    expect(turns[0].text.split(/\s+/).length).toBe(300);
    expect(turns[2].text.split(/\s+/).length).toBe(300);
  });
});

describe('turn numbering', () => {
  it('numbers turns globally, and renders the number the model cites', () => {
    const turns = prepareTranscript('Speaker 1 0:02\nHello there.\n\nSpeaker 2 1:30\nHi back.').turns;
    expect(turns.map((t) => t.index)).toEqual([0, 1]);
    expect(renderTurns(turns)).toContain('#0 ');
    expect(renderTurns(turns)).toContain('#1 ');
  });

  it('keeps a turn number stable after compaction drops its neighbours', () => {
    // Compaction filters turns out; a positional index would renumber the
    // survivors and point every citation at the wrong utterance.
    const turns = prepareTranscript(
      'Speaker 1 0:02\nClose your eyes. Pinky and thumb together.\n\n' +
        'Speaker 1 0:40\nThe gallbladder is showing stress today.',
    ).turns;
    const kept = compactForNarrative(turns);
    expect(kept).toHaveLength(1);
    expect(kept[0].index).toBe(1);
    expect(renderTurns(kept)).toContain('#1 ');
  });
});

// The handover below is transcribed verbatim from recording 92f683ed
// (2026-08-21, 180 turns). It is the case every other multi-session signal
// misses: the diarizer reused SPEAKER_01 for BOTH clients, so the audio shows
// two labels, and no client is ever named aloud. The only evidence that two
// people were in the room is the handover itself.
const filler = (n: number): string[] =>
  Array.from({ length: n }, (_, i) =>
    i % 2 === 0
      ? `SPEAKER_00: Keep the magnesium going, and we will look at it again. Line ${i}.`
      : `SPEAKER_01: Okay, that makes sense to me. Line ${i}.`,
  );

const realHandover = [
  ...filler(160),
  'SPEAKER_00: So five thirty the twenty-third.',
  'SPEAKER_01: Five thirty. No problem. Thanks.',
  'SPEAKER_00: Have fun. Hello.',
  'SPEAKER_01: Hi.',
  'SPEAKER_00: How are you?',
  "SPEAKER_01: I'm good. Oh, you're struggling.",
].join('\n');

describe('findSessionRestart', () => {
  it('finds the handover the diarizer and the calendar both miss', () => {
    // Two speaker labels and no names spoken: the >=4-label signal and the
    // foreign-name signal are both structurally blind here.
    expect(new Set(parseTranscript(realHandover).map((t) => t.speaker)).size).toBe(2);
    expect(findSessionRestart(realHandover)).toBe(163);
  });

  it('reports the turn in parseTurns numbering, not parseTranscript numbering', () => {
    // parseTranscript does not merge adjacent same-speaker turns, so its indices
    // drift from the ones the review UI renders and the splitter cuts on. A
    // number in the wrong scheme silently moves the cut.
    const merged = [
      ...filler(160),
      'SPEAKER_00: So five thirty the twenty-third.',
      'SPEAKER_00: Have fun. Hello.',
      'SPEAKER_01: Hi.',
    ].join('\n');
    const at = findSessionRestart(merged);
    expect(at).not.toBeNull();
    // The two consecutive SPEAKER_00 lines are ONE turn after merging.
    expect(parseTranscript(merged).length).toBeGreaterThan(prepareTurns(merged).length);
    expect(prepareTurns(merged)[at! - 1].text).toContain('Hello');
  });

  it('ignores the opening greeting of a normal consultation', () => {
    const normal = [
      'SPEAKER_00: Hi, come on in. How are you?',
      "SPEAKER_01: I'm good, thanks for fitting me in.",
      ...filler(80),
    ].join('\n');
    expect(findSessionRestart(normal)).toBeNull();
  });

  it('does not fire on a greeting nobody answers', () => {
    // The practitioner waving someone through the door mid-session is not a
    // handover; an arriving client always produces an exchange.
    const unanswered = [
      ...filler(80),
      'SPEAKER_00: Hey, one second, let me grab that.',
      'SPEAKER_00: So the magnesium is what I want you to keep.',
      ...filler(20),
    ].join('\n');
    expect(findSessionRestart(unanswered)).toBeNull();
  });

  it('does not fire when the same speaker greets and continues', () => {
    const solo = [
      ...filler(80),
      'SPEAKER_00: Hello, so as I was saying.',
      'SPEAKER_00: How are you finding the drops?',
      ...filler(20),
    ].join('\n');
    expect(findSessionRestart(solo)).toBeNull();
  });

  it('will not call a short recording two sessions', () => {
    const short = [
      'SPEAKER_00: Take care, see you in four weeks.',
      'SPEAKER_00: Hello.',
      'SPEAKER_01: Hi, how are you?',
    ].join('\n');
    expect(findSessionRestart(short)).toBeNull();
  });

  it('treats "how are you" as an answer but never as an opener', () => {
    // Mid-session small talk is overwhelmingly the status form, so on its own it
    // must not start a handover.
    const smallTalk = [...filler(80), 'SPEAKER_00: How are you doing with all that?', 'SPEAKER_01: Fine, mostly.', ...filler(20)].join('\n');
    expect(findSessionRestart(smallTalk)).toBeNull();
  });
});
