import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const sendEmail = vi.fn();
const buildBrief = vi.fn();

vi.mock('../integrations/outlook', () => ({ sendEmail: (...a: unknown[]) => sendEmail(...a) }));
vi.mock('./service', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./service')>();
  return { ...actual, buildBrief: (...a: unknown[]) => buildBrief(...a) };
});

import { runMorningDigest } from './morningDigest';
import { setDatabaseAdapter, resetDatabaseAdapter, InMemoryMockDatabase } from '../db/index.js';

const BRIEF = {
  client_id: 'c1',
  client_name: 'Maya Chen',
  appointment_id: 'a1',
  starts_at: '2026-07-14T10:00:00Z',
  visit_number: 3,
  last_session: {
    date: '2026-06-16',
    concerns: ['Fatigue'],
    assessments: ['Adrenal pattern'],
    protocol_changes: [],
    follow_ups: [],
  },
  open_tasks: [
    { id: 't1', client_id: 'c1', client_name: 'Maya Chen', appointment_id: 'a0', title: 'Recheck B12', due_date: '2026-07-01', status: 'open', source: 'session', created_at: '', completed_at: null },
  ],
  supplements: [],
  not_covered_last_time: ['K-27', 'Body scan'],
  outstanding_billing: null,
};

const DAY = new Date('2026-07-14T06:00:00Z');
let db: InMemoryMockDatabase;

/** One appointment on the digest's day, unless overridden. */
async function schedule(
  id: string,
  over: { startsAt?: string; status?: string; clientId?: string | null } = {},
): Promise<void> {
  const startsAt = over.startsAt ?? '2026-07-14T10:00:00Z';
  await db.appointments.save({
    id,
    client_id: over.clientId === undefined ? 'c1' : over.clientId,
    client_name: 'Maya Chen',
    starts_at: startsAt,
    ends_at: startsAt,
    status: over.status ?? 'scheduled',
    created_at: startsAt,
    updated_at: startsAt,
  });
}

describe('runMorningDigest', () => {
  const env = process.env.PRACTITIONER_EMAIL;
  beforeEach(() => {
    sendEmail.mockReset().mockResolvedValue({ ok: true });
    db = new InMemoryMockDatabase();
    setDatabaseAdapter(db);
    buildBrief.mockReset().mockResolvedValue(BRIEF);
    process.env.PRACTITIONER_EMAIL = 'nicole@innerlume.test';
  });
  afterEach(() => {
    resetDatabaseAdapter();
    if (env === undefined) delete process.env.PRACTITIONER_EMAIL;
    else process.env.PRACTITIONER_EMAIL = env;
  });

  it('sends one email covering every client on the day', async () => {
    await schedule('a1');
    await schedule('a2', { startsAt: '2026-07-14T14:00:00Z' });
    const r = await runMorningDigest(DAY);

    expect(r).toMatchObject({ appointments: 2, sent: true });
    expect(sendEmail).toHaveBeenCalledTimes(1);

    const mail = sendEmail.mock.calls[0][0];
    expect(mail.to).toBe('nicole@innerlume.test');
    expect(mail.subject).toContain('2026-07-14');
    expect(mail.body).toContain('Maya Chen');
    expect(mail.body).toContain('Recheck B12');
    // The gaps make the trip into the email — that's the checklist she reads.
    expect(mail.body).toContain('K-27');
  });

  it('sends nothing on an empty day', async () => {
    const r = await runMorningDigest(DAY);
    expect(r).toMatchObject({ appointments: 0, sent: false, skipped: 'no-appointments' });
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it('leaves out cancellations, other days, and bookings with no client', async () => {
    await schedule('keep');
    await schedule('cancelled', { status: 'cancelled' });
    await schedule('tomorrow', { startsAt: '2026-07-15T10:00:00Z' });
    await schedule('yesterday', { startsAt: '2026-07-13T23:59:00Z' });
    await schedule('no-client', { clientId: null });

    const r = await runMorningDigest(DAY);
    expect(r).toMatchObject({ appointments: 1, sent: true });
    expect(buildBrief.mock.calls.map((c) => c[0])).toEqual(['keep']);
  });

  it('does not invent a recipient when PRACTITIONER_EMAIL is unset', async () => {
    delete process.env.PRACTITIONER_EMAIL;
    await schedule('a1');
    const r = await runMorningDigest(DAY);
    expect(r).toMatchObject({ sent: false, skipped: 'no-recipient' });
    expect(sendEmail).not.toHaveBeenCalled();
  });
});
