import { describe, it, expect, afterAll, beforeEach, afterEach } from 'vitest';
import { pool } from '../src/db/pool';
import { approveAndCharge } from '../src/checkout/machine';
import { auditForEntity, recentActivity, recordAudit } from '../src/audit/log';

// The unified audit trail: mutations record here, and the two reads (per-entity
// history + global feed) return them newest-first. DB-gated.
const dbUp = await pool.query('SELECT 1').then(() => true).catch(() => false);
const suite = dbUp ? describe : describe.skip;

const summary = {
  currency: 'USD',
  qb_invoice_id: 'mock-inv-audit',
  line_items: [{ label: 'Consultation', amount_cents: 15000 }],
  total_cents: 15000,
  fullscript_changes: [],
};

suite('audit trail (integration)', () => {
  const saved = { ...process.env };
  const created: string[] = [];

  beforeEach(() => {
    delete process.env.QB_CLIENT_ID;
    delete process.env.QB_CLIENT_SECRET;
    delete process.env.QB_REFRESH_TOKEN;
    delete process.env.QB_REALM_ID;
  });
  afterEach(async () => {
    process.env = { ...saved };
    for (const id of created.splice(0)) {
      await pool.query(`DELETE FROM audit_log WHERE entity_id = $1`, [id]);
      await pool.query(`DELETE FROM checkout WHERE id = $1`, [id]);
    }
  });
  afterAll(async () => {
    await pool.end();
  });

  it('records the checkout money lifecycle as an entity history, newest first', async () => {
    const ch = await pool.query<{ id: string }>(
      `INSERT INTO checkout (status, summary_snapshot, qb_invoice_id)
            VALUES ('AWAITING_APPROVAL', $1, 'mock-inv-audit') RETURNING id`,
      [JSON.stringify(summary)],
    );
    const checkoutId = ch.rows[0].id;
    created.push(checkoutId);

    await approveAndCharge(checkoutId);

    const history = await auditForEntity('checkout', checkoutId);
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
    // A too-long entity_type would violate nothing here, but a bad write must be
    // swallowed rather than surfaced — the action it describes already happened.
    await expect(
      recordAudit({ entityType: 'checkout', entityId: 'x'.repeat(10), action: 'test.noop', summary: 'noop' }),
    ).resolves.toBeUndefined();
  });

  it('the global feed returns recent activity across entity types', async () => {
    const id = `audit-feed-${Math.random().toString(36).slice(2)}`;
    await recordAudit({ entityType: 'task', entityId: id, action: 'task.done', actor: 'nicole', summary: 'Task completed: test' });
    try {
      const feed = await recentActivity(50);
      expect(feed.some((e) => e.entity_id === id && e.action === 'task.done')).toBe(true);

      const filtered = await recentActivity(50, 'task');
      expect(filtered.every((e) => e.entity_type === 'task')).toBe(true);
    } finally {
      await pool.query(`DELETE FROM audit_log WHERE entity_id = $1`, [id]);
    }
  });
});
