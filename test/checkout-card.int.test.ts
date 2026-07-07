import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApp } from '../src/app';
import { pool } from '../src/db/pool';
import { updateAuthConfig } from '../src/auth/service';

// Card capture on the approve flow (Option A — backend tokenizes). Validates the
// card is accepted and threaded through the charge, that a malformed card is
// rejected with no echo, and that the raw PAN never appears in what we return.
// DB-gated.
let dbUp = true;
try {
  await pool.query('SELECT 1');
} catch {
  dbUp = false;
}

const summary = {
  currency: 'USD',
  qb_invoice_id: 'mock-inv-card',
  line_items: [{ label: 'Consultation', amount_cents: 15000 }],
  total_cents: 15000,
  fullscript_changes: [],
};

const validCard = {
  number: '4111111111111111',
  expMonth: '02',
  expYear: '2027',
  cvc: '123',
  name: 'Test User',
};

describe.skipIf(!dbUp)('checkout approve — card capture (integration)', () => {
  let server: http.Server;
  let base = '';
  const created: string[] = [];

  beforeAll(async () => {
    await updateAuthConfig({ enabled: false });
    server = http.createServer(createApp());
    await new Promise<void>((r) => server.listen(0, r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterEach(async () => {
    for (const id of created.splice(0)) await pool.query(`DELETE FROM checkout WHERE id = $1`, [id]);
  });
  afterAll(async () => {
    await new Promise<void>((r) => server.close(() => r()));
  });

  const approve = (id: string, body: unknown) =>
    fetch(`${base}/checkout/${id}/approve`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });

  async function newAwaitingCheckout(): Promise<string> {
    const ch = await pool.query<{ id: string }>(
      `INSERT INTO checkout (status, summary_snapshot, qb_invoice_id)
            VALUES ('AWAITING_APPROVAL', $1, 'mock-inv-card') RETURNING id`,
      [JSON.stringify(summary)],
    );
    created.push(ch.rows[0].id);
    return ch.rows[0].id;
  }

  it('accepts a valid card and completes the charge (dry-run), never echoing the PAN', async () => {
    const id = await newAwaitingCheckout();
    const res = await approve(id, { approved_by: 'nicole', card: validCard });
    expect(res.status).toBe(200);
    const bodyText = await res.text();
    expect(bodyText).not.toContain('4111111111111111'); // PAN must not come back
    expect(JSON.parse(bodyText).status).toBe('PB_MARKED');

    // Charge happened and reconciliation was recorded.
    const recon = await pool.query(`SELECT status FROM payment_reconciliation WHERE checkout_id = $1`, [id]);
    expect(recon.rows[0]?.status).toBe('RECORDED');
  });

  it('rejects a malformed card with 400 and no echo', async () => {
    const id = await newAwaitingCheckout();
    const res = await approve(id, { card: { ...validCard, number: 'not-a-number' } });
    expect(res.status).toBe(400);
    const text = await res.text();
    expect(text).not.toContain('not-a-number');
    // Checkout stays approvable — the bad request didn't move money.
    const ch = await pool.query(`SELECT status FROM checkout WHERE id = $1`, [id]);
    expect(ch.rows[0].status).toBe('AWAITING_APPROVAL');
  });

  it('still works with no card in dry-run (backward compatible)', async () => {
    const id = await newAwaitingCheckout();
    const res = await approve(id, {});
    expect(res.status).toBe(200);
    expect((await res.json()).status).toBe('PB_MARKED');
  });
});
