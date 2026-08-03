import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import {
  emulatorUp,
  installFirestore,
  uninstallFirestore,
  clearFirestore,
} from './firestore';
import { seedClient, seedRefill, seedSupplement } from './fixtures';
import type { IDatabase } from '../src/db/interfaces/repositories';
import { nextReminderAction, reminderMessage, reminderLeadDays, followUpDays } from '../src/refills/reminders';
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

// --- Pure: dose-scaled cadence timing ---------------------------------------
describe('reminderLeadDays / followUpDays', () => {
  it('gives a long supply the full two weeks of notice', () => {
    expect(reminderLeadDays(90)).toBe(14);
    expect(followUpDays(90)).toBe(7);
  });
  it('scales the warning down for a fast-burning supply', () => {
    // 15 caps at 1/day: warning 5 days out, chased 3 days later — not a 14-day
    // heads-up sent a day after she dispensed it, followed by a chase a week
    // after the bottle was already empty.
    expect(reminderLeadDays(15)).toBe(5);
    expect(followUpDays(15)).toBe(3);
  });
  it('falls back to the fixed window when supply is unknown', () => {
    expect(reminderLeadDays(null)).toBe(14);
    expect(reminderLeadDays(undefined)).toBe(14);
    expect(reminderLeadDays(0)).toBe(14);
  });
});

describe('nextReminderAction (dose-aware)', () => {
  const base = { status: 'pending', due_date: '2026-07-15', reminder_stage: 0, reminder_next_at: null };

  it('holds off on a short supply that a 14-day window would have warned about', () => {
    // 8 days out. Unknown supply → send; 18-day supply (lead 6) → not yet.
    expect(nextReminderAction({ ...base, due_date: '2026-07-15' }, TODAY)).toEqual({ kind: 'send', stage: 1, tier: 'soon' });
    expect(nextReminderAction({ ...base, due_date: '2026-07-15', days_supply: 18 }, TODAY)).toEqual({ kind: 'none' });
  });

  it('stops entirely once Nicole cancels the reminders', () => {
    expect(nextReminderAction({ ...base, reminders_cancelled_at: '2026-07-06' }, TODAY)).toEqual({ kind: 'none' });
  });
});

describe('reminderMessage', () => {
  it('differs by tier', () => {
    expect(reminderMessage('Maya Chen', 'Magnesium', 'overdue', 1).subject).toMatch(/overdue/i);
    expect(reminderMessage('Maya Chen', 'Magnesium', 'soon', 1).subject).toMatch(/coming up/i);
  });

  it('states the dose back to the client, with the daily rate', () => {
    const { body } = reminderMessage('Maya Chen', 'Magnesium', 'soon', 1, {
      dose: '2 caps twice daily',
      perDay: 4,
      daysLeft: 6,
    });
    expect(body).toContain('2 caps twice daily — about 4 a day');
    expect(body).toContain('about 6 days from now');
    expect(body).toMatch(/different amount/i); // invites a correction
  });

  it('omits what it does not know rather than guessing', () => {
    const { body } = reminderMessage('Maya Chen', 'Magnesium', 'soon', 1);
    expect(body).toContain('Your Magnesium is due to run out soon.');
    expect(body).not.toMatch(/about \d+ a day/);
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
const up = await emulatorUp();
const suite = up ? describe : describe.skip;
if (!up) {
  console.log('[refills-wf4.int] Firestore emulator not running - skipping. Start: npm run firestore:emulator');
}

suite('WF4 refills (integration)', () => {
  let db: IDatabase;

  beforeAll(() => {
    db = installFirestore('refills-wf4-int');
  });
  afterAll(() => uninstallFirestore());
  beforeEach(async () => {
    await clearFirestore(db);
  });

  const newClient = (email: string | null) =>
    seedClient(db, { name: 'WF4 Test', email: email ?? '' }).then((c) => c.id);

  it('projection collapses duplicate cross-source supplements into one refill', async () => {
    const c = await newClient(null);
    // Same supplement from two sources; both have qty + start so both would project.
    // Distinct name_keys are required because the document id is
    // `${client_id}__${name_key}` - two rows sharing a key would be ONE document,
    // which would hide the dedup this test exists to prove.
    await seedSupplement(db, {
      client_id: c,
      name: 'Magnesium',
      name_key: 'magnesium__fullscript',
      dose: '1 cap daily',
      qty: 30,
      start_date: '2026-06-01',
      source: 'fullscript',
    });
    await seedSupplement(db, {
      client_id: c,
      name: 'Magnesium',
      name_key: 'magnesium__notes',
      dose: '1 cap daily',
      qty: 30,
      start_date: '2026-06-20',
      source: 'notes',
    });

    const r = await projectRefills();
    expect(r.deduped).toBeGreaterThanOrEqual(1);

    // Exactly one refill for this client, tied to the notes-source supplement.
    const refills = (await db.refills.listByClient(c)).filter((rf) => rf.status === 'pending');
    expect(refills).toHaveLength(1);
    const winner = await db.refills.findSupplementById(refills[0].supplement_id);
    expect(winner!.source).toBe('notes');
  });

  it('reminder runner sends a due reminder, then auto-closes after the final follow-up', async () => {
    const c = await newClient('client@x.com');
    const supplement = await seedSupplement(db, {
      client_id: c,
      name: 'Zinc',
      source: 'notes',
      dose: null,
      qty: null,
      start_date: null,
    });
    // Pending refill due tomorrow -> first reminder should send.
    const dueSoon = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
    const refill = await seedRefill(db, {
      client_id: c,
      supplement_id: supplement.id,
      supplement_name: 'Zinc',
      due_date: dueSoon,
      status: 'pending',
    });

    const first = await runRefillReminders();
    expect(first.sent).toBeGreaterThanOrEqual(1);
    expect((await db.refills.findById(refill.id))!.reminder_stage).toBe(1);

    // Force the row to the final stage with its follow-up already due -> auto-close.
    const staged = await db.refills.findById(refill.id);
    await db.refills.save({
      ...staged!,
      reminder_stage: 2,
      reminder_next_at: new Date(Date.now() - 86_400_000).toISOString().slice(0, 10),
    });
    const second = await runRefillReminders();
    expect(second.closed).toBeGreaterThanOrEqual(1);
    expect((await db.refills.findById(refill.id))!.status).toBe('closed');
  });
});
