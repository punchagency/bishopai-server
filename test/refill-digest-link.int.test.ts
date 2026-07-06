import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApp } from '../src/app';
import { pool } from '../src/db/pool';
import { updateAuthConfig } from '../src/auth/service';

// Integration: the refill digest surfaces the persisted Fullscript invitation
// link (via the lateral join to the latest sent refill_order), so it survives a
// reload — not just the transient send response. DB-gated.
const dbUp = await pool
  .query('SELECT 1')
  .then(() => true)
  .catch(() => false);

const suite = dbUp ? describe : describe.skip;
const PB = 'dtest-client';
const LINK = 'https://api-us-snd.fullscript.io/users/universal/magic_link?redirect_path=xyz';

suite('refill digest — persisted Fullscript link (integration)', () => {
  let server: http.Server;
  let base = '';
  let refillId = '';

  const cleanup = async () => {
    await pool.query(`DELETE FROM refill_orders WHERE client_id IN (SELECT id FROM clients WHERE pb_id = $1)`, [PB]).catch(() => {});
    await pool.query(`DELETE FROM clients WHERE pb_id = $1`, [PB]).catch(() => {}); // cascades supplements/refills
  };

  beforeAll(async () => {
    await updateAuthConfig({ enabled: false });
    await cleanup();
    const c = await pool.query<{ id: string }>(`INSERT INTO clients (name, pb_id, email) VALUES ('D Test', $1, 'd@test') RETURNING id`, [PB]);
    const clientId = c.rows[0].id;
    const s = await pool.query<{ id: string }>(
      `INSERT INTO supplements (client_id, name, dose, qty, source) VALUES ($1, 'Magnesium', '2 caps nightly', 60, 'notes') RETURNING id`,
      [clientId],
    );
    const rf = await pool.query<{ id: string }>(
      `INSERT INTO refills (client_id, supplement_id, due_date, status) VALUES ($1, $2, current_date - 1, 'notified') RETURNING id`,
      [clientId, s.rows[0].id],
    );
    refillId = rf.rows[0].id;
    // A prior successful send persisted the plan link on the refill_order.
    await pool.query(
      `INSERT INTO refill_orders (batch_id, client_id, refill_id, supplement_name, status, fullscript_order_id, invitation_url, sent_at)
            VALUES (gen_random_uuid(), $1, $2, 'Magnesium', 'sent', 'tp_123', $3, now())`,
      [clientId, refillId, LINK],
    );

    server = http.createServer(createApp());
    await new Promise<void>((r) => server.listen(0, r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await cleanup();
    await new Promise<void>((r) => server.close(() => r()));
    await pool.end();
  });

  it('returns the persisted invitation_url + plan id on a fresh digest read', async () => {
    const res = await fetch(`${base}/refills/digest`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { refills: { id: string; invitation_url: string | null; fullscript_plan_id: string | null }[] };
    const item = body.refills.find((r) => r.id === refillId);
    expect(item).toBeDefined();
    expect(item!.invitation_url).toBe(LINK);
    expect(item!.fullscript_plan_id).toBe('tp_123');
  });
});
