import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { pool } from '../src/db/pool';
import { patchSession } from '../src/session/sessionService';
import {
  DRAFT_REPLACED_REASON,
  EXTRACTION_BASELINE_REASON,
  fetchRevisions,
  snapshotRevision,
} from '../src/session/revisions';

// The extractor's output, kept before the first edit erases it.
//
// A training pair is (what the model produced, what it should have produced),
// and the second half only becomes observable at the instant Nicole corrects
// the first. After that write there is nothing left to compare against — the
// model's version is not stored anywhere else and no later work recovers it.
// Which makes this the one item on the list where waiting has a cost that
// cannot be paid off later: every session edited before this ran is a pair that
// no longer exists.
const dbUp = await pool
  .query('SELECT 1')
  .then(() => true)
  .catch(() => false);
const suite = dbUp ? describe : describe.skip;

const note = (concern: string) => ({
  concerns: [concern],
  goals: [],
  assessments: [],
  protocol_changes: [],
  supplements: [],
  follow_ups: [],
});

suite('extraction baseline (integration, real Postgres)', () => {
  let clientId = '';
  let apptId = '';
  let sheetId = '';

  const baselines = async () => {
    const r = await pool.query<{ content_json: { concerns: string[] }; revision: number }>(
      // Oldest first — by when it was taken, not by revision. Hidden snapshots
      // number DOWNWARDS (-1, -2, …) so they stay out of the amendment
      // numbering a reviewer reads, which makes revision order the reverse of
      // capture order here.
      `SELECT content_json, revision FROM note_revisions
        WHERE source_id = $1 AND reason = $2 ORDER BY revision DESC`,
      [sheetId, EXTRACTION_BASELINE_REASON],
    );
    return r.rows;
  };

  beforeAll(async () => {
    const c = await pool.query<{ id: string }>(
      `INSERT INTO clients (name, pb_id) VALUES ('Baseline Client', 'baseline-c') RETURNING id`,
    );
    clientId = c.rows[0].id;
    const a = await pool.query<{ id: string }>(
      `INSERT INTO appointments (client_id, pb_id, starts_at, ends_at, status)
            VALUES ($1, 'baseline-a', now() - interval '2 hours',
                    now() - interval '1 hour', 'completed') RETURNING id`,
      [clientId],
    );
    apptId = a.rows[0].id;
    // The extractor's output.
    const s = await pool.query<{ id: string }>(
      `INSERT INTO appointment_sheets (appointment_id, client_id, content_json, status)
            VALUES ($1, $2, $3, 'draft') RETURNING id`,
      [apptId, clientId, JSON.stringify(note('model wrote this'))],
    );
    sheetId = s.rows[0].id;
    await pool.query(
      `INSERT INTO protocols (appointment_id, client_id, content_json, status)
            VALUES ($1, $2, $3, 'draft')`,
      [apptId, clientId, JSON.stringify(note('model wrote this'))],
    );
  });

  afterAll(async () => {
    if (sheetId) await pool.query(`DELETE FROM note_revisions WHERE source_id = $1`, [sheetId]);
    if (apptId) {
      await pool.query(`DELETE FROM appointment_sheets WHERE appointment_id = $1`, [apptId]);
      await pool.query(`DELETE FROM protocols WHERE appointment_id = $1`, [apptId]);
      await pool.query(`DELETE FROM appointments WHERE id = $1`, [apptId]);
    }
    if (clientId) await pool.query(`DELETE FROM clients WHERE id = $1`, [clientId]);
  });

  it('files the model output the first time a human edits the note', async () => {
    const out = await patchSession(apptId, note('Nicole corrected this'));
    expect(out.ok).toBe(true);

    const rows = await baselines();
    expect(rows).toHaveLength(1);
    // The half that would otherwise be gone: what the model said, not the fix.
    expect(rows[0].content_json.concerns).toEqual(['model wrote this']);
  });

  it('does not re-file on every subsequent edit', async () => {
    // The pair is (extraction, final). Capturing again on the second edit would
    // replace the model's output with Nicole's own first draft and quietly
    // train the extractor on its own corrections.
    await patchSession(apptId, note('and again'));
    await patchSession(apptId, note('and once more'));

    const rows = await baselines();
    expect(rows).toHaveLength(1);
    expect(rows[0].content_json.concerns).toEqual(['model wrote this']);
  });

  it('stays out of the history a reviewer reads', async () => {
    // Same treatment as re-extraction snapshots. A reviewer opening this note
    // must not be told it was "amended" by a capture nobody performed.
    const history = await fetchRevisions('appointment_sheets', sheetId);
    expect(history.every((h) => h.reason !== EXTRACTION_BASELINE_REASON)).toBe(true);
  });

  it('captures a fresh baseline after a re-extraction replaces the draft', async () => {
    // A re-extraction throws the draft away for a new model run, which makes
    // the standing baseline the wrong half of the pair — it is no longer the
    // text anyone is editing.
    const db = await pool.connect();
    try {
      await snapshotRevision(
        db,
        'appointment_sheets',
        sheetId,
        note('superseded draft'),
        DRAFT_REPLACED_REASON,
      );
    } finally {
      db.release();
    }
    await pool.query(`UPDATE appointment_sheets SET content_json = $1 WHERE id = $2`, [
      JSON.stringify(note('model re-ran')),
      sheetId,
    ]);

    await patchSession(apptId, note('Nicole corrected the re-run'));

    const rows = await baselines();
    expect(rows).toHaveLength(2);
    expect(rows[1].content_json.concerns).toEqual(['model re-ran']);
    // Both outside the visible numbering, so neither shifted the amendment count.
    expect(rows.every((r) => r.revision < 0)).toBe(true);
  });
});
