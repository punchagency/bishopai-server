import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import {
  emulatorUp,
  installFirestore,
  uninstallFirestore,
  clearFirestore,
} from './firestore';
import type { IDatabase } from '../src/db/interfaces/repositories';
import type { SessionNote } from '../src/session/extract';

const up = await emulatorUp();
const suite = up ? describe : describe.skip;
if (!up) {
  console.log('[tasks.firestore] Firestore emulator not running — skipping. Start: npm run firestore:emulator');
}

// Imported lazily so the adapter is installed before the module resolves getDatabase.
let createTasksFromNote: typeof import('../src/tasks/service')['createTasksFromNote'];
let reconcileTasksAfterAmend: typeof import('../src/tasks/service')['reconcileTasksAfterAmend'];
let listOpenTasks: typeof import('../src/tasks/service')['listOpenTasks'];
let setTaskStatus: typeof import('../src/tasks/service')['setTaskStatus'];
let createManualTask: typeof import('../src/tasks/service')['createManualTask'];

const note = (followUps: unknown): SessionNote => ({ follow_ups: followUps } as unknown as SessionNote);
const SESSION_DATE = new Date('2026-07-01T10:00:00Z');

suite('tasks/service against Firestore', () => {
  let db: IDatabase;

  beforeAll(async () => {
    db = installFirestore();
    const mod = await import('../src/tasks/service');
    createTasksFromNote = mod.createTasksFromNote;
    reconcileTasksAfterAmend = mod.reconcileTasksAfterAmend;
    listOpenTasks = mod.listOpenTasks;
    setTaskStatus = mod.setTaskStatus;
    createManualTask = mod.createManualTask;
  });

  afterAll(() => uninstallFirestore());

  beforeEach(async () => {
    await clearFirestore(db);
    await db.clients.save({
      id: 'client-a',
      name: 'Ada Client',
      email: 'ada@example.com',
      created_at: SESSION_DATE.toISOString(),
      updated_at: SESSION_DATE.toISOString(),
    });
  });

  it('creates a task per follow-up, denormalizing the client name', async () => {
    const r = await createTasksFromNote(null, {
      clientId: 'client-a',
      appointmentId: 'appt-1',
      sessionDate: SESSION_DATE,
      note: note(['Recheck B12 in 4 weeks', 'Keep an eye on her sleep']),
    });

    expect(r.created).toBe(2);
    const tasks = await listOpenTasks('client-a');
    expect(tasks).toHaveLength(2);
    expect(tasks.every((t) => t.client_name === 'Ada Client')).toBe(true);
    expect(tasks.every((t) => t.source === 'session')).toBe(true);
  });

  // The reason tasks_session_unique exists: approving the sheet and the protocol
  // both replay the same follow_ups, and a re-approval replays them again.
  it('is idempotent across replayed approvals', async () => {
    const args = {
      clientId: 'client-a',
      appointmentId: 'appt-1',
      sessionDate: SESSION_DATE,
      note: note(['Recheck B12 in 4 weeks']),
    };
    expect((await createTasksFromNote(null, args)).created).toBe(1);
    expect((await createTasksFromNote(null, args)).created).toBe(0);
    expect((await createTasksFromNote(null, args)).created).toBe(0);
    expect(await listOpenTasks('client-a')).toHaveLength(1);
  });

  // Concurrency is the whole point of create() over findById()+save(): a
  // read-then-write pair lets both racers believe they created the task.
  it('reports exactly one creation when two approvals race', async () => {
    const args = {
      clientId: 'client-a',
      appointmentId: 'appt-1',
      sessionDate: SESSION_DATE,
      note: note(['Recheck B12 in 4 weeks']),
    };
    const results = await Promise.all([
      createTasksFromNote(null, args),
      createTasksFromNote(null, args),
    ]);
    expect(results.map((r) => r.created).sort()).toEqual([0, 1]);
    expect(await listOpenTasks('client-a')).toHaveLength(1);
  });

  // A replay must never resurrect a task Nicole already dealt with. set(merge)
  // would reset status to 'open' and wipe completed_at; create() cannot.
  it('does not reopen a completed task when the note is re-approved', async () => {
    const args = {
      clientId: 'client-a',
      appointmentId: 'appt-1',
      sessionDate: SESSION_DATE,
      note: note(['Recheck B12 in 4 weeks']),
    };
    await createTasksFromNote(null, args);
    const [task] = await listOpenTasks('client-a');
    await setTaskStatus(task.id, 'done');

    expect((await createTasksFromNote(null, args)).created).toBe(0);
    expect(await listOpenTasks('client-a')).toHaveLength(0);
    const stored = await db.tasks.findById(task.id);
    expect(stored?.status).toBe('done');
    expect(stored?.completed_at).toBeTruthy();
  });

  // The bug this replaces: hashing an 'unbound' placeholder made the id global,
  // so two clients sharing follow-up wording collapsed into ONE document.
  it('keeps identically-worded unbound follow-ups separate per client', async () => {
    await db.clients.save({
      id: 'client-b',
      name: 'Bo Client',
      email: 'bo@example.com',
      created_at: SESSION_DATE.toISOString(),
      updated_at: SESSION_DATE.toISOString(),
    });

    const followUp = note(['Recheck B12 in 4 weeks']);
    await createTasksFromNote(null, {
      clientId: 'client-a',
      appointmentId: null,
      sessionDate: SESSION_DATE,
      note: followUp,
    });
    await createTasksFromNote(null, {
      clientId: 'client-b',
      appointmentId: null,
      sessionDate: SESSION_DATE,
      note: followUp,
    });

    expect(await listOpenTasks('client-a')).toHaveLength(1);
    expect(await listOpenTasks('client-b')).toHaveLength(1);
    expect(await db.tasks.listAll()).toHaveLength(2);
  });

  // §3.5: Firestore drops documents MISSING the orderBy field. A null due date
  // is legitimate and common, so it must still come back — sorted last.
  it('returns tasks with no due date, ordered last', async () => {
    // A dated follow-up carries due_in_days explicitly — the extractor never
    // infers a timeframe from prose, so a bare string is genuinely undated.
    await createTasksFromNote(null, {
      clientId: 'client-a',
      appointmentId: 'appt-1',
      sessionDate: SESSION_DATE,
      note: note([
        'Keep an eye on her sleep',
        { text: 'Recheck B12 in 4 weeks', due_in_days: 28 },
      ]),
    });

    const tasks = await listOpenTasks('client-a');
    expect(tasks).toHaveLength(2);
    expect(tasks[0].due_date).toBeTruthy();
    expect(tasks[tasks.length - 1].due_date).toBeNull();

    // Also via the collection-wide open query, which is the indexed orderBy path.
    const open = await listOpenTasks();
    expect(open).toHaveLength(2);
  });

  it('dismisses follow-ups an amendment removed, and keeps the rest', async () => {
    const base = {
      clientId: 'client-a',
      appointmentId: 'appt-1',
      sessionDate: SESSION_DATE,
    };
    await createTasksFromNote(null, {
      ...base,
      note: note(['Recheck B12 in 4 weeks', 'Trial magnesium at night']),
    });

    const r = await reconcileTasksAfterAmend(null, {
      ...base,
      note: note(['Recheck B12 in 4 weeks', 'Add vitamin D']),
    });

    expect(r.created).toBe(1);
    expect(r.dismissed).toBe(1);

    const open = await listOpenTasks('client-a');
    expect(open.map((t) => t.title).sort()).toEqual(['Add vitamin D', 'Recheck B12 in 4 weeks']);

    // Dismissed, not done — the distinction the old 'completed' mapping lost.
    const all = await db.tasks.listAll();
    const dropped = all.find((t) => t.title === 'Trial magnesium at night');
    expect(dropped?.status).toBe('dismissed');
    expect(dropped?.completed_at).toBeTruthy();
  });

  it('records a manual task as source=manual', async () => {
    const row = await createManualTask({
      clientId: 'client-a',
      title: 'Call about lab results',
      dueDate: null,
    });
    expect(row.source).toBe('manual');
    expect(row.client_name).toBe('Ada Client');

    const [listed] = await listOpenTasks('client-a');
    expect(listed.source).toBe('manual');
  });

  it('clears completed_at when a task is reopened', async () => {
    const row = await createManualTask({
      clientId: 'client-a',
      title: 'Call about lab results',
      dueDate: '2026-08-01',
    });
    await setTaskStatus(row.id, 'done');
    const reopened = await setTaskStatus(row.id, 'open');
    expect(reopened?.status).toBe('open');
    expect(reopened?.completed_at).toBeNull();
  });
});
