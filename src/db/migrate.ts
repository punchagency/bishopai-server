import { getDatabase } from './index.js';

/**
 * Data-migration runner.
 *
 * Firestore needs no DDL, so the `migrations/*.sql` files no longer run against
 * anything — they stay in the repo as the schema's historical record, and as the
 * specification the document model was reconciled against (Phase 2). What still
 * needs ordering is DATA work: backfilling a newly denormalized field, reshaping
 * a document, repairing a bad write. Those must be ordered, recorded, and safe to
 * replay, which is exactly what `schema_migrations` gave us before.
 *
 * The ledger moves to integration_state under `datamigration:<id>`, so a
 * completed migration is a document that exists. Each step is idempotent on its
 * own terms; the ledger is what stops a long backfill re-running for nothing.
 *
 *   npm run migrate
 */

export interface DataMigration {
  /** Stable, ordered id — `0001_backfill_client_name`. Never renamed once run. */
  id: string;
  /** What it does, printed as it runs. */
  description: string;
  run(): Promise<void>;
}

/**
 * Ordered list of data migrations. Append only; never renumber, because the
 * ledger keys on the id.
 *
 * Empty today: the port wrote every document in its final shape, so there is
 * nothing to backfill yet. The runner exists so the first one that IS needed has
 * somewhere to go that is ordered and replay-safe, rather than becoming a
 * one-off script someone runs twice.
 */
export const MIGRATIONS: DataMigration[] = [];

const ledgerKey = (id: string) => `datamigration:${id}`;

export async function runDataMigrations(migrations = MIGRATIONS): Promise<number> {
  const state = getDatabase().state;
  let applied = 0;

  for (const migration of migrations) {
    const key = ledgerKey(migration.id);
    if (await state.get(key)) continue;

    process.stdout.write(`Applying ${migration.id} — ${migration.description} ... `);
    // No transaction spans the step and the ledger write: a Firestore
    // transaction cannot hold a whole backfill (500 documents, and no external
    // calls inside), so the ledger is written only AFTER the step returns. A
    // crash mid-step therefore re-runs it, which is why every step must be
    // idempotent in its own right.
    await migration.run();
    await state.set(key, new Date().toISOString());
    console.log('ok');
    applied++;
  }

  console.log(applied === 0 ? 'Already up to date.' : `Applied ${applied} migration(s).`);
  return applied;
}

// Run only when invoked directly, so importing the list for a test doesn't
// execute it.
if (require.main === module) {
  runDataMigrations().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
