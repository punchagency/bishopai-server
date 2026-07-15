import { describe, it, expect } from 'vitest';
import PizZip from 'pizzip';
import { fillRof } from './rof';

// Extract the concatenated text of the rendered docx (strip XML tags), so we can
// assert values landed and boilerplate survived without a Word runtime.
function docText(buf: Buffer): string {
  const xml = new PizZip(buf).file('word/document.xml')!.asText();
  return xml.replace(/<[^>]+>/g, '');
}

describe('fillRof', () => {
  it('fills fields, loops the protocol table, and keeps boilerplate', () => {
    const buf = fillRof({
      name: 'Leeza Woodbury',
      date: 'July 9, 2026',
      symptoms: 'Fatigue, bloating',
      goals: 'More energy',
      pulse0: '72',
      priority1: 'Liver',
      k27: 'Positive',
      stressors: 'Immune',
      protocol: [
        { supplement: 'Cataplex B', dosage: '2 daily', function: 'B vitamins' },
        { supplement: 'Zypan', dosage: '1 w/ meals', function: 'Digestion' },
      ],
    });
    const text = docText(buf);

    // Field values present.
    expect(text).toContain('Name: Leeza Woodbury');
    expect(text).toContain('Date: July 9, 2026');
    expect(text).toContain('Symptoms: Fatigue, bloating');
    expect(text).toContain('Goals: More energy');
    expect(text).toContain('Pulse 0: 72');
    expect(text).toContain('Priority #1: Liver');
    expect(text).toContain('K-27: Positive');
    expect(text).toContain('Stressors(s): Immune');
    // Protocol loop expanded both rows.
    expect(text).toContain('Cataplex B');
    expect(text).toContain('Zypan');
    expect(text).toContain('1 w/ meals');
    // Tags fully consumed (no residual template markup).
    expect(text).not.toContain('{');
    expect(text).not.toContain('protocol}');
    // Boilerplate untouched.
    expect(text).toContain('Nutrition Response Testing');
    expect(text).toContain('The average investment of a nutritional program');
  });

  it('renders a sparse session without throwing and empties unknown fields', () => {
    const buf = fillRof({ name: 'Jane Doe', date: '2026-07-09' });
    const text = docText(buf);
    expect(text).toContain('Name: Jane Doe');
    expect(text).toContain('Pulse 0:'); // label kept, value blank
    expect(text).not.toContain('{');
  });
});
