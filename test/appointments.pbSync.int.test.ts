import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import {
  emulatorUp,
  installFirestore,
  uninstallFirestore,
  clearFirestore,
} from './firestore';
import { seedClient } from './fixtures';
import type { IDatabase } from '../src/db/interfaces/repositories';

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

const up = await emulatorUp();
const describeDb = up ? describe : describe.skip;
if (!up) {
  console.log('[appointments.pbSync.int] Firestore emulator not running - skipping. Start: npm run firestore:emulator');
}

describeDb('syncSessionsFromPb (integration)', () => {
  const PB_ID = 'pbsync-test-session-1';
  const PB_CLIENT_ID = 'pbsync-test-client-1';

  let db: IDatabase;

  beforeAll(() => {
    db = installFirestore('appointments-pbsync-int');
  });

  beforeEach(async () => {
    await clearFirestore(db);
    mockListSessions.mockReset();
    mockGetClientRecord.mockReset().mockResolvedValue({ id: PB_CLIENT_ID, profile: {} });
    mockDetectCheckout.mockReset().mockResolvedValue(null);
    mockEnrollCancelled.mockReset().mockResolvedValue({ outcome: 'noop' });
    process.env.PB_CLIENT_ID = 'test-id';
    process.env.PB_CLIENT_SECRET = 'test-secret';
  });

  afterAll(() => {
    delete process.env.PB_CLIENT_ID;
    delete process.env.PB_CLIENT_SECRET;
    uninstallFirestore();
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

    // Looked up through the pb index, which is what replaced the UNIQUE column
    // — so a sync that forgot to claim the pb id would read as "not there".
    expect((await db.appointments.findByPbId(PB_ID))!.status).toBe('confirmed');
    expect((await db.clients.findByPbId(PB_CLIENT_ID))!.name).toBe('Jamie Fox');

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

    expect((await db.appointments.findByPbId(PB_ID))!.status).toBe('completed');
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

    expect((await db.clients.findByPbId(PB_CLIENT_ID))!.email).toBe('backfilled@example.com');
  });

  it('does not call PB for email when the client already has one on file', async () => {
    const now = new Date('2026-07-15T12:00:00.000Z');
    // Through upsertByPbId so the pb-index claim exists — a plain save() would
    // leave the sync unable to find them, and it would call PB after all.
    await db.clients.upsertByPbId(PB_CLIENT_ID, {
      name: 'Existing Client',
      email: 'already@example.com',
    });
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
