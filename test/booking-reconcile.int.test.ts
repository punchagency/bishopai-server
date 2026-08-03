import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import {
  emulatorUp,
  installFirestore,
  uninstallFirestore,
  clearFirestore,
} from './firestore';
import { seedLead } from './fixtures';
import type { IDatabase } from '../src/db/interfaces/repositories';
import { reconcileStuckBookings } from '../src/reengagement/bookingReconcile';

// Stuck-booking sweep: reopens leads left 'booked' with no 'booked' activity
// (crash between claim and record), but only after the grace window and never a
// legitimately-booked or in-flight one.

const up = await emulatorUp();
const suite = up ? describe : describe.skip;
if (!up) {
  console.log('[booking-reconcile.int] Firestore emulator not running — skipping. Start: npm run firestore:emulator');
}

suite('reconcileStuckBookings (integration)', () => {
  let db: IDatabase;

  beforeAll(() => {
    db = installFirestore('booking-reconcile-int');
  });
  afterAll(() => uninstallFirestore());
  beforeEach(async () => {
    await clearFirestore(db);
  });

  // updated_at is stated outright — there is no trigger rewriting it, so the age
  // a test needs is simply the age it writes.
  async function mkLead(status: string, updatedMinutesAgo: number): Promise<string> {
    const lead = await seedLead(db, {
      email: `stuck-${Math.random().toString(36).slice(2)}@x.com`,
      status,
      updated_at: new Date(Date.now() - updatedMinutesAgo * 60_000).toISOString(),
    });
    return lead.id;
  }

  it('reopens a stranded booked lead past the grace window', async () => {
    const id = await mkLead('booked', 30);
    const { reopened } = await reconcileStuckBookings();
    expect(reopened).toBeGreaterThanOrEqual(1);
    expect((await db.reengagement.findLeadById(id))!.status).toBe('nurturing');
  });

  it('leaves an in-flight (recent) booked lead alone', async () => {
    const id = await mkLead('booked', 1); // within grace
    await reconcileStuckBookings();
    expect((await db.reengagement.findLeadById(id))!.status).toBe('booked');
  });

  it('leaves a legitimately booked lead (has a booked activity) alone', async () => {
    const id = await mkLead('booked', 30);
    const now = new Date().toISOString();
    await db.reengagement.logActivity({
      id: randomUUID(),
      lead_id: id,
      type: 'booked',
      path: null,
      detail: 'ok',
      occurred_at: now,
      created_at: now,
    });
    await reconcileStuckBookings();
    expect((await db.reengagement.findLeadById(id))!.status).toBe('booked');
  });
});
