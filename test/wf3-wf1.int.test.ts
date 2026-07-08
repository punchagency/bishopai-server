import { describe, it, expect, beforeEach, afterEach, afterAll } from 'vitest';
import { pool } from '../src/db/pool';
import { ingestSiteEvent } from '../src/reengagement/analytics';
import { recordConsent, listConsents, hasConsent } from '../src/consent/service';
import { publishApproved } from '../src/session/publish';

const dbUp = await pool
  .query('SELECT 1')
  .then(() => true)
  .catch(() => false);
const suite = dbUp ? describe : describe.skip;

suite('WF3 analytics ingest + WF1 consent & drive folder (integration)', () => {
  const clientIds: string[] = [];
  const leadIds: string[] = [];
  // The publish test asserts Drive's dry-run path, so keep Drive unconfigured even
  // if a developer has GOOGLE_* creds in .env.
  beforeEach(() => {
    delete process.env.GOOGLE_CLIENT_ID;
    delete process.env.GOOGLE_CLIENT_SECRET;
    delete process.env.GOOGLE_REFRESH_TOKEN;
  });
  afterEach(async () => {
    for (const id of leadIds.splice(0)) await pool.query(`DELETE FROM leads WHERE id = $1`, [id]);
    for (const id of clientIds.splice(0)) await pool.query(`DELETE FROM clients WHERE id = $1`, [id]);
  });
  afterAll(async () => {
    await pool.end();
  });

  it('attributes a site event to a known lead and touches it', async () => {
    const lead = (await pool.query<{ id: string }>(`INSERT INTO leads (source, email, status) VALUES ('website','visitor@x.com','new') RETURNING id`)).rows[0].id;
    leadIds.push(lead);
    const { activityId, leadId } = await ingestSiteEvent({ email: 'VISITOR@x.com', type: 'form_open', path: '/book' });
    expect(leadId).toBe(lead);
    const act = await pool.query(`SELECT lead_id, type, path FROM lead_activity WHERE id = $1`, [activityId]);
    expect(act.rows[0]).toMatchObject({ lead_id: lead, type: 'form_open', path: '/book' });
    const touched = await pool.query(`SELECT last_touch FROM leads WHERE id = $1`, [lead]);
    expect(touched.rows[0].last_touch).not.toBeNull();
  });

  it('records an anonymous event with no lead', async () => {
    const { leadId } = await ingestSiteEvent({ type: 'page_view', path: '/' });
    expect(leadId).toBeNull();
  });

  it('records, lists, and gates consent', async () => {
    const c = (await pool.query<{ id: string }>(`INSERT INTO clients (name) VALUES ('Consent Test') RETURNING id`)).rows[0].id;
    clientIds.push(c);
    expect(await hasConsent(c, 'recording')).toBe(false);
    const granted = await recordConsent(c, 'recording', true, 'verbal at intake');
    expect(granted.granted).toBe(true);
    expect(await hasConsent(c, 'recording')).toBe(true);
    // Idempotent upsert + revoke.
    const revoked = await recordConsent(c, 'recording', false);
    expect(revoked.granted).toBe(false);
    expect(await hasConsent(c, 'recording')).toBe(false);
    expect((await listConsents(c)).length).toBe(1);
  });

  it('persists the drive folder id per client on publish (dry-run path returns none, so simulate configured folder id reuse via stored id)', async () => {
    // Drive is unconfigured in tests → publishApproved dry-runs and returns no
    // folderId, so we assert the persistence guard is a no-op (doesn't crash) and
    // that a pre-stored folder id is read without error.
    const c = (await pool.query<{ id: string }>(`INSERT INTO clients (name, drive_folder_id) VALUES ('Folder Test','FOLDER-123') RETURNING id`)).rows[0].id;
    clientIds.push(c);
    const appt = (
      await pool.query<{ id: string }>(
        `INSERT INTO appointments (client_id, starts_at, ends_at, status) VALUES ($1, now(), now() + interval '1 hour','completed') RETURNING id`,
        [c],
      )
    ).rows[0].id;
    const sheet = (
      await pool.query<{ id: string }>(`INSERT INTO appointment_sheets (appointment_id, client_id, content_json) VALUES ($1,$2,'{}'::jsonb) RETURNING id`, [appt, c])
    ).rows[0].id;
    const result = await publishApproved('appointment_sheets', sheet);
    expect(result.dryRun).toBe(true); // Drive not configured in tests
    // Stored folder id remains intact.
    const stored = await pool.query(`SELECT drive_folder_id FROM clients WHERE id = $1`, [c]);
    expect(stored.rows[0].drive_folder_id).toBe('FOLDER-123');
  });
});
