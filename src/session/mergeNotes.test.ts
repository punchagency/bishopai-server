import { describe, it, expect } from 'vitest';
import { mergeChunkNotes, mergeStages, similarity, type ChunkResult } from './mergeNotes';
import { SessionNoteSchema, type SessionNote } from './schema';

// Merging chunk results is the riskiest code in the long-transcript path: every
// mistake it makes is invisible, because a dropped finding is indistinguishable
// from a finding the practitioner never called out. These tests are the reason
// the merge can be trusted.

const chunk = (index: number, note: Partial<SessionNote>): ChunkResult => ({ index, note });
const supp = (o: Partial<SessionNote['supplements'][number]>): SessionNote['supplements'][number] =>
  SessionNoteSchema.parse({ supplements: [{ name: 'X', change: 'continue', ...o }] }).supplements[0];

describe('similarity', () => {
  it('treats a rephrased capture of the same finding as the same finding', () => {
    expect(similarity('the gallbladder pain is back', 'gallbladder pain is back')).toBeGreaterThanOrEqual(0.8);
    expect(similarity('pituitary is offline', 'adrenals are stressed')).toBeLessThan(0.3);
  });
});

describe('mergeChunkNotes — string arrays', () => {
  it('concatenates in chunk order and drops near-duplicates from the overlap', () => {
    const { note } = mergeChunkNotes([
      chunk(0, { concerns: ['gallbladder pain is back'] }),
      chunk(1, { concerns: ['the gallbladder pain is back', 'waking in panic at night'] }),
    ]);
    expect(note.concerns).toEqual(['the gallbladder pain is back', 'waking in panic at night']);
  });

  it('keeps the longer of two similar captures', () => {
    // The overlap is exactly where one chunk sees a finding mid-sentence and the
    // other sees it whole.
    const { note } = mergeChunkNotes([
      chunk(0, { assessments: ['pituitary is offline'] }),
      chunk(1, { assessments: ['pituitary is a little bit offline right now'] }),
    ]);
    expect(note.assessments).toEqual(['pituitary is a little bit offline right now']);
  });
});

describe('mergeChunkNotes — supplements', () => {
  it('merges by normalized name, so punctuation does not split one product in two', () => {
    const { note } = mergeChunkNotes([
      chunk(0, { supplements: [supp({ name: 'Bio-C Plus', change: 'start' })] }),
      chunk(1, { supplements: [supp({ name: 'Bio C Plus', dose: '2 caps', change: 'start' })] }),
    ]);
    expect(note.supplements).toHaveLength(1);
    expect(note.supplements?.[0].dose).toBe('2 caps');
  });

  it('unions schedule slots stated minutes apart', () => {
    const { note } = mergeChunkNotes([
      chunk(0, { supplements: [supp({ name: 'Beta Plus', schedule: { breakfast: '2 caps' } as never })] }),
      chunk(1, { supplements: [supp({ name: 'Beta Plus', schedule: { beforeBed: '1 cap' } as never })] }),
    ]);
    expect(note.supplements?.[0].schedule).toMatchObject({ breakfast: '2 caps', beforeBed: '1 cap' });
  });

  it('flags a contradicted change instead of silently taking the last one', () => {
    // start-then-stop for one product is either a mid-session reversal or a
    // mis-read; only Nicole can tell, so the disagreement must reach her.
    const { note, conflicts } = mergeChunkNotes([
      chunk(0, { supplements: [supp({ name: 'Beta Plus', change: 'start' })] }),
      chunk(1, { supplements: [supp({ name: 'Beta Plus', change: 'stop' })] }),
    ]);
    expect(note.supplements?.[0].change).toBe('stop');
    expect(conflicts).toContainEqual(
      expect.objectContaining({ path: 'supplements.Beta Plus.change', candidates: ['start', 'stop'] }),
    );
  });

  it('lets a real reading overwrite a placeholder without calling it a conflict', () => {
    const unresolved = supp({ name: 'Beta Plus', change: 'PRN' as never });
    expect(unresolved.change_unresolved).toBe(true);
    const { note, conflicts } = mergeChunkNotes([
      chunk(0, { supplements: [unresolved] }),
      chunk(1, { supplements: [supp({ name: 'Beta Plus', change: 'stop' })] }),
    ]);
    expect(note.supplements?.[0].change).toBe('stop');
    expect(conflicts).toHaveLength(0);
  });
});

describe('mergeChunkNotes — scalar findings', () => {
  it('takes a slot filled by only one chunk', () => {
    const { note, conflicts } = mergeChunkNotes([
      chunk(0, { nrt: { hta: null, foundation: null } as never }),
      chunk(1, { nrt: { hta: '68', foundation: null } as never }),
    ]);
    expect((note.nrt as Record<string, unknown>).hta).toBe('68');
    expect(conflicts).toHaveLength(0);
  });

  it('reports disagreeing readings rather than picking one quietly', () => {
    const { note, conflicts } = mergeChunkNotes([
      chunk(0, { nrt: { hta: 'negative' } as never }),
      chunk(1, { nrt: { hta: 'positive' } as never }),
    ]);
    // Later reading wins (usually a re-test) — but it is reported either way.
    expect((note.nrt as Record<string, unknown>).hta).toBe('positive');
    expect(conflicts).toContainEqual({
      path: 'nrt.hta',
      chosen: 'positive',
      candidates: ['negative', 'positive'],
    });
  });

  it('recurses into nested findings groups', () => {
    const { note, conflicts } = mergeChunkNotes([
      chunk(0, { nrt: { foundation: { hta: 'negative', art_cns: null } } as never }),
      chunk(1, { nrt: { foundation: { hta: 'negative', art_cns: 'clear' } } as never }),
    ]);
    const foundation = (note.nrt as { foundation: Record<string, unknown> }).foundation;
    expect(foundation.hta).toBe('negative');
    expect(foundation.art_cns).toBe('clear');
    expect(conflicts).toHaveLength(0);
  });
});

describe('mergeChunkNotes — evidence re-pathing', () => {
  it('remaps array paths onto the merged arrays', () => {
    // Chunk 1's "concerns.0" points into CHUNK 1's array. Left unremapped it
    // would point at the wrong finding after the merge — worse than no quote,
    // since the whole value of provenance is that it can be trusted.
    const { note } = mergeChunkNotes([
      chunk(0, {
        concerns: ['gallbladder pain'],
        evidence: [{ path: 'concerns.0', quote: 'the gallbladder pain', at_seconds: 10 }],
      }),
      chunk(1, {
        concerns: ['waking in panic'],
        evidence: [{ path: 'concerns.0', quote: 'I wake up in panic', at_seconds: 700 }],
      }),
    ]);
    expect(note.concerns).toEqual(['gallbladder pain', 'waking in panic']);
    const byQuote = Object.fromEntries((note.evidence ?? []).map((e) => [e.quote, e.path]));
    expect(byQuote['the gallbladder pain']).toBe('concerns.0');
    expect(byQuote['I wake up in panic']).toBe('concerns.1');
  });

  it('keeps stable scalar paths untouched', () => {
    const { note } = mergeChunkNotes([
      chunk(1, {
        nrt: { hta: '68' } as never,
        evidence: [{ path: 'nrt.hta', quote: 'HTA is 68', at_seconds: 400 }],
      }),
    ]);
    expect(note.evidence?.[0].path).toBe('nrt.hta');
  });

  it('drops evidence whose finding lost the dedupe', () => {
    const { note } = mergeChunkNotes([
      chunk(0, {
        concerns: ['gallbladder pain is back'],
        evidence: [{ path: 'concerns.0', quote: 'gallbladder pain is back', at_seconds: 10 }],
      }),
      chunk(1, {
        concerns: ['the gallbladder pain is back'],
        evidence: [{ path: 'concerns.0', quote: 'the gallbladder pain is back', at_seconds: 20 }],
      }),
    ]);
    expect(note.concerns).toHaveLength(1);
    // Every surviving quote points at a concern that actually exists.
    for (const e of note.evidence ?? []) {
      const idx = Number(e.path.split('.')[1]);
      expect(idx).toBeLessThan(note.concerns!.length);
    }
  });
});

describe('mergeStages', () => {
  it('combines disjoint stage outputs and concatenates their evidence', () => {
    const note = mergeStages([
      { concerns: ['a'], evidence: [{ path: 'concerns.0', quote: 'a', at_seconds: null }] },
      { supplements: [supp({ name: 'Beta Plus' })], evidence: [{ path: 'supplements.0', quote: 'b', at_seconds: null }] },
      { nrt: { hta: '1' } as never },
    ]);
    expect(note.concerns).toEqual(['a']);
    expect(note.supplements).toHaveLength(1);
    expect(note.evidence).toHaveLength(2);
  });
});
