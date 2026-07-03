import crypto from 'node:crypto';
import type { RequestHandler } from 'express';
import { logWarn } from '../observability/logger';

/**
 * Guard an inbound webhook with a shared secret. The caller (the Electron Bee
 * courier, or Zapier for PB bookings) sends the secret in either
 * `X-Webhook-Secret` or `Authorization: Bearer <secret>`; we compare it in
 * constant time against the configured value.
 *
 * The secret is read from `process.env[envName]` at mount time. If it is unset,
 * the guard **fails open with a one-time warning** so local dev and the smoke
 * test work without configuration — but any real deployment must set it (the
 * warning is logged to `system_events`, so a misconfigured prod is visible).
 */
export function requireWebhookSecret(envName: string): RequestHandler {
  const expected = process.env[envName];

  if (!expected) {
    let warned = false;
    return (_req, _res, next) => {
      if (!warned) {
        warned = true;
        logWarn('webhook.auth', 'shared secret not set — webhook is UNAUTHENTICATED', { env: envName });
      }
      next();
    };
  }

  const expectedHash = sha256(expected);
  return (req, res, next) => {
    const header = req.get('x-webhook-secret');
    const bearer = req.get('authorization');
    const provided = header ?? (bearer?.startsWith('Bearer ') ? bearer.slice(7) : undefined);

    if (!provided || !crypto.timingSafeEqual(sha256(provided), expectedHash)) {
      logWarn('webhook.auth', 'rejected: missing/invalid webhook secret', {
        env: envName,
        path: req.originalUrl,
      });
      return res.status(401).json({ error: 'unauthorized' });
    }
    next();
  };
}

// Hash both sides to a fixed 32 bytes so timingSafeEqual never sees mismatched
// lengths (which would throw and also leak the secret's length).
function sha256(value: string): Buffer {
  return crypto.createHash('sha256').update(value).digest();
}

// Practice Better signs webhook deliveries with a timestamped HMAC:
//   PB-Signature: t=1735560000,v1=<hex hmac-sha256>
// where the signed payload is `${t}.${rawBody}` and the key is the
// `plaintextSigningSecret` returned when the subscription was created. We verify
// the HMAC and reject stale timestamps (replay protection). Requires the raw
// request body — server.ts captures it via express.json({ verify }).
const PB_TOLERANCE_S = 300; // ±5 min

export function requirePbSignature(envName: string): RequestHandler {
  const secret = process.env[envName];

  if (!secret) {
    let warned = false;
    return (_req, _res, next) => {
      if (!warned) {
        warned = true;
        logWarn('webhook.auth', 'PB signing secret not set — PB webhook is UNVERIFIED', { env: envName });
      }
      next();
    };
  }

  return (req, res, next) => {
    const header = req.get('pb-signature');
    const raw = (req as { rawBody?: Buffer }).rawBody;
    const parsed = header ? parsePbSignature(header) : null;

    if (!parsed || !raw) {
      logWarn('webhook.auth', 'rejected: missing PB-Signature or raw body', { path: req.originalUrl });
      return res.status(401).json({ error: 'unauthorized' });
    }

    const age = Math.abs(Date.now() / 1000 - parsed.t);
    if (!Number.isFinite(parsed.t) || age > PB_TOLERANCE_S) {
      logWarn('webhook.auth', 'rejected: PB-Signature timestamp out of tolerance', { age_s: Math.round(age) });
      return res.status(401).json({ error: 'unauthorized' });
    }

    const expected = crypto
      .createHmac('sha256', secret)
      .update(`${parsed.t}.`)
      .update(raw)
      .digest();
    const provided = Buffer.from(parsed.v1, 'hex');

    if (provided.length !== expected.length || !crypto.timingSafeEqual(provided, expected)) {
      logWarn('webhook.auth', 'rejected: invalid PB-Signature', { path: req.originalUrl });
      return res.status(401).json({ error: 'unauthorized' });
    }
    next();
  };
}

/** Parse `t=<unix>,v1=<hex>` (order-independent, tolerant of spaces). */
export function parsePbSignature(header: string): { t: number; v1: string } | null {
  const parts: Record<string, string> = {};
  for (const seg of header.split(',')) {
    const [k, v] = seg.split('=');
    if (k && v) parts[k.trim()] = v.trim();
  }
  if (!parts.t || !parts.v1 || !/^[0-9a-f]+$/i.test(parts.v1)) return null;
  return { t: Number(parts.t), v1: parts.v1 };
}
