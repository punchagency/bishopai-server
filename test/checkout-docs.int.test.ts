import { describe, it, expect, afterEach, afterAll } from 'vitest';
import { pool } from '../src/db/pool';
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

const dbUp = await pool
  .query('SELECT 1')
  .then(() => true)
  .catch(() => false);
const suite = dbUp ? describe : describe.skip;

suite('recordCheckoutOutcome (integration)', () => {
  const clientIds: string[] = [];
  afterEach(async () => {
    for (const id of clientIds.splice(0)) {
      // appointments.client_id is ON DELETE SET NULL, so dropping the client alone
      // would strand its appointments as orphans that show up as "(unknown)" in the
      // cockpit. Delete them first — appointment_sheets cascade off the appointment.
      await pool.query(`DELETE FROM appointments WHERE client_id = $1`, [id]);
      await pool.query(`DELETE FROM clients WHERE id = $1`, [id]);
    }
  });
  afterAll(async () => {
    await pool.end();
  });

  it('stamps billing on the sheet and refreshes protocol supplements', async () => {
    const client = (await pool.query<{ id: string }>(`INSERT INTO clients (name) VALUES ('Docs Test') RETURNING id`)).rows[0].id;
    clientIds.push(client);
    const appt = (
      await pool.query<{ id: string }>(
        `INSERT INTO appointments (client_id, starts_at, ends_at, status) VALUES ($1, now(), now() + interval '1 hour', 'completed') RETURNING id`,
        [client],
      )
    ).rows[0].id;
    await pool.query(`INSERT INTO appointment_sheets (appointment_id, client_id, content_json) VALUES ($1, $2, '{}'::jsonb)`, [appt, client]);
    await pool.query(`INSERT INTO protocols (appointment_id, client_id, content_json) VALUES ($1, $2, '{}'::jsonb)`, [appt, client]);
    await pool.query(`INSERT INTO supplements (client_id, name, dose, qty) VALUES ($1, 'Magnesium', '2 caps', 60), ($1, 'Zinc', NULL, 30)`, [client]);

    await recordCheckoutOutcome(appt, { status: 'paid', amountCents: 17500, currency: 'USD', qbTxnId: 'EMU1', qbInvoiceId: 'inv-9' });

    const sheet = (await pool.query(`SELECT content_json FROM appointment_sheets WHERE appointment_id = $1`, [appt])).rows[0].content_json;
    expect(sheet.billing).toMatchObject({ status: 'paid', amount_cents: 17500, qb_txn_id: 'EMU1', qb_invoice_id: 'inv-9' });

    const proto = (await pool.query(`SELECT content_json FROM protocols WHERE appointment_id = $1`, [appt])).rows[0].content_json;
    expect(proto.supplements.map((s: { name: string }) => s.name).sort()).toEqual(['Magnesium', 'Zinc']);
    expect(proto.supplements.find((s: { name: string }) => s.name === 'Magnesium')).toMatchObject({ dose: '2 caps', quantity: 60, change: 'continue' });
  });
});
