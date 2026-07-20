import { describe, it, expect } from 'vitest';
import PizZip from 'pizzip';
import { renderClientTemplates } from './publishTemplates';
import type { SessionNote } from './extract';

const note: SessionNote = {
  concerns: ['Fatigue'],
  goals: [],
  assessments: ['Adrenal stress'],
  protocol_changes: [{ description: 'Add liver support', type: 'add' }],
  supplements: [{ name: 'Cataplex B', dose: '2 daily', quantity: 1, change: 'start' }],
  follow_ups: ['Recheck in 2 weeks'],
};

describe('renderClientTemplates', () => {
  it('renders all three templates offline from a note', async () => {
    // The grid comes from the accumulated plan (post-sync in real use), not
    // note.supplements directly — pass it explicitly for this offline test.
    const currentSupplements = [{ name: 'Cataplex B', dose: '2 daily', qty: 1 }];
    const out = await renderClientTemplates(
      note,
      { clientName: 'Leeza Woodbury', date: '2026-07-09T15:00:00Z' },
      currentSupplements,
    );

    // ROF is a real docx carrying the mapped fields + boilerplate.
    const rofText = new PizZip(out.rof).file('word/document.xml')!.asText().replace(/<[^>]+>/g, '');
    expect(rofText).toContain('Name: Leeza Woodbury');
    expect(rofText).toContain('Symptoms: Fatigue');
    expect(rofText).toContain('Cataplex B');
    expect(rofText).toContain('Nutrition Response Testing'); // boilerplate preserved

    // Supplement is a non-empty xlsx buffer, named with Nicole's date stamp.
    expect(out.supplement.length).toBeGreaterThan(1000);
    expect(out.supplementFileName).toBe('Supplement Protocol 7_9_26.xlsx');

    // Flow Sheet entry carries the human date + mapped summaries.
    expect(out.flowEntry.date).toBe('July 9, 2026');
    expect(out.flowEntry.symptoms).toBe('Fatigue');
    // No muscle-testing pass in this note, so the assessments fall through to the
    // scaffold's ADDITIONAL prompt and the rest stay bare.
    expect(out.flowEntry.foundation).toContain('ADDITIONAL: Adrenal stress');
    expect(out.flowEntry.foundation).toContain('HTA:\n');
    expect(out.flowEntry.protocol).toBe('Start Cataplex B 2 daily (qty 1)');
  });
});
