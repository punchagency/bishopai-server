import { logEvent } from '../observability/logger';
import { nextResetAt } from './allowance';
import { llmConfig, type Provider } from './config';

// Failover across several API keys for one provider.
//
// llm/allowance.ts gates on "the day's allowance is spent", but that allowance
// is not a property of this process — it belongs to the project behind the key
// that was refused. A second key on a second project is a second day's worth of
// requests, so closing the gate on the first refusal retires capacity that is
// sitting unused in the env file.
//
// The ring is deliberately thin. It does not retry, back off, or decide what an
// error means; it answers two questions — which key is current, and is there
// another one worth trying — and providers.ts does the rest.
//
// A key is retired ONLY on a per-day refusal, never on a paced 429. That
// distinction is the whole design: a paced 429 says nothing about the key, and
// rotating on it would spend the spare key's daily allowance to skip a wait the
// first key would have served in thirty seconds. The rings would then both be
// empty by mid-morning, which is strictly worse than having no failover at all.
//
// Retired keys come back at the instant allowance.ts reopens its gate, so a ring
// that emptied yesterday is whole again this morning without a restart.
//
// Keys are never logged. A refusal identifies the key by position ("2 of 3"),
// which is what someone reading the log needs and all they need.

interface Ring {
  keys: string[];
  /** Index of the key currently in use. */
  index: number;
  /** key → when its allowance resets. Absent means "believed good". */
  spentUntil: Map<string, Date>;
}

function configuredKeys(p: Provider): string[] {
  switch (p) {
    case 'openrouter':
      return llmConfig.openrouter.apiKeys;
    case 'groq':
      return llmConfig.groq.apiKeys;
    case 'google':
      return llmConfig.google.apiKeys;
    case 'anthropic':
      return llmConfig.anthropic.apiKeys;
    default:
      return []; // mock has no key, and needs none
  }
}

const rings = new Map<Provider, Ring>();

function ringFor(provider: Provider): Ring {
  let ring = rings.get(provider);
  if (!ring) {
    ring = { keys: configuredKeys(provider), index: 0, spentUntil: new Map() };
    rings.set(provider, ring);
  }
  return ring;
}

/** Drop retirements whose reset has passed, so the ring refills on its own. */
function expire(ring: Ring, now: Date): void {
  for (const [key, resetsAt] of ring.spentUntil) {
    if (resetsAt.getTime() <= now.getTime()) ring.spentUntil.delete(key);
  }
}

/** First unspent key at or after `start`, wrapping. -1 when every key is spent. */
function firstFresh(ring: Ring, start: number): number {
  for (let i = 0; i < ring.keys.length; i++) {
    const idx = (start + i) % ring.keys.length;
    if (!ring.spentUntil.has(ring.keys[idx])) return idx;
  }
  return -1;
}

/** How many keys are configured for this provider. */
export function keyCount(provider: Provider = llmConfig.provider): number {
  return ringFor(provider).keys.length;
}

/**
 * The key to send with the next request.
 *
 * Empty string when none is configured — the provider clients already treat that
 * as "unset" and fail the way they always have, so a missing key stays a missing
 * key rather than becoming a keyring error nobody is looking for.
 */
export function currentKey(provider: Provider = llmConfig.provider, now: Date = new Date()): string {
  const ring = ringFor(provider);
  if (!ring.keys.length) return '';
  expire(ring, now);
  const fresh = firstFresh(ring, ring.index);
  // Every key spent: hand back the current one anyway. The allowance gate is
  // closed in that state, so this call is about to be refused locally; returning
  // '' here would turn that into a confusing "no key configured" instead.
  if (fresh === -1) return ring.keys[ring.index] ?? '';
  ring.index = fresh;
  return ring.keys[fresh];
}

/**
 * Retire the key that just refused, and move to the next unspent one.
 *
 * Returns true when a DIFFERENT, unspent key is now current — which is the
 * caller's cue to send the same request again. False means the ring is empty for
 * today and the allowance gate should close.
 */
export function retireCurrentKey(
  provider: Provider,
  reason: string,
  now: Date = new Date(),
): boolean {
  const ring = ringFor(provider);
  if (!ring.keys.length) return false;
  expire(ring, now);

  const spent = ring.keys[ring.index];
  if (!ring.spentUntil.has(spent)) {
    const resetsAt = nextResetAt(now);
    ring.spentUntil.set(spent, resetsAt);
    logEvent('warn', 'llm.keyring', 'api key allowance spent — retiring it until reset', {
      provider,
      key: `${ring.index + 1} of ${ring.keys.length}`,
      resets_at: resetsAt.toISOString(),
      reason: reason.slice(0, 500),
    });
  }

  const next = firstFresh(ring, ring.index + 1);
  if (next === -1) {
    logEvent('warn', 'llm.keyring', 'every api key is spent for today', {
      provider,
      keys: ring.keys.length,
    });
    return false;
  }
  ring.index = next;
  logEvent('info', 'llm.keyring', 'rotated to the next api key', {
    provider,
    key: `${next + 1} of ${ring.keys.length}`,
  });
  return true;
}

/** Is any key still believed good? */
export function hasFreshKey(provider: Provider = llmConfig.provider, now: Date = new Date()): boolean {
  const ring = ringFor(provider);
  if (!ring.keys.length) return false;
  expire(ring, now);
  return firstFresh(ring, ring.index) !== -1;
}

export interface KeyringStatus {
  provider: Provider;
  keys: number;
  /** 1-based position of the key in use, or 0 when none is configured. */
  active: number;
  spent: number;
  /** When the earliest retired key returns. Null when none is retired. */
  nextResetAt: Date | null;
}

/** For logs and health output. Never includes a key. */
export function keyringStatus(
  provider: Provider = llmConfig.provider,
  now: Date = new Date(),
): KeyringStatus {
  const ring = ringFor(provider);
  expire(ring, now);
  const resets = [...ring.spentUntil.values()].sort((a, b) => a.getTime() - b.getTime());
  return {
    provider,
    keys: ring.keys.length,
    active: ring.keys.length ? ring.index + 1 : 0,
    spent: ring.spentUntil.size,
    nextResetAt: resets[0] ?? null,
  };
}

/** Tests only — rings are process-wide, so one test's rotation would otherwise
 *  leak into every test after it in the same worker. */
export function resetKeyringForTests(): void {
  rings.clear();
}
