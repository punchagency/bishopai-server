import { randomUUID } from 'node:crypto';
import type { IDatabase } from '../src/db/interfaces/repositories';
import type {
  Appointment,
  AppointmentSheet,
  Checkout,
  Client,
  Conversation,
  Lead,
  Refill,
  Supplement,
  SupplementProtocol,
} from '../src/db/interfaces/types';
import { supplementDocId } from '../src/db/ids';
import { normalizeSupplementName } from '../src/session/supplementName';

/**
 * Fixture builders for the emulator-backed suites.
 *
 * The integration tests used to seed with hand-written INSERTs, which let each
 * suite invent its own idea of a row — and let a column the app actually
 * requires go missing without anyone noticing. These builders write through the
 * repositories instead, so a fixture is by construction the same shape the app
 * writes: the pb-index claim documents get created, names are denormalized, and
 * supplement ids are the real `${client_id}__${name_key}` document ids.
 *
 * Everything takes a partial override, because a test that says
 * `seedRefill(db, { status: 'snoozed' })` reads as the one thing it is about.
 */

const now = () => new Date().toISOString();

export async function seedClient(db: IDatabase, over: Partial<Client> = {}): Promise<Client> {
  const ts = now();
  const client: Client = {
    ...over,
    id: over.id ?? randomUUID(),
    name: over.name ?? 'Test Client',
    // Lowercased on write, exactly as the app does — the lookups have no
    // case-insensitive comparison to fall back on.
    email: (over.email ?? `client-${randomUUID().slice(0, 8)}@example.com`).toLowerCase(),
    created_at: over.created_at ?? ts,
    updated_at: over.updated_at ?? ts,
  };
  await db.clients.save(client);
  return client;
}

export async function seedAppointment(
  db: IDatabase,
  over: Partial<Appointment> & { client_id: string },
): Promise<Appointment> {
  const ts = now();
  const startsAt = over.starts_at ?? ts;
  // The spread goes FIRST and the resolved fields after: every one of them
  // already folds `over` in, and letting the raw override win again would undo
  // the defaults derived from it (ends_at off starts_at, for one).
  const appointment: Appointment = {
    ...over,
    id: over.id ?? randomUUID(),
    client_id: over.client_id,
    client_name: over.client_name ?? null,
    pb_id: over.pb_id ?? null,
    starts_at: startsAt,
    ends_at: over.ends_at ?? new Date(Date.parse(startsAt) + 3_600_000).toISOString(),
    status: over.status ?? 'confirmed',
    created_at: over.created_at ?? ts,
    updated_at: over.updated_at ?? ts,
  };
  await db.appointments.save(appointment);
  return appointment;
}

/**
 * A client with an appointment, which is what most suites actually want. The
 * appointment carries the denormalized client_name because the app writes it
 * that way and the listings read it rather than joining (§3.4).
 */
export async function seedClientWithAppointment(
  db: IDatabase,
  opts: { client?: Partial<Client>; appointment?: Partial<Appointment> } = {},
): Promise<{ client: Client; appointment: Appointment }> {
  const client = await seedClient(db, opts.client);
  const appointment = await seedAppointment(db, {
    ...opts.appointment,
    // client_id resolved last: an override of `undefined` would otherwise
    // produce an appointment with no client, which is a different fixture.
    client_id: opts.appointment?.client_id ?? client.id,
    client_name: opts.appointment?.client_name ?? client.name,
  });
  return { client, appointment };
}

export async function seedConversation(
  db: IDatabase,
  over: Partial<Conversation> = {},
): Promise<Conversation> {
  const ts = now();
  const startsAt = over.starts_at ?? ts;
  const conversation: Conversation = {
    ...over,
    id: over.id ?? `bee-${randomUUID().slice(0, 8)}`,
    bee_id: over.bee_id ?? over.id ?? `bee-${randomUUID().slice(0, 8)}`,
    appointment_id: over.appointment_id ?? null,
    starts_at: startsAt,
    ends_at: over.ends_at ?? new Date(Date.parse(startsAt) + 3_600_000).toISOString(),
    transcript: over.transcript ?? 'test transcript',
    correlation_status: over.correlation_status ?? 'unmatched',
    extraction_status: over.extraction_status ?? 'pending',
    extraction_attempts: over.extraction_attempts ?? 0,
    created_at: over.created_at ?? ts,
    updated_at: over.updated_at ?? ts,
  };
  await db.conversations.save(conversation);
  return conversation;
}

export async function seedSupplement(
  db: IDatabase,
  over: Partial<Supplement> & { client_id: string },
): Promise<Supplement> {
  const ts = now();
  const name = over.name ?? 'Magnesium glycinate';
  const nameKey = over.name_key ?? (normalizeSupplementName(name) || name.trim().toLowerCase());
  const supplement: Supplement = {
    ...over,
    // The real document id, not a random one — the refill projection keys off
    // it, so a random id here would hide a mismatch the app would hit.
    id: over.id ?? supplementDocId(over.client_id, nameKey),
    client_id: over.client_id,
    name,
    name_key: nameKey,
    dose: over.dose ?? '2 caps nightly',
    qty: over.qty ?? 60,
    start_date: over.start_date ?? new Date().toISOString().slice(0, 10),
    source: over.source ?? 'notes',
    created_at: over.created_at ?? ts,
    updated_at: over.updated_at ?? ts,
  };
  await db.refills.saveSupplement(supplement);
  return supplement;
}

export async function seedRefill(
  db: IDatabase,
  over: Partial<Refill> & { client_id: string; supplement_id: string },
): Promise<Refill> {
  const ts = now();
  const refill: Refill = {
    ...over,
    id: over.id ?? randomUUID(),
    client_id: over.client_id,
    client_name: over.client_name ?? null,
    supplement_id: over.supplement_id,
    supplement_name: over.supplement_name ?? 'Magnesium glycinate',
    dose: over.dose ?? '2 caps nightly',
    due_date: over.due_date ?? new Date().toISOString().slice(0, 10),
    status: over.status ?? 'pending',
    // `NOT NULL DEFAULT 0` in pg (0011) — stated here because Firestore has no
    // column defaults, and the projection writes it for the same reason.
    reminder_stage: over.reminder_stage ?? 0,
    updated_at: over.updated_at ?? ts,
    created_at: over.created_at ?? ts,
  };
  await db.refills.save(refill);
  return refill;
}

export async function seedLead(db: IDatabase, over: Partial<Lead> = {}): Promise<Lead> {
  const ts = now();
  const lead: Lead = {
    ...over,
    id: over.id ?? randomUUID(),
    email: (over.email ?? `lead-${randomUUID().slice(0, 8)}@example.com`).toLowerCase(),
    source: over.source ?? 'seed',
    status: over.status ?? 'new',
    sequence_state: over.sequence_state ?? { sent: [] },
    last_touch: over.last_touch ?? null,
    created_at: over.created_at ?? ts,
    updated_at: over.updated_at ?? ts,
  };
  await db.reengagement.saveLead(lead);
  return lead;
}

/**
 * The two halves of a session's paperwork, as extraction writes them.
 *
 * **The document id IS the appointment id, for both.** That is not cosmetic:
 * `findSessionDocs` gets them by ref rather than querying, and
 * `appointmentForItem` hands a sheet id straight to it — so a sheet stored under
 * any other id is invisible to every review route, which 404s. Overriding
 * `sheet.id` or `protocol.id` here is almost always a mistake.
 *
 * `starts_at` and `client_name` are denormalized on purpose (§3.4) — every
 * listing orders on the session date, and Firestore cannot order one collection
 * by a field in another. A fixture that omitted them would pass here and vanish
 * from the review queue in the app.
 */
export async function seedSessionDocs(
  db: IDatabase,
  args: {
    appointment: Appointment;
    client: Client;
    sheet?: Partial<AppointmentSheet>;
    protocol?: Partial<SupplementProtocol>;
  },
): Promise<{ sheet: AppointmentSheet; protocol: SupplementProtocol }> {
  const ts = now();
  const base = {
    appointment_id: args.appointment.id,
    client_id: args.client.id,
    client_name: args.client.name,
    starts_at: args.appointment.starts_at,
    status: 'draft' as const,
    revision: 1,
    created_at: ts,
    updated_at: ts,
  };

  const sheet: AppointmentSheet = {
    ...base,
    ...args.sheet,
    id: args.sheet?.id ?? args.appointment.id,
    content_json: args.sheet?.content_json ?? {},
  };
  const protocol: SupplementProtocol = {
    ...base,
    ...args.protocol,
    id: args.protocol?.id ?? args.appointment.id,
    content_json: args.protocol?.content_json ?? {},
  };
  await db.sessionNotes.saveSheet(sheet);
  await db.sessionNotes.saveProtocol(protocol);
  return { sheet, protocol };
}

export async function seedCheckout(
  db: IDatabase,
  over: Partial<Checkout> = {},
): Promise<Checkout> {
  const ts = now();
  const checkout: Checkout = {
    ...over,
    // Document id == appointment_id (0023), so a checkout without one still
    // needs a stable id of its own.
    id: over.id ?? over.appointment_id ?? randomUUID(),
    appointment_id: over.appointment_id ?? null,
    client_id: over.client_id ?? null,
    pb_appointment_id: over.pb_appointment_id ?? null,
    status: over.status ?? 'AWAITING_APPROVAL',
    charge_attempts: over.charge_attempts ?? 0,
    created_at: over.created_at ?? ts,
    updated_at: over.updated_at ?? ts,
  };
  await db.checkouts.save(checkout);
  return checkout;
}
