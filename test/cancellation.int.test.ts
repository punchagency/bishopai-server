import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import {
  emulatorUp,
  installFirestore,
  uninstallFirestore,
  clearFirestore,
} from './firestore';
import { seedClient, seedAppointment } from './fixtures';
import type { IDatabase } from '../src/db/interfaces/repositories';
import { enrollCancelledAppointment } from '../src/reengagement/cancellations';
import { runReengagementForLead } from '../src/reengagement/runner';

// Integration: PB cancellation -> WF3 cancelled cadence. Emulator-gated.
const up = await emulatorUp();
const suite = up ? describe : describe.skip;
if (!up) {
  console.log('[cancellation.int] Firestore emulator not running \u2014 skipping. Start: npm run firestore:emulator');
}

const PB_APPT = 'citest-appt';
const PB_APPT_NOEMAIL = 'citest-appt-noemail';
const EMAIL = 'cancel-it@example.test';

suite('cancellation \u2192 cancelled cadence (integration)', () => {
  let db: IDatabase;

  beforeAll(() => {
    db = installFirestore('cancellation-int');
  });
  afterAll(() => uninstallFirestore());
  beforeEach(async () => {
    await clearFirestore(db);
  });

  // The appointment is written through upsertByPbId so its pb-index claim
  // document exists \u2014 enrollCancelledAppointment looks the appointment up BY
  // that pb id, so a plain save() would leave it unfindable.
  async function makeClientWithAppt(pbAppt: string, email: string | null): Promise<void> {
    const client = await seedClient(db, {
      name: `CI Cancel ${pbAppt}`,
      pb_id: `citest-client-${pbAppt}`,
      email: email ?? '',
    });
    await db.appointments.upsertByPbId(pbAppt, {
      client_id: client.id,
      client_name: client.name,
      starts_at: new Date(Date.now() - 2 * 86_400_000).toISOString(),
      ends_at: new Date(Date.now() - 2 * 86_400_000 + 3_600_000).toISOString(),
      status: 'cancelled',
    });
  }

  it('enrolls a cancelled client, is idempotent, and the cadence fires at 7 days', async () => {
    await makeClientWithAppt(PB_APPT, EMAIL);

    const first = await enrollCancelledAppointment(PB_APPT);
    expect(first.outcome).toBe('created');
    const leadId = first.leadId!;

    expect((await db.reengagement.findLeadById(leadId))!.status).toBe('cancelled');

    // Duplicate webhook -> no-op, same lead (no second cancelled lead).
    const again = await enrollCancelledAppointment(PB_APPT);
    expect(again.outcome).toBe('noop');
    expect(again.leadId).toBe(leadId);
    expect(await db.reengagement.listLeadsByEmail(EMAIL)).toHaveLength(1);

    // Nothing due immediately (cancelled_7d is at 7 days).
    expect(await runReengagementForLead(leadId, new Date())).toBe('none');

    // At day 8, the first reschedule prompt sends.
    const day8 = new Date(Date.now() + 8 * 86_400_000);
    expect(await runReengagementForLead(leadId, day8)).toBe('sent');
    const sent = await db.reengagement.findLeadById(leadId);
    expect(sent!.sequence_state.sent).toContain('cancelled_7d');
    expect(sent!.status).toBe('cancelled'); // stays on the cancelled track
  });

  it('skips a cancellation when the client has no email', async () => {
    await makeClientWithAppt(PB_APPT_NOEMAIL, null);
    const r = await enrollCancelledAppointment(PB_APPT_NOEMAIL);
    expect(r.outcome).toBe('skipped_no_email');
  });
});
