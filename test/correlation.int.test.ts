import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import {
  emulatorUp,
  installFirestore,
  uninstallFirestore,
  clearFirestore,
} from './firestore';
import type { IDatabase } from '../src/db/interfaces/repositories';
import { ingestConversation } from '../src/conversations/ingest';

// Integration: the overlap query and the idempotent upsert, against the real
// datastore. This is the suite the emulator earns its keep on - the pg version
// leaned on a tstzrange overlap operator that has no Firestore equivalent, so
// the range query and its index are what actually get exercised here.
const up = await emulatorUp();
const suite = up ? describe : describe.skip;
if (!up) {
  console.log('[correlation.int] Firestore emulator not running - skipping. Start: npm run firestore:emulator');
}

suite('correlation (integration)', () => {
  let db: IDatabase;

  beforeAll(() => {
    db = installFirestore('correlation-int');
  });
  afterAll(() => uninstallFirestore());
  beforeEach(async () => {
    await clearFirestore(db);
  });

  // Written through the pb-id upserts so the claim documents exist, matching how
  // the PB sync creates these for real.
  async function seedAppt(pbId: string, clientPb: string, start: string, end: string, status = 'completed') {
    const client = await db.clients.upsertByPbId(clientPb, { name: `IT ${clientPb}` });
    await db.appointments.upsertByPbId(pbId, {
      client_id: client.id,
      client_name: client.name,
      starts_at: start,
      ends_at: end,
      status,
    });
    return client.id;
  }

  it('matches an overlapping appointment', async () => {
    const clientId = await seedAppt('it-a1', 'it-c1', '2026-09-01T15:00:00Z', '2026-09-01T16:00:00Z');
    const r = await ingestConversation({
      bee_id: 'it-b1',
      starts_at: '2026-09-01T15:05:00Z',
      ends_at: '2026-09-01T15:50:00Z',
    });
    expect(r.correlation.status).toBe('matched');
    if (r.correlation.status === 'matched') {
      expect(r.correlation.clientId).toBe(clientId);
    }
  });

  it('holds a non-overlapping conversation as unmatched', async () => {
    const r = await ingestConversation({
      bee_id: 'it-b2',
      starts_at: '2026-10-01T09:00:00Z',
      ends_at: '2026-10-01T10:00:00Z',
    });
    expect(r.correlation).toMatchObject({ status: 'unmatched', reason: 'no_candidates' });
  });

  it('never auto-guesses when two appointments overlap the window', async () => {
    await seedAppt('it-a2', 'it-c2', '2026-11-01T15:00:00Z', '2026-11-01T16:00:00Z');
    await seedAppt('it-a3', 'it-c2b', '2026-11-01T15:30:00Z', '2026-11-01T16:30:00Z');
    const r = await ingestConversation({
      bee_id: 'it-b3',
      starts_at: '2026-11-01T15:45:00Z',
      ends_at: '2026-11-01T15:50:00Z',
    });
    expect(r.correlation).toMatchObject({ status: 'unmatched', reason: 'ambiguous' });
  });

  it('never auto-matches a cancelled appointment (its client may not be in the room)', async () => {
    await seedAppt('it-cancel', 'it-c-cancel', '2026-12-01T15:00:00Z', '2026-12-01T16:00:00Z', 'cancelled');
    const r = await ingestConversation({
      bee_id: 'it-b-cancel',
      starts_at: '2026-12-01T15:05:00Z',
      ends_at: '2026-12-01T15:50:00Z',
    });
    // The only overlap is cancelled -> treated as no candidate at all.
    expect(r.correlation).toMatchObject({ status: 'unmatched', reason: 'no_candidates' });
  });

  it('sends a second overlapping recording to unmatched instead of overwriting the first', async () => {
    await seedAppt('it-a-taken', 'it-c-taken', '2026-12-02T15:00:00Z', '2026-12-02T16:00:00Z');
    const first = await ingestConversation({
      bee_id: 'it-b-taken-1',
      starts_at: '2026-12-02T15:00:00Z',
      ends_at: '2026-12-02T15:30:00Z',
    });
    expect(first.correlation.status).toBe('matched');

    // A split recording's second chunk overlaps the same booking - but that
    // booking now carries a recording, so this one must NOT silently take it.
    // The claim document is what enforces that (§3.1), not a unique index.
    const second = await ingestConversation({
      bee_id: 'it-b-taken-2',
      starts_at: '2026-12-02T15:30:00Z',
      ends_at: '2026-12-02T15:55:00Z',
    });
    expect(second.correlation).toMatchObject({ status: 'unmatched', reason: 'no_candidates' });
  });

  it('is idempotent on bee_id (re-ingest updates, no duplicate row)', async () => {
    await seedAppt('it-a1', 'it-c1', '2026-09-01T15:00:00Z', '2026-09-01T16:00:00Z');
    const args = {
      bee_id: 'it-b1',
      starts_at: '2026-09-01T15:05:00Z',
      ends_at: '2026-09-01T15:50:00Z',
    };
    await ingestConversation(args);
    await ingestConversation({ ...args, transcript: 'added on re-ingest' });

    // The document id IS the bee id, so a duplicate cannot exist by
    // construction - which is the point. Asserted over the whole collection so a
    // second document under a different id would still fail the test.
    const all = await db.conversations.listAll();
    expect(all.filter((c) => c.bee_id === 'it-b1')).toHaveLength(1);
  });
});
