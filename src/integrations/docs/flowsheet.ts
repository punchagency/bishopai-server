import type { FlowSheetEntry } from './types';

// Nicole's Appointment Flow Sheet is a native Google Sheet (unlike the ROF/
// Supplement binary fills). It's a running log: one 13-row block per appointment,
// repeated down the sheet. The template ships with pre-formatted empty blocks —
// header row + 12 data rows with merges, borders, and the FOUNDATION/BODY SCAN
// scaffolds already in place. So appending a session means writing values into
// the next empty block's cells; we never recreate formatting or insert rows.
//
// This module is the pure "renderer": given an appointment and a target block, it
// returns the list of A1 cell writes. The transport (find the next empty block,
// apply via the Sheets API, dry-run gate) lives in the Drive integration.

/** Rows per appointment block: 1 header + 12 data rows. */
export const BLOCK_ROWS = 13;

// Column B carries pre-set lifestyle labels on merged 2-row cells. We prepend the
// label so a written note reads e.g. "BM: regular" and matches the blank template.
const NOTE_LABEL = {
  bm: 'BM: ',
  sleep: 'SLEEP:',
  water: 'WATER:',
  cycle: 'CYCLE:',
  exercise: 'EXERCISE:',
  diet: 'DIET:',
} as const;

// The FOUNDATION (col D) and BODY SCAN (col E) cells hold a fixed scaffold of
// muscle-testing prompts. Each prompt is a slot: when the session captured a
// finding for it we write the value onto that prompt's own line, so Nicole reads
// "HTA: 68" where she expects it and a bare "HTA POST RUN:" tells her at a glance
// that prompt was never called. The prompt text is preserved either way.
//
// A line is either a blank spacer, a bare heading, or a prompt bound to a findings
// key. The scaffold constants below are DERIVED from these specs, so the blank
// template and the filled version can never drift apart.
interface ScaffoldLine {
  /** Literal prompt text, including the template's own trailing spaces. */
  text: string;
  /** Findings key whose value fills this line, when the line is a prompt. */
  key?: string;
}

const FOUNDATION_LINES: ScaffoldLine[] = [
  { text: 'LAYING 1 FOUNDATIONS:', key: 'laying1' },
  { text: '' },
  { text: '' },
  { text: 'STANDING FOUNDATIONS: ', key: 'standing' },
  { text: '' },
  { text: 'HTA:', key: 'hta' },
  { text: 'HTA POST RUN:', key: 'hta_post_run' },
  { text: '' },
  { text: 'LAYING 2 FOUNDATIONS: ', key: 'laying2' },
  { text: '' },
  { text: 'ART' },
  { text: 'OPEN: ', key: 'art_open' },
  { text: 'SWITCH: ', key: 'art_switch' },
  { text: 'CNS:', key: 'art_cns' },
  { text: 'DENTAL: ', key: 'art_dental' },
  { text: 'HORMONAL: ', key: 'art_hormonal' },
  { text: '' },
  { text: 'ADDITIONAL:', key: 'additional' },
];

const BODY_SCAN_LINES: ScaffoldLine[] = [
  { text: 'ART W/ POL' },
  { text: '' },
  { text: 'ECTODERM:', key: 'art_ectoderm' },
  { text: 'PRIORITY:', key: 'art_priority' },
  { text: 'MATRIX:', key: 'art_matrix' },
  { text: 'CELL:', key: 'art_cell' },
  { text: '' },
  { text: 'ADDITIONAL ART:', key: 'additional_art' },
  { text: '' },
  { text: 'NRT W/O POL' },
  { text: '' },
  { text: 'BODY SCAN:' },
  { text: 'PRIORITY:', key: 'scan_priority' },
  { text: 'MATRIX:', key: 'scan_matrix' },
  { text: 'CELL: ', key: 'scan_cell' },
  { text: '' },
  { text: 'ADDITIONAL NRT: ', key: 'additional_nrt' },
];

/** Findings keyed by scaffold slot; a null/absent value leaves the prompt bare. */
export type ScaffoldFindings = Record<string, string | null | undefined>;

function renderScaffold(lines: ScaffoldLine[], findings?: ScaffoldFindings | null): string {
  return lines
    .map((line) => {
      const value = line.key ? findings?.[line.key]?.trim() : undefined;
      if (!value) return line.text;
      // The template's own prompts carry inconsistent trailing spaces; respect
      // whatever is there rather than normalising it away.
      return line.text.endsWith(' ') ? `${line.text}${value}` : `${line.text} ${value}`;
    })
    .join('\n');
}

/** The blank prompt scaffolds, exactly as the template spells them. */
export const FOUNDATION_SCAFFOLD = renderScaffold(FOUNDATION_LINES);
export const BODY_SCAN_SCAFFOLD = renderScaffold(BODY_SCAN_LINES);

/** Fill the FOUNDATION prompts (col D) with this session's findings. */
export function renderFoundation(findings?: ScaffoldFindings | null): string {
  return renderScaffold(FOUNDATION_LINES, findings);
}

/** Fill the BODY SCAN prompts (col E) with this session's findings. */
export function renderBodyScan(findings?: ScaffoldFindings | null): string {
  return renderScaffold(BODY_SCAN_LINES, findings);
}

/** A single cell write: an A1 reference (sheet-qualified) and its value. */
export interface CellWrite {
  range: string;
  value: string;
}

/** 1-based row of a block's header, for the block at `blockIndex` (0-based). */
export function blockHeaderRow(blockIndex: number): number {
  return 1 + blockIndex * BLOCK_ROWS;
}

/** The block's header labels, A→G, exactly as the template spells them. */
export const HEADER_LABELS = ['DATE', 'NOTES', 'SYMPTOMS', 'FOUNDATION', 'BODY SCAN', 'PROTOCOL', 'Virtual '];

/** Data-row offsets (from the header row) of column B's merged label pairs. */
const NOTE_OFFSET: Record<keyof typeof NOTE_LABEL, number> = {
  bm: 1,
  sleep: 3,
  water: 5,
  cycle: 7,
  exercise: 9,
  diet: 11,
};

/**
 * The merge ranges that make up one block: A/C/D/E/G span all 12 data rows, and
 * column B is six 2-row label pairs. (F — PROTOCOL — is deliberately unmerged in
 * the template.) Used when growing the sheet past its pre-formatted blocks.
 */
export function blockMergeRanges(blockIndex: number): string[] {
  const first = blockHeaderRow(blockIndex) + 1;
  const last = first + BLOCK_ROWS - 2; // 12 data rows
  const spans = ['A', 'C', 'D', 'E', 'G'].map((c) => `${c}${first}:${c}${last}`);
  const pairs = Object.values(NOTE_OFFSET).map((o) => {
    const top = blockHeaderRow(blockIndex) + o;
    return `B${top}:B${top + 1}`;
  });
  return [...spans, ...pairs];
}

/**
 * The cell writes for a *pristine, empty* block: the header row, column B's
 * lifestyle labels, and the FOUNDATION/BODY SCAN scaffolds — plus explicit blanks
 * for the value columns. Needed when we grow the sheet: a new block is created by
 * copying an existing (already filled) one for its formatting, so its content must
 * be reset to the blank-template state before the session's values go in.
 */
export function blankBlockWrites(blockIndex: number, sheetTitle = 'Sheet1'): CellWrite[] {
  const header = blockHeaderRow(blockIndex);
  const first = header + 1;
  const q = (a1: string): string => `${sheetTitle}!${a1}`;
  const writes: CellWrite[] = [];

  HEADER_LABELS.forEach((label, i) => {
    writes.push({ range: q(`${String.fromCharCode(65 + i)}${header}`), value: label });
  });

  // Clear the value columns inherited from the copied block.
  for (const col of ['A', 'C', 'F', 'G']) writes.push({ range: q(`${col}${first}`), value: '' });

  writes.push({ range: q(`D${first}`), value: FOUNDATION_SCAFFOLD });
  writes.push({ range: q(`E${first}`), value: BODY_SCAN_SCAFFOLD });

  for (const [key, offset] of Object.entries(NOTE_OFFSET) as [keyof typeof NOTE_LABEL, number][]) {
    writes.push({ range: q(`B${header + offset}`), value: NOTE_LABEL[key] });
  }

  return writes;
}

/**
 * Build the cell writes that fill one appointment block. `blockIndex` is 0-based
 * (block 0 = rows 1–13). `sheetTitle` qualifies the A1 ranges. Only cells the
 * entry actually carries are emitted, so blank template scaffolds stay intact.
 */
export function buildFlowSheetBlock(
  entry: FlowSheetEntry,
  blockIndex: number,
  sheetTitle = 'Sheet1',
): CellWrite[] {
  const header = blockHeaderRow(blockIndex);
  const first = header + 1; // first data row (values live on the merge masters)
  const q = (a1: string): string => `${sheetTitle}!${a1}`;
  const writes: CellWrite[] = [];
  const put = (a1: string, value: string | undefined): void => {
    if (value !== undefined && value !== '') writes.push({ range: q(a1), value });
  };

  // Block-spanning merged columns (value on the top data row).
  put(`A${first}`, entry.date);
  put(`C${first}`, entry.symptoms);
  put(`F${first}`, entry.protocol);
  put(`G${first}`, entry.virtual);

  // FOUNDATION / BODY SCAN arrive already rendered against their prompt scaffolds
  // (see renderFoundation / renderBodyScan) — the prompts are inside the value.
  put(`D${first}`, entry.foundation);
  put(`E${first}`, entry.bodyScan);

  // Lifestyle log — column B labels sit on merged pairs at data rows 1,3,5,7,9,11.
  const notes = entry.notes ?? {};
  for (const [key, offset] of Object.entries(NOTE_OFFSET) as [keyof typeof NOTE_LABEL, number][]) {
    const val = notes[key]?.trim();
    if (val) {
      // The template's labels carry inconsistent trailing spaces ('BM: ' vs
      // 'SLEEP:'); honour each one rather than emitting a double space.
      const label = NOTE_LABEL[key];
      put(`B${header + offset}`, label.endsWith(' ') ? `${label}${val}` : `${label} ${val}`);
    }
  }

  return writes;
}
