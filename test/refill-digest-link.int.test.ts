import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomUUID } from 'node:crypto';
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

// Integration: the refill digest surfaces the persisted Fullscript invitation
// link (the latest 'sent' refill_order for the refill), so it survives a reload
// — not just the transient send response. Emulator-gated.
const up = await emulatorUp();
const suite = up ? describe : describe.skip;
if (!up) {
  console.log('[refill-digest-link.int] Firestore emulator not running — skipping. Start: npm run firestore:emulator');
}

const PB = 'dtest-client';
const LINK = 'https://api-us-snd.fullscript.io/users/universal/magic_link?redirect_path=xyz';

suite('refill digest — persisted Fullscript link (integration)', () => {
  let server: http.Server;
  let base = '';
  let refillId = '';
  let db: IDatabase;

  beforeAll(async () => {
    db = installFirestore('refill-digest-link-int');
    await clearFirestore(db);
    await updateAuthConfig({ enabled: false });

    const client = await seedClient(db, { name: 'D Test', pb_id: PB, email: 'd@test' });
    const supplement = await seedSupplement(db, {
      client_id: client.id,
      name: 'Magnesium',
      dose: '2 caps nightly',
      qty: 60,
    });
    const refill = await seedRefill(db, {
      client_id: client.id,
      client_name: client.name,
      supplement_id: supplement.id,
      supplement_name: supplement.name,
      // Yesterday — overdue, so it is definitely in the open digest.
      due_date: new Date(Date.now() - 86_400_000).toISOString().slice(0, 10),
      status: 'notified',
    });
    refillId = refill.id;

    // A prior successful send persisted the plan link on the refill_order.
    const now = new Date().toISOString();
    await db.refills.saveOrder({
      id: randomUUID(),
      batch_id: randomUUID(),
      client_id: client.id,
      refill_id: refillId,
      supplement_name: 'Magnesium',
      status: 'sent',
      fullscript_order_id: 'tp_123',
      invitation_url: LINK,
      sent_at: now,
      created_at: now,
    });

    server = http.createServer(createApp());
    await new Promise<void>((r) => server.listen(0, r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await clearFirestore(db);
    await new Promise<void>((r) => server.close(() => r()));
    uninstallFirestore();
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
