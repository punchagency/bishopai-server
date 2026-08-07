import { describe, it, expect } from 'vitest';
import { manualSourceId, normalizeManualTranscript } from './manualImport';

describe('manualSourceId', () => {
  it('is stable for the same text and namespaced manual:', () => {
    const id = manualSourceId('hello there');
    expect(id).toBe(manualSourceId('hello there'));
    expect(id.startsWith('manual:')).toBe(true);
  });

  it('differs for different text', () => {
    expect(manualSourceId('a')).not.toBe(manualSourceId('b'));
  });
});

describe('normalizeManualTranscript', () => {
  it('collapses Otter-style speaker+timestamp headers into `Speaker: text` lines', () => {
    const raw = [
      'Speaker 2 0:07',
      'Okay. And what were you feeling two weeks ago?',
      '',
      'Speaker 3 0:12',
      "It's like two different things.",
      'First, my period came early.',
    ].join('\n');

    expect(normalizeManualTranscript(raw)).toBe(
      [
        'Speaker 2: Okay. And what were you feeling two weeks ago?',
        "Speaker 3: It's like two different things. First, my period came early.",
      ].join('\n'),
    );
  });

  it('handles hour-long timestamps (h:mm:ss)', () => {
    const raw = 'Nicole 1:02:33\nWelcome back.';
    expect(normalizeManualTranscript(raw)).toBe('Nicole: Welcome back.');
  });

  it('passes non-timestamped text through, trimmed and otherwise unchanged', () => {
    const raw = '\n  Nicole: how are you?\nClient: better.  \n';
    expect(normalizeManualTranscript(raw)).toBe('Nicole: how are you?\nClient: better.');
  });

  it('keeps leading unattributed text when it precedes any header', () => {
    const raw = 'Session notes follow.\nSpeaker 1 0:00\nHi there.';
    expect(normalizeManualTranscript(raw)).toBe('Session notes follow.\nSpeaker 1: Hi there.');
  });
});
