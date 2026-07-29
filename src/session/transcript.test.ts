import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  attributeSpeakers,
  attributionCoverage,
  chunkTurns,
  compactForNarrative,
  mergeAdjacentTurns,
  parseTranscript,
  prepareTranscript,
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
