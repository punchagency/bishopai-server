// Presentation demo: fill Nicole's three templates from sample session data and
// drop the real files into ./demo-output — no database, no Google OAuth.
//
//   npm run demo:templates
//
// Tells the update story across two sessions for one client:
//   • Intake     → ROF.docx (once) + Supplement v1 + Flow Sheet block 1
//   • Follow-up  → Supplement v2 (new dated file) + Flow Sheet block 2 (stacks)
// The ROF is fill-once, the Supplement versions by date, the Flow Sheet appends.
import { join } from 'node:path';

// Force a self-contained, dry-run + demo-sink configuration before importing app
// modules (drive dry-run emits local files when DEMO_OUTPUT_DIR is set).
process.env.DATABASE_URL ||= 'postgres://demo:demo@localhost:5432/demo'; // never queried
process.env.DEMO_OUTPUT_DIR ||= join(process.cwd(), 'demo-output');
// Force Drive dry-run so the demo sink runs. Set to empty (not delete): dotenv,
// loaded transitively at import, won't override an already-present key — so these
// stay empty and isDriveConfigured() is false even if .env has real values.
for (const k of ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'GOOGLE_REFRESH_TOKEN']) process.env[k] = '';

const { renderClientTemplates } = await import('../src/session/publishTemplates');
const { publishBinaryDoc, publishFlowSheet, DOCX_MIME, XLSX_MIME } = await import('../src/integrations/drive');
type SessionNote = import('../src/session/extract').SessionNote;

const CLIENT = 'Leeza Woodbury';

const intake: SessionNote = {
  concerns: ['Chronic fatigue', 'Afternoon bloating', 'Trouble sleeping'],
  goals: ['Get energy back for work', 'Sleep through the night'],
  assessments: ['Adrenal stress pattern', 'Low stomach acid', 'Priority: liver/gallbladder'],
  protocol_changes: [{ description: 'Begin foundational gut + adrenal support', type: 'add' }],
  supplements: [
    { name: 'Cataplex B', dose: '2 tabs, 2x daily', quantity: 1, change: 'start' },
    { name: 'Zypan', dose: '1 tab w/ meals', quantity: 2, change: 'start' },
    { name: 'Drenamin', dose: '1 tab 3x daily', quantity: 1, change: 'start' },
  ],
  follow_ups: ['Recheck in 3 weeks', 'Track sleep + digestion daily'],
  nrt: {
    pulse0: '76, thready',
    priority1: 'Immune stressor — upper GI',
    k27: 'Switched; corrected on rub',
    stressors: 'Immune challenge, food (dairy, gluten)',
    foundation: 'HTA positive; CNS switched; dental clear',
    body_scan: 'ART: matrix — liver/gallbladder. NRT: cell — adrenal.',
  },
  lifestyle: {
    bm: 'every other day, sluggish',
    sleep: '5–6 hrs, waking around 3am',
    water: '~40 oz/day',
    cycle: 'regular, 28 days',
    exercise: 'walking 2x/week',
    diet: 'high sugar, coffee on empty stomach',
  },
};

const followUp: SessionNote = {
  concerns: ['Energy improving', 'Bloating mostly resolved'],
  goals: ['Keep energy stable through the afternoon'],
  assessments: ['Adrenals stabilising', 'Add hormonal support'],
  protocol_changes: [
    { description: 'Continue foundation; layer in hormonal support', type: 'adjust' },
    { description: 'Stop Zypan — digestion resolved', type: 'remove' },
  ],
  supplements: [
    { name: 'Cataplex B', dose: '2 tabs, 2x daily', quantity: 1, change: 'continue' },
    { name: 'Drenamin', dose: '1 tab 3x daily', quantity: 1, change: 'continue' },
    { name: 'Symplex F', dose: '1 tab 2x daily', quantity: 1, change: 'start' },
    { name: 'Zypan', dose: null, quantity: null, change: 'stop' },
  ],
  follow_ups: ['Recheck in 4 weeks'],
  nrt: {
    pulse0: '70, steady',
    priority1: 'Hormonal — ovary/pituitary',
    k27: 'Holding',
    stressors: 'Hormonal',
    foundation: 'HTA clear; CNS holding',
    body_scan: 'ART: matrix — endocrine. Ectoderm clear.',
    // Nothing else was muscle-tested this session — those cells stay blank.
  },
  lifestyle: {
    bm: 'daily, formed',
    sleep: '7 hrs, sleeping through',
    water: '~70 oz/day',
    cycle: null, // not discussed → label stays blank on the sheet
    exercise: 'walking 4x/week + yoga',
    diet: 'sugar down, eating breakfast',
  },
};

async function publishSession(note: SessionNote, dateISO: string, opts: { withRof: boolean }): Promise<void> {
  const r = await renderClientTemplates(note, { clientName: CLIENT, date: dateISO });
  if (opts.withRof) {
    await publishBinaryDoc({
      clientName: CLIENT, docType: 'ROF', fileName: 'ROF.docx',
      bytes: r.rof, mimeType: DOCX_MIME, skipIfExists: true,
    });
  }
  await publishBinaryDoc({
    clientName: CLIENT, docType: 'SupplementProtocol', fileName: r.supplementFileName,
    bytes: r.supplement, mimeType: XLSX_MIME,
  });
  await publishFlowSheet({ clientName: CLIENT, spreadsheetId: 'demo', entry: r.flowEntry });
  console.log(`  ✓ ${dateISO.slice(0, 10)} — ${opts.withRof ? 'ROF, ' : ''}${r.supplementFileName}, Flow Sheet block`);
}

console.log(`\nFilling Nicole's templates for ${CLIENT} → ${process.env.DEMO_OUTPUT_DIR}\n`);
await publishSession(intake, '2026-06-15T15:00:00Z', { withRof: true });
await publishSession(followUp, '2026-07-09T15:00:00Z', { withRof: false });
console.log(`\nDone. Open the files under ${process.env.DEMO_OUTPUT_DIR}/${CLIENT}/\n`);
// Exit immediately: the app's logger enqueues a best-effort DB flush we don't
// want in a no-DB demo — quitting now skips it (and its stderr noise) cleanly.
process.exit(0);
