import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import {
  emulatorUp,
  installFirestore,
  uninstallFirestore,
  clearFirestore,
} from './firestore';
import { FirestoreDatabase } from '../src/db/adapters/firestore/index';
import type { IDatabase } from '../src/db/interfaces/repositories';

const up = await emulatorUp();
const suite = up ? describe : describe.skip;
if (!up) {
  console.log('[state.firestore] Firestore emulator not running — skipping. Start: npm run firestore:emulator');
}

let getState: typeof import('../src/db/state')['getState'];
let setState: typeof import('../src/db/state')['setState'];
let delState: typeof import('../src/db/state')['delState'];

suite('integration_state durability', () => {
  let db: IDatabase;

  beforeAll(async () => {
    db = installFirestore('state');
    const mod = await import('../src/db/state');
    getState = mod.getState;
    setState = mod.setState;
    delState = mod.delState;
  });

  afterAll(() => uninstallFirestore());
  beforeEach(async () => {
    await clearFirestore(db);
  });

  it('round-trips a cursor value', async () => {
    expect(await getState('outlook:delta')).toBeNull();
    await setState('outlook:delta', 'token-abc');
    expect(await getState('outlook:delta')).toBe('token-abc');
  });

  it('overwrites an existing key rather than duplicating it', async () => {
    await setState('outlook:delta', 'token-abc');
    await setState('outlook:delta', 'token-def');
    expect(await getState('outlook:delta')).toBe('token-def');
  });

  it('deletes a key', async () => {
    await setState('qb:refresh', 'r1');
    await delState('qb:refresh');
    expect(await getState('qb:refresh')).toBeNull();
  });

  /**
   * The regression this guards: state.ts had been reduced to a module-level Map,
   * so every OAuth cursor was lost whenever the process restarted — which, on
   * Cloud Functions, is constantly. A fresh adapter instance stands in for a cold
   * start: the value must still be there.
   */
  it('survives a process restart (new adapter instance sees the value)', async () => {
    await setState('qb:refresh', 'persisted-token');

    const reconnected = new FirestoreDatabase();
    expect(await reconnected.state.get('qb:refresh')).toBe('persisted-token');
  });
});
