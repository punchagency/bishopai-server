import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import ExcelJS from 'exceljs';
import { appendDemoFlowSheet } from './demoSink';
import { blockHeaderRow, BLOCK_ROWS } from '../docs/flowsheet';

// The template ships with 7 pre-formatted appointment blocks. A real client passes
// that inside a year, so appending an 8th must grow the sheet — not throw, and not
// silently drop the session.

let dir: string;
const prev = process.env.DEMO_OUTPUT_DIR;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'flowsheet-'));
  process.env.DEMO_OUTPUT_DIR = dir;
});

afterAll(() => {
  process.env.DEMO_OUTPUT_DIR = prev ?? '';
  rmSync(dir, { recursive: true, force: true });
});

const TEMPLATE_BLOCKS = 7;

async function load(path: string): Promise<ExcelJS.Worksheet> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(path);
  return wb.worksheets[0];
}

/** The DATE cell of a block (col A, first data row). */
const dateOf = (ws: ExcelJS.Worksheet, block: number): string => {
  const v = ws.getCell(blockHeaderRow(block) + 1, 1).value;
  return v == null ? '' : String(v);
};

describe('appendDemoFlowSheet', () => {
  it('grows past the template blocks instead of failing the 8th session', async () => {
    let path = '';
    // 9 sessions — two blocks past the template's 7.
    for (let i = 0; i < TEMPLATE_BLOCKS + 2; i++) {
      path = await appendDemoFlowSheet('Grow Test', { date: `Session ${i}`, symptoms: `S${i}` });
    }

    const ws = await load(path);

    // Every session landed on its own block, in order.
    for (let i = 0; i < TEMPLATE_BLOCKS + 2; i++) {
      expect(dateOf(ws, i)).toBe(`Session ${i}`);
    }

    // The sheet actually grew by two blocks.
    expect(ws.rowCount).toBeGreaterThanOrEqual(blockHeaderRow(TEMPLATE_BLOCKS + 1) + BLOCK_ROWS - 1);
  });

  it('gives a grown block the blank template content, not block 0’s values', async () => {
    const ws = await load(join(dir, 'Grow Test', 'AppointmentFlowSheet', 'Grow Test Appointment Flow Sheet.xlsx'));
    const grown = TEMPLATE_BLOCKS; // the 8th block — the first manufactured one
    const header = blockHeaderRow(grown);

    // Header row rebuilt.
    expect(String(ws.getCell(header, 1).value)).toBe('DATE');
    expect(String(ws.getCell(header, 5).value)).toBe('BODY SCAN');

    // Lifestyle labels restored, and the scaffold is present (not block 0's data).
    expect(String(ws.getCell(header + 1, 2).value)).toContain('BM:');
    expect(String(ws.getCell(header + 1, 4).value)).toContain('FOUNDATIONS');

    // Merges were recreated: A spans the 12 data rows of the grown block.
    const merges = Object.values(
      (ws as unknown as { _merges: Record<string, { model?: { top: number; bottom: number; left: number } }> })._merges,
    );
    const aSpan = merges.find((m) => m.model?.left === 1 && m.model?.top === header + 1);
    expect(aSpan?.model?.bottom).toBe(header + BLOCK_ROWS - 1);
  });

  it('stays idempotent by date after growing', async () => {
    const before = await load(
      join(dir, 'Grow Test', 'AppointmentFlowSheet', 'Grow Test Appointment Flow Sheet.xlsx'),
    );
    const rowsBefore = before.rowCount;

    // Replaying an already-appended session must not add a block.
    await appendDemoFlowSheet('Grow Test', { date: 'Session 8', symptoms: 'S8' });

    const after = await load(
      join(dir, 'Grow Test', 'AppointmentFlowSheet', 'Grow Test Appointment Flow Sheet.xlsx'),
    );
    expect(after.rowCount).toBe(rowsBefore);
    expect(dateOf(after, TEMPLATE_BLOCKS + 2)).toBe(''); // no 10th block created
  });
});
