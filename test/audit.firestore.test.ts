import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import {
  emulatorUp,
  installFirestore,
  uninstallFirestore,
  clearFirestore,
} from './firestore';
import type { IDatabase } from '../src/db/interfaces/repositories';

const up = await emulatorUp();
const suite = up ? describe : describe.skip;
if (!up) {
  console.log('[audit.firestore] Firestore emulator not running — skipping. Start: npm run firestore:emulator');
}

let recordAudit: typeof import('../src/audit/log')['recordAudit'];
let auditForEntity: typeof import('../src/audit/log')['auditForEntity'];
let recentActivity: typeof import('../src/audit/log')['recentActivity'];

suite('audit/log against Firestore', () => {
  let db: IDatabase;

  beforeAll(async () => {
    db = installFirestore('audit');
    const mod = await import('../src/audit/log');
    recordAudit = mod.recordAudit;
    auditForEntity = mod.auditForEntity;
    recentActivity = mod.recentActivity;
  });

  afterAll(() => uninstallFirestore());
  beforeEach(async () => {
    await clearFirestore(db);
  });

  it('writes an entry with the flat 0024 columns', async () => {
    await recordAudit({
      entityType: 'checkout',
      entityId: 'chk-1',
      action: 'checkout.approved',
      actor: 'nicole',
      summary: 'Approved charge of $120.00',
      metadata: { total_cents: 12000 },
    });

    const rows = await auditForEntity('checkout', 'chk-1');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      entity_type: 'checkout',
      entity_id: 'chk-1',
      action: 'checkout.approved',
      actor: 'nicole',
      summary: 'Approved charge of $120.00',
    });
    expect(rows[0].metadata).toEqual({ total_cents: 12000 });
  });

  it("defaults the actor to 'system' when unattributed", async () => {
    await recordAudit({
      entityType: 'refill',
      entityId: 'rf-1',
      action: 'refill.projected',
      summary: 'Nightly projection',
    });
    const [row] = await auditForEntity('refill', 'rf-1');
    expect(row.actor).toBe('system');
  });

  it('returns an entity trail newest-first, honouring the limit', async () => {
    for (let i = 0; i < 5; i++) {
      await recordAudit({
        entityType: 'session',
        entityId: 'appt-1',
        action: `session.step${i}`,
        summary: `step ${i}`,
      });
    }

    const all = await auditForEntity('session', 'appt-1');
    expect(all).toHaveLength(5);
    const times = all.map((r) => r.created_at);
    expect([...times].sort().reverse()).toEqual(times);

    expect(await auditForEntity('session', 'appt-1', 2)).toHaveLength(2);
  });

  it('scopes the entity trail to the entity', async () => {
    await recordAudit({ entityType: 'session', entityId: 'appt-1', action: 'a', summary: 'a' });
    await recordAudit({ entityType: 'session', entityId: 'appt-2', action: 'b', summary: 'b' });
    await recordAudit({ entityType: 'client', entityId: 'appt-1', action: 'c', summary: 'c' });

    const rows = await auditForEntity('session', 'appt-1');
    expect(rows).toHaveLength(1);
    expect(rows[0].action).toBe('a');
  });

  it('feeds the global activity list, optionally filtered by type', async () => {
    await recordAudit({ entityType: 'session', entityId: 's1', action: 'a', summary: 'a' });
    await recordAudit({ entityType: 'checkout', entityId: 'c1', action: 'b', summary: 'b' });
    await recordAudit({ entityType: 'checkout', entityId: 'c2', action: 'c', summary: 'c' });

    expect(await recentActivity(100)).toHaveLength(3);
    const checkouts = await recentActivity(100, 'checkout');
    expect(checkouts).toHaveLength(2);
    expect(checkouts.every((r) => r.entity_type === 'checkout')).toBe(true);
  });

  // An audit write must never take down the business operation that triggered it.
  it('swallows a write failure instead of throwing to the caller', async () => {
    const spy = vi.spyOn(db.audit, 'log').mockRejectedValueOnce(new Error('backend down'));
    await expect(
      recordAudit({ entityType: 'task', entityId: 't1', action: 'task.done', summary: 'done' }),
    ).resolves.toBeUndefined();
    spy.mockRestore();
  });

  // Append-only by contract: "an audit you can rewrite isn't one."
  it('refuses to overwrite an existing entry', async () => {
    const entry = {
      id: 'audit_fixed_id',
      entity_type: 'client',
      entity_id: 'client-a',
      action: 'client.created',
      actor: 'system',
      summary: 'first write',
      metadata: null,
      created_at: new Date().toISOString(),
    };
    await db.audit.log(entry);
    await expect(db.audit.log({ ...entry, summary: 'rewritten' })).rejects.toThrow();

    const rows = await auditForEntity('client', 'client-a');
    expect(rows).toHaveLength(1);
    expect(rows[0].summary).toBe('first write');
  });
});
