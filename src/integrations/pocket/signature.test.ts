import { describe, it, expect } from 'vitest';
import { verifyPocketSignature, signPocketPayload, DEFAULT_TOLERANCE_MS } from './signature';

const SECRET = 'whsec_test';
const BODY = JSON.stringify({ event: 'summary.completed', recording: { id: 'rec_1' } });

describe('verifyPocketSignature', () => {
  const now = 1_770_000_000_000;
  const ts = String(now);
  const good = signPocketPayload(SECRET, ts, BODY);

  it('accepts a correctly signed delivery', () => {
    expect(verifyPocketSignature({ secret: SECRET, signature: good, timestamp: ts, rawBody: BODY, now })).toEqual({
      ok: true,
    });
  });

  it('accepts the raw body as a Buffer, byte-identically', () => {
    const res = verifyPocketSignature({
      secret: SECRET,
      signature: good,
      timestamp: ts,
      rawBody: Buffer.from(BODY, 'utf8'),
      now,
    });
    expect(res).toEqual({ ok: true });
  });

  it('rejects a body whose bytes changed, even if the JSON is equivalent', () => {
    // Re-serializing with different key order is the realistic way this breaks:
    // it is the same object and a different signature.
    const reordered = JSON.stringify({ recording: { id: 'rec_1' }, event: 'summary.completed' });
    expect(
      verifyPocketSignature({ secret: SECRET, signature: good, timestamp: ts, rawBody: reordered, now }),
    ).toEqual({ ok: false, reason: 'mismatch' });
  });

  it('rejects a wrong secret', () => {
    const forged = signPocketPayload('whsec_other', ts, BODY);
    expect(verifyPocketSignature({ secret: SECRET, signature: forged, timestamp: ts, rawBody: BODY, now })).toEqual({
      ok: false,
      reason: 'mismatch',
    });
  });

  it('returns mismatch (not a thrown RangeError) for a short signature', () => {
    // Pocket's own documented snippet calls timingSafeEqual without comparing
    // lengths, which throws here. A forged request must be a 401, not a 500.
    expect(verifyPocketSignature({ secret: SECRET, signature: 'ab', timestamp: ts, rawBody: BODY, now })).toEqual({
      ok: false,
      reason: 'mismatch',
    });
  });

  it('rejects a replayed delivery outside the tolerance window', () => {
    const old = String(now - DEFAULT_TOLERANCE_MS - 1);
    const sig = signPocketPayload(SECRET, old, BODY);
    expect(verifyPocketSignature({ secret: SECRET, signature: sig, timestamp: old, rawBody: BODY, now })).toEqual({
      ok: false,
      reason: 'stale',
    });
  });

  it('rejects a clock far in the future as well as the past', () => {
    const ahead = String(now + DEFAULT_TOLERANCE_MS + 1);
    const sig = signPocketPayload(SECRET, ahead, BODY);
    expect(verifyPocketSignature({ secret: SECRET, signature: sig, timestamp: ahead, rawBody: BODY, now })).toEqual({
      ok: false,
      reason: 'stale',
    });
  });

  it('rejects a non-numeric timestamp instead of waiving the replay window', () => {
    // NaN comparisons are false, so an unguarded drift check would PASS here.
    const sig = signPocketPayload(SECRET, 'not-a-number', BODY);
    expect(
      verifyPocketSignature({ secret: SECRET, signature: sig, timestamp: 'not-a-number', rawBody: BODY, now }),
    ).toEqual({ ok: false, reason: 'stale' });
  });

  it('reports missing headers distinctly', () => {
    expect(verifyPocketSignature({ secret: SECRET, signature: undefined, timestamp: ts, rawBody: BODY, now })).toEqual(
      { ok: false, reason: 'missing_signature' },
    );
    expect(verifyPocketSignature({ secret: SECRET, signature: good, timestamp: undefined, rawBody: BODY, now })).toEqual(
      { ok: false, reason: 'missing_timestamp' },
    );
  });
});
