import { describe, it, expect, afterAll } from 'vitest';
import { pool } from '../src/db/pool';
import { ingestConversation } from '../src/conversations/ingest';

// Integration: exercises the real Postgres tstzrange overlap and the
// idempotent upsert. Skips (not fails) when the dev DB isn't reachable so the
// unit suite stays runnable anywhere.
const dbUp = await pool
  .query('SELECT 1')
  .then(() => true)
  .catch(() => false);

const suite = dbUp ? describe : describe.skip;

suite('correlation (integration, real Postgres)', () => {
  afterAll(async () => {
    await pool.query(`DELETE FROM conversations WHERE bee_id LIKE 'it-%'`).catch(() => {});
    await pool.query(`DELETE FROM appointments WHERE pb_id LIKE 'it-%'`).catch(() => {});
    await pool.query(`DELETE FROM clients WHERE pb_id LIKE 'it-%'`).catch(() => {});
    await pool.end();
  });

  async function seedAppointment(pbId: string, clientPb: string, start: string, end: string) {
    await pool.query(
      `INSERT INTO clients (name, pb_id) VALUES ($1, $2) ON CONFLICT (pb_id) DO NOTHING`,
      [`IT ${clientPb}`, clientPb],
    );
    const c = await pool.query(`SELECT id FROM clients WHERE pb_id = $1`, [clientPb]);
    const clientId = c.rows[0].id as string;
    await pool.query(
      `INSERT INTO appointments (client_id, pb_id, starts_at, ends_at, status)
            VALUES ($1, $2, $3, $4, 'completed')
       ON CONFLICT (pb_id) DO NOTHING`,
      [clientId, pbId, start, end],
    );
    return clientId;
  }

  it('matches an overlapping appointment', async () => {
    const clientId = await seedAppointment(
      'it-a1',
      'it-c1',
      '2026-09-01T15:00:00Z',
      '2026-09-01T16:00:00Z',
    );
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
    await seedAppointment('it-a2', 'it-c2', '2026-11-01T15:00:00Z', '2026-11-01T16:00:00Z');
    await seedAppointment('it-a3', 'it-c2', '2026-11-01T15:30:00Z', '2026-11-01T16:30:00Z');
    const r = await ingestConversation({
      bee_id: 'it-b3',
      starts_at: '2026-11-01T15:45:00Z',
      ends_at: '2026-11-01T15:50:00Z',
    });
    expect(r.correlation).toMatchObject({ status: 'unmatched', reason: 'ambiguous' });
  });

  it('never auto-matches a cancelled appointment (its client may not be in the room)', async () => {
    const clientId = await seedAppointment(
      'it-cancel',
      'it-c-cancel',
      '2026-12-01T15:00:00Z',
      '2026-12-01T16:00:00Z',
    );
    await pool.query(`UPDATE appointments SET status = 'cancelled' WHERE pb_id = 'it-cancel'`);
    void clientId;
    const r = await ingestConversation({
      bee_id: 'it-b-cancel',
      starts_at: '2026-12-01T15:05:00Z',
      ends_at: '2026-12-01T15:50:00Z',
    });
    // The only overlap is cancelled → treated as no candidate at all.
    expect(r.correlation).toMatchObject({ status: 'unmatched', reason: 'no_candidates' });
  });

  it('sends a second overlapping recording to unmatched instead of overwriting the first', async () => {
    await seedAppointment('it-a-taken', 'it-c-taken', '2026-12-02T15:00:00Z', '2026-12-02T16:00:00Z');
    const first = await ingestConversation({
      bee_id: 'it-b-taken-1',
      starts_at: '2026-12-02T15:00:00Z',
      ends_at: '2026-12-02T15:30:00Z',
    });
    expect(first.correlation.status).toBe('matched');

    // A split recording's second chunk overlaps the same booking — but that
    // booking now carries a recording, so this one must NOT silently take it.
    const second = await ingestConversation({
      bee_id: 'it-b-taken-2',
      starts_at: '2026-12-02T15:30:00Z',
      ends_at: '2026-12-02T15:55:00Z',
    });
    expect(second.correlation).toMatchObject({ status: 'unmatched', reason: 'no_candidates' });
  });

  it('is idempotent on bee_id (re-ingest updates, no duplicate row)', async () => {
    await ingestConversation({
      bee_id: 'it-b1',
      starts_at: '2026-09-01T15:05:00Z',
      ends_at: '2026-09-01T15:50:00Z',
      transcript: 'added on re-ingest',
    });
    const rows = await pool.query(`SELECT count(*)::int AS n FROM conversations WHERE bee_id = 'it-b1'`);
    expect(rows.rows[0].n).toBe(1);
  });
});
