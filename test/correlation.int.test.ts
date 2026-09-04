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
    await pool.query(`DELETE FROM conversations WHERE source_id LIKE 'it-%'`).catch(() => {});
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
      source: 'pocket',
      source_id: 'it-b1',
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
      source: 'pocket',
      source_id: 'it-b2',
      starts_at: '2026-10-01T09:00:00Z',
      ends_at: '2026-10-01T10:00:00Z',
    });
    expect(r.correlation).toMatchObject({ status: 'unmatched', reason: 'no_candidates' });
  });

  // Overlap alone is not doubt — on a back-to-back day nearly every recording
  // overlaps two bookings. The matcher abstains on MARGIN: the nearest start has
  // to beat the runner-up by a clear distance (see correlateConversation).
  it('abstains when the two nearest appointment starts are too close to call', async () => {
    await seedAppointment('it-a-tie1', 'it-c-tie1', '2026-11-01T15:00:00Z', '2026-11-01T16:00:00Z');
    await seedAppointment('it-a-tie2', 'it-c-tie2', '2026-11-01T15:30:00Z', '2026-11-01T16:30:00Z');
    // 15:15 sits 15 min from each start — a dead heat, well inside the 15-minute
    // margin, so the recording could belong to either client.
    const r = await ingestConversation({
      source: 'pocket',
      source_id: 'it-b-tie',
      starts_at: '2026-11-01T15:15:00Z',
      ends_at: '2026-11-01T15:20:00Z',
    });
    expect(r.correlation).toMatchObject({ status: 'unmatched', reason: 'margin_too_tight' });
  });

  it('matches the clearly nearer of two overlapping bookings', async () => {
    await seedAppointment('it-a-near1', 'it-c-near1', '2026-11-02T15:00:00Z', '2026-11-02T16:00:00Z');
    const nearer = await seedAppointment(
      'it-a-near2',
      'it-c-near2',
      '2026-11-02T15:30:00Z',
      '2026-11-02T16:30:00Z',
    );
    // 15:45 is 15 min from the 15:30 start and 45 min from the 15:00 one — a
    // 30-minute margin, comfortably past the threshold.
    const r = await ingestConversation({
      source: 'pocket',
      source_id: 'it-b-near',
      starts_at: '2026-11-02T15:45:00Z',
      ends_at: '2026-11-02T15:50:00Z',
    });
    expect(r.correlation.status).toBe('matched');
    if (r.correlation.status === 'matched') {
      expect(r.correlation.clientId).toBe(nearer);
    }
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
      source: 'pocket',
      source_id: 'it-b-cancel',
      starts_at: '2026-12-01T15:05:00Z',
      ends_at: '2026-12-01T15:50:00Z',
    });
    // The only overlap is cancelled → treated as no candidate at all.
    expect(r.correlation).toMatchObject({ status: 'unmatched', reason: 'no_candidates' });
  });

  it('sends a second overlapping recording to unmatched instead of overwriting the first', async () => {
    await seedAppointment('it-a-taken', 'it-c-taken', '2026-12-02T15:00:00Z', '2026-12-02T16:00:00Z');
    const first = await ingestConversation({
      source: 'pocket',
      source_id: 'it-b-taken-1',
      starts_at: '2026-12-02T15:00:00Z',
      ends_at: '2026-12-02T15:30:00Z',
    });
    expect(first.correlation.status).toBe('matched');

    // A split recording's second chunk overlaps the same booking — but that
    // booking now carries a recording, so this one must NOT silently take it.
    const second = await ingestConversation({
      source: 'pocket',
      source_id: 'it-b-taken-2',
      starts_at: '2026-12-02T15:30:00Z',
      ends_at: '2026-12-02T15:55:00Z',
    });
    expect(second.correlation).toMatchObject({ status: 'unmatched', reason: 'no_candidates' });
  });

  it('is idempotent on (source, source_id) (re-ingest updates, no duplicate row)', async () => {
    await ingestConversation({
      source: 'pocket',
      source_id: 'it-b1',
      starts_at: '2026-09-01T15:05:00Z',
      ends_at: '2026-09-01T15:50:00Z',
      transcript: 'added on re-ingest',
    });
    const rows = await pool.query(`SELECT count(*)::int AS n FROM conversations WHERE source_id = 'it-b1'`);
    expect(rows.rows[0].n).toBe(1);
  });

  const status = (sourceId: string) =>
    pool
      .query(`SELECT correlation_status, appointment_id FROM conversations WHERE source_id = $1`, [
        sourceId,
      ])
      .then((r) => r.rows[0]);

  it('files a sub-minute recording with no speech as discarded, never matched', async () => {
    // Overlaps a real booking on purpose: a stray "[click]" that lands inside a
    // slot must not correlate to it and file an empty body against the chart.
    await seedAppointment('it-a-noise', 'it-c-noise', '2027-01-05T15:00:00Z', '2027-01-05T16:00:00Z');
    const r = await ingestConversation({
      source: 'pocket',
      source_id: 'it-b-noise',
      starts_at: '2027-01-05T15:10:00Z',
      ends_at: '2027-01-05T15:10:12Z',
      transcript: '[background noise]',
    });
    expect(r.correlation.status).toBe('unmatched');
    expect(r.discarded?.reason).toMatch(/no speech/);
    expect(await status('it-b-noise')).toMatchObject({
      correlation_status: 'discarded',
      appointment_id: null,
    });
  });

  it('keeps a discarded recording out of the unmatched review queue', async () => {
    await ingestConversation({
      source: 'pocket',
      source_id: 'it-b-noise-2',
      starts_at: '2027-01-06T09:00:00Z',
      ends_at: '2027-01-06T09:00:03Z',
      transcript: '[click]',
    });
    const { rows } = await pool.query(
      `SELECT 1 FROM conversations
        WHERE appointment_id IS NULL
          AND correlation_status NOT IN ('split', 'discarded')
          AND source_id = 'it-b-noise-2'`,
    );
    expect(rows).toHaveLength(0);
  });

  it('leaves a short recording that actually has words alone', async () => {
    const r = await ingestConversation({
      source: 'pocket',
      source_id: 'it-b-short-words',
      starts_at: '2027-01-07T09:00:00Z',
      ends_at: '2027-01-07T09:00:20Z',
      transcript: 'Hi Nicole, I need to reschedule Thursday.',
    });
    expect(r.discarded).toBeUndefined();
    expect(await status('it-b-short-words')).toMatchObject({ correlation_status: 'unmatched' });
  });

  it('discards on the later delivery when the transcript arrives after the audio', async () => {
    const first = await ingestConversation({
      source: 'pocket',
      source_id: 'it-b-late-tx',
      starts_at: '2027-01-08T09:00:00Z',
      ends_at: '2027-01-08T09:00:08Z',
    });
    expect(first.correlation.status).toBe('unmatched');
    expect(await status('it-b-late-tx')).toMatchObject({ correlation_status: 'unmatched' });

    const second = await ingestConversation({
      source: 'pocket',
      source_id: 'it-b-late-tx',
      starts_at: '2027-01-08T09:00:00Z',
      ends_at: '2027-01-08T09:00:08Z',
      transcript: '[BLANK_AUDIO]',
    });
    expect(second.discarded?.reason).toMatch(/no speech/);
    const rows = await pool.query(
      `SELECT count(*)::int AS n FROM conversations WHERE source_id = 'it-b-late-tx'`,
    );
    expect(rows.rows[0].n).toBe(1);
    expect(await status('it-b-late-tx')).toMatchObject({ correlation_status: 'discarded' });
  });
});
