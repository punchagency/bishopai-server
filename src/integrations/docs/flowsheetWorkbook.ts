import { join } from 'node:path';
import ExcelJS from 'exceljs';
import type { FlowSheetEntry } from './types';
import {
  buildFlowSheetBlock,
  blankBlockWrites,
  blockMergeRanges,
  blockHeaderRow,
  BLOCK_ROWS,
  FIRST_DATA_BLOCK,
} from './flowsheet';

// Builds the client's whole Appointment Flow Sheet as an xlsx buffer, one block
// per session. This is the "xlsx-overwrite" Flow Sheet mode (FLOW_SHEET_AS_XLSX):
// instead of appending a block to a native Google Sheet via the Sheets API — which
// needs a scope + API this pilot hasn't enabled yet — we rebuild the file from the
// DB on each approve and overwrite it in Drive using only the drive.file scope.
// The cell layout is the same pure block logic the native path uses (flowsheet.ts).

const FLOW_TEMPLATE = join(__dirname, '../../../assets/templates/appointment-flow-sheet.xlsx');

/**
 * Rebuild the entire Flow Sheet from an ordered list of sessions (oldest first).
 * Fills block `i + FIRST_DATA_BLOCK` for `entries[i]` (leaving block 0 empty),
 * growing past the template's pre-formatted blocks when a client has more sessions.
 */
export async function buildFlowSheetXlsx(entries: FlowSheetEntry[]): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(FLOW_TEMPLATE);
  const ws = wb.worksheets[0];

  // How many blocks the template already carries, pre-formatted.
  const preformatted = Math.max(1, Math.floor(ws.rowCount / BLOCK_ROWS));

  entries.forEach((entry, i) => {
    // Start writing entries from FIRST_DATA_BLOCK (block 1), leaving block 0 empty.
    const blockIndex = i + FIRST_DATA_BLOCK;
    const grew = blockIndex >= preformatted;
    if (grew) growFlowSheetBlock(ws, blockIndex);
    const writes = grew
      ? [...blankBlockWrites(blockIndex, ws.name), ...buildFlowSheetBlock(entry, blockIndex, ws.name)]
      : buildFlowSheetBlock(entry, blockIndex, ws.name);
    for (const w of writes) {
      const a1 = w.range.includes('!') ? w.range.split('!')[1] : w.range;
      ws.getCell(a1).value = w.value;
    }
  });

  const out = await wb.xlsx.writeBuffer();
  return Buffer.from(out);
}

/**
 * Clone block 0's formatting (cell styles, row heights, merges) into a new block.
 * exceljs has no copy-paste, so we replicate style-by-style; content is reset by
 * the caller's `blankBlockWrites`. Shared with the demo sink's local append.
 */
export function growFlowSheetBlock(ws: ExcelJS.Worksheet, blockIndex: number): void {
  const srcTop = blockHeaderRow(0);
  const dstTop = blockHeaderRow(blockIndex);
  const cols = Math.max(7, ws.columnCount);

  for (let r = 0; r < BLOCK_ROWS; r++) {
    const src = ws.getRow(srcTop + r);
    const dst = ws.getRow(dstTop + r);
    dst.height = src.height;
    for (let c = 1; c <= cols; c++) {
      dst.getCell(c).style = { ...src.getCell(c).style };
    }
    dst.commit();
  }
  for (const range of blockMergeRanges(blockIndex)) {
    try { ws.unMergeCells(range); } catch { /* not yet merged — fine */ }
    ws.mergeCells(range);
  }
}
