import { describe, it, expect } from 'vitest';
import {
  EXPIRY_DAYS,
  categoryForTrack,
  dedupeKeyFor,
  expiryFor,
  isExpired,
  isSendable,
  listForTrack,
  normalizeQueueInput,
} from './policy';

const at = (iso: string) => new Date(iso);
const DUE = at('2026-08-19T09:00:00Z');

describe('approval policy', () => {
  it('sends only what a person approved', () => {
    // The single rule the gate exists for. Everything else in this module is
    // bookkeeping around this line.
    const expires = expiryFor(DUE);
    const later = at('2026-08-19T10:00:00Z');
    expect(isSendable('approved', later, DUE, expires)).toBe(true);
    for (const state of ['pending', 'rejected', 'expired', 'sent', 'failed'] as const) {
      expect(isSendable(state, later, DUE, expires), state).toBe(false);
    }
  });

  it('will not send before the step is due', () => {
    const expires = expiryFor(DUE);
    expect(isSendable('approved', at('2026-08-19T08:59:00Z'), DUE, expires)).toBe(false);
  });

  it('drops an approval that sat too long instead of sending it late', () => {
    // "Just checking in" three weeks after an enquiry reads as a machine talking
    // to itself. Past the window it is not sent even though it was approved.
    const expires = expiryFor(DUE);
    const tooLate = at('2026-08-27T09:00:01Z');
    expect(isSendable('approved', tooLate, DUE, expires)).toBe(false);
    expect(isExpired('approved', tooLate, expires)).toBe(true);
    expect(isExpired('pending', tooLate, expires)).toBe(true);
  });

  it('expires exactly at the window edge, not a day either side', () => {
    const expires = expiryFor(DUE);
    expect(expires.toISOString()).toBe('2026-08-26T09:00:00.000Z');
    expect(isExpired('pending', at('2026-08-26T08:59:59Z'), expires)).toBe(false);
    expect(isExpired('pending', at('2026-08-26T09:00:00Z'), expires)).toBe(true);
    expect(EXPIRY_DAYS).toBe(7);
  });

  it('leaves a decided item alone once it is decided', () => {
    const expires = expiryFor(DUE);
    const tooLate = at('2026-09-01T00:00:00Z');
    // A rejected or already-sent item must not be swept into 'expired' — the
    // record of what Nicole decided, and of what a client received, stands.
    expect(isExpired('rejected', tooLate, expires)).toBe(false);
    expect(isExpired('sent', tooLate, expires)).toBe(false);
  });

  it('splits cancelled win-back from everything else', () => {
    expect(listForTrack('cancelled')).toBe('cancelled');
    for (const t of ['inquiry', 'maintenance', 'first_appointment', 'refill']) {
      expect(listForTrack(t), t).toBe('normal');
    }
  });

  it('groups the normal list by why the email exists', () => {
    expect(categoryForTrack('inquiry')).toBe('enquiry');
    expect(categoryForTrack('maintenance')).toBe('appointment_lapse');
    expect(categoryForTrack('first_appointment')).toBe('appointment_lapse');
    expect(categoryForTrack('refill')).toBe('dose_lapse');
    expect(categoryForTrack('cancelled')).toBe('cancelled');
  });

  it('gives the same email the same identity across assembly runs', () => {
    // What stops a weekly re-assembly queueing a second copy of a nudge that is
    // already waiting for review.
    expect(dedupeKeyFor('Client@Example.com ', 'cadence:inquiry:nudge_3d')).toBe(
      dedupeKeyFor('client@example.com', 'cadence:inquiry:nudge_3d'),
    );
    expect(dedupeKeyFor('a@b.com', 'cadence:inquiry:nudge_3d')).not.toBe(
      dedupeKeyFor('a@b.com', 'cadence:inquiry:nudge_7d'),
    );
  });

  it('keeps an edited item the same item', () => {
    // Nicole rewording a draft before approving must not let a pristine copy in
    // beside it — same person, same reason, same email.
    const a = normalizeQueueInput(
      { category: 'enquiry', toEmail: 'a@b.com', subject: 'Hi', body: 'one', sourceRef: 'cadence:inquiry:welcome' },
      DUE,
    );
    const b = normalizeQueueInput(
      { category: 'enquiry', toEmail: 'a@b.com', subject: 'Rewritten', body: 'two', sourceRef: 'cadence:inquiry:welcome' },
      DUE,
    );
    expect(a.dedupeKey).toBe(b.dedupeKey);
  });

  it('fills in the list and the window from the category', () => {
    const n = normalizeQueueInput(
      { category: 'dose_lapse', toEmail: 'a@b.com', subject: 's', body: 'b', sourceRef: 'refill:1' },
      DUE,
    );
    expect(n.list).toBe('normal');
    expect(n.sendAfter).toEqual(DUE);
    expect(n.expiresAt).toEqual(expiryFor(DUE));
  });
});
