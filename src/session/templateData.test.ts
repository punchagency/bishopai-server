import { describe, it, expect } from 'vitest';
import type { SessionNote } from './extract';
import { toRofData, toSupplementData, toFlowSheetEntry } from './templateData';

const note: SessionNote = {
  concerns: ['Fatigue', 'Bloating'],
  goals: [],
  assessments: ['Adrenal stress', 'Low stomach acid'],
  protocol_changes: [{ description: 'Add liver support', type: 'add' }],
  supplements: [
    { name: 'Cataplex B', dose: '2 daily', quantity: 1, change: 'start' },
    { name: 'Zypan', dose: '1 w/ meals', quantity: 2, change: 'continue' },
    { name: 'Old Supp', dose: null, quantity: null, change: 'stop' },
  ],
  follow_ups: ['Recheck in 2 weeks'],
};

describe('toSupplementData', () => {
  it('builds grid rows from the accumulated plan (not just this session), and fills notes/toDo', () => {
    // The accumulated `supplements` table state — post-sync, so it already
    // reflects this note's start/continue changes and excludes the stopped one.
    const current = [
      { name: 'Cataplex B', dose: '2 daily', qty: 1 },
      { name: 'Zypan', dose: '1 w/ meals', qty: 2 },
    ];
    const data = toSupplementData(current, note);
    expect(data.rows).toEqual([
      { name: 'Cataplex B', specialInstructions: '2 daily', bottleQuantity: 1 },
      { name: 'Zypan', specialInstructions: '1 w/ meals', bottleQuantity: 2 },
    ]);
    expect(data.notes).toBe('Recheck in 2 weeks');
    expect(data.toDo).toBe('Add liver support');
  });

  it('fills the Daily Schedule slots and the Here/Fullscript column', () => {
    const data = toSupplementData(
      [
        {
          name: 'Cataplex B',
          dose: '2 daily',
          qty: 1,
          schedule: { breakfast: '1 tab', beforeBed: '1 tab' },
          source: 'Fullscript',
        },
      ],
      note,
    );
    expect(data.rows[0]).toEqual({
      name: 'Cataplex B',
      specialInstructions: '2 daily',
      bottleQuantity: 1,
      schedule: { breakfast: '1 tab', beforeBed: '1 tab' },
      source: 'Fullscript',
    });
  });

  it('omits the schedule when no dosing time was stated', () => {
    // Blank slots must stay blank — never spread a daily dose across meals.
    const data = toSupplementData(
      [{ name: 'Zypan', dose: '1 w/ meals', qty: 2, schedule: { lunch: '  ', dinner: null } }],
      note,
    );
    expect(data.rows[0].schedule).toBeUndefined();
    expect(data.rows[0].source).toBeUndefined();
  });
});

// A session where Nicole called out the NRT findings and the client reported their
// lifestyle log — the fields the extraction now captures.
const richNote: SessionNote = {
  ...note,
  goals: ['Get energy back', 'Sleep through the night'],
  nrt: {
    pulse0: '72, regular',
    priority1: 'Immune stressor — upper GI',
    k27: 'Switched, corrected with rub',
    stressors: 'Immune, food (dairy)',
    foundation: {
      laying1: null,
      standing: null,
      hta: 'positive',
      hta_post_run: null,
      laying2: null,
      art_open: null,
      art_switch: null,
      art_cns: 'switched',
      art_dental: null,
      art_hormonal: null,
      additional: null,
    },
    body_scan: {
      art_ectoderm: null,
      art_priority: null,
      art_matrix: null,
      art_cell: null,
      additional_art: null,
      scan_priority: null,
      scan_matrix: 'liver',
      scan_cell: 'spleen',
      additional_nrt: null,
    },
  },
  lifestyle: {
    bm: 'daily, formed',
    sleep: '6 hrs, waking at 3am',
    water: '60 oz',
    cycle: null,
    exercise: 'walking 3x/week',
    diet: 'gluten-free, high sugar',
  },
};

describe('toRofData', () => {
  it('carries symptoms + protocol, leaves NRT findings blank', () => {
    const rof = toRofData(note, { name: 'Leeza Woodbury', date: 'Jul 9, 2026' });
    expect(rof.name).toBe('Leeza Woodbury');
    expect(rof.symptoms).toBe('Fatigue; Bloating');
    expect(rof.protocol).toEqual([
      { supplement: 'Cataplex B', dosage: '2 daily', function: '' },
      { supplement: 'Zypan', dosage: '1 w/ meals', function: '' },
    ]);
    // Not captured by extraction → undefined, so the ROF template stays blank there.
    expect(rof.pulse0).toBeUndefined();
    expect(rof.k27).toBeUndefined();
    expect(rof.goals).toBeUndefined();
  });

  it('fills the NRT block and goals when the session captured them', () => {
    const rof = toRofData(richNote, { name: 'Leeza Woodbury', date: 'Jul 9, 2026' });
    expect(rof.goals).toBe('Get energy back; Sleep through the night');
    expect(rof.pulse0).toBe('72, regular');
    expect(rof.priority1).toBe('Immune stressor — upper GI');
    expect(rof.k27).toBe('Switched, corrected with rub');
    expect(rof.stressors).toBe('Immune, food (dairy)');
  });
});

describe('toFlowSheetEntry', () => {
  it('summarises symptoms/findings/protocol for the appended block', () => {
    const entry = toFlowSheetEntry(note, { date: 'Jul 9, 2026' });
    expect(entry.date).toBe('Jul 9, 2026');
    expect(entry.symptoms).toBe('Fatigue; Bloating');
    // No muscle-testing findings, so the assessments fall through to ADDITIONAL and
    // every other prompt stays bare for Nicole to complete in-session.
    expect(entry.foundation).toContain('ADDITIONAL: Adrenal stress\nLow stomach acid');
    expect(entry.foundation).toContain('HTA:\nHTA POST RUN:');
    expect(entry.protocol).toBe('Start Cataplex B 2 daily (qty 1)\nContinue Zypan 1 w/ meals (qty 2)\nStop Old Supp');
    // Lifestyle log isn't extracted → left for Nicole.
    expect(entry.notes).toBeUndefined();
  });

  it('writes each finding onto its own prompt line, and fills the lifestyle log', () => {
    const entry = toFlowSheetEntry(richNote, { date: 'Jul 9, 2026' });
    // Findings land on their own prompt; untested prompts stay bare so Nicole can
    // see at a glance what the session never covered.
    expect(entry.foundation).toContain('HTA: positive');
    expect(entry.foundation).toContain('CNS: switched');
    expect(entry.foundation).toContain('HTA POST RUN:\n'); // never called → still bare
    expect(entry.foundation).toContain('DENTAL: \n');
    // Real muscle-testing findings win over the assessments fallback.
    expect(entry.foundation).not.toContain('Adrenal stress');
    expect(entry.bodyScan).toContain('MATRIX: liver');
    expect(entry.bodyScan).toContain('CELL: spleen');
    expect(entry.bodyScan).toContain('ECTODERM:\n'); // ART pass untested → bare
    expect(entry.notes).toEqual({
      bm: 'daily, formed',
      sleep: '6 hrs, waking at 3am',
      water: '60 oz',
      cycle: undefined, // not mentioned → that label stays blank on the sheet
      exercise: 'walking 3x/week',
      diet: 'gluten-free, high sugar',
    });
  });

  it('omits the lifestyle log entirely when nothing was reported', () => {
    const silent: SessionNote = {
      ...note,
      lifestyle: { bm: null, sleep: null, water: null, cycle: null, exercise: null, diet: null },
    };
    expect(toFlowSheetEntry(silent, { date: 'd' }).notes).toBeUndefined();
  });

  it('handles an empty note without emitting stray fields', () => {
    const empty: SessionNote = { concerns: [], goals: [], assessments: [], protocol_changes: [], supplements: [], follow_ups: [] };
    const entry = toFlowSheetEntry(empty, { date: 'd' });
    expect(entry).toEqual({ date: 'd', symptoms: undefined, foundation: undefined, protocol: undefined });
  });
});
