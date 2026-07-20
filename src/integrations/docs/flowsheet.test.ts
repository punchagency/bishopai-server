import { describe, it, expect } from 'vitest';
import {
  buildFlowSheetBlock,
  blankBlockWrites,
  blockMergeRanges,
  blockHeaderRow,
  BLOCK_ROWS,
  FOUNDATION_SCAFFOLD,
  BODY_SCAN_SCAFFOLD,
  renderFoundation,
  renderBodyScan,
} from './flowsheet';

// A block write list is easiest to assert as a range→value map.
const asMap = (writes: { range: string; value: string }[]) =>
  Object.fromEntries(writes.map((w) => [w.range, w.value]));

describe('buildFlowSheetBlock', () => {
  it('places values on the right cells of the first block', () => {
    const writes = buildFlowSheetBlock(
      {
        date: 'Jul 9, 2026',
        symptoms: 'Fatigue',
        protocol: 'Cataplex B',
        virtual: 'Y',
        notes: { bm: 'regular', sleep: '7h', diet: 'clean' },
      },
      0,
    );
    const m = asMap(writes);
    // Block 0 header is row 1, so data starts on row 2 (the merge masters).
    expect(m['Sheet1!A2']).toBe('Jul 9, 2026');
    expect(m['Sheet1!C2']).toBe('Fatigue');
    expect(m['Sheet1!F2']).toBe('Cataplex B');
    expect(m['Sheet1!G2']).toBe('Y');
    // Lifestyle labels are prepended; rows step 1,3,…,11 down the block.
    // 'BM: ' already carries a trailing space in the template; don't add a second.
    expect(m['Sheet1!B2']).toBe('BM: regular');
    expect(m['Sheet1!B4']).toBe('SLEEP: 7h');
    expect(m['Sheet1!B12']).toBe('DIET: clean');
    // Untouched notes/columns are not emitted (blank scaffold stays intact).
    expect(m['Sheet1!B6']).toBeUndefined(); // water
    expect(m['Sheet1!D2']).toBeUndefined(); // foundation
    expect(m['Sheet1!E2']).toBeUndefined(); // body scan
  });

  it('offsets the block by 13 rows per appointment', () => {
    expect(blockHeaderRow(0)).toBe(1);
    expect(blockHeaderRow(1)).toBe(1 + BLOCK_ROWS);
    expect(blockHeaderRow(3)).toBe(40);
    const m = asMap(buildFlowSheetBlock({ date: 'x' }, 3));
    // Block 3 header = row 40, first data row = 41.
    expect(m['Sheet1!A41']).toBe('x');
  });

  it('writes the pre-rendered FOUNDATION/BODY SCAN columns and honours the sheet title', () => {
    // The prompt scaffold is rendered upstream (renderFoundation/renderBodyScan),
    // so the block builder writes the column value through untouched.
    const writes = buildFlowSheetBlock(
      { date: 'd', foundation: 'HTA: 68', bodyScan: 'MATRIX: liver' },
      0,
      'Log',
    );
    const m = asMap(writes);
    expect(m['Log!D2']).toBe('HTA: 68');
    expect(m['Log!E2']).toBe('MATRIX: liver');
  });

  describe('renderFoundation / renderBodyScan', () => {
    it('leaves every prompt bare when nothing was tested', () => {
      expect(renderFoundation(null)).toBe(FOUNDATION_SCAFFOLD);
      expect(renderBodyScan({})).toBe(BODY_SCAN_SCAFFOLD);
    });

    it('fills each finding onto its own prompt line, leaving the rest bare', () => {
      const d = renderFoundation({ hta: '68', art_cns: 'switched', art_dental: 'clear' });
      expect(d).toContain('HTA: 68');
      expect(d).toContain('CNS: switched');
      expect(d).toContain('DENTAL: clear'); // template prompt has a trailing space
      expect(d).toContain('HTA POST RUN:\n'); // untested → bare
      expect(d).toContain('LAYING 1 FOUNDATIONS:\n'); // untested → bare
      // Line count is fixed: filling values never adds or drops a prompt.
      expect(d.split('\n')).toHaveLength(FOUNDATION_SCAFFOLD.split('\n').length);
    });

    it('keeps the ART and NRT passes in their own slots', () => {
      const e = renderBodyScan({ art_matrix: 'kidney', scan_matrix: 'liver' });
      const lines = e.split('\n');
      // Two MATRIX prompts exist; each takes only its own pass's reading.
      expect(lines.filter((l) => l.startsWith('MATRIX:'))).toEqual([
        'MATRIX: kidney',
        'MATRIX: liver',
      ]);
      expect(e.split('\n')).toHaveLength(BODY_SCAN_SCAFFOLD.split('\n').length);
    });
  });

  it('emits nothing but the date for a sparse entry', () => {
    const writes = buildFlowSheetBlock({ date: 'only' }, 0);
    expect(writes).toEqual([{ range: 'Sheet1!A2', value: 'only' }]);
  });
});

// Growing the sheet past the template's 7 pre-formatted blocks: a new block is a
// copy of block 0, so its inherited content has to be reset to the blank template.
describe('blankBlockWrites', () => {
  it('restores the header, lifestyle labels and scaffolds, and clears value cells', () => {
    const m = asMap(blankBlockWrites(7)); // the first block past the template's 7
    const header = blockHeaderRow(7); // row 92
    const first = header + 1;

    expect(m[`Sheet1!A${header}`]).toBe('DATE');
    expect(m[`Sheet1!E${header}`]).toBe('BODY SCAN');
    expect(m[`Sheet1!G${header}`]).toBe('Virtual ');

    // Values copied from block 0 must be wiped, or the new appointment inherits them.
    expect(m[`Sheet1!A${first}`]).toBe('');
    expect(m[`Sheet1!C${first}`]).toBe('');
    expect(m[`Sheet1!F${first}`]).toBe('');
    expect(m[`Sheet1!G${first}`]).toBe('');

    expect(m[`Sheet1!D${first}`]).toBe(FOUNDATION_SCAFFOLD);
    expect(m[`Sheet1!E${first}`]).toBe(BODY_SCAN_SCAFFOLD);
    expect(m[`Sheet1!B${first}`]).toBe('BM: ');
    expect(m[`Sheet1!B${first + 10}`]).toBe('DIET:');
  });

  it('is overridden by the entry values written on top of it', () => {
    const blank = asMap(blankBlockWrites(7));
    const entry = asMap(buildFlowSheetBlock({ date: 'Aug 1, 2026', symptoms: 'Headaches' }, 7));
    const merged = { ...blank, ...entry };
    const first = blockHeaderRow(7) + 1;
    expect(merged[`Sheet1!A${first}`]).toBe('Aug 1, 2026');
    expect(merged[`Sheet1!C${first}`]).toBe('Headaches');
    expect(merged[`Sheet1!F${first}`]).toBe(''); // no protocol → stays cleared
  });
});

describe('blockMergeRanges', () => {
  it('reproduces the template merge structure for a grown block', () => {
    // Block 1 (rows 14–26) exists in the template, so it is the ground truth.
    const ranges = blockMergeRanges(1);
    expect(ranges).toContain('A15:A26');
    expect(ranges).toContain('C15:C26');
    expect(ranges).toContain('E15:E26');
    expect(ranges).toContain('G15:G26');
    expect(ranges).toContain('B15:B16'); // BM label pair
    expect(ranges).toContain('B25:B26'); // DIET label pair
    // F (PROTOCOL) is deliberately unmerged in the template.
    expect(ranges.some((r) => r.startsWith('F'))).toBe(false);
    expect(ranges).toHaveLength(11); // 5 spans + 6 label pairs
  });
});
