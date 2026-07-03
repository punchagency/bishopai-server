import 'dotenv/config';
import { Pool, type QueryResultRow } from 'pg';

if (!process.env.DATABASE_URL) {
  throw new Error('DATABASE_URL is not set (see .env.example)');
}

// Managed Postgres (Heroku, Railway, most cloud providers) requires TLS and
// presents a self-signed cert chain, so we connect with SSL but don't verify the
// chain. Auto-enable for any non-local DATABASE_URL; override with DATABASE_SSL
// ('true'/'false') if the heuristic is wrong for your host.
function resolveSsl(): false | { rejectUnauthorized: false } {
  const flag = process.env.DATABASE_SSL;
  if (flag === 'true') return { rejectUnauthorized: false };
  if (flag === 'false') return false;
  const isLocal = /@(localhost|127\.0\.0\.1|\[::1\])[:/]/.test(process.env.DATABASE_URL ?? '');
  return isLocal ? false : { rejectUnauthorized: false };
}

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: Number(process.env.PG_POOL_MAX ?? 10),
  ssl: resolveSsl(),
});

pool.on('error', (err) => {
  // Idle client errors shouldn't crash the process.
  console.error('Unexpected idle pg client error', err);
});

/** Thin helper for one-off parameterized queries against the pool. */
export function query<T extends QueryResultRow = QueryResultRow>(
  text: string,
  params?: unknown[],
) {
  return pool.query<T>(text, params);
}
