import { describe, it, expect, afterEach, afterAll } from 'vitest';
import { pool } from '../src/db/pool';
import { nextReminderAction, reminderMessage } from '../src/refills/reminders';
import { pickSupplementWinner, projectRefills, type SupplementRow } from '../src/refills/project';
import { suggestedMonths } from '../src/refills/adherence';
import { runRefillReminders } from '../src/refills/remindersRunner';

const TODAY = '2026-07-07';

// --- Pure: reminder cadence -------------------------------------------------
describe('nextReminderAction', () => {
  const base = { status: 'pending', due_date: '2026-07-15', reminder_stage: 0, reminder_next_at: null };

  it('sends the first reminder inside the SOON window', () => {
    expect(nextReminderAction(base, TODAY)).toEqual({ kind: 'send', stage: 1, tier: 'soon' });
  });
  it('does nothing when the refill is far off', () => {
    expect(nextReminderAction({ ...base, due_date: '2026-09-01' }, TODAY)).toEqual({ kind: 'none' });
  });
  it('marks overdue when past due', () => {
    expect(nextReminderAction({ ...base, due_date: '2026-07-01' }, TODAY)).toEqual({ kind: 'send', stage: 1, tier: 'overdue' });
  });
  it('sends the follow-up once the next date arrives', () => {
    expect(nextReminderAction({ ...base, reminder_stage: 1, reminder_next_at: '2026-07-07' }, TODAY)).toEqual({ kind: 'send', stage: 2, tier: 'soon' });
  });
  it('waits when the follow-up is not yet due', () => {
    expect(nextReminderAction({ ...base, reminder_stage: 1, reminder_next_at: '2026-07-20' }, TODAY)).toEqual({ kind: 'none' });
  });
  it('auto-closes after the final follow-up window', () => {
    expect(nextReminderAction({ ...base, reminder_stage: 2, reminder_next_at: '2026-07-06' }, TODAY)).toEqual({ kind: 'close' });
  });
  it('stops once the refill is no longer pending', () => {
    expect(nextReminderAction({ ...base, status: 'notified' }, TODAY)).toEqual({ kind: 'none' });
  });
});

describe('reminderMessage', () => {
  it('differs by tier', () => {
    expect(reminderMessage('Maya Chen', 'Magnesium', 'overdue', 1).subject).toMatch(/overdue/i);
    expect(reminderMessage('Maya Chen', 'Magnesium', 'soon', 1).subject).toMatch(/coming up/i);
  });
});

// --- Pure: multi-source reconciliation --------------------------------------
const supp = (id: string, source: string | null, start: string | null): SupplementRow => ({
  id,
  client_id: 'c1',
  name: 'Magnesium',
  dose: null,
  qty: null,
  start_date: start,
  source,
});

describe('pickSupplementWinner', () => {
  it('prefers the practitioner note over vendor feeds', () => {
    const { winner, loserIds } = pickSupplementWinner([supp('a', 'pb', '2026-07-01'), supp('b', 'notes', '2026-06-01'), supp('c', 'fullscript', '2026-06-15')]);
    expect(winner.id).toBe('b');
    expect(loserIds.sort()).toEqual(['a', 'c']);
  });
  it('breaks source ties by most recent start_date', () => {
    const { winner } = pickSupplementWinner([supp('a', 'notes', '2026-06-01'), supp('b', 'notes', '2026-07-01')]);
    expect(winner.id).toBe('b');
  });
});

// --- Pure: adherence bundling ------------------------------------------------
describe('suggestedMonths', () => {
  it('bundles multi-month only for proven high adherence', () => {
    expect(suggestedMonths({ score: 0.9, actioned: 4, overdue: 0 })).toBe(3);
    expect(suggestedMonths({ score: 1, actioned: 1, overdue: 0 })).toBe(1); // not enough history
    expect(suggestedMonths({ score: 0.5, actioned: 2, overdue: 2 })).toBe(1);
  });
});

// --- Integration ------------------------------------------------------------
const dbUp = await pool
  .query('SELECT 1')
  .then(() => true)
  .catch(() => false);
const suite = dbUp ? describe : describe.skip;

suite('WF4 refills (integration)', () => {
  const clientIds: string[] = [];
  const newClient = async (email: string | null) =>
    (await pool.query<{ id: string }>(`INSERT INTO clients (name, email) VALUES ('WF4 Test', $1) RETURNING id`, [email])).rows[0].id;
  afterEach(async () => {
    for (const id of clientIds.splice(0)) await pool.query(`DELETE FROM clients WHERE id = $1`, [id]);
  });
  afterAll(async () => {
    await pool.end();
  });

  it('projection collapses duplicate cross-source supplements into one refill', async () => {
    const c = await newClient(null);
    clientIds.push(c);
    // Same supplement from two sources; both have qty + start so both would project.
    await pool.query(
      `INSERT INTO supplements (client_id, name, dose, qty, start_date, source)
       VALUES ($1,'Magnesium','1 cap daily',30,'2026-06-01','fullscript'),
              ($1,'Magnesium','1 cap daily',30,'2026-06-20','notes')`,
      [c],
    );
    const r = await projectRefills();
    expect(r.deduped).toBeGreaterThanOrEqual(1);
    // Exactly one refill for this client, tied to the notes-source supplement.
    const refills = await pool.query(
      `SELECT rf.id, s.source FROM refills rf JOIN supplements s ON s.id = rf.supplement_id
        WHERE rf.client_id = $1 AND rf.status = 'pending'`,
      [c],
    );
    expect(refills.rowCount).toBe(1);
    expect(refills.rows[0].source).toBe('notes');
  });

  it('reminder runner sends a due reminder, then auto-closes after the final follow-up', async () => {
    const c = await newClient('client@x.com');
    clientIds.push(c);
    const supId = (
      await pool.query<{ id: string }>(`INSERT INTO supplements (client_id, name, source) VALUES ($1,'Zinc','notes') RETURNING id`, [c])
    ).rows[0].id;
    // Pending refill due tomorrow → first reminder should send.
    const dueSoon = (await pool.query<{ d: string }>(`SELECT to_char(current_date + 1, 'YYYY-MM-DD') AS d`)).rows[0].d;
    await pool.query(`INSERT INTO refills (client_id, supplement_id, due_date, status) VALUES ($1,$2,$3,'pending')`, [c, supId, dueSoon]);

    const first = await runRefillReminders();
    expect(first.sent).toBeGreaterThanOrEqual(1);
    let row = (await pool.query(`SELECT reminder_stage, status FROM refills WHERE client_id = $1`, [c])).rows[0];
    expect(row.reminder_stage).toBe(1);

    // Force the row to the final stage with its follow-up already due → auto-close.
    await pool.query(`UPDATE refills SET reminder_stage = 2, reminder_next_at = current_date - 1 WHERE client_id = $1`, [c]);
    const second = await runRefillReminders();
    expect(second.closed).toBeGreaterThanOrEqual(1);
    row = (await pool.query(`SELECT status FROM refills WHERE client_id = $1`, [c])).rows[0];
    expect(row.status).toBe('closed');
  });
});
