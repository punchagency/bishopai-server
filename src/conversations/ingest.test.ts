import { describe, it, expect } from 'vitest';
import { classifyNoiseRecording } from './ingest';

// The rule that decides whether a recording is ever seen again. A false positive
// hides a real (short) session; a false negative leaves "[click]" sitting in the
// Unmatched queue. Both are worth pinning directly rather than through the DB.

const base = {
  source: 'pocket' as const,
  source_id: 'rec-1',
  starts_at: '2026-09-03T14:42:11.000Z',
  ends_at: '2026-09-03T14:42:12.000Z', // 1 second
};

describe('classifyNoiseRecording', () => {
  it('flags a sub-minute recording whose transcript is a single event tag', () => {
    expect(classifyNoiseRecording({ ...base, transcript: '[click]' })).toMatch(/no speech/);
    expect(
      classifyNoiseRecording({
        ...base,
        ends_at: '2026-09-03T14:42:26.000Z',
        transcript: '[background noise]',
      }),
    ).toMatch(/no speech/);
  });

  it('flags whitespace and punctuation around bracketed tags', () => {
    expect(
      classifyNoiseRecording({ ...base, transcript: '  [BLANK_AUDIO] ... [click]\n' }),
    ).not.toBeNull();
  });

  it('keeps a short recording that has actual words in it', () => {
    expect(
      classifyNoiseRecording({ ...base, transcript: '[laughs] yeah, I have been tired' }),
    ).toBeNull();
    expect(classifyNoiseRecording({ ...base, transcript: 'Hi Nicole, I need to reschedule.' })).toBeNull();
  });

  it('keeps a longer recording even when it transcribes to noise alone', () => {
    // A 3-minute recording that came back "[background noise]" is likelier a
    // transcription failure than a recording of nothing — that wants a human.
    expect(
      classifyNoiseRecording({
        ...base,
        ends_at: '2026-09-03T14:45:11.000Z', // 3 minutes
        transcript: '[background noise]',
      }),
    ).toBeNull();
  });

  it('leaves a recording with no transcript alone (audio arrives before words)', () => {
    expect(classifyNoiseRecording({ ...base, transcript: null })).toBeNull();
    expect(classifyNoiseRecording({ ...base, transcript: '   ' })).toBeNull();
    expect(classifyNoiseRecording({ ...base })).toBeNull();
  });

  it('does not choke on an unparseable time window', () => {
    expect(
      classifyNoiseRecording({ ...base, ends_at: 'not-a-date', transcript: '[click]' }),
    ).toBeNull();
  });

  it('names the length and quotes the transcript so the row explains itself', () => {
    const reason = classifyNoiseRecording({ ...base, transcript: '[click]' });
    expect(reason).toContain('1s');
    expect(reason).toContain('[click]');
  });
});
