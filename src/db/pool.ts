import 'dotenv/config';
import { Pool, type QueryResultRow } from 'pg';

if (!process.env.DATABASE_URL) {
  throw new Error('DATABASE_URL is not set (see .env.example)');
}

/** Does a connection string point at a database on this machine? */
function isLocalDatabase(url = process.env.DATABASE_URL ?? ''): boolean {
  return /@(localhost|127\.0\.0\.1|\[::1\])[:/]/.test(url);
}

/** Host portion of DATABASE_URL, for messages — never the credentials. */
function databaseHost(): string {
  return (process.env.DATABASE_URL ?? '').replace(/.*@([^/]+)\/.*/, '$1') || '(unparseable)';
}

// Managed Postgres (Heroku, Railway, most cloud providers) requires TLS and
// presents a self-signed cert chain, so we connect with SSL but don't verify the
// chain. Auto-enable for any non-local DATABASE_URL; override with DATABASE_SSL
// ('true'/'false') if the heuristic is wrong for your host.
function resolveSsl(): false | { rejectUnauthorized: false } {
  const flag = process.env.DATABASE_SSL;
  if (flag === 'true') return { rejectUnauthorized: false };
  if (flag === 'false') return false;
  return isLocalDatabase() ? false : { rejectUnauthorized: false };
}

// ─── Tests must never reach a real clinical database ─────────────────────────
//
// Every `*.int.test.ts` suite gates itself on `SELECT 1` succeeding and skips if
// it fails. That check was written for "the developer has no local Postgres
// running", and it inverts against a remote DATABASE_URL: production always
// answers, so the suites run in full — against live patient data.
//
// On 2026-08-25 a plain `npm test` did exactly that, writing 21 fixture rows
// into production (clients, appointments, conversations, protocols, supplements)
// plus 96 audit_log rows that are append-only by contract and cannot be taken
// back. Killing the run mid-flight orphaned the rest, because the suites' own
// cleanup never got to run.
//
// scripts/prod-db.sh already treats "point at production" as a deliberate act
// that must be spelled out. This is the same rule for the test runner: under
// vitest, a non-local DATABASE_URL yields a pool that refuses every query, so
// the existing `SELECT 1` guards see a failure and skip — the behaviour they
// were always meant to have. Unit suites are untouched; they mock the DB.
//
// Set ALLOW_REMOTE_TEST_DB=true to override for a run you actually intend.
/** Exported so the rule itself is testable — the decision is the safety
 *  property here, and it is otherwise only observable by connecting. */
export function shouldRefuseRemoteTestDb(env: NodeJS.ProcessEnv = process.env): boolean {
  const underTest = env.VITEST === 'true' || env.VITEST === '1';
  if (!underTest) return false;
  if (env.ALLOW_REMOTE_TEST_DB === 'true') return false;
  return !isLocalDatabase(env.DATABASE_URL ?? '');
}

const remoteTestDbRefused = shouldRefuseRemoteTestDb();

function refuseRemoteTestDb(): never {
  throw new Error(
    `Refusing to run tests against non-local DATABASE_URL (${databaseHost()}). ` +
      'Integration suites write and delete rows; against production that is real ' +
      'clinical data. Point DATABASE_URL at a local Postgres, or set ' +
      'ALLOW_REMOTE_TEST_DB=true if you genuinely mean to.',
  );
}

/** Stands in for the Pool under vitest when DATABASE_URL is not local. Rejects
 *  rather than throwing synchronously, so the suites' `.catch(() => false)`
 *  guards see an ordinary failed query and skip instead of crashing the run. */
const refusingPool = {
  query: () => Promise.reject(new Error(refusalMessage())),
  connect: () => Promise.reject(new Error(refusalMessage())),
  end: () => Promise.resolve(),
  on: () => refusingPool,
};

function refusalMessage(): string {
  try {
    refuseRemoteTestDb();
  } catch (err) {
    return (err as Error).message;
  }
}

if (remoteTestDbRefused) {
  console.error(
    `\n  ⚠ DB-backed suites will SKIP: DATABASE_URL points at ${databaseHost()}, not localhost.\n` +
      '    Integration tests write to whatever they connect to. Use a local Postgres,\n' +
      '    or set ALLOW_REMOTE_TEST_DB=true to override.\n',
  );
}

export const pool = remoteTestDbRefused
  ? (refusingPool as unknown as Pool)
  : new Pool({
      connectionString: process.env.DATABASE_URL,
      max: Number(process.env.PG_POOL_MAX ?? 10),
      ssl: resolveSsl(),
    });

if (!remoteTestDbRefused) {
  pool.on('error', (err) => {
    // Idle client errors shouldn't crash the process.
    console.error('Unexpected idle pg client error', err);
  });
}

/** Thin helper for one-off parameterized queries against the pool. */
export function query<T extends QueryResultRow = QueryResultRow>(
  text: string,
  params?: unknown[],
) {
  return pool.query<T>(text, params);
}
