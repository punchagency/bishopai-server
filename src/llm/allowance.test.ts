import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  allowanceStatus,
  assertAllowance,
  closeAllowance,
  nextResetAt,
  noteProviderError,
  resetAllowanceForTests,
} from './allowance';
import { RateLimitError } from './errors';

afterEach(() => {
  resetAllowanceForTests();
  vi.useRealTimers();
});

// The verbatim body Google returned on 2026-08-24, the day seven sessions were
// filed as extracted with every field blank. Abridging it is how the original
// quota test passed while the classifier it tested was broken, so it stays whole.
const REAL_429 =
  'got status: 429 Too Many Requests. {"error":{"code":429,"message":"You exceeded your ' +
  'current quota, please check your plan and billing details.","status":"RESOURCE_EXHAUSTED",' +
  '"details":[{"@type":"type.googleapis.com/google.rpc.QuotaFailure","violations":[{' +
  '"quotaMetric":"generativelanguage.googleapis.com/generate_content_free_tier_requests",' +
  '"quotaId":"GenerateRequestsPerDayPerProjectPerModel-FreeTier",' +
  '"quotaDimensions":{"model":"gemini-3.6-flash","location":"global"},"quotaValue":"20"}]},' +
  '{"@type":"type.googleapis.com/google.rpc.RetryInfo","retryDelay":"25s"}]}}';

describe('the daily allowance gate', () => {
  it('is open until something says otherwise', () => {
    expect(allowanceStatus().open).toBe(true);
    expect(() => assertAllowance()).not.toThrow();
  });

  it('closes on a real per-day refusal and refuses the next call without a network round trip', () => {
    expect(noteProviderError(new Error(REAL_429))).toBe(true);
    expect(allowanceStatus().open).toBe(false);
    expect(() => assertAllowance()).toThrow(RateLimitError);
  });

  it('refuses in the shape the provider would have, so no caller needs to know a gate exists', () => {
    closeAllowance(REAL_429);
    try {
      assertAllowance();
      expect.unreachable('gate should have refused');
    } catch (err) {
      // The whole pipeline branches on `exhausted` — markExtractionFailed parks
      // instead of laddering, extract.ts stops chunking. A gate refusal that
      // didn't carry it would be retried as an ordinary blip, which is the
      // amplification this exists to stop.
      expect(err).toBeInstanceOf(RateLimitError);
      expect((err as RateLimitError).exhausted).toBe(true);
      // The provider's own words, not a sentence this module made up: the row
      // stores this, and `classify` in unprocessed.ts re-reads it later to
      // decide whether to tell Nicole "waiting" or "broken".
      expect((err as RateLimitError).message).toContain('RESOURCE_EXHAUSTED');
    }
  });

  it('stays open for a rate limit that is merely paced', () => {
    // Same status code, opposite meaning. Closing on this would stall a healthy
    // day's work on a limiter that wanted a 25-second wait.
    const paced = new RateLimitError({
      provider: 'google',
      retryAfterMs: 25_000,
      exhausted: false,
      cause: new Error('429 rate limit exceeded, retry in 25s'),
    });
    expect(noteProviderError(paced)).toBe(false);
    expect(allowanceStatus().open).toBe(true);
  });

  it('reopens once the reset passes', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-24T18:00:00Z')); // 11:00 Pacific
    closeAllowance(REAL_429);
    expect(allowanceStatus().open).toBe(false);

    vi.setSystemTime(new Date('2026-08-25T06:59:00Z')); // 23:59 Pacific, same day
    expect(allowanceStatus().open).toBe(false);

    vi.setSystemTime(new Date('2026-08-25T07:01:00Z')); // 00:01 Pacific, next day
    expect(allowanceStatus().open).toBe(true);
  });

  it('resets at local midnight Pacific, not UTC midnight', () => {
    // The distinction is the whole reason this is not `+ 24 hours`: a refusal at
    // 11:00 Pacific waits 13 hours, and a refusal at 23:00 Pacific waits one.
    const morning = nextResetAt(new Date('2026-08-24T18:00:00Z'));
    expect(morning.toISOString()).toBe('2026-08-25T07:00:00.000Z');

    const lateEvening = nextResetAt(new Date('2026-08-25T06:30:00Z'));
    expect(lateEvening.toISOString()).toBe('2026-08-25T07:00:00.000Z');
    expect(lateEvening.getTime() - new Date('2026-08-25T06:30:00Z').getTime()).toBe(30 * 60_000);
  });
});
