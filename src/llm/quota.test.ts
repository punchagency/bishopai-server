import { describe, it, expect } from 'vitest';
import {
  RateLimitError,
  TransientServerError,
  isQuotaExhausted,
  isRetryable,
} from './errors';

// VERBATIM 429 bodies, not summaries of them.
//
// The abridged fixtures these replace are the reason the classifier shipped
// broken: hand-written down to the fields the test author thought mattered,
// they omitted every token the implementation actually keyed on, so the test
// asserted the right answer about a message Google does not send. The real
// per-day body below is copied out of `system_events` for 2026-08-24 14:21 UTC,
// the run that filed seven sessions as extracted and blank. Shorten it and the
// regression it guards becomes invisible again.
const GOOGLE_DAILY =
  'provider rate limited: {"error":{"code":429,"message":"You exceeded your current quota, ' +
  'please check your plan and billing details. For more information on this error, head to: ' +
  'https://ai.google.dev/gemini-api/docs/rate-limits. To monitor your current usage, head to: ' +
  'https://ai.dev/rate-limit. \\n* Quota exceeded for metric: ' +
  'generativelanguage.googleapis.com/generate_content_free_tier_requests, limit: 20, ' +
  'model: gemini-3.6-flash\\nPlease retry in 58.690269291s.","status":"RESOURCE_EXHAUSTED",' +
  '"details":[{"@type":"type.googleapis.com/google.rpc.QuotaFailure","violations":[{' +
  '"quotaMetric":"generativelanguage.googleapis.com/generate_content_free_tier_requests",' +
  '"quotaId":"GenerateRequestsPerDayPerProjectPerModel-FreeTier","quotaDimensions":{' +
  '"location":"global","model":"gemini-3.6-flash"},"quotaValue":"20"}]},{' +
  '"@type":"type.googleapis.com/google.rpc.RetryInfo","retryDelay":"58s"}]}}';
const GOOGLE_PER_MINUTE =
  'provider rate limited: {"error":{"code":429,"message":"You exceeded your current quota, ' +
  'please check your plan and billing details. \\n* Quota exceeded for metric: ' +
  'generativelanguage.googleapis.com/generate_content_free_tier_requests, limit: 15, ' +
  'model: gemini-3.6-flash\\nPlease retry in 12.4s.","status":"RESOURCE_EXHAUSTED",' +
  '"details":[{"@type":"type.googleapis.com/google.rpc.QuotaFailure","violations":[{' +
  '"quotaMetric":"generativelanguage.googleapis.com/generate_content_free_tier_requests",' +
  '"quotaId":"GenerateRequestsPerMinutePerProjectPerModel-FreeTier","quotaValue":"15"}]},{' +
  '"@type":"type.googleapis.com/google.rpc.RetryInfo","retryDelay":"12s"}]}}';
const GROQ_TPM = 'Rate limit reached for model in organization on tokens per minute (TPM)';

describe('quota exhaustion vs pacing', () => {
  it('reads a per-day cap as spent', () => {
    expect(isQuotaExhausted(new Error(GOOGLE_DAILY))).toBe(true);
    expect(isQuotaExhausted(new Error('insufficient_quota'))).toBe(true);
  });

  it('is not talked out of it by the retry-after on a per-day cap', () => {
    // The specific regression. Google attaches "Please retry in 58.69s" and a
    // RetryInfo block to a cap that resets at midnight, and names the metric
    // `generate_content_free_tier_requests` and a numeric `limit:` on BOTH
    // periods. None of that says anything about which quota was hit — only
    // `quotaId` does — so none of it may be read as evidence of pacing.
    expect(GOOGLE_DAILY).toMatch(/generate_content_free_tier_requests/);
    expect(GOOGLE_DAILY).toMatch(/limit: \d+/);
    expect(GOOGLE_DAILY).toMatch(/retry in/i);
    expect(GOOGLE_DAILY).toMatch(/RetryInfo/);
    expect(isQuotaExhausted(new Error(GOOGLE_DAILY))).toBe(true);
  });

  it('reads a per-minute limit as pacing, which is the more expensive one to get wrong', () => {
    // Calling this exhausted would abandon a session the provider would have
    // served thirty seconds later. Note this body is near-identical to the
    // per-day one — same metric, same shape, same retry hint. `quotaId` is the
    // only field that differs, which is why it is the only field consulted.
    expect(isQuotaExhausted(new Error(GOOGLE_PER_MINUTE))).toBe(false);
    expect(isQuotaExhausted(new Error(GROQ_TPM))).toBe(false);
  });

  it('prefers the named quota over anything the prose says', () => {
    // A per-minute refusal whose help text mentions daily limits must still
    // read as pacing: the name of the quota that was actually refused wins.
    const chatty =
      '"quotaId":"GenerateRequestsPerMinutePerProjectPerModel-FreeTier" — ' +
      'see the docs for your daily limit and per day allowance';
    expect(isQuotaExhausted(new Error(chatty))).toBe(false);
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
