// Demo seed — populates the whole cockpit offline, with NO external creds.
// Uses the mock LLM (unless a real provider key is configured) so
// ingest → extract → render works without an API key.
// Idempotent: clears prior 'Seed …' rows first, so re-running is safe.
//
//   npm run seed
import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { getDatabase } from './index.js';
import { supplementDocId } from './ids.js';
import { normalizeSupplementName } from '../session/supplementName';
import { llmConfig } from '../llm/config';
import { ingestConversation } from '../conversations/ingest';
import { processConversation } from '../session/process';
import { projectRefills } from '../refills/project';
import { createTasksFromNote } from '../tasks/service';
import type { SessionNote } from '../session/extract';
import { detectCheckout, approveAndCharge } from '../checkout/machine';
import { enrollMaintenanceClients } from '../reengagement/maintenance';
import { enrollFirstAppointmentClients } from '../reengagement/firstAppointment';

// LLM provider auto-resolves to `mock` when no key is configured (see
// llm/config.ts), so seeding needs no credentials.

const DAY = 86_400_000;
const iso = (msFromNow: number) => new Date(Date.now() + msFromNow).toISOString();
const dateOnly = (msFromNow: number) => new Date(Date.now() + msFromNow).toISOString().slice(0, 10);

interface SeedClient {
  name: string;
  email: string; // so a cancellation can re-engage them (WF3 cancelled cadence)
  transcript: string;
  // appointment offset (ms from now); negative = past (gets a note), positive = upcoming.
  appointmentOffset: number;
  // A booked return visit. This is what the prep brief briefs *for* — without a
  // next appointment there is nothing to prepare, and the Schedule has no card to
  // open. Set on the clients whose past session is worth reading back.
  returnOffset?: number;
  supplements: { name: string; dose: string; qty: number | null; startOffset: number }[];
}

const CLIENTS: SeedClient[] = [
  {
    name: 'Seed Maya Chen',
    email: 'maya.chen@example.com',
    appointmentOffset: -2 * DAY,
    returnOffset: 2 * DAY,
    transcript:
      "Maya's been having trouble sleeping and low energy for weeks. We talked through her stress at work. " +
      'She wants to get through the afternoon without crashing. ' +
      'Pulse 0 is 78, thready. K-27 was switched, corrected on the rub. ' +
      'Priority #1 is an immune stressor in the upper GI. Stressors are immune challenge and food, mainly dairy. ' +
      'Foundation testing shows HTA positive with the CNS switched; dental is clear. ' +
      'Body scan shows matrix at the liver and cell at the adrenal. ' +
      'Her BM is every other day and sluggish, sleep is 5 to 6 hours waking around 3am, water is about 40oz a day, ' +
      'cycle is regular at 28 days, exercise is walking twice a week, and her diet is high sugar with coffee on an empty stomach. ' +
      "Let's start magnesium glycinate at night and add a B-complex in the morning. Recheck in 4 weeks.",
    supplements: [
      { name: 'Magnesium glycinate', dose: '2 caps nightly', qty: 60, startOffset: -25 * DAY },
      { name: 'B-complex', dose: '1 cap daily', qty: 30, startOffset: -25 * DAY },
    ],
  },
  {
    name: 'Seed David Osei',
    email: 'david.osei@example.com',
    appointmentOffset: -5 * DAY,
    returnOffset: 4 * DAY,
    transcript:
      'David reports bloating and digestive discomfort after meals, plus some joint aches. ' +
      'He wants to eat a full meal without discomfort. ' +
      'Pulse 0 reads 68, steady. K-27 is holding this time. ' +
      'Priority #1 is a food stressor at the small intestine. Stressors are food, mainly gluten. ' +
      'Foundation shows HTA clear and the CNS holding. ' +
      'Body scan shows matrix at the gallbladder, ectoderm clear. ' +
      'BM is daily but loose, sleep is a solid 7 hours, water is around 80oz, exercise is lifting three times a week, ' +
      'and his diet is mostly clean with late dinners. ' +
      "We'll continue his omega-3 and introduce a probiotic. Follow-up in 6 weeks.",
    supplements: [
      { name: 'Omega-3', dose: '2 softgels daily', qty: 60, startOffset: -50 * DAY },
      { name: 'Probiotic', dose: '1 cap daily', qty: 30, startOffset: -10 * DAY },
    ],
  },
  {
    name: 'Seed Lena Petrov',
    email: 'lena.petrov@example.com',
    appointmentOffset: -1 * DAY,
    // Her return visit is the payoff: the brief for it lists exactly what the short
    // session never covered (Priority #1, K-27, body scan, BM, cycle, exercise).
    returnOffset: 1 * DAY,
    // Deliberately partial: no body scan, no cycle, no K-27 — a short session where
    // Nicole didn't get to everything. Those cells must come out BLANK, never guessed.
    transcript:
      "Lena's main concern is anxiety and feeling overwhelmed. Sleep is disrupted, about 4 hours a night. " +
      'She would like to feel calm enough to focus at work. ' +
      'Pulse 0 is 84 and jumpy. Stressors are chemical, likely her new cleaning products. ' +
      'Foundation shows the CNS switched. We ran short on time so no body scan today. ' +
      'Water is barely 30oz a day and her diet is skipping meals under stress. ' +
      "Let's begin ashwagandha twice daily and keep the vitamin D going. Recheck in 8 weeks.",
    supplements: [
      { name: 'Ashwagandha', dose: '1 cap twice daily', qty: 60, startOffset: -3 * DAY },
      { name: 'Vitamin D3', dose: '1 softgel daily', qty: 90, startOffset: -3 * DAY },
    ],
  },
  {
    name: 'Seed Priya Nair',
    email: 'priya.nair@example.com',
    appointmentOffset: 3 * DAY, // upcoming — shows in Overview, no note yet
    transcript: '',
    supplements: [{ name: 'Zinc', dose: '1 cap daily', qty: 30, startOffset: -28 * DAY }],
  },
  {
    name: 'Seed Quiet Client',
    email: 'quiet.client@example.com',
    appointmentOffset: -120 * DAY, // maintenance-phase: no visit in months, no rebooking
    transcript: '',
    supplements: [{ name: 'Multivitamin', dose: '1 cap daily', qty: 30, startOffset: -120 * DAY }],
  },
  {
    name: 'Seed One Visit',
    email: 'one.visit@example.com',
    appointmentOffset: -30 * DAY, // came once a month ago, never rebooked → first-appointment track
    transcript: '',
    supplements: [],
  },
];

/**
 * Remove everything a prior seed run created, so re-running is safe.
 *
 * Two things changed in the port. There are no `ON DELETE CASCADE` FKs any more
 * (§7), so every dependent collection is cleared explicitly rather than falling
 * out of deleting the client. And `LIKE 'seed-%'` has no Firestore equivalent
 * (§3.5): the seed set is small and dev-only, so this lists each collection once
 * and matches in memory. That is the one place a full scan is the right answer —
 * it is a local script, not a request path.
 */
async function clearSeed(): Promise<void> {
  const db = getDatabase();
  const seedEmails = new Set(CLIENTS.map((c) => c.email));
  const isSeedName = (name: string) => name.startsWith('Seed ') || name.startsWith('SMOKE ');

  const clients = (await db.clients.listAll()).filter((c) => isSeedName(c.name));
  const clientIds = new Set(clients.map((c) => c.id));

  const appointments = (await db.appointments.listAll()).filter(
    (a) => a.pb_id?.startsWith('seed-appt-') || (a.client_id && clientIds.has(a.client_id)),
  );
  const appointmentIds = new Set(appointments.map((a) => a.id));

  // Conversations first: unmatching one releases its appointment claim, and the
  // claim document would otherwise outlive the appointment and block a re-seed.
  const conversations = (await db.conversations.listAll()).filter((c) =>
    c.id.startsWith('seed-'),
  );
  for (const conv of conversations) {
    if (conv.appointment_id) await db.conversations.releaseAppointment(conv.appointment_id);
    await db.conversations.delete(conv.id);
  }

  for (const appointment of appointments) {
    // Approvals go too. Their ids are deterministic
    // (`approval_${checkoutId}_${attempt}`), so one left behind by a previous
    // run makes the next approve of the same checkout fail on ALREADY_EXISTS
    // instead of proceeding — a re-seed that silently produces no charge.
    for (const approval of await db.sessionNotes.listApprovals(appointment.id)) {
      await db.sessionNotes.deleteApproval(approval.id);
    }
    await db.sessionNotes.deleteSessionDocs(appointment.id);
    await db.appointments.delete(appointment.id);
  }

  // Checkouts are keyed on the appointment id, so they go with the appointments.
  const checkouts = (await db.checkouts.listAll()).filter(
    (c) => c.appointment_id && appointmentIds.has(c.appointment_id),
  );
  for (const checkout of checkouts) {
    for (const approval of await db.checkouts.listApprovalsByCheckout(checkout.id, 100)) {
      await db.sessionNotes.deleteApproval(approval.id);
    }
    await db.checkouts.deleteCheckout(checkout.id);
  }

  for (const refill of (await db.refills.listAll()).filter((r) => clientIds.has(r.client_id))) {
    await db.refills.deleteRefill(refill.id);
  }
  for (const clientId of clientIds) {
    for (const supp of await db.refills.listSupplementsByClient(clientId)) {
      await db.refills.deleteSupplement(clientId, supp.name_key);
    }
    for (const task of await db.tasks.listByClient(clientId)) {
      await db.tasks.delete(task.id);
    }
  }

  for (const client of clients) await db.clients.delete(client.id);

  // Seed leads, plus any re-engagement leads (maintenance / cancellation) that a
  // prior seed run generated for a seed client email.
  const leads = (await db.reengagement.listLeads()).filter(
    (l) => l.source === 'seed' || (l.email && seedEmails.has(l.email)),
  );
  for (const lead of leads) await db.reengagement.deleteLead(lead.id);

  // audit_logs is append-only by contract, so a re-seed adds to the trail rather
  // than rewriting it. That is the correct behaviour for an audit log — the
  // entries are true, they just describe an earlier run.
}

async function main(): Promise<void> {
  console.log(`Seeding demo data (LLM provider: ${llmConfig.provider})…`);
  await clearSeed();

  const db = getDatabase();
  let matched = 0;
  for (const c of CLIENTS) {
    const now = new Date().toISOString();
    const clientId = randomUUID();
    await db.clients.save({
      id: clientId,
      name: c.name,
      email: c.email,
      created_at: now,
      updated_at: now,
    });

    // Appointment (1h window).
    const apptStart = c.appointmentOffset;
    const apptEnd = apptStart + 60 * 60 * 1000;
    // pb_id tagged 'seed-…' so clearSeed can find these across re-runs. Written
    // through upsertByPbId so the pb-index claim document is created with them —
    // otherwise a later PB sync for the same id would mint a second appointment.
    await db.appointments.upsertByPbId(`seed-appt-${clientId}`, {
      client_id: clientId,
      client_name: c.name,
      starts_at: iso(apptStart),
      ends_at: iso(apptEnd),
      status: apptStart < 0 ? 'completed' : 'confirmed',
    });

    // The booked return visit — what the prep brief is prepared for.
    if (c.returnOffset !== undefined) {
      await db.appointments.upsertByPbId(`seed-appt-return-${clientId}`, {
        client_id: clientId,
        client_name: c.name,
        starts_at: iso(c.returnOffset),
        ends_at: iso(c.returnOffset + 60 * 60 * 1000),
        status: 'confirmed',
      });
    }

    // Supplements (drive refill projection).
    for (const s of c.supplements) {
      const nameKey = normalizeSupplementName(s.name) || s.name.trim().toLowerCase();
      await db.refills.saveSupplement({
        id: supplementDocId(clientId, nameKey),
        client_id: clientId,
        name: s.name,
        name_key: nameKey,
        dose: s.dose,
        qty: s.qty,
        start_date: dateOnly(s.startOffset),
        source: 'notes',
        created_at: now,
        updated_at: now,
      });
    }

    // Past appointments get a Bee conversation overlapping the window → matched
    // → extraction (mock) → draft sheet + protocol land in the review queue.
    if (apptStart < 0 && c.transcript) {
      const { conversationId, correlation } = await ingestConversation({
        bee_id: `seed-${clientId}`,
        starts_at: iso(apptStart + 5 * 60 * 1000),
        ends_at: iso(apptEnd - 5 * 60 * 1000),
        transcript: c.transcript,
      });
      if (correlation.status === 'matched') {
        matched++;
        await processConversation(conversationId);
      }
    }
  }

  // David's last session is already signed off, so his return visit has a populated
  // prep brief the moment the app opens — a brief only reads from APPROVED notes, and
  // without this every brief would be empty until someone clicks Approve. Maya and Lena
  // stay in the review queue: they're the two the demo actually approves.
  const seededClients = await db.clients.listAll();
  const david = seededClients.find((c) => c.name === 'Seed David Osei') ?? null;
  if (david) {
    // The three-way join becomes: the client's appointments (indexed), then that
    // appointment's sheet by known ref.
    for (const appointment of await db.appointments.listByClient(david.id)) {
      const sheet = await db.sessionNotes.findSheetByAppointment(appointment.id);
      if (!sheet) continue;
      await db.sessionNotes.saveSheet({ ...sheet, status: 'approved' });
      await createTasksFromNote({
        clientId: david.id,
        appointmentId: appointment.id,
        sessionDate: new Date(appointment.starts_at),
        note: sheet.content_json as SessionNote,
      });
    }
  }

  // Give the quiet client a second, older completed session so it reads as an
  // established maintenance-phase client (2+ sessions) rather than a one-visit
  // first-appointment case.
  const quiet = seededClients.find((c) => c.name === 'Seed Quiet Client') ?? null;
  if (quiet) {
    await db.appointments.upsertByPbId('seed-appt-quiet-2', {
      client_id: quiet.id,
      client_name: quiet.name,
      starts_at: iso(-200 * DAY),
      ends_at: iso(-200 * DAY + 60 * 60 * 1000),
      status: 'completed',
    });
  }

  // --- WF3 leads + site activity (Engagement view) --------------------------
  interface SeedLead {
    email: string;
    status: string;
    ageDays: number;
    sent: string[];
    activity: { type: string; path?: string; detail?: string; agoHours: number }[];
  }
  const LEADS: SeedLead[] = [
    { email: 'sarah.m@example.com', status: 'new', ageDays: 1, sent: [],
      activity: [ { type: 'page_view', path: '/services', agoHours: 2 }, { type: 'form_open', path: '/book-a-consult', agoHours: 1 } ] },
    { email: 'james.t@example.com', status: 'contacted', ageDays: 5, sent: ['welcome'],
      activity: [ { type: 'page_view', path: '/about', agoHours: 30 }, { type: 'email_open', detail: 'welcome', agoHours: 20 } ] },
    { email: 'nadia.k@example.com', status: 'cancelled', ageDays: 9, sent: [],
      activity: [ { type: 'booked', detail: 'cancelled by client', agoHours: 200 } ] },
    { email: 'tom.b@example.com', status: 'booked', ageDays: 3, sent: ['welcome'],
      activity: [ { type: 'form_submit', path: '/book-a-consult', agoHours: 70 } ] },
    { email: 'cold.lead@example.com', status: 'nurturing', ageDays: 200, sent: ['welcome', 'nudge_3d', 'nudge_7d', 'final_14d'],
      activity: [ { type: 'page_view', path: '/', agoHours: 24 * 160 } ] },
  ];
  for (const l of LEADS) {
    const leadId = randomUUID();
    const createdAt = iso(-l.ageDays * DAY);
    await db.reengagement.saveLead({
      id: leadId,
      source: 'seed',
      // Addresses are stored lowercased — that is what replaces `lower(email)`
      // in the lookups, so the seed has to honour it too.
      email: l.email.toLowerCase(),
      status: l.status,
      sequence_state: { sent: l.sent },
      // last_touch trails the lead's age so a long-cold lead can deactivate.
      last_touch: l.sent.length ? iso(-Math.max(1, l.ageDays - 2) * DAY) : null,
      created_at: createdAt,
      updated_at: createdAt,
    });
    for (const a of l.activity) {
      const occurredAt = iso(-a.agoHours * 3600 * 1000);
      await db.reengagement.logActivity({
        id: randomUUID(),
        lead_id: leadId,
        type: a.type,
        path: a.path ?? null,
        detail: a.detail ?? null,
        occurred_at: occurredAt,
        created_at: occurredAt,
      });
    }
  }

  // --- WF2 checkouts (Checkout view) ----------------------------------------
  // Detect a checkout for each completed (past) appointment; take one all the
  // way through the dry-run charge so the view shows both an awaiting-approval
  // and a closed example.
  const nowIso = new Date().toISOString();
  const pastAppts = (
    await Promise.all(
      seededClients
        .filter((c) => c.name.startsWith('Seed '))
        .map((c) => db.appointments.listByClient(c.id)),
    )
  )
    .flat()
    .filter((a) => a.starts_at < nowIso)
    .sort((a, b) => a.starts_at.localeCompare(b.starts_at));

  let firstCheckoutId: string | null = null;
  for (const { id } of pastAppts) {
    const d = await detectCheckout(id);
    if (d && !firstCheckoutId) firstCheckoutId = d.checkoutId;
  }
  // Push the first one through approve → charge (dry-run) → PB_MARKED.
  if (firstCheckoutId) await approveAndCharge(firstCheckoutId, { approvedBy: 'nicole' });

  // One unmatched conversation (no overlapping appointment) → Unmatched view.
  // A full multi-turn transcript, well past the 240-char list preview, so the
  // detail pane visibly shows the whole recording rather than the same snippet.
  await ingestConversation({
    bee_id: 'seed-unmatched-1',
    starts_at: iso(-9 * DAY),
    ends_at: iso(-9 * DAY + 40 * 60 * 1000),
    transcript: [
      'Nicole: Come on in — I don\'t think we had you on the calendar today, did we?',
      'Client: No, I was just in the area and wanted to ask a couple of quick things.',
      'Nicole: Of course, no problem at all. What\'s been going on?',
      'Client: Honestly my energy has been all over the place. Fine in the morning, then completely flat by about two or three in the afternoon.',
      'Nicole: How\'s your sleep been through all this?',
      'Client: Not great. I fall asleep okay but I\'m wide awake around three or four most nights.',
      'Nicole: And water — are you drinking much through the day?',
      'Client: Probably not enough. Mostly coffee if I\'m honest, two or three cups before lunch.',
      'Nicole: That afternoon crash makes a lot of sense then. Before we change anything, let\'s get you properly booked so I can do a full assessment and testing — this was really just a hallway chat.',
      'Client: That\'s fair. Can we do sometime next week?',
      'Nicole: Absolutely. I\'ll have the front desk find you a slot and we\'ll go through all of it properly.',
    ].join('\n'),
  });

  const projection = await projectRefills();
  // WF3 reactivation passes: first-appointment (one-visit clients) + maintenance
  // (established clients gone quiet). Disjoint by session count.
  const firstAppointment = await enrollFirstAppointmentClients();
  const maintenance = await enrollMaintenanceClients();

  // The seven-subquery summary. Two of these are real count() aggregations; the
  // rest read the small seeded set back, which is the honest way to report what
  // this script actually created rather than what the whole store holds.
  const [awaitingReview, unmatchedCount, allRefills, allLeads, allCheckouts, allClients] =
    await Promise.all([
      db.sessionNotes.countAwaitingReview(),
      db.conversations.countUnmatched(),
      db.refills.listAll(),
      db.reengagement.listLeads(),
      db.checkouts.listAll(),
      db.clients.listAll(),
    ]);
  const counts = {
    clients: allClients.filter((c) => c.name.startsWith('Seed ')).length,
    awaiting_review: awaitingReview,
    refills: allRefills.filter((r) => !!r.due_date).length,
    unmatched: unmatchedCount,
    leads: allLeads.filter((l) => l.source === 'seed').length,
    checkouts: allCheckouts.filter((c) => c.pb_appointment_id?.startsWith('seed-appt-')).length,
  };
  console.log('Seed complete:', { matched, projection, firstAppointment, maintenance, ...counts });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
