import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import {
  emulatorUp,
  installFirestore,
  uninstallFirestore,
  clearFirestore,
} from './firestore';
import { seedClient, seedAppointment } from './fixtures';
import type { IDatabase } from '../src/db/interfaces/repositories';
import { enrollFirstAppointmentClients } from '../src/reengagement/firstAppointment';
import { runReengagementForLead } from '../src/reengagement/runner';

// Integration: WF3 first-appointment conversion - identify one-and-done clients
// and enroll them. Emulator-gated.
const up = await emulatorUp();
const suite = up ? describe : describe.skip;
if (!up) {
  console.log('[first-appointment.int] Firestore emulator not running - skipping. Start: npm run firestore:emulator');
}

const ONE = 'one-ftest@example.test'; // eligible: exactly one session, 30d ago, no rebooking
const TWO = 'two-ftest@example.test'; // ineligible: two sessions (maintenance territory)
const REBOOKED = 'rebooked-ftest@example.test'; // ineligible: one session but has an upcoming booking
const FRESH = 'fresh-ftest@example.test'; // ineligible: session was yesterday (within the wait window)

suite('first-appointment conversion (integration)', () => {
  let db: IDatabase;

  beforeAll(() => {
    db = installFirestore('first-appointment-int');
  });
  afterAll(() => uninstallFirestore());
  beforeEach(async () => {
    await clearFirestore(db);
  });

  async function client(sfx: string, email: string): Promise<string> {
    const c = await seedClient(db, { name: `F ${sfx}`, pb_id: `ftest-client-${sfx}`, email });
    return c.id;
  }
  async function appt(clientId: string, sfx: string, daysFromNow: number, status: string): Promise<void> {
    const startsAt = new Date(Date.now() + daysFromNow * 86_400_000).toISOString();
    await seedAppointment(db, {
      client_id: clientId,
      pb_id: `ftest-appt-${sfx}`,
      starts_at: startsAt,
      ends_at: new Date(Date.parse(startsAt) + 3_600_000).toISOString(),
      status,
    });
  }

  it('enrolls only one-and-done clients; excludes 2-session, rebooked, and too-fresh; idempotent', async () => {
    const oneId = await client('one', ONE);
    await appt(oneId, 'one', -30, 'completed');

    const twoId = await client('two', TWO);
    await appt(twoId, 'two-1', -60, 'completed');
    await appt(twoId, 'two-2', -30, 'completed'); // two sessions -> not first-appt

    const rebookedId = await client('rebooked', REBOOKED);
    await appt(rebookedId, 'rebooked-1', -30, 'completed');
    await appt(rebookedId, 'rebooked-next', 5, 'confirmed'); // has a future booking

    const freshId = await client('fresh', FRESH);
    await appt(freshId, 'fresh', -1, 'completed'); // within the wait window

    const r1 = await enrollFirstAppointmentClients();
    expect(r1.enrolled).toBeGreaterThanOrEqual(1);

    const leadFor = async (email: string) => (await db.reengagement.listLeadsByEmail(email))[0] ?? null;
    expect(await leadFor(ONE)).toMatchObject({ status: 'first_appointment', source: 'first_appointment' });
    expect(await leadFor(TWO)).toBeNull();
    expect(await leadFor(REBOOKED)).toBeNull();
    expect(await leadFor(FRESH)).toBeNull();

    // The cadence sends the 7-day nudge at day 8, then the 14-day incentive.
    const leadId = (await leadFor(ONE))!.id;
    expect(await runReengagementForLead(leadId, new Date(Date.now() + 8 * 86_400_000))).toBe('sent');
    expect(await runReengagementForLead(leadId, new Date(Date.now() + 15 * 86_400_000))).toBe('sent');
    const sent = await db.reengagement.findLeadById(leadId);
    expect(sent!.sequence_state.sent).toEqual(
      expect.arrayContaining(['first_appt_7d', 'first_appt_14d']),
    );
    expect(sent!.status).toBe('first_appointment'); // stays on track

    // Idempotent: re-running enrolls nobody new.
    await enrollFirstAppointmentClients();
    expect(await db.reengagement.listLeadsByEmail(ONE)).toHaveLength(1);
  }, 15_000);
});
