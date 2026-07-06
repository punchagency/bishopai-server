import { describe, it, expect } from 'vitest';
import crypto from 'node:crypto';
import { verifyFullscriptSignature, parseFullscriptSignature } from './webhooks';

const SECRET = 'whsec_test';
const body = JSON.stringify({ event: 'treatment_plan.updated', id: 'tp_123' });

function sign(rawBody: string, t: number, secret = SECRET): string {
  const v1 = crypto.createHmac('sha256', secret).update(`${t}.`).update(rawBody).digest('hex');
  return `t=${t},v1=${v1}`;
}

describe('verifyFullscriptSignature', () => {
  const now = 1_800_000_000_000; // fixed clock (ms)
  const t = Math.floor(now / 1000);

  it('accepts a valid signature within tolerance', () => {
    expect(verifyFullscriptSignature(body, sign(body, t), SECRET, now)).toBe(true);
  });

  it('rejects a tampered body', () => {
    expect(verifyFullscriptSignature(body + ' ', sign(body, t), SECRET, now)).toBe(false);
  });

  it('rejects the wrong secret', () => {
    expect(verifyFullscriptSignature(body, sign(body, t, 'other'), SECRET, now)).toBe(false);
  });

  it('rejects a stale timestamp (replay)', () => {
    const old = t - 10_000;
    expect(verifyFullscriptSignature(body, sign(body, old), SECRET, now)).toBe(false);
  });

  it('rejects a missing or malformed header', () => {
    expect(verifyFullscriptSignature(body, undefined, SECRET, now)).toBe(false);
    expect(verifyFullscriptSignature(body, 'garbage', SECRET, now)).toBe(false);
    expect(parseFullscriptSignature('t=abc')).toBeNull();
  });
});
