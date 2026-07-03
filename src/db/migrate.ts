import fs from 'node:fs';
import path from 'node:path';
import { pool } from './pool';

// Plain .sql files, applied in filename order, each in its own transaction.
// Applied filenames are recorded so re-running is a no-op.
const MIGRATIONS_DIR = path.join(__dirname, '..', '..', 'migrations');

async function migrate(): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        filename   text PRIMARY KEY,
        applied_at timestamptz NOT NULL DEFAULT now()
      );
    `);

    const { rows } = await client.query<{ filename: string }>(
      'SELECT filename FROM schema_migrations',
    );
    const applied = new Set(rows.map((r) => r.filename));

    const files = fs
      .readdirSync(MIGRATIONS_DIR)
      .filter((f) => f.endsWith('.sql'))
      .sort();

    let count = 0;
    for (const file of files) {
      if (applied.has(file)) continue;
      const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');
      process.stdout.write(`Applying ${file} ... `);
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (filename) VALUES ($1)', [file]);
        await client.query('COMMIT');
        console.log('ok');
        count++;
      } catch (err) {
        await client.query('ROLLBACK');
        console.log('FAILED');
        throw err;
      }
    }
    console.log(count === 0 ? 'Already up to date.' : `Applied ${count} migration(s).`);
  } finally {
    client.release();
    await pool.end();
  }
}

migrate().catch((err) => {
  console.error(err);
  process.exit(1);
});
