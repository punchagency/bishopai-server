import { pool } from './pool';

// Tiny key/value accessor over `integration_state` — for integration sync
// cursors (e.g. the Outlook inbox poller). Kept trivial on purpose.

export async function getState(key: string): Promise<string | null> {
  const r = await pool.query<{ value: string | null }>(
    `SELECT value FROM integration_state WHERE key = $1`,
    [key],
  );
  return r.rows[0]?.value ?? null;
}

export async function setState(key: string, value: string): Promise<void> {
  await pool.query(
    `INSERT INTO integration_state (key, value) VALUES ($1, $2)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
    [key, value],
  );
}

export async function delState(key: string): Promise<void> {
  await pool.query(`DELETE FROM integration_state WHERE key = $1`, [key]);
}
