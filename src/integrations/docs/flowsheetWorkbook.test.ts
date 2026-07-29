import { describe, it, expect } from 'vitest';
import ExcelJS from 'exceljs';
import { buildFlowSheetXlsx } from './flowsheetWorkbook';
import { blockHeaderRow, BLOCK_ROWS } from './flowsheet';
import type { FlowSheetEntry } from './types';

// The xlsx-overwrite Flow Sheet mode rebuilds the whole file from the DB each
// approve. These pin the rebuild: one block per session, in order, growing past
// the template's 7 pre-formatted blocks — mirroring the demo-sink append, but as
// a from-scratch build rather than an in-place edit.

const TEMPLATE_BLOCKS = 7;

async function load(bytes: Buffer): Promise<ExcelJS.Worksheet> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(bytes as unknown as ExcelJS.Buffer);
  return wb.worksheets[0];
}

/** The DATE cell of a block (col A, first data row). */
const dateOf = (ws: ExcelJS.Worksheet, block: number): string => {
  const v = ws.getCell(blockHeaderRow(block) + 1, 1).value;
  return v == null ? '' : String(v);
};

const entry = (i: number): FlowSheetEntry => ({ date: `Session ${i}`, symptoms: `S${i}` });

describe('buildFlowSheetXlsx', () => {
  it('lays each session into its own block, in order', async () => {
    const ws = await load(await buildFlowSheetXlsx([entry(0), entry(1), entry(2)]));
    expect(dateOf(ws, 0)).toBe('Session 0');
    expect(dateOf(ws, 1)).toBe('Session 1');
    expect(dateOf(ws, 2)).toBe('Session 2');
    // Untouched template blocks stay blank.
    expect(dateOf(ws, 3)).toBe('');
  });

  it('grows past the template blocks instead of dropping later sessions', async () => {
    const entries = Array.from({ length: TEMPLATE_BLOCKS + 2 }, (_, i) => entry(i));
    const ws = await load(await buildFlowSheetXlsx(entries));

    for (let i = 0; i < TEMPLATE_BLOCKS + 2; i++) {
      expect(dateOf(ws, i)).toBe(`Session ${i}`);
    }
    // The sheet actually grew by two blocks.
    expect(ws.rowCount).toBeGreaterThanOrEqual(blockHeaderRow(TEMPLATE_BLOCKS + 1) + BLOCK_ROWS - 1);
  });

  it('gives a grown block the blank scaffold, not block 0’s values', async () => {
    const entries = Array.from({ length: TEMPLATE_BLOCKS + 1 }, (_, i) => entry(i));
    const ws = await load(await buildFlowSheetXlsx(entries));
    const grown = TEMPLATE_BLOCKS; // first manufactured block
    const header = blockHeaderRow(grown);

    expect(String(ws.getCell(header, 1).value)).toBe('DATE');
    expect(String(ws.getCell(header, 5).value)).toBe('BODY SCAN');
    expect(String(ws.getCell(header + 1, 2).value)).toContain('BM:');
    expect(String(ws.getCell(header + 1, 4).value)).toContain('FOUNDATIONS');
    // The session's own date still landed on the grown block.
    expect(dateOf(ws, grown)).toBe(`Session ${grown}`);
  });

  it('is deterministic — same entries, same bytes', async () => {
    const entries = [entry(0), entry(1)];
    const a = await buildFlowSheetXlsx(entries);
    const b = await buildFlowSheetXlsx(entries);
    // Reload both and compare the DATE cells rather than raw bytes (xlsx zips can
    // carry timestamps); the content must match block-for-block.
    const wsa = await load(a);
    const wsb = await load(b);
    expect(dateOf(wsa, 0)).toBe(dateOf(wsb, 0));
    expect(dateOf(wsa, 1)).toBe(dateOf(wsb, 1));
  });
});
