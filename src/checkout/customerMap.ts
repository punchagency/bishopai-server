import { pool } from '../db/pool';

// client → QuickBooks Online Customer.Id mapping. QBO has no notion of a Practice
// Better client, so reconciliation needs this bridge to know which customer a
// Payment belongs to. Populated per client (one-time sync or manual); a missing
// mapping in live mode dead-letters the reconciliation for a human rather than
// guessing the wrong customer.

export async function resolveQboCustomerId(clientId: string | null | undefined): Promise<string | null> {
  if (!clientId) return null;
  const r = await pool.query<{ qbo_customer_id: string }>(
    `SELECT qbo_customer_id FROM client_qbo_map WHERE client_id = $1`,
    [clientId],
  );
  return r.rows[0]?.qbo_customer_id ?? null;
}

export async function setQboCustomerId(clientId: string, qboCustomerId: string): Promise<void> {
  await pool.query(
    `INSERT INTO client_qbo_map (client_id, qbo_customer_id) VALUES ($1, $2)
     ON CONFLICT (client_id) DO UPDATE SET qbo_customer_id = EXCLUDED.qbo_customer_id`,
    [clientId, qboCustomerId],
  );
}
