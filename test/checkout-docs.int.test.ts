import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import {
  emulatorUp,
  installFirestore,
  uninstallFirestore,
  clearFirestore,
} from './firestore';
import { seedClientWithAppointment, seedSessionDocs, seedSupplement } from './fixtures';
import type { IDatabase } from '../src/db/interfaces/repositories';
import { recordCheckoutOutcome } from '../src/checkout/docWriteback';
import { renderAppointmentSheet } from '../src/session/render';

// WF2 doc write-backs: billing stamped on the internal sheet, protocol supplements
// refreshed from the plan.

describe('renderAppointmentSheet billing (pure)', () => {
  const note = { concerns: [], assessments: [], protocol_changes: [], supplements: [], follow_ups: [] };
  it('renders a Billing section when present', () => {
    const md = renderAppointmentSheet(note, {
      clientName: 'Maya',
      appointmentDate: '2026-07-07',
      billing: { status: 'paid', amount_cents: 17500, currency: 'USD', qb_txn_id: 'EMU1', qb_invoice_id: 'inv-9', paid_at: '2026-07-07T10:00:00Z' },
    });
    expect(md).toContain('## Billing');
    expect(md).toContain('$175.00');
    expect(md).toContain('EMU1');
    expect(md).toContain('inv-9');
  });
  it('shows a placeholder when not checked out', () => {
    expect(renderAppointmentSheet(note, { clientName: 'Maya', appointmentDate: '2026-07-07' })).toContain('_Not checked out._');
  });
});

const up = await emulatorUp();
const suite = up ? describe : describe.skip;
if (!up) {
  console.log('[checkout-docs.int] Firestore emulator not running — skipping. Start: npm run firestore:emulator');
}

suite('recordCheckoutOutcome (integration)', () => {
  let db: IDatabase;

  beforeAll(() => {
    db = installFirestore('checkout-docs-int');
  });
  afterAll(() => uninstallFirestore());
  beforeEach(async () => {
    await clearFirestore(db);
  });

  it('stamps billing on the sheet and refreshes protocol supplements', async () => {
    const { client, appointment } = await seedClientWithAppointment(db, {
      client: { name: 'Docs Test' },
      appointment: { status: 'completed' },
    });
    await seedSessionDocs(db, { client, appointment });
    await seedSupplement(db, { client_id: client.id, name: 'Magnesium', dose: '2 caps', qty: 60 });
    await seedSupplement(db, { client_id: client.id, name: 'Zinc', dose: null, qty: 30 });

    await recordCheckoutOutcome(appointment.id, { status: 'paid', amountCents: 17500, currency: 'USD', qbTxnId: 'EMU1', qbInvoiceId: 'inv-9' });

    const sheet = await db.sessionNotes.findSheetByAppointment(appointment.id);
    expect(sheet!.content_json.billing).toMatchObject({ status: 'paid', amount_cents: 17500, qb_txn_id: 'EMU1', qb_invoice_id: 'inv-9' });

    const proto = await db.sessionNotes.findProtocolByAppointment(appointment.id);
    const supplements = proto!.content_json.supplements as Array<{ name: string; dose: string | null; quantity: number | null; change: string }>;
    expect(supplements.map((s) => s.name).sort()).toEqual(['Magnesium', 'Zinc']);
    expect(supplements.find((s) => s.name === 'Magnesium')).toMatchObject({ dose: '2 caps', quantity: 60, change: 'continue' });
  });
});
