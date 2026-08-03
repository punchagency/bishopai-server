import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import {
  emulatorUp,
  installFirestore,
  uninstallFirestore,
  clearFirestore,
} from './firestore';
import type { IDatabase } from '../src/db/interfaces/repositories';
import { ingestLead } from '../src/reengagement/intake';
import { runReengagementForLead } from '../src/reengagement/runner';

// Integration: WF3 lead intake -> immediate automated first response.
const up = await emulatorUp();
const suite = up ? describe : describe.skip;
if (!up) {
  console.log('[lead-intake.int] Firestore emulator not running \u2014 skipping. Start: npm run firestore:emulator');
}

const EMAIL = 'intake-it@example.test';

suite('lead intake (integration)', () => {
  let db: IDatabase;

  beforeAll(() => {
    db = installFirestore('lead-intake-int');
  });
  afterAll(() => uninstallFirestore());
  beforeEach(async () => {
    await clearFirestore(db);
  });

  const activityCount = async (leadId: string) =>
    (await db.reengagement.listActivities(leadId)).length;
  const messageCount = async (leadId: string) =>
    (await db.reengagement.listMessagesForLead(leadId)).length;

  it('creates a lead, reuses it on repeat, and auto-sends the welcome once', async () => {
    // First inquiry -> new lead + one activity.
    const first = await ingestLead({
      email: EMAIL,
      name: 'Test Person',
      source: 'website',
      path: '/book-a-consult',
      detail: 'Interested in a consult',
    });
    expect(first.created).toBe(true);
    expect(await activityCount(first.leadId)).toBe(1);

    // Repeat submission from the same email -> reuse, no duplicate lead.
    const second = await ingestLead({ email: EMAIL, source: 'website' });
    expect(second.created).toBe(false);
    expect(second.leadId).toBe(first.leadId);
    expect(await activityCount(first.leadId)).toBe(2);

    // Immediate first response: welcome (afterDays 0) sends now.
    expect(await runReengagementForLead(first.leadId)).toBe('sent');

    const lead = await db.reengagement.findLeadById(first.leadId);
    expect(lead!.status).toBe('contacted');
    expect(lead!.sequence_state.sent).toContain('welcome');
    expect(await messageCount(first.leadId)).toBe(1);

    // Idempotent: running again right away sends nothing (welcome already sent,
    // nudge_3d not yet due).
    expect(await runReengagementForLead(first.leadId)).toBe('none');
    expect(await messageCount(first.leadId)).toBe(1);
  });

  it('starts a fresh lead when the prior one is closed', async () => {
    const first = await ingestLead({ email: EMAIL, source: 'website' });
    const stored = await db.reengagement.findLeadById(first.leadId);
    await db.reengagement.saveLead({ ...stored!, status: 'closed' });

    const again = await ingestLead({ email: EMAIL, source: 'website' });
    expect(again.created).toBe(true); // closed lead not reused
    expect(await db.reengagement.listLeadsByEmail(EMAIL)).toHaveLength(2);
  });
});
