import { describe, it, expect } from 'vitest';
import { findUnstatedNumbers, statedNumbers } from './verifyNumbers';
import { SessionNoteSchema } from './schema';

const note = (over: Record<string, unknown>) => SessionNoteSchema.parse(over);

describe('statedNumbers', () => {
  it('reads a number however it was said', () => {
    const said = statedNumbers('she was at 172 pounds, sleeping seven hours, twenty-two days in');
    expect(said.has(172)).toBe(true);
    expect(said.has(7)).toBe(true);
    expect(said.has(22)).toBe(true);
  });

  it('builds compounds and keeps their parts', () => {
    // "seventy" from "seventy two" is a rounding, not an invention — flagging it
    // would spend Nicole's attention on the pipeline working.
    const said = statedNumbers('one hundred and seventy two pounds');
    expect(said.has(172)).toBe(true);
    expect(said.has(100)).toBe(true);
    expect(said.has(70)).toBe(true);
    expect(said.has(2)).toBe(true);
  });

  it('reads a figure said colloquially — "one seventy-two" is 172', () => {
    // Straight out of the pocket session: the client's weight is spoken as
    // "one fifty-five ... now I'm at one seventy-two", and an extraction that
    // writes "172 lbs" is copying it. Reading that as 1 + 72 is exactly how a
    // correct finding gets reported as an invented one.
    const said = statedNumbers("pre-weight gave us one fifty-five. Now I'm at one seventy-two.");
    expect(said.has(172)).toBe(true);
    expect(said.has(155)).toBe(true);
  });

  it('counts the quantity words a practitioner uses instead of a figure', () => {
    const said = statedNumbers('a couple of years ago, twice a day, half a scoop');
    expect(said.has(2)).toBe(true);
    expect(said.has(0.5)).toBe(true);
  });

  it('reads digits with separators and decimals', () => {
    const said = statedNumbers('the reading was 1,200 and the dose 2.5 ml');
    expect(said.has(1200)).toBe(true);
    expect(said.has(2.5)).toBe(true);
  });
});

describe('findUnstatedNumbers', () => {
  const transcript = 'PRACTITIONER: your liver enzymes were elevated about two years ago.';

  it('flags a figure the session never states', () => {
    // The failure this exists for: the citation verifies — the turn is real and
    // about the right thing — and the number in the finding was never spoken.
    const found = findUnstatedNumbers(note({ concerns: ['weight is up to 172 lbs'] }), transcript);
    expect(found).toEqual([{ path: 'concerns.0', value: 'weight is up to 172 lbs', numbers: [172] }]);
  });

  it('says nothing about a figure that was spoken as words', () => {
    const found = findUnstatedNumbers(note({ concerns: ['elevated liver enzymes 2 years ago'] }), transcript);
    expect(found).toEqual([]);
  });

  it('ignores derived numeric fields — only strings are claims', () => {
    // due_in_days is 28 BECAUSE someone said "four weeks". Demanding the digit
    // appear verbatim would flag the pipeline working correctly.
    const found = findUnstatedNumbers(
      note({ follow_ups: [{ text: 'recheck in four weeks', due_in_days: 28 }] }),
      'PRACTITIONER: come back in four weeks.',
    );
    expect(found).toEqual([]);
  });

  it('ignores digits in a product name — the catalog spells those, not the transcript', () => {
    const found = findUnstatedNumbers(
      note({ supplements: [{ name: 'Bio-D 5000', change: 'start' }] }),
      'PRACTITIONER: we are putting in the vitamin D one.',
    );
    expect(found).toEqual([]);
  });

  it('checks findings wherever they sit, not just the top-level lists', () => {
    const found = findUnstatedNumbers(
      note({
        concerns: [],
        nrt: { stressors: [{ category: 'food', detail: 'reacts to 3 of the panel foods' }] },
        lifestyle: { sleep: '5 hours, broken' },
      }),
      'PRACTITIONER: food is the stressor. CLIENT: I sleep five hours, broken.',
    );
    expect(found.map((f) => f.path)).toEqual(['nrt.stressors.0.detail']);
    expect(found[0].numbers).toEqual([3]);
  });

  it('does not audit the server\'s own bookkeeping', () => {
    const found = findUnstatedNumbers(
      note({
        concerns: [],
        evidence: [{ path: 'concerns.0', quote: 'up to 172 lbs', turn: 9, at_seconds: null }],
        extraction: { model: 'gpt-oss-120b', chunks: 4 },
      }),
      'PRACTITIONER: nothing numeric here.',
    );
    expect(found).toEqual([]);
  });
});
