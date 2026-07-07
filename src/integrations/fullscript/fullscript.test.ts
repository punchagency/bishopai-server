import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { sendBulkRefillOrders, type RefillOrderLine } from './index';
import type { FullscriptClient, PlanRecommendation } from './client';

// Unit test for the bulk-send orchestration with an injected Fullscript client
// (no network/DB). Toggles OAuth config via env for dry-run vs live.

const line = (
  orderId: string,
  email: string | null,
  supplement: string,
  dose?: string,
  qty?: number,
): RefillOrderLine => ({
  orderId,
  clientName: `Maya Chen`,
  clientEmail: email,
  supplementName: supplement,
  dose,
  qty,
});

interface Calls {
  find: string[];
  create: string[];
  variants: string[];
  plans: { patientId: string; recs: PlanRecommendation[]; metadataId?: string }[];
}

function fakeClient(over: Partial<FullscriptClient> = {}): { client: FullscriptClient; calls: Calls } {
  const calls: Calls = { find: [], create: [], variants: [], plans: [] };
  const client: FullscriptClient = {
    async findPatientByEmail(email) {
      calls.find.push(email);
      return null; // default: not found → will create
    },
    async createPatient(p) {
      calls.create.push(p.email);
      return `pat_${p.email}`;
    },
    async findVariantId(name) {
      calls.variants.push(name);
      return `var_${name}`;
    },
    async createTreatmentPlan(patientId, recs, o) {
      calls.plans.push({ patientId, recs, metadataId: o?.metadataId });
      return { planId: `tp_${patientId}`, invitationUrl: `https://fs/plan/${patientId}` };
    },
    async listRecentSupplements() {
      return [];
    },
    ...over,
  };
  return { client, calls };
}

describe('sendBulkRefillOrders', () => {
  const saved = { ...process.env };
  beforeEach(() => {
    delete process.env.FULLSCRIPT_CLIENT_ID;
    delete process.env.FULLSCRIPT_CLIENT_SECRET;
    delete process.env.FULLSCRIPT_REFRESH_TOKEN;
  });
  afterEach(() => {
    process.env = { ...saved };
  });

  const configure = () => {
    process.env.FULLSCRIPT_CLIENT_ID = 'cid';
    process.env.FULLSCRIPT_CLIENT_SECRET = 'csecret';
    process.env.FULLSCRIPT_REFRESH_TOKEN = 'rtok';
  };

  it('dry-runs (synthetic ids) when OAuth is not configured', async () => {
    const res = await sendBulkRefillOrders([line('o1', 'a@x.com', 'Mag')]);
    expect(res).toEqual([{ orderId: 'o1', ok: true, fullscriptPlanId: 'dry-run-o1' }]);
  });

  it('creates one plan per patient with a recommendation per supplement', async () => {
    configure();
    const { client, calls } = fakeClient();
    const res = await sendBulkRefillOrders(
      [
        line('o1', 'maya@x.com', 'Magnesium', '2 caps nightly', 60),
        line('o2', 'maya@x.com', 'B-complex'), // same patient → same plan, 2 recs
        line('o3', 'david@x.com', 'Omega-3'),
        line('o4', null, 'Zinc'), // no email → fails
      ],
      { client, batchId: 'batch-1' },
    );

    // One patient created per unique email; one plan each.
    expect(calls.create.sort()).toEqual(['david@x.com', 'maya@x.com']);
    expect(calls.plans).toHaveLength(2);
    const maya = calls.plans.find((p) => p.patientId === 'pat_maya@x.com')!;
    expect(maya.recs.map((r) => r.variantId).sort()).toEqual(['var_B-complex', 'var_Magnesium']);
    expect(maya.metadataId).toBe('batch-1');

    // Dose/qty wired into the recommendation: one bottle + structured dosage.
    const magRec = maya.recs.find((r) => r.variantId === 'var_Magnesium')!;
    expect(magRec.unitsToPurchase).toBe(1);
    expect(magRec.dosage).toEqual({
      amount: '2',
      frequency: 'every night',
      format: 'capsule',
      duration: '30',
      time_of_day: ['bedtime'],
    });
    // A line with no dose text carries no dosage.
    expect(maya.recs.find((r) => r.variantId === 'var_B-complex')!.dosage).toBeUndefined();

    const byId = Object.fromEntries(res.map((r) => [r.orderId, r]));
    expect(byId.o1).toMatchObject({ ok: true, fullscriptPlanId: 'tp_pat_maya@x.com', invitationUrl: 'https://fs/plan/pat_maya@x.com' });
    expect(byId.o2.ok).toBe(true);
    expect(byId.o3).toMatchObject({ ok: true, fullscriptPlanId: 'tp_pat_david@x.com' });
    expect(byId.o4).toMatchObject({ ok: false, error: 'no client email on file' });
  });

  it('reuses an existing patient instead of creating one', async () => {
    configure();
    const { client, calls } = fakeClient({ async findPatientByEmail() { return 'existing-pat'; } });
    await sendBulkRefillOrders([line('o1', 'maya@x.com', 'Mag')], { client });
    expect(calls.create).toEqual([]); // not created
    expect(calls.plans[0].patientId).toBe('existing-pat');
  });

  it('fails only the line whose supplement has no catalog match', async () => {
    configure();
    const { client } = fakeClient({
      async findVariantId(name) {
        return name === 'Unobtanium' ? null : `var_${name}`;
      },
    });
    const res = await sendBulkRefillOrders(
      [line('o1', 'maya@x.com', 'Magnesium'), line('o2', 'maya@x.com', 'Unobtanium')],
      { client },
    );
    const byId = Object.fromEntries(res.map((r) => [r.orderId, r]));
    expect(byId.o1.ok).toBe(true);
    expect(byId.o2).toMatchObject({ ok: false, error: 'no Fullscript product match for "Unobtanium"' });
  });

  it('fails a patient cleanly when plan creation throws', async () => {
    configure();
    const { client } = fakeClient({ async createTreatmentPlan() { throw new Error('fullscript 422'); } });
    const res = await sendBulkRefillOrders(
      [line('o1', 'maya@x.com', 'Magnesium'), line('o2', 'maya@x.com', 'B-complex')],
      { client },
    );
    expect(res.every((r) => !r.ok)).toBe(true);
    expect(res[0].error).toBe('fullscript 422');
  });
});
