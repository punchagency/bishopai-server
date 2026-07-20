/**
 * Seed ONE demo client with a run of sessions over several months, so the review
 * queue and the Flow Sheet comparison have real history to show.
 *
 * Why this exists: the Otter seed gives three clients with one session each, so
 * every "previous session" panel is empty and the whole point of the Flow Sheet
 * — reading a field across visits — can't be demonstrated. This gives one client
 * a journey: symptoms resolving, lifestyle numbers improving, the protocol
 * evolving, and NRT findings that change between visits.
 *
 * Seven sessions, matching the seven pre-formatted blocks in her Appointment Flow
 * Sheet template. The last is deliberately left as a DRAFT so it lands in the
 * queue with six approved sessions of history behind it — enough that the
 * history view has to scroll, which is the case worth designing against.
 *
 * Some prompts are deliberately left unstated in each transcript. That is the
 * realistic case — Nicole doesn't run every test every visit — and it's what
 * makes the coverage gutter and `not_covered_last_time` show anything at all.
 *
 * Idempotent: clears prior rows for this client before re-inserting.
 *
 * Usage:
 *   npm run seed:journey              # extraction only (works offline, mock LLM)
 *   PUBLISH=1 npm run seed:journey    # also publish docs (needs Drive creds)
 */
import 'dotenv/config';
import { pool } from '../src/db/pool.js';
import { ingestConversation } from '../src/conversations/ingest.js';
import { processConversation } from '../src/session/process.js';
import { publishClientTemplates } from '../src/session/publishTemplates.js';
import { syncClientSupplements } from '../src/session/supplements.js';
import { llmConfig } from '../src/llm/config.js';

const CLIENT_NAME = 'DEMO - Marta Reyes (multi-session)';
const CLIENT_EMAIL = 'demo.journey@example.com';
const DAY = 86_400_000;

interface DemoSession {
  /** Days before today this session happened. */
  daysAgo: number;
  label: string;
  /** Left as a draft so it shows up in the review queue. */
  draft?: boolean;
  transcript: string;
}

// Spoken-style clinical narration. The practitioner calls each muscle-testing
// result out loud as she works down the sheet, which is how these sessions
// actually run — and it's what the extraction has to key on.
const SESSIONS: DemoSession[] = [
  {
    daysAgo: 84,
    label: 'Initial consultation',
    transcript: `
Nicole: Okay Marta, let's go through what brought you in today.

Marta: The big one is fatigue. I'm exhausted by two in the afternoon, every day, and
I've been getting bloating after almost every meal. I've also had headaches maybe
three times a week for the last six months.

Nicole: And what would you like to get out of this?

Marta: I want to get through a workday without crashing. And I'd like to stop
reaching for sugar at 3pm just to function.

Nicole: Good. Let's do the testing. Pulse 0 is 74 and a little thready. K-27 is
switched, corrected with the rub. Priority #1 is an immune stressor in the upper GI.
Stressors are immune challenge and food, mainly dairy and gluten.

Nicole: Working the foundations now. Laying 1 foundations is weak on the right side.
Standing foundations is holding. HTA is positive. HTA post run is still positive, so
we will recheck that next visit. Laying 2 foundations is clear. Open is clear. Switch
is switched, corrected on the second pass. CNS is stressed. Dental is clear.
Hormonal is weak.

Nicole: Body scan with polarity. Ectoderm is reactive. ART priority is liver. ART
matrix is gallbladder. ART cell is spleen. Additional ART is some small intestine
involvement.

Nicole: Now without polarity. Scan priority is adrenal. Scan matrix is kidney. Scan
cell is thymus.

Nicole: Let's talk about your daily patterns. BM is every other day and sluggish.
Sleep is 5 hours, waking around 3am. Water is about 40 ounces a day. Cycle is
irregular, running 35 days. Exercise is walking twice a week. Diet is high sugar with
coffee on an empty stomach most mornings.

Nicole: Here's where we start. I want to begin Cataplex B, two tabs with breakfast and
two with dinner. Start Zypan, one tab with meals. And start Drenamin, one tab upon
waking and one mid-afternoon. Let's recheck in three weeks.
`.trim(),
  },
  {
    daysAgo: 63,
    label: 'Follow-up 1',
    transcript: `
Nicole: How have the last three weeks been?

Marta: Better than I expected. The afternoon crash is not as sharp. Still there, but
I'm not desperate for sugar at 3pm anymore. Bloating is maybe half what it was.
Headaches are down to about once a week.

Nicole: That's a good first pass. Pulse 0 is 70 and steadier. Priority #1 is still the
upper GI, but it's weaker. Stressors are immune and food, dairy still showing.

Nicole: Foundations. Laying 1 foundations is holding now. Standing foundations is
clear. HTA is negative, which is the change I wanted to see. HTA post run is clear.
Switch is clear. CNS is calmer. Hormonal is still weak.

Nicole: I'm going to skip the full body scan today since we're tracking the foundation
change. Ectoderm is quiet.

Nicole: Daily patterns. BM is daily now and formed. Sleep is 6 hours and she's not
waking at 3am. Water is about 60 ounces a day. Exercise is walking three times a week.
Diet is much less sugar, and she's eating breakfast.

Nicole: Continue Cataplex B at the same dose. Continue Zypan. Continue Drenamin. I
want to add Symplex F, one tab with breakfast, for the hormonal piece. Back in three
weeks.
`.trim(),
  },
  {
    daysAgo: 35,
    label: 'Follow-up 2',
    transcript: `
Nicole: Talk to me about where you are.

Marta: Energy is genuinely good now. The afternoon crash is gone. Bloating only shows
up if I eat late. No headaches at all in the last two weeks.

Nicole: Pulse 0 is 68 and even. K-27 is clear. Priority #1 is the adrenal now, the GI
has moved off the top. Stressors are food only, and mild.

Nicole: Foundations. Laying 1 foundations is clear. Standing foundations is clear. HTA
is negative. Open is clear. CNS is clear. Dental is clear. Hormonal is improving but
not resolved.

Nicole: Full body scan today. Ectoderm is quiet. ART priority is adrenal. ART matrix is
kidney. ART cell is thymus. Additional ART is nothing further. Scan priority is
adrenal. Scan matrix is kidney. Scan cell is clear. Additional NRT is good response
across the board.

Nicole: Daily patterns. BM is daily and formed. Sleep is 7 hours, sleeping through.
Water is about 70 ounces a day. Cycle is regular at 29 days. Exercise is walking four
times a week plus yoga. Diet is stable, protein at every meal.

Nicole: Continue Cataplex B, continue Drenamin, continue Symplex F. Let's stop Zypan,
the digestion piece has resolved. Back in four weeks.
`.trim(),
  },
  {
    daysAgo: 21,
    label: 'Follow-up 3',
    transcript: `
Nicole: How's the month been?

Marta: Good. Energy is holding. I did get a headache last week after a stressful few
days, but only the one.

Nicole: Pulse 0 is 68 and even. Priority #1 is the adrenal, still mild. Stressors are
chemical, the cleaning products again.

Nicole: Foundations. Laying 1 foundations is clear. Standing foundations is clear.
HTA is negative. Hormonal is improving.

Nicole: Body scan. Ectoderm is quiet. Scan priority is adrenal. Scan matrix is clear.
Scan cell is clear.

Nicole: Daily patterns. BM is daily and formed. Sleep is 7 hours. Water is about 70
ounces a day. Cycle is regular at 28 days. Exercise is walking four times a week plus
yoga. Diet is stable.

Nicole: Continue everything. Back in three weeks.
`.trim(),
  },
  {
    daysAgo: 49,
    label: 'Follow-up 1b',
    transcript: `
Nicole: Two weeks on, how are you?

Marta: The bloating is basically gone. Energy still climbing. Sleep is the slow one.

Nicole: Pulse 0 is 70. Priority #1 is the upper GI, weaker again. Stressors are food,
dairy only now.

Nicole: Foundations. Laying 1 foundations is holding. Standing foundations is clear.
HTA is negative. CNS is clear. Hormonal is weak.

Nicole: No body scan today, we focused on the foundation recheck.

Nicole: Daily patterns. BM is daily. Sleep is 6 hours, occasional waking. Water is
about 65 ounces a day. Exercise is walking three times a week. Diet is steady, no
sugar crash.

Nicole: Continue Cataplex B, Zypan and Drenamin. Continue Symplex F. Back in two weeks.
`.trim(),
  },
  {
    daysAgo: 10,
    label: 'Follow-up 4',
    transcript: `
Nicole: Anything changed since last time?

Marta: Sleep got worse this last stretch. Work has been heavy. Otherwise fine.

Nicole: Pulse 0 is 66. Priority #1 is the adrenal. Stressors are chemical.

Nicole: Foundations. Laying 1 foundations is clear. Standing foundations is clear.
Hormonal is clear.

Nicole: Body scan. Scan priority is adrenal. Scan matrix is clear.

Nicole: Daily patterns. BM is daily and formed. Sleep is 6 hours, broken. Water is
about 72 ounces a day. Exercise is walking three times a week. Diet is stable.

Nicole: Continue everything. Recheck in ten days.
`.trim(),
  },
  {
    daysAgo: 2,
    label: 'Latest session (awaiting review)',
    draft: true,
    transcript: `
Nicole: How's it been over the last month?

Marta: Really steady. I've had energy the whole way through. The only thing is my
sleep slipped a bit the last week or so, I think it's work stress. Maybe six hours.

Nicole: Let's look. Pulse 0 is 66 and even. Priority #1 is the adrenal again, mild.
Stressors are chemical this time, likely a new cleaning product she started using.

Nicole: Foundations. Laying 1 foundations is clear. Standing foundations is clear.
Hormonal is clear now, which is the one I've been waiting on. Dental is clear.

Nicole: We ran short on time so I did not run the body scan today. We'll pick that up
next visit.

Nicole: Daily patterns. BM is daily and formed. Sleep is 6 hours with some waking.
Water is about 75 ounces a day. Exercise is walking four times a week plus yoga twice.
Diet is stable.

Nicole: Continue Cataplex B. Continue Drenamin. Continue Symplex F. I want to add
Min-Tran, one tab before bed, for the sleep and the stress load. Recheck in four weeks.
`.trim(),
  },
];

async function clearDemo(): Promise<void> {
  await pool.query(
    `DELETE FROM conversations WHERE client_id IN (SELECT id FROM clients WHERE name = $1)`,
    [CLIENT_NAME],
  );
  await pool.query(
    `DELETE FROM supplements WHERE client_id IN (SELECT id FROM clients WHERE name = $1)`,
    [CLIENT_NAME],
  );
  await pool.query(
    `DELETE FROM appointments WHERE client_id IN (SELECT id FROM clients WHERE name = $1)`,
    [CLIENT_NAME],
  );
  await pool.query(`DELETE FROM clients WHERE name = $1`, [CLIENT_NAME]);
}

async function seedSession(
  clientId: string,
  s: DemoSession,
  index: number,
): Promise<void> {
  const start = new Date(Date.now() - s.daysAgo * DAY);
  const end = new Date(start.getTime() + 45 * 60_000);

  const { rows: [{ id: appointmentId }] } = await pool.query<{ id: string }>(
    `INSERT INTO appointments (client_id, pb_id, starts_at, ends_at, status)
     VALUES ($1, $2, $3, $4, 'completed') RETURNING id`,
    [clientId, `demo-journey-${clientId}-${index}`, start.toISOString(), end.toISOString()],
  );

  const { conversationId, correlation } = await ingestConversation({
    bee_id: `demo-journey-${clientId}-${index}`,
    starts_at: new Date(start.getTime() + 2 * 60_000).toISOString(),
    ends_at: new Date(end.getTime() - 2 * 60_000).toISOString(),
    transcript: s.transcript,
  });

  if (correlation.status !== 'matched') {
    await pool.query(
      `UPDATE conversations SET appointment_id = $1, client_id = $2, correlation_status = 'manual'
        WHERE id = $3`,
      [appointmentId, clientId, conversationId],
    );
  }

  await processConversation(conversationId);

  const { rows: protocolRows } = await pool.query<{ id: string; content_json: unknown }>(
    `SELECT id, content_json FROM protocols WHERE appointment_id = $1`,
    [appointmentId],
  );
  if (protocolRows.length === 0) {
    console.log(`  ! no protocol produced for "${s.label}" — extraction may have failed`);
    return;
  }
  const protocolId = protocolRows[0].id;

  if (s.draft) {
    console.log(`  · ${s.label} — left as DRAFT (this is the one in the review queue)`);
    return;
  }

  // Past sessions are approved, so they count as prior context: the brief and the
  // Flow Sheet comparison both deliberately ignore drafts ("a draft isn't yet
  // Nicole's word"), so seeding them as drafts would leave the panels empty.
  await pool.query(
    `UPDATE appointment_sheets SET status = 'approved' WHERE appointment_id = $1`,
    [appointmentId],
  );
  await pool.query(`UPDATE protocols SET status = 'approved' WHERE id = $1`, [protocolId]);

  // Approving normally runs this inside the approve transaction; do it here so
  // the running supplement plan accumulates the way it would in real use.
  const db = await pool.connect();
  try {
    const r = await syncClientSupplements(
      db,
      clientId,
      start.toISOString().slice(0, 10),
      protocolRows[0].content_json,
    );
    console.log(`  ✓ ${s.label} — approved (${r.upserted} supplement(s) up, ${r.removed} stopped)`);
  } finally {
    db.release();
  }

  if (process.env.PUBLISH === '1') {
    try {
      await publishClientTemplates(protocolId);
      console.log('    published documents');
    } catch (err) {
      console.error('    publish failed (continuing):', (err as Error).message ?? err);
    }
  }
}

async function main(): Promise<void> {
  console.log(`Seeding "${CLIENT_NAME}" — ${SESSIONS.length} sessions (LLM: ${llmConfig.provider})`);
  await clearDemo();

  const { rows: [{ id: clientId }] } = await pool.query<{ id: string }>(
    `INSERT INTO clients (name, email) VALUES ($1, $2) RETURNING id`,
    [CLIENT_NAME, CLIENT_EMAIL],
  );

  // Oldest first, so the supplement plan accumulates in the right order.
  const ordered = [...SESSIONS].sort((a, b) => b.daysAgo - a.daysAgo);
  for (let i = 0; i < ordered.length; i++) {
    await seedSession(clientId, ordered[i], i);
  }

  await pool.end();
  console.log('\nDone. Open the Review Queue — the newest session is waiting there.');
}

main().catch((err) => {
  console.error('Seed failed:', err);
  process.exit(1);
});
