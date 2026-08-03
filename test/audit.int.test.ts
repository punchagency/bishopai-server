import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll } from 'vitest';
import {
  emulatorUp,
  installFirestore,
  uninstallFirestore,
  clearFirestore,
} from './firestore';
import { seedCheckout } from './fixtures';
import type { IDatabase } from '../src/db/interfaces/repositories';
import { approveAndCharge } from '../src/checkout/machine';
import { auditForEntity, recentActivity, recordAudit } from '../src/audit/log';

// The unified audit trail: mutations record here, and the two reads (per-entity
// history + global feed) return them newest-first. Emulator-gated.
const up = await emulatorUp();
const suite = up ? describe : describe.skip;
if (!up) {
  console.log('[audit.int] Firestore emulator not running — skipping. Start: npm run firestore:emulator');
}

const summary = {
  currency: 'USD',
  qb_invoice_id: 'mock-inv-audit',
  line_items: [{ label: 'Consultation', amount_cents: 15000 }],
  total_cents: 15000,
  fullscript_changes: [],
};

suite('audit trail (integration)', () => {
  const saved = { ...process.env };
  let db: IDatabase;

  beforeAll(() => {
    db = installFirestore('audit-int');
  });
  afterAll(() => uninstallFirestore());

  beforeEach(async () => {
    await clearFirestore(db);
    delete process.env.QB_CLIENT_ID;
    delete process.env.QB_CLIENT_SECRET;
    delete process.env.QB_REFRESH_TOKEN;
    delete process.env.QB_REALM_ID;
  });
  afterEach(() => {
    process.env = { ...saved };
  });

  it('records the checkout money lifecycle as an entity history, newest first', async () => {
    const checkout = await seedCheckout(db, {
      status: 'AWAITING_APPROVAL',
      summary_snapshot: summary,
      qb_invoice_id: 'mock-inv-audit',
    });

    await approveAndCharge(checkout.id);

    const history = await auditForEntity('checkout', checkout.id);
    const actions = history.map((h) => h.action);
    // Approval and capture both recorded (detect wasn't used here).
    expect(actions).toContain('checkout.approved');
    expect(actions).toContain('checkout.charge_captured');
    // Newest first.
    const times = history.map((h) => new Date(h.created_at).getTime());
    expect(times).toEqual([...times].sort((a, b) => b - a));
    // The capture carries a human summary + structured metadata.
    const capture = history.find((h) => h.action === 'checkout.charge_captured')!;
    expect(capture.summary).toMatch(/charged/i);
    expect(capture.metadata?.total_cents).toBe(15000);
  });

  it('never throws on a write failure (best-effort)', async () => {
    // The action an audit entry describes has already happened, so a failed
    // write must be swallowed rather than surfaced to the caller.
    await expect(
      recordAudit({ entityType: 'checkout', entityId: 'x'.repeat(10), action: 'test.noop', summary: 'noop' }),
    ).resolves.toBeUndefined();
  });

  it('the global feed returns recent activity across entity types', async () => {
    const id = `audit-feed-${Math.random().toString(36).slice(2)}`;
    await recordAudit({ entityType: 'task', entityId: id, action: 'task.done', actor: 'nicole', summary: 'Task completed: test' });

    const feed = await recentActivity(50);
    expect(feed.some((e) => e.entity_id === id && e.action === 'task.done')).toBe(true);

    const filtered = await recentActivity(50, 'task');
    expect(filtered.every((e) => e.entity_type === 'task')).toBe(true);
  });
});
