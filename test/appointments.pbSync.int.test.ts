import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import { pool } from '../src/db/pool';

const mockListSessions = vi.fn();
const mockGetClientRecord = vi.fn();
vi.mock('../src/integrations/pb/reads', () => ({
  listSessions: (...args: any[]) => mockListSessions(...args),
  getClientRecord: (...args: any[]) => mockGetClientRecord(...args),
}));

const mockDetectCheckout = vi.fn().mockResolvedValue(null);
vi.mock('../src/checkout/machine', () => ({
  detectCheckout: (...args: any[]) => mockDetectCheckout(...args),
}));

const mockEnrollCancelled = vi.fn().mockResolvedValue({ outcome: 'noop' });
vi.mock('../src/reengagement/cancellations', () => ({
  enrollCancelledAppointment: (...args: any[]) => mockEnrollCancelled(...args),
}));

const { syncSessionsFromPb } = await import('../src/appointments/pbSync');

// Substitutes for PB's session/booking webhooks while running on localhost
// (no public URL for PB to deliver to) — see appointments/pbSync.ts.

let dbUp = true;
try {
  await pool.query('SELECT 1');
} catch {
  dbUp = false;
}

const describeDb = dbUp ? describe : describe.skip;

describeDb('syncSessionsFromPb (integration)', () => {
  const PB_ID = 'pbsync-test-session-1';
  const PB_CLIENT_ID = 'pbsync-test-client-1';

  const clearFixtures = async (): Promise<void> => {
    await pool.query(`DELETE FROM appointments WHERE pb_id LIKE 'pbsync-test-%'`);
    await pool.query(`DELETE FROM clients WHERE pb_id LIKE 'pbsync-test-%'`);
  };

  beforeEach(async () => {
    mockListSessions.mockReset();
    mockGetClientRecord.mockReset().mockResolvedValue({ id: PB_CLIENT_ID, profile: {} });
    mockDetectCheckout.mockReset().mockResolvedValue(null);
    mockEnrollCancelled.mockReset().mockResolvedValue({ outcome: 'noop' });
    process.env.PB_CLIENT_ID = 'test-id';
    process.env.PB_CLIENT_SECRET = 'test-secret';
    await clearFixtures();
  });

  afterAll(async () => {
    await clearFixtures();
    delete process.env.PB_CLIENT_ID;
    delete process.env.PB_CLIENT_SECRET;
  });

  it('is a no-op dry-run when PB is not configured', async () => {
    delete process.env.PB_CLIENT_ID;
    delete process.env.PB_CLIENT_SECRET;
    const r = await syncSessionsFromPb();
    expect(r).toEqual({ dryRun: true, fetched: 0, upserted: 0, checkoutsDetected: 0, cancellationsEnrolled: 0 });
    expect(mockListSessions).not.toHaveBeenCalled();
  });

  it('upserts a new confirmed session into clients + appointments', async () => {
    const now = new Date('2026-07-15T12:00:00.000Z');
    mockListSessions.mockResolvedValue({
      items: [
        {
          id: PB_ID,
          sessionDate: '2026-07-16T15:00:00.000Z', // future — stays 'confirmed'
          endDate: '2026-07-16T15:15:00.000Z',
          clientRecord: { id: PB_CLIENT_ID, profile: { firstName: 'Jamie', lastName: 'Fox' } },
        },
      ],
    });

    const r = await syncSessionsFromPb(now);
    expect(r).toEqual({ fetched: 1, upserted: 1, checkoutsDetected: 0, cancellationsEnrolled: 0 });

    const appt = await pool.query(`SELECT status, starts_at FROM appointments WHERE pb_id = $1`, [PB_ID]);
    expect(appt.rows[0].status).toBe('confirmed');

    const client = await pool.query(`SELECT name FROM clients WHERE pb_id = $1`, [PB_CLIENT_ID]);
    expect(client.rows[0].name).toBe('Jamie Fox');

    expect(mockDetectCheckout).not.toHaveBeenCalled();
    expect(mockEnrollCancelled).not.toHaveBeenCalled();
  });

  it('treats a session whose end time has passed as completed and fires checkout detection', async () => {
    const now = new Date('2026-07-15T12:00:00.000Z');
    mockListSessions.mockResolvedValue({
      items: [
        {
          id: PB_ID,
          sessionDate: '2026-07-15T09:00:00.000Z',
          endDate: '2026-07-15T09:15:00.000Z', // in the past relative to `now`
          clientRecord: { id: PB_CLIENT_ID, name: 'Past Client' },
        },
      ],
    });

    const r = await syncSessionsFromPb(now);
    expect(r.checkoutsDetected).toBe(1);
    expect(mockDetectCheckout).toHaveBeenCalledTimes(1);

    const appt = await pool.query(`SELECT status FROM appointments WHERE pb_id = $1`, [PB_ID]);
    expect(appt.rows[0].status).toBe('completed');
  });

  it('does not re-fire checkout detection on a re-poll once already completed', async () => {
    const now = new Date('2026-07-15T12:00:00.000Z');
    mockListSessions.mockResolvedValue({
      items: [
        {
          id: PB_ID,
          sessionDate: '2026-07-15T09:00:00.000Z',
          endDate: '2026-07-15T09:15:00.000Z',
          clientRecord: { id: PB_CLIENT_ID, name: 'Past Client' },
        },
      ],
    });

    await syncSessionsFromPb(now);
    mockDetectCheckout.mockClear();
    const r = await syncSessionsFromPb(now);
    expect(r.checkoutsDetected).toBe(0);
    expect(mockDetectCheckout).not.toHaveBeenCalled();
  });

  it('marks a cancelled session and enrolls the cancelled-cadence exactly once', async () => {
    const now = new Date('2026-07-15T12:00:00.000Z');
    mockListSessions.mockResolvedValue({
      items: [
        {
          id: PB_ID,
          sessionDate: '2026-07-16T15:00:00.000Z',
          cancelled: true,
          clientRecord: { id: PB_CLIENT_ID, name: 'Cancels A Lot' },
        },
      ],
    });

    const r1 = await syncSessionsFromPb(now);
    expect(r1.cancellationsEnrolled).toBe(1);
    expect(mockEnrollCancelled).toHaveBeenCalledWith(PB_ID);

    mockEnrollCancelled.mockClear();
    const r2 = await syncSessionsFromPb(now);
    expect(r2.cancellationsEnrolled).toBe(0);
    expect(mockEnrollCancelled).not.toHaveBeenCalled();
  });

  it('backfills the client email from PB before enrolling a cancellation, so re-engagement can actually fire', async () => {
    const now = new Date('2026-07-15T12:00:00.000Z');
    mockGetClientRecord.mockResolvedValue({
      id: PB_CLIENT_ID,
      profile: { emailAddress: 'backfilled@example.com' },
    });
    mockListSessions.mockResolvedValue({
      items: [
        {
          id: PB_ID,
          sessionDate: '2026-07-16T15:00:00.000Z',
          cancelled: true,
          clientRecord: { id: PB_CLIENT_ID, name: 'No Email On File' },
        },
      ],
    });

    await syncSessionsFromPb(now);
    expect(mockGetClientRecord).toHaveBeenCalledWith(PB_CLIENT_ID);

    const client = await pool.query(`SELECT email FROM clients WHERE pb_id = $1`, [PB_CLIENT_ID]);
    expect(client.rows[0].email).toBe('backfilled@example.com');
  });

  it('does not call PB for email when the client already has one on file', async () => {
    const now = new Date('2026-07-15T12:00:00.000Z');
    await pool.query(
      `INSERT INTO clients (name, pb_id, email) VALUES ('Existing Client', $1, 'already@example.com')`,
      [PB_CLIENT_ID],
    );
    mockListSessions.mockResolvedValue({
      items: [
        {
          id: PB_ID,
          sessionDate: '2026-07-16T15:00:00.000Z',
          cancelled: true,
          clientRecord: { id: PB_CLIENT_ID, name: 'Existing Client' },
        },
      ],
    });

    await syncSessionsFromPb(now);
    expect(mockGetClientRecord).not.toHaveBeenCalled();
  });

  it('skips sessions with no PB client id rather than throwing', async () => {
    mockListSessions.mockResolvedValue({
      items: [{ id: PB_ID, sessionDate: '2026-07-16T15:00:00.000Z' }],
    });
    const r = await syncSessionsFromPb();
    expect(r.upserted).toBe(0);
  });
});
