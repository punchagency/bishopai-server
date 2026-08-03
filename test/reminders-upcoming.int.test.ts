import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApp } from '../src/app';
import {
  emulatorUp,
  installFirestore,
  uninstallFirestore,
  clearFirestore,
} from './firestore';
import { seedClient, seedLead, seedRefill, seedSupplement } from './fixtures';
import type { IDatabase } from '../src/db/interfaces/repositories';
import { updateAuthConfig } from '../src/auth/service';
import { nextRefillSendDate, doseSummary } from '../src/reminders/upcoming';
import { runRefillReminders } from '../src/refills/remindersRunner';
import { nextScheduledStep } from '../src/reengagement/cadence';

const TODAY = '2026-07-07';

// --- Pure: when the next email lands ----------------------------------------
describe('nextRefillSendDate', () => {
  const base = { status: 'pending', due_date: '2026-08-01', reminder_stage: 0, reminder_next_at: null };

  it('backs the first send off the run-out by the dose-scaled lead time', () => {
    // 90-day supply → full 14 days' notice.
    expect(nextRefillSendDate({ ...base, days_supply: 90 }, TODAY)).toBe('2026-07-18');
    // 15-day supply → 5 days' notice, so the same refill sends much later.
    expect(nextRefillSendDate({ ...base, days_supply: 15 }, TODAY)).toBe('2026-07-27');
  });

  it('reports today (not a past date) for a cadence that is overdue to fire', () => {
    expect(nextRefillSendDate({ ...base, due_date: '2026-06-01' }, TODAY)).toBe(TODAY);
  });

  it('uses the stored follow-up date once the first reminder has gone', () => {
    expect(nextRefillSendDate({ ...base, reminder_stage: 1, reminder_next_at: '2026-07-14' }, TODAY)).toBe('2026-07-14');
  });

  it('shows nothing further when only the auto-close remains, or the refill is actioned', () => {
    expect(nextRefillSendDate({ ...base, reminder_stage: 2, reminder_next_at: '2026-07-14' }, TODAY)).toBeNull();
    expect(nextRefillSendDate({ ...base, status: 'notified' }, TODAY)).toBeNull();
    expect(nextRefillSendDate({ ...base, due_date: null }, TODAY)).toBeNull();
  });
});

describe('doseSummary', () => {
  it('joins only what is known', () => {
    expect(doseSummary('2 caps twice daily', 4, 30)).toBe('2 caps twice daily · about 4 a day · 30-day supply');
    expect(doseSummary(null, null, null)).toBeNull();
  });
});

describe('nextScheduledStep', () => {
  const created = new Date('2026-07-01T00:00:00Z');
  const now = new Date(`${TODAY}T00:00:00Z`);

  it('dates the next unsent step off the lead age', () => {
    const step = nextScheduledStep({ status: 'new', created_at: created, last_touch: null, sentSteps: ['welcome', 'nudge_3d'] }, now);
    expect(step?.step).toBe('nudge_7d');
    expect(step?.sendAt.toISOString().slice(0, 10)).toBe('2026-07-08');
  });

  it('reports a due step as sending now, never in the past', () => {
    const step = nextScheduledStep({ status: 'new', created_at: created, last_touch: null, sentSteps: [] }, now);
    expect(step?.sendAt).toEqual(now);
  });

  it('is silent for a cancelled cadence or a lead who replied', () => {
    const lead = { status: 'new', created_at: created, last_touch: null, sentSteps: [] };
    expect(nextScheduledStep({ ...lead, cadenceCancelled: true }, now)).toBeNull();
    expect(nextScheduledStep({ ...lead, status: 'replied' }, now)).toBeNull();
  });
});

// --- Integration ------------------------------------------------------------
const up = await emulatorUp();
const suite = up ? describe : describe.skip;
if (!up) {
  console.log('[reminders-upcoming.int] Firestore emulator not running - skipping. Start: npm run firestore:emulator');
}

suite('GET /reminders/upcoming + cancel', () => {
  let server: http.Server;
  let base = '';
  let db: IDatabase;

  const dayOffset = (days: number) =>
    new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);

  const newClient = (name: string, email: string | null) =>
    seedClient(db, { name, email: email ?? '' }).then((c) => c.id);

  /** A supplement + its projected refill, due `dueInDays` from today. */
  const newRefill = async (clientId: string, name: string, dose: string, qty: number, dueInDays: number) => {
    const supplement = await seedSupplement(db, {
      client_id: clientId,
      name,
      dose,
      qty,
      start_date: dayOffset(-Math.max(0, qty - dueInDays)),
      source: 'notes',
    });
    const refill = await seedRefill(db, {
      client_id: clientId,
      supplement_id: supplement.id,
      supplement_name: name,
      dose,
      due_date: dayOffset(dueInDays),
      status: 'pending',
    });
    return refill.id;
  };

  beforeAll(async () => {
    db = installFirestore('reminders-upcoming-int');
    await updateAuthConfig({ enabled: false });
    server = http.createServer(createApp());
    await new Promise<void>((r) => server.listen(0, r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  beforeEach(async () => {
    await clearFirestore(db);
  });

  afterAll(async () => {
    await new Promise<void>((r) => server.close(() => r()));
    uninstallFirestore();
  });

  const upcoming = async (days = 30) => {
    const res = await fetch(`${base}/reminders/upcoming?days=${days}`);
    expect(res.status).toBe(200);
    return (await res.json()) as { reminders: Array<Record<string, unknown>> };
  };

  it('lists a refill reminder with its send date and the dose behind it', async () => {
    const c = await newClient('Maya Upcoming', 'maya.upcoming@test.com');
    // 60 caps at 2/day = 30-day supply → 10 days' lead, run-out in 12 days,
    // so the email lands 2 days from today.
    await newRefill(c, 'Magnesium', '2 caps daily', 60, 12);

    const { reminders } = await upcoming();
    const mine = reminders.filter((r) => r.client_name === 'Maya Upcoming');
    expect(mine).toHaveLength(1);
    expect(mine[0].kind).toBe('refill');
    expect(mine[0].subject).toMatch(/Magnesium refill is coming up/);
    expect(mine[0].detail).toContain('2 caps daily');
    expect(mine[0].detail).toContain('about 2 a day');
    expect(mine[0].detail).toContain('30-day supply');
    expect(mine[0].blocked_reason).toBeNull();

    const sendAt = new Date(`${mine[0].send_at as string}T00:00:00Z`);
    const daysOut = Math.round((sendAt.getTime() - Date.parse(`${new Date().toISOString().slice(0, 10)}T00:00:00Z`)) / 86_400_000);
    expect(daysOut).toBe(2);
  });

  it('flags a client with no email rather than silently sending nothing', async () => {
    const c = await newClient('No Email Upcoming', null);
    await newRefill(c, 'Zinc', '1 cap daily', 30, 1);

    const { reminders } = await upcoming();
    const mine = reminders.filter((r) => r.client_name === 'No Email Upcoming');
    expect(mine).toHaveLength(1);
    expect(mine[0].blocked_reason).toBe('no email on file');
  });

  it('cancelling drops it from the queue AND stops the runner from sending it', async () => {
    const c = await newClient('Cancel Me', 'cancel.me@test.com');
    const refillId = await newRefill(c, 'Vitamin D', '1 cap daily', 30, 1); // due tomorrow → sends today

    expect((await upcoming()).reminders.some((r) => r.source_id === refillId)).toBe(true);

    const res = await fetch(`${base}/reminders/refill/${refillId}/cancel`, { method: 'POST' });
    expect(res.status).toBe(200);
    expect((await res.json()).cancelled_at).not.toBeNull();

    expect((await upcoming()).reminders.some((r) => r.source_id === refillId)).toBe(false);

    // The cadence itself must respect it — otherwise the queue lies.
    await runRefillReminders();
    const row = await db.refills.findById(refillId);
    expect(row!.reminder_stage).toBe(0);
    expect(row!.status).toBe('pending'); // still running low; only the email stopped
  });

  it('restores a cancelled cadence where it left off', async () => {
    const c = await newClient('Restore Me', 'restore.me@test.com');
    const refillId = await newRefill(c, 'Iron', '1 cap daily', 30, 1);

    await fetch(`${base}/reminders/refill/${refillId}/cancel`, { method: 'POST' });
    const res = await fetch(`${base}/reminders/refill/${refillId}/restore`, { method: 'POST' });
    expect(res.status).toBe(200);
    expect((await res.json()).cancelled_at).toBeNull();
    expect((await upcoming()).reminders.some((r) => r.source_id === refillId)).toBe(true);
  });

  it('lists a WF3 re-engagement step and cancels it by lead id', async () => {
    const lead = await seedLead(db, { source: 'web', email: 'lead.upcoming@test.com', status: 'new' });

    const listed = (await upcoming()).reminders.find((r) => r.source_id === lead.id);
    expect(listed?.kind).toBe('reengagement');
    expect(listed?.detail).toBe('Re-engagement · welcome note');

    const res = await fetch(`${base}/reminders/reengagement/${lead.id}/cancel`, { method: 'POST' });
    expect(res.status).toBe(200);
    expect((await upcoming()).reminders.some((r) => r.source_id === lead.id)).toBe(false);
  });

  it('rejects an unknown kind and an id that matches nothing', async () => {
    const bogus = await fetch(`${base}/reminders/newsletter/00000000-0000-0000-0000-000000000000/cancel`, { method: 'POST' });
    expect(bogus.status).toBe(404);
    // Ids are document ids now, not uuids (see isDocId) - so this 404s because
    // no such refill exists, which is the behaviour that actually matters.
    const missing = await fetch(`${base}/reminders/refill/no-such-refill/cancel`, { method: 'POST' });
    expect(missing.status).toBe(404);
  });
});
