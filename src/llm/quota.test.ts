import { describe, it, expect } from 'vitest';
import {
  RateLimitError,
  TransientServerError,
  isQuotaExhausted,
  isRetryable,
} from './errors';

// The message bodies below are copied from real 429s, not invented: the whole
// point of the classifier is that these two arrive with the same status code and
// need opposite handling.
const GOOGLE_DAILY =
  'You exceeded your current quota, please check your plan and billing details. ' +
  '"quotaId":"GenerateRequestsPerDayPerProjectPerModel-FreeTier","quotaValue":"20" ' +
  '"retryDelay":"8s"';
const GOOGLE_PER_MINUTE =
  '"quotaId":"GenerateRequestsPerMinutePerProjectPerModel-FreeTier","quotaValue":"15"';
const GROQ_TPM = 'Rate limit reached for model in organization on tokens per minute (TPM)';

describe('quota exhaustion vs pacing', () => {
  it('reads a per-day cap as spent', () => {
    expect(isQuotaExhausted(new Error(GOOGLE_DAILY))).toBe(true);
    expect(isQuotaExhausted(new Error('insufficient_quota'))).toBe(true);
  });

  it('reads a per-minute limit as pacing, which is the more expensive one to get wrong', () => {
    // Calling this exhausted would abandon a session the provider would have
    // served thirty seconds later.
    expect(isQuotaExhausted(new Error(GOOGLE_PER_MINUTE))).toBe(false);
    expect(isQuotaExhausted(new Error(GROQ_TPM))).toBe(false);
  });

  it('stops retrying a spent allowance, and keeps retrying a paced one', () => {
    // Every retry against a per-day REQUEST cap spends another request on the
    // cap that just refused this one.
    expect(isRetryable(new RateLimitError({ provider: 'google', exhausted: true }))).toBe(false);
    expect(isRetryable(new RateLimitError({ provider: 'google' }))).toBe(true);
  });

  it('treats a provider blip as worth retrying, and says so plainly', () => {
    // "This model is currently experiencing high demand" arrived as a 503 and
    // dropped two stages with no second attempt — the most transient error there
    // is, handled as though it were fatal.
    const err = new TransientServerError({ provider: 'google', status: 503 });
    expect(isRetryable(err)).toBe(true);
    expect(err.message).toContain('temporarily unavailable');
    expect(err.message).toContain('503');
  });

  it('says which one it was in the message', () => {
    // "provider rate limited" on an exhausted key is what made this look like a
    // transient blip in the logs for a whole afternoon.
    expect(new RateLimitError({ provider: 'google', exhausted: true }).message).toContain(
      'quota exhausted',
    );
    expect(new RateLimitError({ provider: 'google' }).message).toContain('rate limited');
  });
});
