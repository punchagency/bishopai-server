import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll } from 'vitest';
import {
  emulatorUp,
  installFirestore,
  uninstallFirestore,
  clearFirestore,
} from './firestore';
import { seedClientWithAppointment, seedLead, seedSessionDocs } from './fixtures';
import type { IDatabase } from '../src/db/interfaces/repositories';
import { ingestSiteEvent } from '../src/reengagement/analytics';
import { recordConsent, listConsents, hasConsent } from '../src/consent/service';
import { publishApproved } from '../src/session/publish';

const up = await emulatorUp();
const suite = up ? describe : describe.skip;
if (!up) {
  console.log('[wf3-wf1.int] Firestore emulator not running - skipping. Start: npm run firestore:emulator');
}

suite('WF3 analytics ingest + WF1 consent & drive folder (integration)', () => {
  const saved = { ...process.env };
  let db: IDatabase;

  beforeAll(() => {
    db = installFirestore('wf3-wf1-int');
  });
  afterAll(() => uninstallFirestore());

  // The publish test asserts Drive's dry-run path, so keep Drive unconfigured even
  // if a developer has GOOGLE_* creds in .env.
  beforeEach(async () => {
    await clearFirestore(db);
    delete process.env.GOOGLE_CLIENT_ID;
    delete process.env.GOOGLE_CLIENT_SECRET;
    delete process.env.GOOGLE_REFRESH_TOKEN;
  });
  afterEach(() => {
    process.env = { ...saved };
  });

  it('attributes a site event to a known lead and touches it', async () => {
    const lead = await seedLead(db, { source: 'website', email: 'visitor@x.com', status: 'new' });
    const { activityId, leadId } = await ingestSiteEvent({ email: 'VISITOR@x.com', type: 'form_open', path: '/book' });
    expect(leadId).toBe(lead.id);

    const activities = await db.reengagement.listActivities(lead.id);
    expect(activities.find((a) => a.id === activityId)).toMatchObject({
      lead_id: lead.id,
      type: 'form_open',
      path: '/book',
    });
    expect((await db.reengagement.findLeadById(lead.id))!.last_touch).toBeTruthy();
  });

  it('records an anonymous event with no lead', async () => {
    const { leadId } = await ingestSiteEvent({ type: 'page_view', path: '/' });
    expect(leadId).toBeNull();
  });

  it('records, lists, and gates consent', async () => {
    const { client } = await seedClientWithAppointment(db, { client: { name: 'Consent Test' } });
    expect(await hasConsent(client.id, 'recording')).toBe(false);
    const granted = await recordConsent(client.id, 'recording', true, 'verbal at intake');
    expect(granted.granted).toBe(true);
    expect(await hasConsent(client.id, 'recording')).toBe(true);
    // Idempotent upsert + revoke. The document id is `${clientId}__${type}`, so
    // the revoke lands on the same document rather than adding a second one.
    const revoked = await recordConsent(client.id, 'recording', false);
    expect(revoked.granted).toBe(false);
    expect(await hasConsent(client.id, 'recording')).toBe(false);
    expect((await listConsents(client.id)).length).toBe(1);
  });

  it('leaves a stored drive folder id intact when publish dry-runs', async () => {
    // Drive is unconfigured in tests -> publishApproved dry-runs and returns no
    // folderId, so this asserts the persistence guard is a no-op (doesn't crash)
    // and that a pre-stored folder id survives.
    const { client, appointment } = await seedClientWithAppointment(db, {
      client: { name: 'Folder Test', drive_folder_id: 'FOLDER-123' },
      appointment: { status: 'completed' },
    });
    const { sheet } = await seedSessionDocs(db, { client, appointment });

    const result = await publishApproved('appointment_sheets', sheet.id);
    expect(result.dryRun).toBe(true); // Drive not configured in tests
    expect((await db.clients.findById(client.id))!.drive_folder_id).toBe('FOLDER-123');
  });
});
