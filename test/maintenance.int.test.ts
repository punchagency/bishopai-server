import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import {
  emulatorUp,
  installFirestore,
  uninstallFirestore,
  clearFirestore,
} from './firestore';
import { seedClient, seedAppointment } from './fixtures';
import type { IDatabase } from '../src/db/interfaces/repositories';
import { enrollMaintenanceClients } from '../src/reengagement/maintenance';
import { runReengagementForLead } from '../src/reengagement/runner';

// Integration: WF3 maintenance reactivation - identify quiet clients by session
// gap and enroll them. Emulator-gated.
const up = await emulatorUp();
const suite = up ? describe : describe.skip;
if (!up) {
  console.log('[maintenance.int] Firestore emulator not running - skipping. Start: npm run firestore:emulator');
}

// GAP_DAYS defaults to 90; 'gap' clients last saw us >90d ago.
const GAP = 'gap-mtest@example.test'; // eligible: last session 120d ago, no upcoming
const RECENT = 'recent-mtest@example.test'; // ineligible: last session 20d ago
const UPCOMING = 'upcoming-mtest@example.test'; // ineligible: gap but has a future booking
const ONEVISIT = 'onevisit-mtest@example.test'; // ineligible for maintenance: only 1 session (first-appt track)

suite('maintenance reactivation (integration)', () => {
  let db: IDatabase;

  beforeAll(() => {
    db = installFirestore('maintenance-int');
  });
  afterAll(() => uninstallFirestore());
  beforeEach(async () => {
    await clearFirestore(db);
  });

  async function client(pbSuffix: string, email: string): Promise<string> {
    const c = await seedClient(db, { name: `M ${pbSuffix}`, pb_id: `mtest-client-${pbSuffix}`, email });
    return c.id;
  }
  async function appt(clientId: string, pbSuffix: string, daysFromNow: number, status: string): Promise<void> {
    const startsAt = new Date(Date.now() + daysFromNow * 86_400_000).toISOString();
    await seedAppointment(db, {
      client_id: clientId,
      pb_id: `mtest-appt-${pbSuffix}`,
      starts_at: startsAt,
      ends_at: new Date(Date.parse(startsAt) + 3_600_000).toISOString(),
      status,
    });
  }

  it('enrolls only quiet clients, respecting recency and upcoming bookings; idempotent', async () => {
    // Maintenance requires 2+ completed sessions (an established client).
    const gapId = await client('gap', GAP);
    await appt(gapId, 'gap-1', -200, 'completed'); // earlier session...
    await appt(gapId, 'gap-2', -120, 'completed'); // ...most recent, 120d ago

    const recentId = await client('recent', RECENT);
    await appt(recentId, 'recent-1', -200, 'completed');
    await appt(recentId, 'recent-2', -20, 'completed'); // too recent

    const upcomingId = await client('upcoming', UPCOMING);
    await appt(upcomingId, 'upcoming-1', -200, 'completed');
    await appt(upcomingId, 'upcoming-old', -120, 'completed'); // old session...
    await appt(upcomingId, 'upcoming-next', 7, 'confirmed'); // ...but rebooked

    const oneVisitId = await client('onevisit', ONEVISIT);
    await appt(oneVisitId, 'onevisit', -120, 'completed'); // only ONE session -> first-appt track

    const r1 = await enrollMaintenanceClients();
    expect(r1.enrolled).toBeGreaterThanOrEqual(1);

    const leadFor = async (email: string) => (await db.reengagement.listLeadsByEmail(email))[0] ?? null;
    expect(await leadFor(GAP)).toMatchObject({ status: 'maintenance', source: 'maintenance' });
    expect(await leadFor(RECENT)).toBeNull(); // too recent -> not enrolled
    expect(await leadFor(UPCOMING)).toBeNull(); // has a future booking -> not enrolled
    expect(await leadFor(ONEVISIT)).toBeNull(); // only one session -> not maintenance

    // The maintenance cadence fires the 7-day nudge at day 8.
    const gapLeadId = (await leadFor(GAP))!.id;
    const day8 = new Date(Date.now() + 8 * 86_400_000);
    expect(await runReengagementForLead(gapLeadId, day8)).toBe('sent');
    const sent = await db.reengagement.findLeadById(gapLeadId);
    expect(sent!.sequence_state.sent).toContain('maintenance_7d');
    expect(sent!.status).toBe('maintenance'); // stays on the maintenance track

    // Idempotent: re-running enrolls nobody new (the gap client now has an active lead).
    const r2 = await enrollMaintenanceClients();
    expect(await db.reengagement.listLeadsByEmail(GAP)).toHaveLength(1);
    expect(r2.skipped).toBeGreaterThanOrEqual(1);
  }, 15_000);
});
