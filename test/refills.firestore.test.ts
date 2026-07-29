import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import {
  emulatorUp,
  installFirestore,
  uninstallFirestore,
  clearFirestore,
} from './firestore';
import type { IDatabase } from '../src/db/interfaces/repositories';
import type { Supplement } from '../src/db/interfaces/types';

const up = await emulatorUp();
const suite = up ? describe : describe.skip;
if (!up) {
  console.log('[refills.firestore] Firestore emulator not running — skipping. Start: npm run firestore:emulator');
}

let projectRefills: typeof import('../src/refills/project')['projectRefills'];

const supp = (over: Partial<Supplement> & { id: string; client_id: string; name: string }): Supplement =>
  ({
    dose: '1 cap daily',
    qty: 30,
    start_date: '2026-06-01',
    source: 'notes',
    created_at: '2026-06-01T00:00:00.000Z',
    updated_at: '2026-06-01T00:00:00.000Z',
    ...over,
  }) as Supplement;

suite('projectRefills against Firestore', () => {
  let db: IDatabase;

  beforeAll(async () => {
    db = installFirestore();
    projectRefills = (await import('../src/refills/project')).projectRefills;
  });

  afterAll(() => uninstallFirestore());
  beforeEach(async () => {
    await clearFirestore(db);
  });

  // The regression the earlier port introduced: qty was hardcoded to 60 and
  // start_date to now(), so every projected date was wrong.
  it("projects run-out from the supplement's own qty and start_date", async () => {
    await db.refills.saveSupplement(
      supp({ id: 's1', client_id: 'c1', name: 'Magnesium', qty: 30, start_date: '2026-06-01', dose: '1 cap daily' }),
    );

    const r = await projectRefills();
    expect(r.projected).toBe(1);

    const [refill] = await db.refills.listAll();
    // 30 caps at 1/day from Jun 1 runs out Jul 1 — not "60 from today".
    expect(refill.due_date).toBe('2026-07-01');
    expect(refill.supplement_id).toBe('s1');
  });

  it('reads the schedule grid in preference to the dose text', async () => {
    await db.refills.saveSupplement(
      supp({
        id: 's1',
        client_id: 'c1',
        name: 'Magnesium',
        qty: 30,
        start_date: '2026-06-01',
        dose: '1 cap daily',
        schedule: { uponWaking: '1 cap', beforeBed: '2 caps' },
      } as Partial<Supplement> & { id: string; client_id: string; name: string }),
    );

    const r = await projectRefills();
    expect(r.projected).toBe(1);
    // 3 units/day from the grid, not 1/day from the dose text: 30/3 = 10 days.
    const [refill] = await db.refills.listAll();
    expect(refill.due_date).toBe('2026-06-11');
  });

  // Restores the WF4 behaviour the earlier port silently dropped (deduped was
  // hardcoded 0 and pickSupplementWinner was orphaned).
  it('collapses the same supplement from multiple sources, notes winning', async () => {
    await db.refills.saveSupplement(
      supp({ id: 's-fs', client_id: 'c1', name: 'Magnesium', source: 'fullscript', start_date: '2026-06-01' }),
    );
    await db.refills.saveSupplement(
      supp({ id: 's-notes', client_id: 'c1', name: 'Magnesium', source: 'notes', start_date: '2026-06-20' }),
    );

    const r = await projectRefills();
    expect(r.deduped).toBe(1);
    expect(r.projected).toBe(1);

    const refills = await db.refills.listAll();
    const active = refills.filter((rf) => rf.status !== 'closed');
    expect(active).toHaveLength(1);
    expect(active[0].supplement_id).toBe('s-notes');
  });

  it('does not merge same-named supplements belonging to different clients', async () => {
    await db.refills.saveSupplement(supp({ id: 's1', client_id: 'c1', name: 'Magnesium' }));
    await db.refills.saveSupplement(supp({ id: 's2', client_id: 'c2', name: 'Magnesium' }));

    const r = await projectRefills();
    expect(r.deduped).toBe(0);
    expect(r.projected).toBe(2);
  });

  it('skips a supplement it cannot project, without failing the run', async () => {
    await db.refills.saveSupplement(supp({ id: 's1', client_id: 'c1', name: 'NoQty', qty: null }));
    await db.refills.saveSupplement(supp({ id: 's2', client_id: 'c1', name: 'Fine', qty: 30 }));

    const r = await projectRefills();
    expect(r.skipped).toBe(1);
    expect(r.projected).toBe(1);
  });

  // The nightly job runs every night; a second run must not duplicate refills.
  it('is idempotent across consecutive nightly runs', async () => {
    await db.refills.saveSupplement(supp({ id: 's1', client_id: 'c1', name: 'Magnesium' }));

    await projectRefills();
    await projectRefills();

    expect(await db.refills.listAll()).toHaveLength(1);
  });

  it('preserves a refill status a human already moved off pending', async () => {
    await db.refills.saveSupplement(supp({ id: 's1', client_id: 'c1', name: 'Magnesium' }));
    await projectRefills();

    const [refill] = await db.refills.listAll();
    await db.refills.save({ ...refill, status: 'notified' });

    await projectRefills();
    const [after] = await db.refills.listAll();
    expect(after.status).toBe('notified');
  });
});
