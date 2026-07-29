import { getDatabase } from '../db/index.js';

// client → QuickBooks Online Customer.Id mapping. QBO has no notion of a Practice
// Better client, so reconciliation needs this bridge to know which customer a
// Payment belongs to. Populated per client (one-time sync or manual); a missing
// mapping in live mode dead-letters the reconciliation for a human rather than
// guessing the wrong customer.

export async function resolveQboCustomerId(clientId: string | null | undefined): Promise<string | null> {
  if (!clientId) return null;
  // Document id == client_id, which was the primary key in Postgres.
  const map = await getDatabase().checkouts.findQboMapByClient(clientId);
  return map?.qbo_customer_id ?? null;
}

export async function setQboCustomerId(clientId: string, qboCustomerId: string): Promise<void> {
  const db = getDatabase();
  const existing = await db.checkouts.findQboMapByClient(clientId);
  const now = new Date().toISOString();
  await db.checkouts.saveQboMap({
    client_id: clientId,
    qbo_customer_id: qboCustomerId,
    created_at: existing?.created_at ?? now,
    updated_at: now,
  });
}
