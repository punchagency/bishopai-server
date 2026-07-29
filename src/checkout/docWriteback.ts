import { getDatabase } from '../db/index.js';
import { logEvent } from '../observability/logger';

// WF2 doc write-backs: after a charge, stamp the outcome onto the internal
// Appointment Sheet (payment status/amount/refs) and refresh the client-facing
// Protocol's supplement list from the current plan. Both write into the docs'
// `content_json`, so the subsequent Drive publish re-renders them with the new
// content. Best-effort and idempotent (re-running overwrites the same keys).

export interface CheckoutOutcome {
  status: string; // paid | dry-run | failed
  amountCents: number;
  currency: string;
  qbTxnId?: string | null;
  qbInvoiceId?: string | null;
  note?: string | null;
}

export async function recordCheckoutOutcome(appointmentId: string | null, outcome: CheckoutOutcome): Promise<void> {
  if (!appointmentId) return;

  const billing = {
    status: outcome.status,
    amount_cents: outcome.amountCents,
    currency: outcome.currency,
    qb_txn_id: outcome.qbTxnId ?? null,
    qb_invoice_id: outcome.qbInvoiceId ?? null,
    note: outcome.note ?? null,
    paid_at: new Date().toISOString(),
  };

  // Internal sheet: stamp the billing outcome.
  const db = getDatabase();
  // jsonb_set on a single key becomes a read-merge-write of content_json; the
  // other keys must survive, so spread rather than replace.
  const sheet = await db.sessionNotes.findSheetByAppointment(appointmentId);
  if (sheet) {
    await db.sessionNotes.saveSheet({
      ...sheet,
      content_json: { ...(sheet.content_json ?? {}), billing },
    });
  }

  // Client-facing protocol: refresh its supplement list from the current plan
  // (the `supplements` collection is the source of truth, kept current by WF1).
  const appt = await db.appointments.findById(appointmentId);
  const clientId = appt?.client_id ?? null;
  if (clientId) {
    const supps = (await db.refills.listSupplementsByClient(clientId)).sort((a, b) =>
      a.name.localeCompare(b.name),
    );
    const asNote = supps.map((s) => ({ name: s.name, dose: s.dose ?? null, quantity: s.qty ?? null, change: 'continue' as const }));
    const protocol = await db.sessionNotes.findProtocolByAppointment(appointmentId);
    if (protocol) {
      await db.sessionNotes.saveProtocol({
        ...protocol,
        content_json: { ...(protocol.content_json ?? {}), supplements: asNote },
      });
    }
  }

  logEvent('info', 'checkout.docs', 'recorded checkout outcome on docs', {
    appointment_id: appointmentId,
    status: outcome.status,
  });
}
