import 'dotenv/config';
import { pool } from './src/db/pool';
import { projectRefills } from './src/refills/project';

async function main() {
  await pool.query(`DELETE FROM refill_orders`);
  await pool.query(`DELETE FROM refills`);
  await pool.query(`DELETE FROM supplements`);
  await pool.query(`DELETE FROM clients WHERE name LIKE 'SMOKE %'`);

  const c1 = (await pool.query(`INSERT INTO clients (name) VALUES ('SMOKE Maya') RETURNING id`)).rows[0].id;
  const c2 = (await pool.query(`INSERT INTO clients (name) VALUES ('SMOKE David') RETURNING id`)).rows[0].id;

  const start = new Date(Date.now() - 20 * 864e5).toISOString().slice(0, 10);
  await pool.query(
    `INSERT INTO supplements (client_id, name, dose, qty, start_date) VALUES ($1,'Magnesium glycinate','2 caps daily',60,$2)`,
    [c1, start],
  );
  const start2 = new Date(Date.now() - 45 * 864e5).toISOString().slice(0, 10);
  await pool.query(
    `INSERT INTO supplements (client_id, name, dose, qty, start_date) VALUES ($1,'B-complex','1 tab daily',30,$2)`,
    [c2, start2],
  );
  await pool.query(
    `INSERT INTO supplements (client_id, name, dose, qty, start_date) VALUES ($1,'Omega-3','1 softgel daily',NULL,$2)`,
    [c1, start],
  );

  console.log('projection:    ', await projectRefills());
  console.log('re-projection: ', await projectRefills()); // idempotent

  const digest = await pool.query(
    `SELECT c.name, s.name AS supp, rf.due_date, (rf.due_date - current_date) AS days_left, rf.status
       FROM refills rf JOIN clients c ON c.id=rf.client_id JOIN supplements s ON s.id=rf.supplement_id
      ORDER BY rf.due_date`,
  );
  console.log('refills after projection:');
  for (const r of digest.rows) {
    const due = r.due_date instanceof Date ? r.due_date.toISOString().slice(0, 10) : r.due_date;
    console.log('   ', r.name, '|', r.supp, '| due', due, '| days_left', r.days_left, '|', r.status);
  }
  console.log('refill row count:', (await pool.query('SELECT count(*) FROM refills')).rows[0].count);

  await pool.end();
}
main().catch((e) => { console.error(e); process.exit(1); });
