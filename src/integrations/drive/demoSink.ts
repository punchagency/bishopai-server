import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import ExcelJS from 'exceljs';
import type { FlowSheetEntry } from '../docs/types';
import {
  buildFlowSheetBlock,
  blankBlockWrites,
  blockMergeRanges,
  blockHeaderRow,
  BLOCK_ROWS,
} from '../docs/flowsheet';

// Demo sink: when DEMO_OUTPUT_DIR is set, dry-run publishes ALSO write the real
// rendered files to a local folder so a presentation has tangible artifacts to
// open — filled ROF.docx / Supplement.xlsx and a Flow Sheet.xlsx that stacks a
// block per session — without any Google OAuth. Off by default (unset in tests /
// production); best-effort, never throws into the publish path.

const FLOW_TEMPLATE = join(__dirname, '../../../assets/templates/appointment-flow-sheet.xlsx');

/** The configured demo output directory, or null when the sink is disabled. */
export function demoDir(): string | null {
  return process.env.DEMO_OUTPUT_DIR?.trim() || null;
}

// Keep folder/file names filesystem-safe (client names can contain anything).
const safe = (s: string): string => s.replace(/[/\\:*?"<>|]/g, '_').trim() || 'unnamed';

/** Write a rendered binary doc under `<demoDir>/<Client>/<DocType>/<fileName>`. */
export function writeDemoBinary(clientName: string, docType: string, fileName: string, bytes: Buffer): string {
  const dir = join(demoDir()!, safe(clientName), docType);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, safe(fileName));
  writeFileSync(path, bytes);
  return path;
}

/**
 * Append a Flow Sheet block into a local xlsx (mirrors the Sheets-API append, but
 * to a file). Loads the client's accumulated demo sheet if present, else the blank
 * template, fills the next empty block, and saves. Idempotent by date.
 */
export async function appendDemoFlowSheet(clientName: string, entry: FlowSheetEntry): Promise<string> {
  const dir = join(demoDir()!, safe(clientName), 'AppointmentFlowSheet');
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${safe(clientName)} Appointment Flow Sheet.xlsx`);

  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(existsSync(path) ? path : FLOW_TEMPLATE);
  const ws = wb.worksheets[0];

  // Locate the target block: skip any block whose DATE cell is already filled
  // (idempotent by date), then take the first empty one.
  const blocks = Math.max(1, Math.floor(ws.rowCount / BLOCK_ROWS));
  let target = -1;
  for (let b = 0; b < blocks; b++) {
    const dateCell = ws.getCell(blockHeaderRow(b) + 1, 1).value; // col A, header+1
    const val = dateCell == null ? '' : String(dateCell);
    if (val === entry.date) return path; // already appended for this date
    if (val === '' && target < 0) target = b;
  }

  // Every pre-formatted block is used — manufacture the next one (mirrors the
  // Sheets-API grow path) rather than silently dropping the session.
  let grew = false;
  if (target < 0) {
    target = blocks;
    growLocalBlock(ws, target);
    grew = true;
  }

  const writes = grew
    ? [...blankBlockWrites(target, ws.name), ...buildFlowSheetBlock(entry, target, ws.name)]
    : buildFlowSheetBlock(entry, target, ws.name);
  for (const w of writes) {
    const a1 = w.range.includes('!') ? w.range.split('!')[1] : w.range;
    ws.getCell(a1).value = w.value;
  }
  await wb.xlsx.writeFile(path);
  return path;
}

/**
 * Clone block 0's formatting (cell styles, row heights, merges) into a new block.
 * exceljs has no copy-paste, so we replicate style-by-style; content is reset by
 * the caller's `blankBlockWrites`.
 */
function growLocalBlock(ws: ExcelJS.Worksheet, blockIndex: number): void {
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
  for (const range of blockMergeRanges(blockIndex)) ws.mergeCells(range);
}
