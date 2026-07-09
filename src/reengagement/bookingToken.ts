import crypto from 'node:crypto';
import { logWarn } from '../observability/logger';

// Signed booking links. The public click-to-book endpoints (webhooks.ts) are
// unauthenticated, so a bare `?leadId=&slot=` link is only as safe as the leadId
// is unguessable. A signed token makes the link tamper-proof (you can't change
// the slot or forge a leadId) and time-bounded.
//
// The token is `${exp}.${hmacHex}` where the HMAC covers `${leadId}.${slot}.${exp}`
// keyed by BOOKING_LINK_SECRET. Same fail-open-in-dev contract as the webhook
// signature guards: when the secret is unset, verification passes with a one-time
// warning so existing/offline flows keep working; set the secret to enforce.

const TTL_MS = Number(process.env.BOOKING_LINK_TTL_DAYS ?? 14) * 86_400_000;

function secret(): string | undefined {
  return process.env.BOOKING_LINK_SECRET || undefined;
}

/** True when links are actually enforced (secret configured). */
export function bookingLinkEnforced(): boolean {
  return !!secret();
}

function hmacHex(data: string, key: string): string {
  return crypto.createHmac('sha256', key).update(data).digest('hex');
}

/**
 * Sign a booking token for a (leadId, slot) pair, or null when no secret is set
 * (links go out unsigned in dev — verification fails open to match).
 */
export function signBookingToken(leadId: string, slot: string, now: number = Date.now()): string | null {
  const s = secret();
  if (!s) return null;
  const exp = now + TTL_MS;
  return `${exp}.${hmacHex(`${leadId}.${slot}.${exp}`, s)}`;
}

let warnedOpen = false;

/**
 * Verify a booking token. Returns true when the HMAC matches and the token hasn't
 * expired. Fails OPEN (true) with a one-time warning when no secret is configured
 * — same dev contract as requirePbSignature/requireWebhookSecret.
 */
export function verifyBookingToken(
  leadId: string,
  slot: string,
  token: string | undefined,
  now: number = Date.now(),
): boolean {
  const s = secret();
  if (!s) {
    if (!warnedOpen) {
      warnedOpen = true;
      logWarn('booking.token', 'BOOKING_LINK_SECRET unset — booking links are UNSIGNED');
    }
    return true;
  }
  if (!token) return false;

  const dot = token.indexOf('.');
  if (dot < 0) return false;
  const exp = Number(token.slice(0, dot));
  const sig = token.slice(dot + 1);
  if (!Number.isFinite(exp) || exp < now) return false;

  const expected = hmacHex(`${leadId}.${slot}.${exp}`, s);
  const a = Buffer.from(sig, 'hex');
  const b = Buffer.from(expected, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
