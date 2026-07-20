// Shared shapes for filling Nicole's per-client doc templates after a session.
// Field values originate from the Bee-transcript → extraction pipeline.
//
// Three doc types, three update models (see integrations/docs/index.ts):
//   ROF            docx  — fill-once at intake (binary, docxtemplater)
//   Supplement     xlsx  — new dated version per protocol change (binary, exceljs)
//   Flow Sheet     Sheet — append a block per session (native Google Sheet)

/** One supplement line on the Daily Schedule grid (rows 5–21, cols B–L). */
export interface SupplementRow {
  /** B: product name. */
  name: string;
  /** C: Special Instructions. */
  specialInstructions?: string;
  /** D–J: an "X"/dose marker per time-of-day column. Blank = not taken then. */
  schedule?: Partial<Record<ScheduleSlot, string>>;
  /** K: Bottle Quantity. */
  bottleQuantity?: string | number;
  /** L: where the client obtains it. */
  source?: 'Here' | 'Fullscript' | string;
}

export type ScheduleSlot =
  | 'uponWaking'
  | 'breakfast'
  | 'midMorning'
  | 'lunch'
  | 'midAfternoon'
  | 'dinner'
  | 'beforeBed';

export interface SupplementProtocolData {
  rows: SupplementRow[];
  /** Free-text NOTES block (merged cell under the grid). */
  notes?: string;
  /** Free-text TO DO block (merged cell under the grid). */
  toDo?: string;
}

/** One line of the ROF's Initial Protocol table (Supplement | Dosage | Function). */
export interface ProtocolLine {
  supplement: string;
  dosage: string;
  function: string;
}

/** Lifestyle-log notes for the Flow Sheet's NOTES column (each a pre-labelled,
 *  merged 2-row cell in column B). Provide only what the session captured. */
export interface FlowSheetNotes {
  bm?: string;
  sleep?: string;
  water?: string;
  cycle?: string;
  exercise?: string;
  diet?: string;
}

/**
 * One appointment's worth of the Flow Sheet — appended as a 13-row block per
 * session. The template ships with pre-formatted empty blocks; we fill the next
 * one's cells (merges/borders already exist), so this carries values only.
 */
export interface FlowSheetEntry {
  /** DATE column (merged down the block). */
  date: string;
  /** SYMPTOMS column (merged). */
  symptoms?: string;
  /** FOUNDATION column: the prompt scaffold with each captured finding written
   *  onto its own prompt line (see renderFoundation). Prompts the session never
   *  covered stay bare, for Nicole to fill in-session. */
  foundation?: string;
  /** BODY SCAN column, same prompt-scaffold treatment (see renderBodyScan). */
  bodyScan?: string;
  /** PROTOCOL column free text. */
  protocol?: string;
  /** "Virtual" column (e.g. "Y"/"N"). */
  virtual?: string;
  /** Lifestyle log written after the pre-set BM:/SLEEP:/… labels. */
  notes?: FlowSheetNotes;
}

/** Report of Findings — fill-once at intake. Boilerplate is fixed in the template. */
export interface RofData {
  name: string;
  /** Formatted date string as it should appear (caller controls the format). */
  date: string;
  symptoms?: string;
  goals?: string;
  /** NRT findings. */
  pulse0?: string;
  priority1?: string;
  k27?: string;
  stressors?: string;
  /** Initial Protocol table rows. */
  protocol?: ProtocolLine[];
}
