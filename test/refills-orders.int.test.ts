import { describe, it, expect, afterEach, afterAll, beforeAll } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApp } from '../src/app';
import { pool } from '../src/db/pool';
import { updateAuthConfig } from '../src/auth/service';

const dbUp = await pool
  .query('SELECT 1')
  .then(() => true)
  .catch(() => false);

const suite = dbUp ? describe : describe.skip;

suite('POST /refills/orders (email-based notifications)', () => {
  let server: http.Server;
  let base = '';
  const clientIds: string[] = [];

  const newClient = async (name: string, email: string | null) => {
    const res = await pool.query<{ id: string }>(
      `INSERT INTO clients (name, email) VALUES ($1, $2) RETURNING id`,
      [name, email]
    );
    clientIds.push(res.rows[0].id);
    return res.rows[0].id;
  };

  const newSupplement = async (clientId: string, name: string) => {
    const res = await pool.query<{ id: string }>(
      `INSERT INTO supplements (client_id, name, dose, qty, source) VALUES ($1, $2, '1 cap daily', 30, 'notes') RETURNING id`,
      [clientId, name]
    );
    return res.rows[0].id;
  };

  const newRefill = async (clientId: string, supplementId: string) => {
    const res = await pool.query<{ id: string }>(
      `INSERT INTO refills (client_id, supplement_id, due_date, status) VALUES ($1, $2, current_date - 1, 'pending') RETURNING id`,
      [clientId, supplementId]
    );
    return res.rows[0].id;
  };

  beforeAll(async () => {
    await updateAuthConfig({ enabled: false });
    server = http.createServer(createApp());
    await new Promise<void>((r) => server.listen(0, r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    await pool.query(`DELETE FROM refill_orders WHERE client_id = ANY($1::uuid[])`, [clientIds]);
    for (const id of clientIds) {
      await pool.query(`DELETE FROM clients WHERE id = $1`, [id]);
    }
    clientIds.length = 0;
  });

  afterAll(async () => {
    await new Promise<void>((r) => server.close(() => r()));
    await pool.end();
  });

  it('groups multiple refills for the same client and sends one email', async () => {
    const cId = await newClient('Alice Test', 'alice@test.com');
    const s1 = await newSupplement(cId, 'Vitamin D');
    const s2 = await newSupplement(cId, 'Zinc');
    const r1 = await newRefill(cId, s1);
    const r2 = await newRefill(cId, s2);

    const res = await fetch(`${base}/refills/orders`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ refill_ids: [r1, r2], approved_by: 'nicole' }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.sent).toBe(2);
    expect(body.failed).toBe(0);
    expect(body.results.length).toBe(2);

    // Verify both items in response are marked as ok
    expect(body.results[0].ok).toBe(true);
    expect(body.results[1].ok).toBe(true);

    // Verify refills status updated to notified
    const refills = await pool.query<{ status: string }>(
      `SELECT status FROM refills WHERE id = ANY($1::uuid[])`,
      [[r1, r2]]
    );
    expect(refills.rows[0].status).toBe('notified');
    expect(refills.rows[1].status).toBe('notified');

    // Verify refill_orders created
    const orders = await pool.query<{ status: string; invitation_url: string }>(
      `SELECT status, invitation_url FROM refill_orders WHERE batch_id = $1`,
      [body.batch_id]
    );
    expect(orders.rowCount).toBe(2);
    expect(orders.rows[0].status).toBe('sent');
    expect(orders.rows[0].invitation_url).toContain('fullscript.com');
  });

  it('fails refills for clients with no email address on file', async () => {
    const cId = await newClient('No Email Client', null);
    const s1 = await newSupplement(cId, 'Vitamin C');
    const r1 = await newRefill(cId, s1);

    const res = await fetch(`${base}/refills/orders`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ refill_ids: [r1] }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.sent).toBe(0);
    expect(body.failed).toBe(1);
    expect(body.results[0].ok).toBe(false);
    expect(body.results[0].error).toBe('no client email on file');

    // Verify refills status remains pending
    const refills = await pool.query<{ status: string }>(
      `SELECT status FROM refills WHERE id = $1`,
      [r1]
    );
    expect(refills.rows[0].status).toBe('pending');
  });
});
