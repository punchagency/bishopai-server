import { driveRequest } from './client';
import type { FlowSheetEntry } from '../docs/types';
import {
  buildFlowSheetBlock,
  blankBlockWrites,
  blockHeaderRow,
  BLOCK_ROWS,
  type CellWrite,
} from '../docs/flowsheet';

// Google Sheets transport for the Appointment Flow Sheet. The file is a native
// Google Sheet with pre-formatted empty appointment blocks; we find the next
// empty block and write the session's values into it (no formatting touched, no
// rows inserted). Reuses the Drive OAuth token — this needs the
// https://www.googleapis.com/auth/spreadsheets scope granted at consent, on top
// of Drive. Same bearer/refresh mechanics as `driveRequest`.

const SHEETS = 'https://sheets.googleapis.com/v4/spreadsheets';

interface SheetMeta {
  sheetId: number;
  title: string;
  rowCount: number;
}

/** First sheet's id/title/row count (blocks live on the first sheet). */
async function firstSheetMeta(spreadsheetId: string): Promise<SheetMeta> {
  const res = await driveRequest<{
    sheets?: {
      properties?: { sheetId?: number; title?: string; gridProperties?: { rowCount?: number } };
    }[];
  }>(`${SHEETS}/${spreadsheetId}?fields=sheets(properties(sheetId,title,gridProperties(rowCount)))`);
  const props = res.sheets?.[0]?.properties;
  return {
    sheetId: props?.sheetId ?? 0,
    title: props?.title ?? 'Sheet1',
    rowCount: props?.gridProperties?.rowCount ?? 0,
  };
}

/** A1 range → the GridRange the Sheets batchUpdate API wants (0-based, end-exclusive). */
function blockGrid(sheetId: number, blockIndex: number): {
  sheetId: number;
  startRowIndex: number;
  endRowIndex: number;
  startColumnIndex: number;
  endColumnIndex: number;
} {
  const start = blockHeaderRow(blockIndex) - 1; // 0-based
  return {
    sheetId,
    startRowIndex: start,
    endRowIndex: start + BLOCK_ROWS,
    startColumnIndex: 0,
    endColumnIndex: 7, // A–G
  };
}

/**
 * Grow the sheet by one appointment block. The template ships with a fixed number
 * of pre-formatted blocks; once they're all used we manufacture the next one
 * rather than failing a session. Formatting (borders, merges, row heights) is
 * replicated by copy-pasting block 0 — the cheapest way to clone the template's
 * look — and its inherited *content* is then reset to the blank-template state by
 * the caller's `blankBlockWrites`.
 */
async function growBlock(spreadsheetId: string, meta: SheetMeta, blockIndex: number): Promise<void> {
  const neededRows = blockHeaderRow(blockIndex) + BLOCK_ROWS - 1;
  const requests: unknown[] = [];

  if (meta.rowCount < neededRows) {
    requests.push({
      appendDimension: {
        sheetId: meta.sheetId,
        dimension: 'ROWS',
        length: neededRows - meta.rowCount,
      },
    });
  }

  // PASTE_NORMAL carries values, formats AND merges — merges are why we copy a
  // whole block instead of only its formatting.
  requests.push({
    copyPaste: {
      source: blockGrid(meta.sheetId, 0),
      destination: blockGrid(meta.sheetId, blockIndex),
      pasteType: 'PASTE_NORMAL',
    },
  });

  await driveRequest(`${SHEETS}/${spreadsheetId}:batchUpdate`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ requests }),
  });

  meta.rowCount = Math.max(meta.rowCount, neededRows);
}

/** The DATE-cell value of each pre-formatted block, indexed by block (0-based). */
async function scanBlockDates(spreadsheetId: string, meta: SheetMeta): Promise<(string | undefined)[]> {
  const range = encodeURIComponent(`${meta.title}!A1:A${meta.rowCount || 1}`);
  const res = await driveRequest<{ values?: string[][] }>(
    `${SHEETS}/${spreadsheetId}/values/${range}?majorDimension=COLUMNS`,
  );
  const col = res.values?.[0] ?? [];
  const blocks = Math.max(1, Math.floor(meta.rowCount / BLOCK_ROWS));
  return Array.from({ length: blocks }, (_, b) => {
    const val = col[blockHeaderRow(b)]; // date cell = header + 1 (1-based) = index header (0-based)
    return val === '' ? undefined : val;
  });
}

export interface AppendResult {
  blockIndex: number;
  headerRow: number;
  cellsWritten: number;
  /** True when a block for this date already existed — nothing was written. */
  alreadyPresent?: boolean;
  /** True when the sheet had to be grown past its pre-formatted blocks. */
  grew?: boolean;
}

/**
 * Append one appointment into the next empty block, growing the sheet when the
 * template's pre-formatted blocks run out. Idempotent by date: if a block already
 * carries this entry's DATE, it's a no-op (guards against a retried/replayed publish).
 */
export async function appendFlowSheetEntry(
  spreadsheetId: string,
  entry: FlowSheetEntry,
): Promise<AppendResult> {
  const meta = await firstSheetMeta(spreadsheetId);
  const dates = await scanBlockDates(spreadsheetId, meta);

  const existing = dates.findIndex((d) => d === entry.date);
  if (existing >= 0) {
    return { blockIndex: existing, headerRow: blockHeaderRow(existing), cellsWritten: 0, alreadyPresent: true };
  }

  // Next empty pre-formatted block, or — when they're all used — a brand new one.
  let blockIndex = dates.findIndex((d) => d === undefined);
  let grew = false;
  if (blockIndex < 0) {
    blockIndex = dates.length;
    await growBlock(spreadsheetId, meta, blockIndex);
    grew = true;
  }

  // A grown block is a copy of block 0, so its inherited content must be reset to
  // the blank template before the session's values land on top.
  const entryWrites = buildFlowSheetBlock(entry, blockIndex, meta.title);
  const writes: CellWrite[] = grew
    ? mergeWrites(blankBlockWrites(blockIndex, meta.title), entryWrites)
    : entryWrites;

  await driveRequest(`${SHEETS}/${spreadsheetId}/values:batchUpdate`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      valueInputOption: 'RAW',
      data: writes.map((w) => ({ range: w.range, values: [[w.value]] })),
    }),
  });

  return { blockIndex, headerRow: blockHeaderRow(blockIndex), cellsWritten: writes.length, grew };
}

/** Overlay `over` onto `base`, last write per cell wins (entry beats blank scaffold). */
function mergeWrites(base: CellWrite[], over: CellWrite[]): CellWrite[] {
  const byRange = new Map(base.map((w) => [w.range, w]));
  for (const w of over) byRange.set(w.range, w);
  return [...byRange.values()];
}
