import { describe, it, expect } from 'vitest';
import { renderAppointmentSheet, renderProtocol, coerceSessionNote } from './render';

const fullNote = {
  concerns: ['poor sleep'],
  assessments: ['magnesium deficiency'],
  protocol_changes: [{ description: 'increase magnesium', type: 'adjust' as const }],
  supplements: [{ name: 'Magnesium', dose: '400mg', quantity: 60, change: 'increase' as const }],
  follow_ups: ['recheck in 4 weeks'],
};
const ctx = { clientName: 'Jane Doe', appointmentDate: '2026-07-07' };

describe('renderAppointmentSheet (internal)', () => {
  it('includes every section, incl. assessments and a supplements table', () => {
    const md = renderAppointmentSheet(coerceSessionNote(fullNote), ctx);
    expect(md).toContain('# Appointment Sheet — Jane Doe');
    expect(md).toContain('**Date:** 2026-07-07');
    expect(md).toContain('magnesium deficiency'); // assessments are internal-only
    expect(md).toContain('| Magnesium | 400mg | 60 | increase |');
    expect(md).toContain('- **[adjust]** increase magnesium');
    expect(md).toContain('- recheck in 4 weeks');
  });

  it('renders placeholders for empty sections', () => {
    const md = renderAppointmentSheet(coerceSessionNote({}), ctx);
    expect(md).toContain('## Concerns\n_None noted._');
    expect(md).toContain('## Supplements\n_None noted._');
    expect(md).toContain('## Follow-ups\n_None noted._');
  });
});

describe('renderProtocol (client-facing)', () => {
  it('omits internal assessments', () => {
    const md = renderProtocol(coerceSessionNote(fullNote), ctx);
    expect(md).toContain('# Your Protocol — Jane Doe');
    expect(md).not.toContain('Assessments');
    expect(md).not.toContain('magnesium deficiency');
    expect(md).toContain('- **Magnesium** — 400mg (qty 60) — _increase_');
  });

  it('handles supplements missing dose/qty and empty changes', () => {
    const md = renderProtocol(
      coerceSessionNote({ supplements: [{ name: 'Vit D', change: 'start' }] }),
      ctx,
    );
    expect(md).toContain('- **Vit D** — _start_');
    expect(md).toContain('## Plan Changes\n_No changes._');
  });
});

describe('coerceSessionNote', () => {
  it('fills missing arrays with []', () => {
    const n = coerceSessionNote({ concerns: ['x'] });
    expect(n.concerns).toEqual(['x']);
    expect(n.assessments).toEqual([]);
    expect(n.supplements).toEqual([]);
  });

  it('tolerates non-object input', () => {
    expect(coerceSessionNote(null).follow_ups).toEqual([]);
    expect(coerceSessionNote('nope').concerns).toEqual([]);
  });

  it('drops non-array fields rather than throwing', () => {
    const n = coerceSessionNote({ concerns: 'not-an-array', supplements: 42 });
    expect(n.concerns).toEqual([]);
    expect(n.supplements).toEqual([]);
  });

  // Regression: the fallback path used to rebuild only the six array fields, so a
  // note that failed strict parse silently lost every NRT finding and the whole
  // lifestyle log. Downstream that reads as "never tested", not "failed to parse".
  it('keeps nrt and lifestyle when the note fails strict parse', () => {
    const n = coerceSessionNote({
      concerns: 'not-an-array', // forces the fallback path
      nrt: { pulse0: '72', priority1: 'liver', k27: 'positive', stressors: 'immune, food' },
      lifestyle: { bm: 'daily', sleep: '6 hours', water: '80oz' },
    });
    expect(n.concerns).toEqual([]); // fallback path confirmed
    expect(n.nrt?.pulse0).toBe('72');
    expect(n.nrt?.priority1).toBe('liver');
    expect(n.nrt?.k27).toBe('positive');
    expect(n.nrt?.stressors).toBe('immune, food');
    expect(n.nrt?.foundation).toBeNull(); // unstated stays null, never invented
    expect(n.lifestyle?.bm).toBe('daily');
    expect(n.lifestyle?.sleep).toBe('6 hours');
    expect(n.lifestyle?.cycle).toBeNull();
  });

  it('salvages nrt even when lifestyle is malformed', () => {
    const n = coerceSessionNote({
      concerns: 'not-an-array',
      nrt: { pulse0: '68' },
      lifestyle: 'not-an-object',
    });
    expect(n.nrt?.pulse0).toBe('68');
    expect(n.lifestyle).toBeUndefined();
  });

  it('omits nrt and lifestyle entirely when absent', () => {
    const n = coerceSessionNote({ concerns: 'not-an-array' });
    expect(n.nrt).toBeUndefined();
    expect(n.lifestyle).toBeUndefined();
  });
});
