// Demo seed — populates the whole cockpit offline, with NO external creds.
// Uses the mock LLM (unless a real provider key is configured) so
// ingest → extract → render works without an API key.
// Idempotent: clears prior 'Seed …' rows first, so re-running is safe.
//
//   npm run seed
import 'dotenv/config';
import { pool } from './pool';
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

async function clearSeed(): Promise<void> {
  // FKs cascade from clients → appointments/supplements/refills/protocols/etc.
  await pool.query(
    `DELETE FROM refill_orders WHERE client_id IN (SELECT id FROM clients WHERE name LIKE 'Seed %' OR name LIKE 'SMOKE %')`,
  );
  await pool.query(`DELETE FROM conversations WHERE bee_id LIKE 'seed-%'`);
  await pool.query(`DELETE FROM checkout WHERE pb_appointment_id LIKE 'seed-appt-%'`);
  await pool.query(`DELETE FROM appointments WHERE pb_id LIKE 'seed-appt-%'`);
  await pool.query(`DELETE FROM clients WHERE name LIKE 'Seed %' OR name LIKE 'SMOKE %'`);
  // Seed leads, plus any re-engagement leads (maintenance / cancellation) that a
  // prior seed run generated for a seed client email. Cascades lead_activity + messages.
  await pool.query(`DELETE FROM leads WHERE source = 'seed' OR email = ANY($1)`, [
    CLIENTS.map((c) => c.email),
  ]);
}

async function main(): Promise<void> {
  console.log(`Seeding demo data (LLM provider: ${llmConfig.provider})…`);
  await clearSeed();

  let matched = 0;
  for (const c of CLIENTS) {
    const clientId = (
      await pool.query<{ id: string }>(`INSERT INTO clients (name, email) VALUES ($1, $2) RETURNING id`, [c.name, c.email])
    ).rows[0].id;

    // Appointment (1h window).
    const apptStart = c.appointmentOffset;
    const apptEnd = apptStart + 60 * 60 * 1000;
    // pb_id tagged 'seed-…' so clearSeed can remove appointments across re-runs
    // (they don't cascade from clients — client_id is ON DELETE SET NULL).
    await pool.query(
      `INSERT INTO appointments (client_id, pb_id, starts_at, ends_at, status) VALUES ($1,$2,$3,$4,$5)`,
      [clientId, `seed-appt-${clientId}`, iso(apptStart), iso(apptEnd), apptStart < 0 ? 'completed' : 'confirmed'],
    );

    // The booked return visit — what the prep brief is prepared for.
    if (c.returnOffset !== undefined) {
      await pool.query(
        `INSERT INTO appointments (client_id, pb_id, starts_at, ends_at, status) VALUES ($1,$2,$3,$4,'confirmed')`,
        [clientId, `seed-appt-return-${clientId}`, iso(c.returnOffset), iso(c.returnOffset + 60 * 60 * 1000)],
      );
    }

    // Supplements (drive refill projection).
    for (const s of c.supplements) {
      await pool.query(
        `INSERT INTO supplements (client_id, name, dose, qty, start_date, source) VALUES ($1,$2,$3,$4,$5,'notes')`,
        [clientId, s.name, s.dose, s.qty, dateOnly(s.startOffset)],
      );
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
  const david = await pool.query<{
    sheet_id: string;
    client_id: string;
    appointment_id: string;
    starts_at: string;
    content_json: SessionNote;
  }>(
    `SELECT s.id AS sheet_id, s.client_id, s.appointment_id, a.starts_at, s.content_json
       FROM appointment_sheets s
       JOIN clients c ON c.id = s.client_id
       JOIN appointments a ON a.id = s.appointment_id
      WHERE c.name = 'Seed David Osei'`,
  );
  if (david.rowCount) {
    const d = david.rows[0];
    await pool.query(`UPDATE appointment_sheets SET status = 'approved' WHERE id = $1`, [d.sheet_id]);
    await createTasksFromNote(pool, {
      clientId: d.client_id,
      appointmentId: d.appointment_id,
      sessionDate: new Date(d.starts_at),
      note: d.content_json,
    });
  }

  // Give the quiet client a second, older completed session so it reads as an
  // established maintenance-phase client (2+ sessions) rather than a one-visit
  // first-appointment case.
  const quiet = await pool.query<{ id: string }>(`SELECT id FROM clients WHERE name = 'Seed Quiet Client'`);
  if (quiet.rowCount) {
    await pool.query(
      `INSERT INTO appointments (client_id, pb_id, starts_at, ends_at, status)
            VALUES ($1, 'seed-appt-quiet-2', now() - interval '200 days', now() - interval '200 days' + interval '1 hour', 'completed')`,
      [quiet.rows[0].id],
    );
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
    const leadId = (
      await pool.query<{ id: string }>(
        `INSERT INTO leads (source, email, status, sequence_state, last_touch, created_at)
              VALUES ('seed', $1, $2, $3, $4, $5) RETURNING id`,
        [
          l.email,
          l.status,
          JSON.stringify({ sent: l.sent }),
          // last_touch trails the lead's age so a long-cold lead can deactivate.
          l.sent.length ? iso(-Math.max(1, l.ageDays - 2) * DAY) : null,
          iso(-l.ageDays * DAY),
        ],
      )
    ).rows[0].id;
    for (const a of l.activity) {
      await pool.query(
        `INSERT INTO lead_activity (lead_id, type, path, detail, occurred_at) VALUES ($1,$2,$3,$4,$5)`,
        [leadId, a.type, a.path ?? null, a.detail ?? null, iso(-a.agoHours * 3600 * 1000)],
      );
    }
  }

  // --- WF2 checkouts (Checkout view) ----------------------------------------
  // Detect a checkout for each completed (past) appointment; take one all the
  // way through the dry-run charge so the view shows both an awaiting-approval
  // and a closed example.
  const pastAppts = await pool.query<{ id: string }>(
    `SELECT a.id FROM appointments a JOIN clients c ON c.id = a.client_id
      WHERE c.name LIKE 'Seed %' AND a.starts_at < now() ORDER BY a.starts_at`,
  );
  let firstCheckoutId: string | null = null;
  for (const { id } of pastAppts.rows) {
    const d = await detectCheckout(id);
    if (d && !firstCheckoutId) firstCheckoutId = d.checkoutId;
  }
  // Push the first one through approve → charge (dry-run) → PB_MARKED.
  if (firstCheckoutId) await approveAndCharge(firstCheckoutId, { approvedBy: 'nicole' });

  // One unmatched conversation (no overlapping appointment) → Unmatched view.
  await ingestConversation({
    bee_id: 'seed-unmatched-1',
    starts_at: iso(-9 * DAY),
    ends_at: iso(-9 * DAY + 40 * 60 * 1000),
    transcript: 'Walk-in style chat about general wellness — no booking on the calendar for this one.',
  });

  const projection = await projectRefills();
  // WF3 reactivation passes: first-appointment (one-visit clients) + maintenance
  // (established clients gone quiet). Disjoint by session count.
  const firstAppointment = await enrollFirstAppointmentClients();
  const maintenance = await enrollMaintenanceClients();

  const counts = await pool.query(`
    SELECT
      (SELECT count(*) FROM clients            WHERE name LIKE 'Seed %')            AS clients,
      (SELECT count(*) FROM appointment_sheets WHERE status IN ('draft','in_review')) AS sheets,
      (SELECT count(*) FROM protocols          WHERE status IN ('draft','in_review')) AS protocols,
      (SELECT count(*) FROM refills            WHERE due_date IS NOT NULL)          AS refills,
      (SELECT count(*) FROM conversations      WHERE appointment_id IS NULL)        AS unmatched,
      (SELECT count(*) FROM leads              WHERE source = 'seed')               AS leads,
      (SELECT count(*) FROM checkout           WHERE pb_appointment_id LIKE 'seed-appt-%') AS checkouts
  `);
  console.log('Seed complete:', { matched, projection, firstAppointment, maintenance, ...counts.rows[0] });
  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
