import { createHmac, timingSafeEqual } from 'node:crypto';

// Pocket webhook signature verification.
//
//   X-HeyPocket-Signature  hex HMAC-SHA256 of `${timestamp}.${rawBody}`
//   X-HeyPocket-Timestamp  unix ms of the delivery
//
// The RAW body bytes matter: re-serializing the parsed JSON reorders keys and
// changes whitespace, and the digest stops matching. The route mounts a
// raw-body parser for this path only.

export const POCKET_SIGNATURE_HEADER = 'x-heypocket-signature';
export const POCKET_TIMESTAMP_HEADER = 'x-heypocket-timestamp';

/** Deliveries older than this are rejected, so a captured POST can't be replayed. */
export const DEFAULT_TOLERANCE_MS = 5 * 60_000;

export interface VerifyInput {
  secret: string;
  signature: string | undefined;
  timestamp: string | undefined;
  rawBody: Buffer | string;
  toleranceMs?: number;
  /** Injectable for tests. */
  now?: number;
}

export type VerifyResult =
  | { ok: true }
  | { ok: false; reason: 'missing_signature' | 'missing_timestamp' | 'stale' | 'mismatch' };

/**
 * Constant-time signature check.
 *
 * Note this does NOT follow Pocket's documented snippet verbatim: theirs calls
 * timingSafeEqual on two buffers without comparing lengths first, which throws
 * a RangeError instead of returning false whenever an attacker sends a
 * short signature — turning a forged request into a 500 rather than a 401.
 * Length is checked first here, which is also not a secret-dependent branch.
 */
export function verifyPocketSignature(input: VerifyInput): VerifyResult {
  const { secret, signature, timestamp, rawBody } = input;
  if (!signature) return { ok: false, reason: 'missing_signature' };
  if (!timestamp) return { ok: false, reason: 'missing_timestamp' };

  const tolerance = input.toleranceMs ?? DEFAULT_TOLERANCE_MS;
  const sentAt = Number(timestamp);
  const now = input.now ?? Date.now();
  // Reject non-numeric timestamps too: they'd make the drift NaN, and NaN
  // comparisons are false, which would silently WAIVE the replay window.
  if (!Number.isFinite(sentAt) || Math.abs(now - sentAt) > tolerance) {
    return { ok: false, reason: 'stale' };
  }

  const body = typeof rawBody === 'string' ? Buffer.from(rawBody, 'utf8') : rawBody;
  const expected = createHmac('sha256', secret)
    .update(Buffer.concat([Buffer.from(`${timestamp}.`, 'utf8'), body]))
    .digest('hex');

  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(signature, 'utf8');
  if (a.length !== b.length) return { ok: false, reason: 'mismatch' };
  return timingSafeEqual(a, b) ? { ok: true } : { ok: false, reason: 'mismatch' };
}

/** Sign a body the way Pocket does — used by tests and the webhook self-test. */
export function signPocketPayload(secret: string, timestamp: string | number, rawBody: string): string {
  return createHmac('sha256', secret).update(`${timestamp}.${rawBody}`).digest('hex');
}
