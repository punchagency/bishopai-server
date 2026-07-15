import { describe, it, expect, afterEach, afterAll } from 'vitest';
import { pool } from '../src/db/pool';
import { createTasksFromNote, listOpenTasks, setTaskStatus } from '../src/tasks/service';
import { buildBrief, renderBriefText } from '../src/brief/service';
import type { SessionNote } from '../src/session/extract';

const dbUp = await pool
  .query('SELECT 1')
  .then(() => true)
  .catch(() => false);
const suite = dbUp ? describe : describe.skip;

const NOTE: SessionNote = {
  concerns: ['Fatigue', 'Bloating'],
  goals: ['Sleep through the night'],
  assessments: ['Adrenal fatigue pattern'],
  protocol_changes: [{ description: 'Start Magnesium 2 caps', type: 'add' }],
  supplements: [{ name: 'Magnesium', dose: '2 caps', quantity: 60, change: 'start' }],
  follow_ups: [
    { text: 'Recheck B12 levels', due_in_days: 28 },
    { text: 'Watch her sleep', due_in_days: null },
  ],
  nrt: {
    pulse0: '78, thready',
    priority1: null, // never got to it
    k27: null, // never got to it
    stressors: 'chemical',
    foundation: 'CNS switched',
    body_scan: null, // never got to it
  },
  lifestyle: {
    bm: 'once daily',
    sleep: 'waking at 3am',
    water: '2L',
    cycle: null, // not discussed
    exercise: null, // not discussed
    diet: 'mostly whole foods',
  },
};

suite('tasks + prep brief (integration)', () => {
  const clientIds: string[] = [];

  afterEach(async () => {
    for (const id of clientIds.splice(0)) {
      // appointments.client_id is ON DELETE SET NULL — drop appointments first or
      // they survive as orphans the cockpit shows as "(unknown)". tasks cascade
      // off the client.
      await pool.query(`DELETE FROM appointments WHERE client_id = $1`, [id]);
      await pool.query(`DELETE FROM clients WHERE id = $1`, [id]);
    }
  });
  afterAll(async () => {
    await pool.end();
  });

  /** A client with a past (approved) session and a future appointment to brief for. */
  async function fixture() {
    const client = (
      await pool.query<{ id: string }>(`INSERT INTO clients (name) VALUES ('Brief Test') RETURNING id`)
    ).rows[0].id;
    clientIds.push(client);

    const past = (
      await pool.query<{ id: string }>(
        `INSERT INTO appointments (client_id, starts_at, ends_at, status)
              VALUES ($1, now() - interval '28 days', now() - interval '28 days' + interval '1 hour', 'completed')
         RETURNING id`,
        [client],
      )
    ).rows[0].id;
    await pool.query(
      `INSERT INTO appointment_sheets (appointment_id, client_id, content_json, status)
            VALUES ($1, $2, $3::jsonb, 'approved')`,
      [past, client, JSON.stringify(NOTE)],
    );

    const next = (
      await pool.query<{ id: string }>(
        `INSERT INTO appointments (client_id, starts_at, ends_at, status)
              VALUES ($1, now() + interval '1 day', now() + interval '1 day' + interval '1 hour', 'confirmed')
         RETURNING id`,
        [client],
      )
    ).rows[0].id;

    return { client, past, next };
  }

  it('promotes follow-ups to tasks, dating only the one that was given a timeframe', async () => {
    const { client, past } = await fixture();
    const sessionDate = new Date('2026-06-01T10:00:00Z');

    const r = await createTasksFromNote(pool, {
      clientId: client,
      appointmentId: past,
      sessionDate,
      note: NOTE,
    });
    expect(r.created).toBe(2);

    const tasks = await listOpenTasks(client);
    expect(tasks.map((t) => t.title)).toEqual(['Recheck B12 levels', 'Watch her sleep']);
    // 28 days after the SESSION, not after approval.
    expect(tasks[0].due_date).toBe('2026-06-29');
    // No timeframe was spoken, so there is no due date. Not a default, not a guess.
    expect(tasks[1].due_date).toBeNull();
  });

  it('is idempotent — sheet + protocol approval, and re-approval, never duplicate', async () => {
    const { client, past } = await fixture();
    const args = { clientId: client, appointmentId: past, sessionDate: new Date(), note: NOTE };

    expect((await createTasksFromNote(pool, args)).created).toBe(2);
    expect((await createTasksFromNote(pool, args)).created).toBe(0); // protocol approval
    expect((await createTasksFromNote(pool, args)).created).toBe(0); // re-approval

    expect((await listOpenTasks(client)).length).toBe(2);
  });

  it('completing a task drops it out of the open list', async () => {
    const { client, past } = await fixture();
    await createTasksFromNote(pool, { clientId: client, appointmentId: past, sessionDate: new Date(), note: NOTE });

    const [first] = await listOpenTasks(client);
    const done = await setTaskStatus(first.id, 'done');
    expect(done?.status).toBe('done');
    expect(done?.completed_at).not.toBeNull();

    const open = await listOpenTasks(client);
    expect(open.length).toBe(1);
    expect(open[0].title).toBe('Watch her sleep');
  });

  it('builds a brief carrying the last session, open tasks and the plan', async () => {
    const { client, past, next } = await fixture();
    await createTasksFromNote(pool, { clientId: client, appointmentId: past, sessionDate: new Date(), note: NOTE });
    await pool.query(`INSERT INTO supplements (client_id, name, dose, qty) VALUES ($1,'Magnesium','2 caps',60)`, [client]);

    const brief = await buildBrief(next);
    expect(brief).not.toBeNull();
    expect(brief!.client_name).toBe('Brief Test');
    expect(brief!.visit_number).toBe(2); // one prior visit
    expect(brief!.last_session?.concerns).toEqual(['Fatigue', 'Bloating']);
    expect(brief!.last_session?.assessments).toEqual(['Adrenal fatigue pattern']);
    expect(brief!.open_tasks.map((t) => t.title)).toContain('Recheck B12 levels');
    expect(brief!.supplements.map((s) => s.name)).toEqual(['Magnesium']);
  });

  it('reports what was NOT covered last time — the blanks are the point', async () => {
    const { next } = await fixture();
    const brief = await buildBrief(next);

    // Recorded last session → must NOT be flagged as a gap.
    expect(brief!.not_covered_last_time).not.toContain('Pulse 0');
    expect(brief!.not_covered_last_time).not.toContain('Sleep');
    // Never got to these → they come back as her checklist for this visit.
    expect(brief!.not_covered_last_time).toEqual(
      expect.arrayContaining(['Priority #1', 'K-27', 'Body scan', 'Cycle', 'Exercise']),
    );
  });

  it('returns null for an appointment with no client', async () => {
    const orphan = (
      await pool.query<{ id: string }>(
        `INSERT INTO appointments (starts_at, ends_at, status)
              VALUES (now(), now() + interval '1 hour', 'confirmed') RETURNING id`,
      )
    ).rows[0].id;
    expect(await buildBrief(orphan)).toBeNull();
    await pool.query(`DELETE FROM appointments WHERE id = $1`, [orphan]);
  });

  it('renders a readable text brief for the morning digest', async () => {
    const { client, past, next } = await fixture();
    await createTasksFromNote(pool, { clientId: client, appointmentId: past, sessionDate: new Date(), note: NOTE });

    const text = renderBriefText((await buildBrief(next))!);
    expect(text).toContain('Brief Test');
    expect(text).toContain('visit 2');
    expect(text).toContain('Recheck B12 levels');
    expect(text).toContain('Not covered last time');
    expect(text).toContain('K-27');
  });
});
