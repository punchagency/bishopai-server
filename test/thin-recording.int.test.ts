import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { pool } from '../src/db/pool';
import { listSessions } from '../src/session/sessionService';
import { listUnprocessed } from '../src/session/unprocessed';

// A recording that cannot be the appointment it is filed against, in the list
// where that goes unnoticed.
//
// `tooShortForAppointment` was wired into listUnprocessed first, which is the
// one list where it adds nothing — those rows already say the extraction
// produced no note. The gap is here. `classify` returns null the moment a note
// has a single finding, so the row falls OUT of the unprocessed list and lands
// in the review queue as an ordinary draft: a note built from two minutes of a
// sixty-minute booking, sitting next to a client name and a date, looking like
// a session that simply ran short.
//
// That is the harder failure to see. A blank note looks blank when you open it.
// This one reads as a short session and gets approved.
const dbUp = await pool
  .query('SELECT 1')
  .then(() => true)
  .catch(() => false);
const suite = dbUp ? describe : describe.skip;

const HOUR_NOTE = {
  concerns: ['fatigue'],
  goals: [],
  assessments: [],
  protocol_changes: [],
  supplements: [],
  follow_ups: [],
};

suite('coverage of the appointment (integration, real Postgres)', () => {
  const ids: string[] = [];
  let clientId = '';

  /** One appointment + sheet, with at most one recording filed against it.
   *
   *  At most one because migration 0022 says so: conversations(appointment_id)
   *  is unique, which is also why the join in SESSION_SELECT needs no aggregate. */
  async function session(
    tag: string,
    bookedMinutes: number,
    recording: { minutes: number; chars: number; status?: string } | null,
  ): Promise<string> {
    const a = await pool.query<{ id: string }>(
      `INSERT INTO appointments (client_id, pb_id, starts_at, ends_at, status)
            VALUES ($1, $2, now() - interval '3 hours',
                    now() - interval '3 hours' + ($3 || ' minutes')::interval, 'completed')
         RETURNING id`,
      [clientId, `thin-${tag}`, String(bookedMinutes)],
    );
    const apptId = a.rows[0].id;
    ids.push(apptId);

    if (recording) {
      await pool.query(
        `INSERT INTO conversations
                (source_id, source, starts_at, ends_at, transcript, appointment_id,
                 correlation_status, extraction_status)
              VALUES ($1, 'manual', now() - interval '3 hours',
                      now() - interval '3 hours' + ($2 || ' minutes')::interval,
                      repeat('x', $3), $4, $5, 'done')`,
        [
          `thin-${tag}`,
          String(recording.minutes),
          recording.chars,
          apptId,
          recording.status ?? 'matched',
        ],
      );
    }
    // A real note: this session is NOT in the unprocessed list.
    await pool.query(
      `INSERT INTO appointment_sheets (appointment_id, client_id, content_json, status)
            VALUES ($1, $2, $3, 'draft')`,
      [apptId, clientId, JSON.stringify(HOUR_NOTE)],
    );
    return apptId;
  }

  const find = (rows: Awaited<ReturnType<typeof listSessions>>, id: string) =>
    rows.find((r) => r.appointment_id === id);

  beforeAll(async () => {
    const c = await pool.query<{ id: string }>(
      `INSERT INTO clients (name, pb_id) VALUES ('Thin Coverage', 'thin-coverage') RETURNING id`,
    );
    clientId = c.rows[0].id;
  });

  afterAll(async () => {
    if (ids.length) {
      await pool.query(`DELETE FROM conversations WHERE appointment_id = ANY($1)`, [ids]);
      await pool.query(`DELETE FROM appointment_sheets WHERE appointment_id = ANY($1)`, [ids]);
      await pool.query(`DELETE FROM appointments WHERE id = ANY($1)`, [ids]);
    }
    if (clientId) await pool.query(`DELETE FROM clients WHERE id = $1`, [clientId]);
  });

  it('flags a fragment that produced a note, in the queue where it lands', async () => {
    // The Amber Stack shape: 2 minutes of a 60-minute booking, 695 characters,
    // and a note with something in it.
    const id = await session('fragment', 60, { minutes: 2, chars: 695 });

    // Not in the unprocessed list — the note is not empty, so `classify`
    // returns null and this row is somebody else's problem. That is the gap.
    const unprocessed = await listUnprocessed();
    expect(unprocessed.some((u) => u.appointment_id === id)).toBe(false);

    const row = find(await listSessions('pending'), id);
    expect(row).toBeDefined();
    expect(row!.too_short_for_appointment).toBe(true);
    expect(row!.recording_seconds).toBe(120);
    expect(row!.appointment_seconds).toBe(3600);
    expect(row!.transcript_chars).toBe(695);
  });

  it('leaves a session that filled its booking alone', async () => {
    const id = await session('full', 60, { minutes: 55, chars: 16882 });
    const row = find(await listSessions('pending'), id);
    expect(row!.too_short_for_appointment).toBe(false);
  });

  it('measures against the booking, not a fixed length', async () => {
    // Four minutes and 900 characters is a fragment against an hour and a
    // perfectly ordinary recording of a five-minute check-in. The ratio is the
    // whole point: the same recording is flagged or not depending on what it
    // was supposed to be a recording OF.
    const brief = await session('brief-booking', 5, { minutes: 4, chars: 900 });
    expect(find(await listSessions('pending'), brief)!.too_short_for_appointment).toBe(false);

    const long = await session('long-booking', 60, { minutes: 4, chars: 900 });
    expect(find(await listSessions('pending'), long)!.too_short_for_appointment).toBe(true);
  });

  it('says nothing about an appointment with no recording', async () => {
    // Silence beats a guess. A false warning spent on a correct row is how a
    // warning stops being read.
    const id = await session('no-recording', 60, null);
    const row = find(await listSessions('pending'), id);
    expect(row!.recording_seconds).toBeNull();
    expect(row!.too_short_for_appointment).toBe(false);
  });
});
