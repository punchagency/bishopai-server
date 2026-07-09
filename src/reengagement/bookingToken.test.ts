import { describe, it, expect, afterEach } from 'vitest';
import { signBookingToken, verifyBookingToken, bookingLinkEnforced } from './bookingToken';

const LEAD = '11111111-1111-1111-1111-111111111111';
const SLOT = '2026-07-13T10:00:00.000Z';

describe('bookingToken', () => {
  const saved = process.env.BOOKING_LINK_SECRET;
  afterEach(() => {
    if (saved === undefined) delete process.env.BOOKING_LINK_SECRET;
    else process.env.BOOKING_LINK_SECRET = saved;
  });

  it('fails OPEN (unsigned) when no secret is set', () => {
    delete process.env.BOOKING_LINK_SECRET;
    expect(bookingLinkEnforced()).toBe(false);
    expect(signBookingToken(LEAD, SLOT)).toBeNull();
    expect(verifyBookingToken(LEAD, SLOT, undefined)).toBe(true); // fail open
  });

  it('round-trips a valid token when a secret is set', () => {
    process.env.BOOKING_LINK_SECRET = 'shh';
    const token = signBookingToken(LEAD, SLOT)!;
    expect(token).toBeTruthy();
    expect(verifyBookingToken(LEAD, SLOT, token)).toBe(true);
  });

  it('rejects a missing token when enforced', () => {
    process.env.BOOKING_LINK_SECRET = 'shh';
    expect(verifyBookingToken(LEAD, SLOT, undefined)).toBe(false);
  });

  it('rejects a token bound to a different slot (tamper)', () => {
    process.env.BOOKING_LINK_SECRET = 'shh';
    const token = signBookingToken(LEAD, SLOT)!;
    expect(verifyBookingToken(LEAD, '2026-07-14T10:00:00.000Z', token)).toBe(false);
  });

  it('rejects a token signed with a different secret', () => {
    process.env.BOOKING_LINK_SECRET = 'secret-a';
    const token = signBookingToken(LEAD, SLOT)!;
    process.env.BOOKING_LINK_SECRET = 'secret-b';
    expect(verifyBookingToken(LEAD, SLOT, token)).toBe(false);
  });

  it('rejects an expired token', () => {
    process.env.BOOKING_LINK_SECRET = 'shh';
    const past = Date.now() - 60 * 86_400_000; // signed 60 days ago (TTL default 14d)
    const token = signBookingToken(LEAD, SLOT, past)!;
    expect(verifyBookingToken(LEAD, SLOT, token)).toBe(false);
  });

  it('rejects a malformed token', () => {
    process.env.BOOKING_LINK_SECRET = 'shh';
    expect(verifyBookingToken(LEAD, SLOT, 'garbage')).toBe(false);
    expect(verifyBookingToken(LEAD, SLOT, '123.notavalidhex')).toBe(false);
  });
});
