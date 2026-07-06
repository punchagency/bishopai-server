import { describe, it, expect } from 'vitest';
import { intakeSkipReason } from './inboxGuards';
import type { InboundMessage } from '../integrations/outlook';

const msg = (over: Partial<InboundMessage>): InboundMessage => ({
  id: 'm1',
  from: 'person@example.com',
  subject: 'Interested in a consult',
  receivedDateTime: '2026-07-06T12:00:00Z',
  ...over,
});

describe('intakeSkipReason', () => {
  const MAILBOX = 'clinic@innerlume.com';

  it('allows a genuine person reaching out', () => {
    expect(intakeSkipReason(msg({}), MAILBOX)).toBeNull();
  });

  it('skips our own mailbox address', () => {
    expect(intakeSkipReason(msg({ from: 'Clinic@Innerlume.com' }), MAILBOX)).toBe('self');
  });

  it('skips automated local-parts', () => {
    for (const from of ['no-reply@x.com', 'noreply@x.com', 'donotreply@x.com', 'mailer-daemon@x.com', 'bounce@x.com', 'postmaster@x.com']) {
      expect(intakeSkipReason(msg({ from }), MAILBOX), from).toBe('automated-sender');
    }
  });

  it('skips auto-reply / bounce subjects', () => {
    for (const subject of ['Automatic reply: away', 'Out of Office', 'Undeliverable: your message', 'Delivery Status Notification (Failure)']) {
      expect(intakeSkipReason(msg({ subject }), MAILBOX), subject).toBe('auto-reply');
    }
  });

  it('skips RFC-3834 auto-submitted mail', () => {
    expect(intakeSkipReason(msg({ headers: [{ name: 'Auto-Submitted', value: 'auto-replied' }] }), MAILBOX)).toBe('auto-submitted');
    expect(intakeSkipReason(msg({ headers: [{ name: 'Auto-Submitted', value: 'no' }] }), MAILBOX)).toBeNull();
  });

  it('skips bulk / list mail', () => {
    expect(intakeSkipReason(msg({ headers: [{ name: 'Precedence', value: 'bulk' }] }), MAILBOX)).toBe('bulk');
    expect(intakeSkipReason(msg({ headers: [{ name: 'List-Unsubscribe', value: '<mailto:u@x.com>' }] }), MAILBOX)).toBe('bulk-list');
  });

  it('skips malformed senders', () => {
    expect(intakeSkipReason(msg({ from: 'not-an-email' }), MAILBOX)).toBe('no-sender');
  });
});
