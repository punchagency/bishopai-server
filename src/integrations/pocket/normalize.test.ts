import { describe, it, expect } from 'vitest';
import { recordingWindow, transcriptText, toConversationInput, fromRestData, fromRestList } from './normalize';

describe('recordingWindow', () => {
  it('derives the window from createdAt + duration', () => {
    // Pocket's own documented example: createdAt 11:30 + 1800s lands on the
    // 12:00 event timestamp, which is what makes createdAt the START.
    expect(recordingWindow({ createdAt: '2026-02-18T11:30:00.000Z', duration: 1800 })).toEqual({
      starts_at: '2026-02-18T11:30:00.000Z',
      ends_at: '2026-02-18T12:00:00.000Z',
    });
  });

  it('prefers explicit start/end fields over the inference', () => {
    expect(
      recordingWindow({
        createdAt: '2026-02-18T11:30:00.000Z',
        duration: 1800,
        startedAt: '2026-02-18T09:00:00.000Z',
        endedAt: '2026-02-18T09:45:00.000Z',
      }),
    ).toEqual({ starts_at: '2026-02-18T09:00:00.000Z', ends_at: '2026-02-18T09:45:00.000Z' });
  });

  it('accepts snake_case variants', () => {
    expect(recordingWindow({ created_at: '2026-02-18T11:30:00.000Z', duration: 60 })).toEqual({
      starts_at: '2026-02-18T11:30:00.000Z',
      ends_at: '2026-02-18T11:31:00.000Z',
    });
  });

  it('collapses to a 1ms window when duration is missing, rather than inventing a length', () => {
    expect(recordingWindow({ createdAt: '2026-02-18T11:30:00.000Z' })).toEqual({
      starts_at: '2026-02-18T11:30:00.000Z',
      ends_at: '2026-02-18T11:30:00.001Z',
    });
  });

  it('ignores a negative or zero duration the same way', () => {
    expect(recordingWindow({ createdAt: '2026-02-18T11:30:00.000Z', duration: -5 })?.ends_at).toBe(
      '2026-02-18T11:30:00.001Z',
    );
  });

  it('ignores an end that precedes the start', () => {
    const w = recordingWindow({
      createdAt: '2026-02-18T11:30:00.000Z',
      duration: 600,
      endedAt: '2026-02-18T10:00:00.000Z',
    });
    expect(w).toEqual({ starts_at: '2026-02-18T11:30:00.000Z', ends_at: '2026-02-18T11:40:00.000Z' });
  });

  it('returns null when there is no usable start — never guesses a time', () => {
    expect(recordingWindow({ duration: 1800 })).toBeNull();
    expect(recordingWindow({ createdAt: 'not a date' })).toBeNull();
    expect(recordingWindow(undefined)).toBeNull();
  });
});

describe('transcriptText', () => {
  it('renders one `Speaker: text` line per utterance, in order', () => {
    expect(
      transcriptText([
        { speaker: 'Nicole', text: "Let's go over your protocol.", start: 0, end: 3.5 },
        { speaker: 'Marta', text: 'I stopped the magnesium.', start: 3.5, end: 6 },
      ]),
    ).toBe("Nicole: Let's go over your protocol.\nMarta: I stopped the magnesium.");
  });

  it('keeps unattributed text rather than inventing a speaker', () => {
    expect(transcriptText([{ text: 'mumbling' }])).toBe('mumbling');
  });

  it('drops empty segments but keeps the rest', () => {
    expect(transcriptText([{ speaker: 'A', text: '  ' }, { speaker: 'B', text: 'real' }])).toBe('B: real');
  });

  it('is undefined (not an empty string) when there is nothing usable', () => {
    expect(transcriptText([])).toBeUndefined();
    expect(transcriptText(undefined)).toBeUndefined();
    expect(transcriptText([{ speaker: 'A' }])).toBeUndefined();
  });
});

describe('toConversationInput', () => {
  const payload = {
    event: 'summary.completed',
    recording: { id: 'rec_abc123', title: 'Team Standup', duration: 1800, createdAt: '2026-02-18T11:30:00.000Z' },
    transcript: [{ speaker: 'Alice', text: "Let's go over this week's priorities.", start: 0, end: 3.5 }],
  };

  it('maps a documented webhook payload onto the ingest input', () => {
    expect(toConversationInput(payload)).toEqual({
      source_id: 'rec_abc123',
      source: 'pocket',
      starts_at: '2026-02-18T11:30:00.000Z',
      ends_at: '2026-02-18T12:00:00.000Z',
      transcript: "Alice: Let's go over this week's priorities.",
    });
  });

  it('leaves transcript undefined so a later event cannot blank a stored one', () => {
    // ingest COALESCEs on conflict; undefined preserves what is already there,
    // whereas null would erase a transcript an earlier delivery landed.
    const { transcript, ...rest } = payload;
    expect(toConversationInput(rest)?.transcript).toBeUndefined();
  });

  it('returns null without a recording id — there would be nothing to dedupe on', () => {
    expect(toConversationInput({ ...payload, recording: { ...payload.recording, id: '' } })).toBeNull();
    expect(toConversationInput({ transcript: payload.transcript })).toBeNull();
  });

  it('returns null when the recording cannot be placed in time', () => {
    expect(toConversationInput({ recording: { id: 'rec_1' } })).toBeNull();
  });
});

describe('fromRestData — the undocumented `data` envelope', () => {
  const rec = { id: 'rec_1', createdAt: '2026-02-18T11:30:00.000Z', duration: 60 };
  const seg = [{ speaker: 'A', text: 'hi' }];

  it('accepts the recording nested under `recording`', () => {
    expect(fromRestData({ recording: rec, transcript: seg })).toEqual({ recording: rec, transcript: seg });
  });

  it('accepts the recording fields inline at the top level', () => {
    expect(fromRestData({ ...rec, transcript: seg })).toEqual({ recording: { ...rec, transcript: seg }, transcript: seg });
  });

  it('accepts the transcript under `segments` or `utterances`', () => {
    expect(fromRestData({ recording: rec, transcript: { segments: seg } }).transcript).toEqual(seg);
    expect(fromRestData({ recording: rec, segments: seg }).transcript).toEqual(seg);
    expect(fromRestData({ recording: rec, utterances: seg }).transcript).toEqual(seg);
  });

  it('yields something toConversationInput rejects for an unrecognized body', () => {
    expect(toConversationInput(fromRestData(null))).toBeNull();
    expect(toConversationInput(fromRestData('nope'))).toBeNull();
    expect(toConversationInput(fromRestData({ unexpected: true }))).toBeNull();
  });
});

describe('fromRestList', () => {
  const recs = [{ id: 'rec_1' }, { id: 'rec_2' }];

  it('accepts a bare array or a wrapped one', () => {
    expect(fromRestList(recs)).toEqual(recs);
    expect(fromRestList({ recordings: recs })).toEqual(recs);
    expect(fromRestList({ items: recs })).toEqual(recs);
    expect(fromRestList({ results: recs })).toEqual(recs);
  });

  it('is empty rather than throwing on an unexpected body', () => {
    expect(fromRestList(null)).toEqual([]);
    expect(fromRestList({ nope: 1 })).toEqual([]);
  });
});
