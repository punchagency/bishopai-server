import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const logEvent = vi.fn();
vi.mock('../observability/logger', () => ({ logEvent: (...a: unknown[]) => logEvent(...a) }));

import { llmConfig } from './config';
import {
  currentKey,
  hasFreshKey,
  keyCount,
  keyringStatus,
  resetKeyringForTests,
  retireCurrentKey,
} from './keyring';

// The ring reads llmConfig once per provider, so the fixture is installed by
// mutating the array in place and rebuilding the ring — no module mocking, and
// the real config object stays the one under test.
function withKeys(...keys: string[]): void {
  llmConfig.google.apiKeys.splice(0, llmConfig.google.apiKeys.length, ...keys);
  resetKeyringForTests();
}

const original = [...llmConfig.google.apiKeys];

beforeEach(() => logEvent.mockClear());
afterEach(() => {
  llmConfig.google.apiKeys.splice(0, llmConfig.google.apiKeys.length, ...original);
  resetKeyringForTests();
});

describe('key ring', () => {
  it('stays on one key until that key is retired', () => {
    withKeys('key-a', 'key-b');
    expect(keyCount('google')).toBe(2);
    expect(currentKey('google')).toBe('key-a');
    expect(currentKey('google')).toBe('key-a'); // reading does not advance
  });

  it('rotates to the spare when the first key spends its day', () => {
    withKeys('key-a', 'key-b');
    expect(retireCurrentKey('google', 'per-day quota')).toBe(true);
    expect(currentKey('google')).toBe('key-b');
    expect(hasFreshKey('google')).toBe(true);
  });

  it('reports the ring empty once every key is spent', () => {
    withKeys('key-a', 'key-b');
    expect(retireCurrentKey('google', 'per-day quota')).toBe(true);
    // The second refusal has nowhere to go — this false is what closes the
    // allowance gate in providers.ts.
    expect(retireCurrentKey('google', 'per-day quota')).toBe(false);
    expect(hasFreshKey('google')).toBe(false);
  });

  it('does not pretend a single key can fail over', () => {
    withKeys('only-key');
    expect(retireCurrentKey('google', 'per-day quota')).toBe(false);
    expect(hasFreshKey('google')).toBe(false);
  });

  it('refills when the allowance resets, without a restart', () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-09-02T10:00:00Z'));
      withKeys('key-a', 'key-b');
      retireCurrentKey('google', 'per-day quota');
      retireCurrentKey('google', 'per-day quota');
      expect(hasFreshKey('google')).toBe(false);

      // Past the reset both keys are believed good again.
      vi.setSystemTime(new Date('2026-09-04T10:00:00Z'));
      expect(hasFreshKey('google')).toBe(true);
      expect(keyringStatus('google')).toMatchObject({ spent: 0 });
      // Resumes where it left off rather than walking back to the first key.
      // Both are equally fresh, so returning to 'key-a' would buy nothing and
      // the ring is a rotation, not a primary with a standby.
      expect(currentKey('google')).toBe('key-b');
    } finally {
      vi.useRealTimers();
    }
  });

  it('retires nothing on its own — only an explicit refusal moves the ring', () => {
    withKeys('key-a', 'key-b');
    for (let i = 0; i < 50; i++) currentKey('google');
    expect(keyringStatus('google')).toMatchObject({ keys: 2, active: 1, spent: 0 });
  });

  it('never puts a key in the log', () => {
    withKeys('sk-secret-alpha', 'sk-secret-beta');
    retireCurrentKey('google', 'quota exceeded for sk-secret-alpha');
    const logged = JSON.stringify(logEvent.mock.calls);
    expect(logEvent).toHaveBeenCalled();
    // The reason is the provider's own words and is kept, but the ring must not
    // add a key of its own — it identifies keys by position.
    expect(logged).not.toContain('sk-secret-beta');
    expect(logged).toContain('1 of 2');
  });

  it('has no ring for a provider that needs no key', () => {
    expect(keyCount('mock')).toBe(0);
    expect(hasFreshKey('mock')).toBe(false);
    expect(retireCurrentKey('mock', 'n/a')).toBe(false);
  });
});
