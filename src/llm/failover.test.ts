import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Keys the SDK was actually constructed with, in order. This is the assertion
// that matters: a rotation is only real if it reaches the client, and the
// clients are cached, so a `??=` would pin key 1 for the life of the process.
const keysUsed: string[] = [];
let respond: () => unknown;

vi.mock('@google/genai', () => ({
  GoogleGenAI: class {
    models = { generateContent: async () => respond() };
    constructor(opts: { apiKey: string }) {
      keysUsed.push(opts.apiKey);
    }
  },
}));

import { llmConfig } from './config';
import { resetAllowanceForTests, allowanceStatus } from './allowance';
import { resetKeyringForTests } from './keyring';
import { generateStructured } from './providers';

/** Google's real per-day refusal, trimmed to the part the classifier reads. */
function perDayRefusal(): Error {
  const err = new Error(
    'got status: 429 Too Many Requests. {"error":{"code":429,"message":"Quota exceeded for ' +
      'metric: generativelanguage.googleapis.com/generate_content_free_tier_requests, limit: 20",' +
      '"details":[{"violations":[{"quotaId":"GenerateRequestsPerDayPerProjectPerModel-FreeTier"}]}]}}',
  );
  (err as { status?: number }).status = 429;
  return err;
}

const ok = () => ({ text: '{"ok":true}', candidates: [{ finishReason: 'STOP' }] });

const originalKeys = [...llmConfig.google.apiKeys];
const originalProvider = llmConfig.provider;

beforeEach(() => {
  keysUsed.length = 0;
  // Pinned rather than inherited from .env, so this test means the same thing
  // on a machine that has no credentials at all.
  (llmConfig as { provider: string }).provider = 'google';
  llmConfig.google.apiKeys.splice(0, llmConfig.google.apiKeys.length, 'key-a', 'key-b');
  resetKeyringForTests();
  resetAllowanceForTests();
});

afterEach(() => {
  (llmConfig as { provider: string }).provider = originalProvider;
  llmConfig.google.apiKeys.splice(0, llmConfig.google.apiKeys.length, ...originalKeys);
  resetKeyringForTests();
  resetAllowanceForTests();
});

const req = { system: 's', user: 'u', jsonSchema: undefined, maxTokens: 64 } as Parameters<
  typeof generateStructured
>[0];

describe('api key failover', () => {
  it('retries the same request on the spare when the first key spends its day', async () => {
    let call = 0;
    respond = () => {
      call += 1;
      if (call === 1) throw perDayRefusal();
      return ok();
    };

    await expect(generateStructured(req)).resolves.toMatchObject({ parsed: { ok: true } });
    expect(keysUsed).toEqual(['key-a', 'key-b']);
    // The point of the whole exercise: one key being spent must NOT stop the
    // day's work while another key is good.
    expect(allowanceStatus().open).toBe(true);
  });

  it('closes the allowance gate only once every key is spent', async () => {
    respond = () => {
      throw perDayRefusal();
    };

    await expect(generateStructured(req)).rejects.toThrow();
    expect(keysUsed).toEqual(['key-a', 'key-b']);
    expect(allowanceStatus().open).toBe(false);
  });

  it('does not rotate on an ordinary paced 429', async () => {
    let call = 0;
    respond = () => {
      call += 1;
      if (call === 1) {
        const err = new Error('got status: 429. Please retry in 8s.');
        (err as { status?: number }).status = 429;
        throw err;
      }
      return ok();
    };

    // Paced, not spent: this must surface to the caller's own backoff rather
    // than burning the spare key's daily allowance to skip an eight-second wait.
    await expect(generateStructured(req)).rejects.toThrow();
    expect(keysUsed).toEqual(['key-a']);
    expect(allowanceStatus().open).toBe(true);
  });
});
