import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const sendEmail = vi.fn();
const query = vi.fn();
const buildBrief = vi.fn();

vi.mock('../integrations/outlook', () => ({ sendEmail: (...a: unknown[]) => sendEmail(...a) }));
vi.mock('../db/pool', () => ({ pool: { query: (...a: unknown[]) => query(...a) } }));
vi.mock('./service', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./service')>();
  return { ...actual, buildBrief: (...a: unknown[]) => buildBrief(...a) };
});

import { runMorningDigest } from './morningDigest';

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

describe('runMorningDigest', () => {
  const env = process.env.PRACTITIONER_EMAIL;
  beforeEach(() => {
    sendEmail.mockReset().mockResolvedValue({ ok: true });
    query.mockReset();
    buildBrief.mockReset().mockResolvedValue(BRIEF);
    process.env.PRACTITIONER_EMAIL = 'nicole@innerlume.test';
  });
  afterEach(() => {
    if (env === undefined) delete process.env.PRACTITIONER_EMAIL;
    else process.env.PRACTITIONER_EMAIL = env;
  });

  it('sends one email covering every client on the day', async () => {
    query.mockResolvedValue({ rows: [{ id: 'a1' }, { id: 'a2' }] });
    const r = await runMorningDigest(new Date('2026-07-14T06:00:00Z'));

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
    query.mockResolvedValue({ rows: [] });
    const r = await runMorningDigest(new Date('2026-07-14T06:00:00Z'));
    expect(r).toMatchObject({ appointments: 0, sent: false, skipped: 'no-appointments' });
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it('does not invent a recipient when PRACTITIONER_EMAIL is unset', async () => {
    delete process.env.PRACTITIONER_EMAIL;
    query.mockResolvedValue({ rows: [{ id: 'a1' }] });
    const r = await runMorningDigest(new Date('2026-07-14T06:00:00Z'));
    expect(r).toMatchObject({ sent: false, skipped: 'no-recipient' });
    expect(sendEmail).not.toHaveBeenCalled();
  });
});
