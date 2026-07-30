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
 * A project id unique to the calling suite.
 *
 * The emulator keeps a separate dataset per project, and vitest runs test files
 * concurrently — so with a shared project id, one suite's `clearFirestore`
 * between tests wipes another suite's fixtures mid-assertion. That shows up as
 * an intermittent failure in whichever file lost the race, which is the worst
 * possible signal on a money-path test.
 *
 * Derived from the suite name so a failure is traceable to a dataset in the
 * emulator UI, and prefixed `demo-` so the Admin SDK never asks for credentials.
 */
export function emulatorProject(suiteName: string): string {
  return `demo-${suiteName.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}`;
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
    db.state.clearAll(),
    db.audit.clearAll(),
  ]);
}

/**
 * Install a live Firestore adapter for the current suite and hand it back.
 *
 * Pass a distinct `suiteName` per test FILE — see emulatorProject for why a
 * shared dataset makes concurrent suites flaky.
 */
export function installFirestore(suiteName?: string): IDatabase {
  useEmulator(suiteName ? emulatorProject(suiteName) : undefined);
  const db = new FirestoreDatabase();
  setDatabaseAdapter(db);
  return db;
}

export function uninstallFirestore(): void {
  resetDatabaseAdapter();
}
