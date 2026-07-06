import crypto from 'node:crypto';
import type { RequestHandler } from 'express';
import { logWarn } from '../../observability/logger';

// Fullscript webhook signature verification. Fullscript signs each delivery with
// a `Fullscript-Signature: t=<unix>,v1=<hex-hmac>` header (verified against the
// Integrate docs, 2026-07). The signature is HMAC-SHA256 over `${t}.${rawBody}`
// keyed by your Webhook Secret Key — same scheme as the PB webhook here.

const DEFAULT_TOLERANCE_S = 300;

/** Parse `t=<unix>,v1=<hex>` (order-independent, tolerant of spaces). */
export function parseFullscriptSignature(header: string): { t: number; v1: string } | null {
  const parts: Record<string, string> = {};
  for (const seg of header.split(',')) {
    const [k, v] = seg.split('=');
    if (k && v) parts[k.trim()] = v.trim();
  }
  if (!parts.t || !parts.v1 || !/^[0-9a-f]+$/i.test(parts.v1)) return null;
  return { t: Number(parts.t), v1: parts.v1 };
}

/**
 * Verify a Fullscript webhook signature. Pure + testable: returns true only when
 * the HMAC matches and the timestamp is within tolerance (replay protection).
 */
export function verifyFullscriptSignature(
  rawBody: Buffer | string,
  header: string | undefined,
  secret: string,
  now: number = Date.now(),
  toleranceS: number = DEFAULT_TOLERANCE_S,
): boolean {
  if (!header) return false;
  const parsed = parseFullscriptSignature(header);
  if (!parsed || !Number.isFinite(parsed.t)) return false;
  if (Math.abs(now / 1000 - parsed.t) > toleranceS) return false;

  const expected = crypto
    .createHmac('sha256', secret)
    .update(`${parsed.t}.`)
    .update(rawBody)
    .digest();
  const provided = Buffer.from(parsed.v1, 'hex');
  return provided.length === expected.length && crypto.timingSafeEqual(provided, expected);
}

/**
 * Express guard for a Fullscript webhook route. Requires the app to capture the
 * raw body (app.ts already does via the express.json `verify` hook). Fails open
 * with a one-time warning when the secret is unset (dev), enforced when set —
 * matching the Bee/PB webhook guards.
 */
export function requireFullscriptSignature(envName: string): RequestHandler {
  const secret = process.env[envName];
  if (!secret) {
    let warned = false;
    return (_req, _res, next) => {
      if (!warned) {
        warned = true;
        logWarn('webhook.auth', 'Fullscript webhook secret not set — webhook is UNVERIFIED', { env: envName });
      }
      next();
    };
  }
  return (req, res, next) => {
    const header = req.get('fullscript-signature') ?? undefined;
    const raw = (req as { rawBody?: Buffer }).rawBody;
    if (!raw || !verifyFullscriptSignature(raw, header, secret)) {
      logWarn('webhook.auth', 'rejected: invalid Fullscript-Signature', { path: req.originalUrl });
      return res.status(401).json({ error: 'unauthorized' });
    }
    next();
  };
}
