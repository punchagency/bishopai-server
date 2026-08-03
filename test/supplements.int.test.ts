import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import {
  emulatorUp,
  installFirestore,
  uninstallFirestore,
  clearFirestore,
} from './firestore';
import { seedClient } from './fixtures';
import type { IDatabase } from '../src/db/interfaces/repositories';
import { syncClientSupplements } from '../src/session/supplements';

// Integration: the WF1→WF2/WF4 linkage — approving a Protocol reconciles its
// supplement changes into the shared `supplements` plan. Emulator-gated.
const up = await emulatorUp();
const suite = up ? describe : describe.skip;
if (!up) {
  console.log('[supplements.int] Firestore emulator not running - skipping. Start: npm run firestore:emulator');
}

suite('supplement sync (integration)', () => {
  let clientId = '';
  let db: IDatabase;

  beforeAll(() => {
    db = installFirestore('supplements-int');
  });
  afterAll(() => uninstallFirestore());
  beforeEach(async () => {
    await clearFirestore(db);
  });

  async function makeClient(suffix = ''): Promise<string> {
    const c = await seedClient(db, { name: 'SS SuppSync', pb_id: `sstest-suppsync${suffix}` });
    return c.id;
  }

  // listSupplementsByClient is ordered by name through its composite index, so
  // this reads the same order the app's protocol sheet does.
  const names = async (): Promise<string[]> =>
    (await db.refills.listSupplementsByClient(clientId)).map((s) => s.name);

  const findByName = async (name: string) =>
    (await db.refills.listSupplementsByClient(clientId)).find((s) => s.name === name) ?? null;

  const note = (supplements: unknown[]) => ({
    concerns: [],
    assessments: [],
    protocol_changes: [],
    supplements,
    follow_ups: [],
  });

  it('starts, stops, upserts and is idempotent', async () => {
    clientId = await makeClient();
    {
      // Start two supplements.
      const r1 = await syncClientSupplements(
        clientId,
        '2026-07-01',
        note([
          { name: 'Magnesium', dose: '2 caps daily', quantity: 60, change: 'start' },
          { name: 'Vitamin D', dose: '1 cap daily', quantity: 90, change: 'start' },
        ]),
      );
      expect(r1).toEqual({ upserted: 2, removed: 0 });
      expect(await names()).toEqual(['Magnesium', 'Vitamin D']);

      // Stop one, adjust the other (dose/qty updates in place, no new row).
      const r2 = await syncClientSupplements(
        clientId,
        '2026-08-01',
        note([
          { name: 'magnesium', dose: '3 caps daily', quantity: 90, change: 'increase' }, // case-insensitive match
          { name: 'Vitamin D', dose: null, quantity: null, change: 'stop' },
        ]),
      );
      expect(r2).toEqual({ upserted: 1, removed: 1 });
      // Matched case-insensitively (no duplicate row); the latest protocol's
      // spelling wins, so the stored name adopts the incoming 'magnesium'.
      expect(await names()).toEqual(['magnesium']);

      const all = await db.refills.listSupplementsByClient(clientId);
      expect(all).toHaveLength(1); // updated in place, not duplicated
      expect(all[0].dose).toBe('3 caps daily');
      expect(all[0].qty).toBe(90);

      // Re-applying a note is a no-op on row count (idempotent upsert); the
      // canonical spelling can be restored by a later protocol.
      const r3 = await syncClientSupplements(
        clientId,
        '2026-08-01',
        note([{ name: 'Magnesium', dose: '3 caps daily', quantity: 90, change: 'continue' }]),
      );
      expect(r3).toEqual({ upserted: 1, removed: 0 });
      expect(await names()).toEqual(['Magnesium']);
    }
  });

  it('does not let an out-of-order (older) approval walk the plan backwards', async () => {
    clientId = await makeClient('-chrono');
    const row = () => findByName('Iron');
    {
      // The NEWER session (July) is approved first and establishes the plan.
      await syncClientSupplements(
        clientId, '2026-07-01',
        note([{ name: 'Iron', dose: '2 caps', quantity: 60, change: 'increase' }]),
      );
      expect(await row()).toMatchObject({ dose: '2 caps', qty: 60, start_date: '2026-07-01' });

      // The OLDER session (June) is approved late. Its dose must NOT overwrite
      // the newer one, and its start_date must not move backwards.
      const r = await syncClientSupplements(
        clientId, '2026-06-01',
        note([{ name: 'Iron', dose: '1 cap', quantity: 30, change: 'start' }]),
      );
      expect(r.upserted).toBe(0); // guarded out
      expect(await row()).toMatchObject({ dose: '2 caps', qty: 60, start_date: '2026-07-01' });

      // And an OLDER `stop` must not remove a supplement a newer session kept.
      const r2 = await syncClientSupplements(
        clientId, '2026-06-15',
        note([{ name: 'Iron', dose: null, quantity: null, change: 'stop' }]),
      );
      expect(r2.removed).toBe(0);
      expect(await row()).toMatchObject({ dose: '2 caps' });
    }
  });

  it('keeps a stated dosing schedule and does not clear it on a silent session', async () => {
    clientId = await makeClient('-sched');
    const scheduleOf = async (): Promise<unknown> => (await findByName('Zypan'))?.schedule;
    {
      // Session one states when it's taken.
      await syncClientSupplements(
        clientId,
        '2026-07-01',
        note([
          {
            name: 'Zypan',
            dose: '1 w/ meals',
            quantity: 2,
            change: 'start',
            schedule: { breakfast: '1 tab', dinner: '1 tab' },
          },
        ]),
      );
      // The schema normalises to all seven slots; unstated ones are explicitly
      // null, which is what keeps "not taken then" distinct from "unknown".
      expect(await scheduleOf()).toMatchObject({ breakfast: '1 tab', dinner: '1 tab', lunch: null });

      // Session two continues it without restating the timing. The established
      // pattern must survive — clearing it would silently blank the protocol
      // sheet's dosing columns for a supplement she never changed.
      await syncClientSupplements(
        clientId,
        '2026-08-01',
        note([{ name: 'Zypan', dose: '1 w/ meals', quantity: 2, change: 'continue' }]),
      );
      expect(await scheduleOf()).toMatchObject({ breakfast: '1 tab', dinner: '1 tab' });

      // A restated schedule replaces the old one outright.
      await syncClientSupplements(
        clientId,
        '2026-09-01',
        note([
          {
            name: 'Zypan',
            dose: '2 w/ meals',
            quantity: 2,
            change: 'increase',
            schedule: { lunch: '2 tabs' },
          },
        ]),
      );
      expect(await scheduleOf()).toMatchObject({ lunch: '2 tabs', breakfast: null, dinner: null });
    }
  });
});
