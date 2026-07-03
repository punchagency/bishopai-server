import { describe, it, expect } from 'vitest';
import { classifyPbEvent, appointmentStatusFor } from './events';

describe('classifyPbEvent', () => {
  it('classifies completion events (various wordings)', () => {
    expect(classifyPbEvent({ eventType: 'session.completed', id: 's1' }).kind).toBe('session_completed');
    expect(classifyPbEvent({ type: 'appointment.finished', id: 's2' }).kind).toBe('session_completed');
    expect(classifyPbEvent({ eventType: 'booking.checkout', id: 's3' }).kind).toBe('session_completed');
  });

  it('classifies cancellations', () => {
    expect(classifyPbEvent({ eventType: 'appointment.cancelled', id: 'a1' }).kind).toBe('session_cancelled');
    expect(classifyPbEvent({ eventType: 'booking.canceled', id: 'a2' }).kind).toBe('session_cancelled');
  });

  it('classifies other session/appointment changes as booking_updated', () => {
    expect(classifyPbEvent({ eventType: 'session.updated', id: 'x' }).kind).toBe('booking_updated');
    expect(classifyPbEvent({ eventType: 'appointment.rescheduled', id: 'x' }).kind).toBe('booking_updated');
  });

  it('falls back to unknown for unrelated events', () => {
    expect(classifyPbEvent({ eventType: 'invoice.paid', id: 'i1' }).kind).toBe('unknown');
    expect(classifyPbEvent({}).kind).toBe('unknown');
    expect(classifyPbEvent(null).kind).toBe('unknown');
  });

  it('extracts the object id from the several places PB might put it', () => {
    expect(classifyPbEvent({ eventType: 'session.completed', id: 'top' }).objectId).toBe('top');
    expect(classifyPbEvent({ eventType: 'session.completed', data: { id: 'nested' } }).objectId).toBe('nested');
    expect(classifyPbEvent({ eventType: 'session.completed', data: { appointmentId: 'appt' } }).objectId).toBe('appt');
    expect(classifyPbEvent({ eventType: 'session.completed' }).objectId).toBeNull();
  });

  it('lowercases the event type for logging', () => {
    expect(classifyPbEvent({ eventType: 'Session.Completed', id: 's' }).eventType).toBe('session.completed');
  });
});

describe('appointmentStatusFor', () => {
  it('maps completed/cancelled to a status, others to null', () => {
    expect(appointmentStatusFor('session_completed')).toBe('completed');
    expect(appointmentStatusFor('session_cancelled')).toBe('cancelled');
    expect(appointmentStatusFor('booking_updated')).toBeNull();
    expect(appointmentStatusFor('unknown')).toBeNull();
  });
});
