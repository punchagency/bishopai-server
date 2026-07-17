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
    foundation: 'HTA positive; CNS switched',
    body_scan: 'Matrix: liver; Cell: spleen',
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
    expect(entry.foundation).toBe('Adrenal stress\nLow stomach acid');
    expect(entry.protocol).toBe('Start Cataplex B 2 daily (qty 1)\nContinue Zypan 1 w/ meals (qty 2)\nStop Old Supp');
    // Lifestyle log isn't extracted → left for Nicole.
    expect(entry.notes).toBeUndefined();
  });

  it('prefers real muscle-testing findings over assessments, and fills the lifestyle log', () => {
    const entry = toFlowSheetEntry(richNote, { date: 'Jul 9, 2026' });
    expect(entry.foundation).toBe('HTA positive; CNS switched');
    expect(entry.bodyScan).toBe('Matrix: liver; Cell: spleen');
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
