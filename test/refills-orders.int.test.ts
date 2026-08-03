import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApp } from '../src/app';
import {
  emulatorUp,
  installFirestore,
  uninstallFirestore,
  clearFirestore,
} from './firestore';
import { seedClient, seedRefill, seedSupplement } from './fixtures';
import type { IDatabase } from '../src/db/interfaces/repositories';
import { updateAuthConfig } from '../src/auth/service';

const up = await emulatorUp();
const suite = up ? describe : describe.skip;
if (!up) {
  console.log('[refills-orders.int] Firestore emulator not running - skipping. Start: npm run firestore:emulator');
}

suite('POST /refills/orders (email-based notifications)', () => {
  let server: http.Server;
  let base = '';
  let db: IDatabase;

  const newClient = (name: string, email: string | null) =>
    seedClient(db, { name, email: email ?? '' }).then((c) => c.id);

  const newSupplement = (clientId: string, name: string) =>
    seedSupplement(db, { client_id: clientId, name, dose: '1 cap daily', qty: 30 }).then((s) => s.id);

  const newRefill = (clientId: string, supplementId: string, supplementName: string) =>
    seedRefill(db, {
      client_id: clientId,
      supplement_id: supplementId,
      supplement_name: supplementName,
      due_date: new Date(Date.now() - 86_400_000).toISOString().slice(0, 10),
      status: 'pending',
    }).then((r) => r.id);

  beforeAll(async () => {
    db = installFirestore('refills-orders-int');
    await updateAuthConfig({ enabled: false });
    server = http.createServer(createApp());
    await new Promise<void>((r) => server.listen(0, r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  beforeEach(async () => {
    await clearFirestore(db);
  });

  afterAll(async () => {
    await new Promise<void>((r) => server.close(() => r()));
    uninstallFirestore();
  });

  it('groups multiple refills for the same client and sends one email', async () => {
    const cId = await newClient('Alice Test', 'alice@test.com');
    const s1 = await newSupplement(cId, 'Vitamin D');
    const s2 = await newSupplement(cId, 'Zinc');
    const r1 = await newRefill(cId, s1, 'Vitamin D');
    const r2 = await newRefill(cId, s2, 'Zinc');

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
    expect(body.results[0].ok).toBe(true);
    expect(body.results[1].ok).toBe(true);

    // Both refills moved to notified.
    for (const id of [r1, r2]) {
      expect((await db.refills.findById(id))!.status).toBe('notified');
    }

    // And one refill_order per refill, under the one batch.
    const orders = (await db.refills.listOrdersForRefills([r1, r2])).filter(
      (o) => o.batch_id === body.batch_id,
    );
    expect(orders).toHaveLength(2);
    expect(orders[0].status).toBe('sent');
    expect(orders[0].invitation_url).toContain('fullscript.com');
  });

  it('fails refills for clients with no email address on file', async () => {
    const cId = await newClient('No Email Client', null);
    const s1 = await newSupplement(cId, 'Vitamin C');
    const r1 = await newRefill(cId, s1, 'Vitamin C');

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

    // The refill stays pending - a failed send must not mark it notified.
    expect((await db.refills.findById(r1))!.status).toBe('pending');
  });
});
