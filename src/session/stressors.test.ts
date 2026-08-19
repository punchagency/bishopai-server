import { describe, it, expect } from 'vitest';
import { NrtFindingsSchema, formatStressors, mapStressorCategory } from './schema';
import { mergeChunkNotes } from './mergeNotes';
import type { SessionNote } from './schema';

const parse = (stressors: unknown) =>
  NrtFindingsSchema.parse({
    pulse0: null,
    priority1: null,
    k27: null,
    stressors,
    foundation: null,
    body_scan: null,
  }).stressors;

describe('stressor category mapping', () => {
  it('maps the words practitioners actually say onto NRT categories', () => {
    expect(mapStressorCategory('heavy metals').value).toBe('metal');
    expect(mapStressorCategory('food sensitivity').value).toBe('food');
    expect(mapStressorCategory('scar tissue').value).toBe('scar');
    expect(mapStressorCategory('parasite').value).toBe('immune');
  });

  it('falls to "other" rather than guessing a category, and says it did', () => {
    const m = mapStressorCategory('electromagnetic');
    expect(m.value).toBe('other');
    expect(m.unresolved).toBe(true);
    expect(m.raw).toBe('electromagnetic');
  });

  it('refuses a negated statement — "no food stressor" is not a food stressor', () => {
    expect(mapStressorCategory('not a food stressor').unresolved).toBe(true);
  });
});

describe('stressor list', () => {
  it('keeps the category and the SOURCE apart, which is the whole point', () => {
    const [s] = parse([{ category: 'food', source: 'dairy', body_area: 'gallbladder', detail: null }]);
    expect(s.category).toBe('food');
    expect(s.source).toBe('dairy');
    expect(formatStressors([s])).toBe('food — dairy (gallbladder)');
  });

  it('keeps every stressor a session names, not just the last', () => {
    const list = parse([
      { category: 'immune', source: 'Lyme', body_area: 'brain stem' },
      { category: 'food', source: null, body_area: null },
      { category: 'metal', source: 'mercury', body_area: null },
    ]);
    expect(list.map((s) => s.category)).toEqual(['immune', 'food', 'metal']);
  });

  it('leaves source null when the category was named and the thing was not', () => {
    // "It's showing food, but not anything specific" is a real reading. Filling
    // in a plausible food here would be a fabricated clinical finding.
    const [s] = parse([{ category: 'food', source: null, body_area: null, detail: null }]);
    expect(s.source).toBeNull();
    expect(formatStressors([s])).toBe('food');
  });

  it('renders nothing for a session that identified none', () => {
    expect(parse([])).toEqual([]);
    expect(formatStressors([])).toBeNull();
    expect(parse(null)).toEqual([]);
  });
});

describe('legacy notes', () => {
  it('parses a note stored as a plain string and renders it unchanged', () => {
    const list = parse('immune, food (dairy)');
    expect(list).toHaveLength(1);
    // NOT comma-split into two findings: the split point is a guess, and a
    // guessed stressor is exactly what this pipeline must never produce.
    expect(formatStressors(list)).toBe('immune, food (dairy)');
  });

  it('takes an array of bare strings, one entry each', () => {
    const list = parse(['immune', 'chemical']);
    expect(list.map((s) => s.category)).toEqual(['immune', 'chemical']);
  });
});

describe('merging chunks', () => {
  const chunk = (stressors: unknown, index: number) => ({
    index,
    note: { nrt: { stressors } } as unknown as Partial<SessionNote>,
  });

  it('unions stressors across chunks instead of keeping only the latest', () => {
    // The regression this guards: stressors were merged as a SCALAR, so a
    // session naming food early and metal late kept metal and silently dropped
    // food — "we missed a lot of stressors", exactly.
    const { note } = mergeChunkNotes([
      chunk([{ category: 'food', source: 'dairy', body_area: null, detail: null }], 0),
      chunk([{ category: 'metal', source: 'mercury', body_area: null, detail: null }], 2),
    ]);
    expect(note.nrt?.stressors?.map((s) => s.category)).toEqual(['food', 'metal']);
  });

  it('drops the duplicate an overlapping chunk re-reads', () => {
    const same = [{ category: 'immune', source: 'Lyme', body_area: 'brain stem', detail: null }];
    const { note } = mergeChunkNotes([chunk(same, 0), chunk(same, 1)]);
    expect(note.nrt?.stressors).toHaveLength(1);
  });

  it('keeps a category and its later-narrowed source as two findings', () => {
    // "It's food" then, minutes later, "specifically dairy" are a question and
    // its answer. Collapsing them would throw away whichever one it judged the
    // duplicate — and the one it would keep is not predictable.
    const { note } = mergeChunkNotes([
      chunk([{ category: 'food', source: null, body_area: null, detail: null }], 0),
      chunk([{ category: 'food', source: 'dairy', body_area: null, detail: null }], 1),
    ]);
    expect(note.nrt?.stressors?.map((s) => s.source)).toEqual([null, 'dairy']);
  });
});

describe('rendering a note that predates the change', () => {
  it('never crashes on a row still holding a bare string', () => {
    // The type says Stressor[]; a database row written months ago does not. A
    // `.map` on that string would throw in the middle of publishing a client's
    // Report of Findings, so the renderer checks rather than trusting the type.
    expect(formatStressors('immune, food' as unknown as never)).toBe('immune, food');
    expect(formatStressors(undefined)).toBeNull();
    expect(formatStressors(null)).toBeNull();
  });
});
