import { join } from 'node:path';
import ExcelJS from 'exceljs';
import type { ScheduleSlot, SupplementProtocolData } from './types';

// Fill Nicole's Supplement Protocol template (xlsx) with a session's protocol.
// Binary fidelity: we load HER workbook and only write cell values, so every
// border/fill/merge/brand style survives untouched. A fresh copy is produced
// per call — she versions protocols by date rather than overwriting, so callers
// name the output with the date (e.g. "Initial Supplement Protocol 7_9_26.xlsx").

const TEMPLATE = join(__dirname, '../../../assets/templates/supplement-protocol.xlsx');

// Data grid: header at row 4, one supplement per row from DATA_START, NOTES/TO DO
// begin at NOTES_ROW. Columns map to the header on row 4.
const DATA_START = 5;
const NOTES_ROW = 22;
const CAPACITY = NOTES_ROW - DATA_START; // rows available before NOTES (17)

const COL = {
  name: 'B',
  specialInstructions: 'C',
  bottleQuantity: 'K',
  source: 'L',
} as const;

const SLOT_COL: Record<ScheduleSlot, string> = {
  uponWaking: 'D',
  breakfast: 'E',
  midMorning: 'F',
  lunch: 'G',
  midAfternoon: 'H',
  dinner: 'I',
  beforeBed: 'J',
};

/** Render the filled Supplement Protocol as an .xlsx buffer. */
export async function fillSupplementProtocol(data: SupplementProtocolData): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(TEMPLATE);
  const ws = wb.worksheets[0];

  // If the protocol has more lines than the template's blank rows, grow the grid
  // by duplicating the first data row (keeps its borders) just above NOTES, so
  // the NOTES/TO DO block stays intact below the data.
  const overflow = data.rows.length - CAPACITY;
  if (overflow > 0) {
    ws.duplicateRow(DATA_START, overflow, true);
  }

  data.rows.forEach((row, i) => {
    const r = DATA_START + i;
    setCell(ws, `${COL.name}${r}`, row.name);
    setCell(ws, `${COL.specialInstructions}${r}`, row.specialInstructions);
    setCell(ws, `${COL.bottleQuantity}${r}`, row.bottleQuantity);
    setCell(ws, `${COL.source}${r}`, row.source);
    if (row.schedule) {
      for (const [slot, col] of Object.entries(SLOT_COL)) {
        setCell(ws, `${col}${r}`, row.schedule[slot as ScheduleSlot]);
      }
    }
  });

  // NOTES/TO DO sit one row below the (possibly shifted) NOTES header.
  const contentRow = NOTES_ROW + Math.max(0, overflow) + 1;
  setCell(ws, `B${contentRow}`, data.notes);
  setCell(ws, `H${contentRow}`, data.toDo);

  const out = await wb.xlsx.writeBuffer();
  return Buffer.from(out);
}

function setCell(ws: ExcelJS.Worksheet, address: string, value: string | number | undefined): void {
  if (value === undefined || value === '') return;
  ws.getCell(address).value = value;
}
