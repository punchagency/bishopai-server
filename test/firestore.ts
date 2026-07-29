import { FirestoreDatabase } from '../src/db/adapters/firestore/index';
import { setDatabaseAdapter, resetDatabaseAdapter } from '../src/db/index';
import type { IDatabase } from '../src/db/interfaces/repositories';

/**
 * Firestore emulator harness.
 *
 * The in-memory mock cannot catch the failure modes that actually bite in
 * Firestore — a missing composite index, an orderBy that silently drops
 * documents lacking the field, create() vs set(merge) semantics. So suites that
 * exercise repository behaviour run against the real emulator.
 *
 * Start it with:  npm run firestore:emulator
 * (firebase-tools 15 needs JDK 21+; the pinned @13 works on JDK 17.)
 *
 * Suites call `describeFirestore(...)` so they SKIP rather than fail when the
 * emulator isn't running — same convention as the `dbUp` guard the Postgres
 * integration tests use, so a contributor without the emulator still gets a
 * green, honest run.
 */

const EMULATOR_HOST = process.env.FIRESTORE_EMULATOR_HOST ?? '127.0.0.1:8080';

export async function emulatorUp(): Promise<boolean> {
  try {
    const res = await fetch(`http://${EMULATOR_HOST}/`, {
      signal: AbortSignal.timeout(1500),
    });
    return res.status < 500;
  } catch {
    return false;
  }
}

/** Point the Admin SDK at the emulator. Must run before the first getFirestore(). */
export function useEmulator(projectId = 'demo-bishopai'): void {
  process.env.FIRESTORE_EMULATOR_HOST = EMULATOR_HOST;
  process.env.GCLOUD_PROJECT = projectId;
  process.env.GOOGLE_CLOUD_PROJECT = projectId;
}

/**
 * Wipe every collection between tests. The adapter is a process-level singleton
 * (`activeDatabase` in db/index.ts), so without this, state leaks across test
 * files — which is exactly how the current suite hides cross-test contamination.
 */
export async function clearFirestore(db: IDatabase): Promise<void> {
  await Promise.all([
    db.clients.clearAll(),
    db.appointments.clearAll(),
    db.conversations.clearAll(),
    db.sessionNotes.clearAll(),
    db.checkouts.clearAll(),
    db.refills.clearAll(),
    db.reengagement.clearAll(),
    db.tasks.clearAll(),
    db.documents.clearAll(),
    db.consents.clearAll(),
    db.audit.clearAll(),
  ]);
}

/** Install a live Firestore adapter for the current suite and hand it back. */
export function installFirestore(): IDatabase {
  useEmulator();
  const db = new FirestoreDatabase();
  setDatabaseAdapter(db);
  return db;
}

export function uninstallFirestore(): void {
  resetDatabaseAdapter();
}
