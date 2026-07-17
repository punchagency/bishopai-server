import type { SessionNote } from './extract';
import { followUpTexts } from './followups';
import type { CurrentSupplementRow } from './supplements';
import type {
  RofData,
  SupplementProtocolData,
  SupplementRow,
  FlowSheetEntry,
  ProtocolLine,
} from '../integrations/docs/types';

// Map an extracted SessionNote onto Nicole's three template shapes. The extraction
// captures the NRT findings (Pulse 0, Priority #1, K-27, stressors, foundation /
// body-scan) and the lifestyle log, so those flow through to the ROF and Flow Sheet
// here. Any field the transcript didn't state arrives null and stays blank on the
// template — deliberately, for Nicole to complete in-session. These are review
// drafts, never final clinical records.

const join = (items: string[]): string | undefined => (items.length ? items.join('; ') : undefined);

/** Null (not stated in the session) and empty string both mean "leave the cell blank". */
const text = (v: string | null | undefined): string | undefined => v?.trim() || undefined;

/** Human phrasing of a supplement change for free-text summaries. */
function describeSupplement(s: SessionNote['supplements'][number]): string {
  const verb = { start: 'Start', stop: 'Stop', increase: 'Increase', decrease: 'Decrease', continue: 'Continue' }[
    s.change
  ];
  const dose = s.dose ? ` ${s.dose}` : '';
  const qty = s.quantity != null ? ` (qty ${s.quantity})` : '';
  return `${verb} ${s.name}${dose}${qty}`.trim();
}

/** The client's running plan (accumulated across every approved session,
 *  post-sync) → Supplement Protocol grid rows. A row not touched this session
 *  is still here — the grid reflects the FULL current protocol, not just
 *  today's deltas. */
function supplementRows(current: CurrentSupplementRow[]): SupplementRow[] {
  return current.map((s) => ({
    name: s.name,
    specialInstructions: s.dose ?? undefined,
    bottleQuantity: s.qty ?? undefined,
  }));
}

/**
 * The client's current supplement plan + this note's follow-ups/changes →
 * Supplement Protocol data (new dated version per protocol change). `current`
 * must already include this session's changes merged in (real publishes call
 * this after `syncClientSupplements`; the Review UI preview merges separately
 * via `previewSupplementMerge`).
 */
export function toSupplementData(current: CurrentSupplementRow[], note: SessionNote): SupplementProtocolData {
  const toDo = note.protocol_changes.length
    ? note.protocol_changes.map((c) => c.description).join('\n')
    : undefined;
  return {
    rows: supplementRows(current),
    notes: followUpTexts(note.follow_ups).join('\n') || undefined,
    toDo,
  };
}

/** SessionNote → ROF (fill-once at intake), including the NRT findings block. */
export function toRofData(note: SessionNote, ctx: { name: string; date: string }): RofData {
  const protocol: ProtocolLine[] = note.supplements
    .filter((s) => s.change !== 'stop')
    .map((s) => ({ supplement: s.name, dosage: s.dose ?? '', function: '' }));
  const nrt = note.nrt;
  return {
    name: ctx.name,
    date: ctx.date,
    symptoms: join(note.concerns),
    goals: join(note.goals ?? []),
    pulse0: text(nrt?.pulse0),
    priority1: text(nrt?.priority1),
    k27: text(nrt?.k27),
    stressors: text(nrt?.stressors),
    protocol: protocol.length ? protocol : undefined,
  };
}

/** SessionNote → one Flow Sheet appointment block (appended per session). */
export function toFlowSheetEntry(note: SessionNote, ctx: { date: string }): FlowSheetEntry {
  const protocol = note.supplements.length
    ? note.supplements.map(describeSupplement).join('\n')
    : undefined;

  // FOUNDATION column: the muscle-testing findings when captured, else fall back to
  // the practitioner's assessments — the closest thing the transcript yields.
  const foundation =
    text(note.nrt?.foundation) ?? (note.assessments.length ? note.assessments.join('\n') : undefined);

  const ls = note.lifestyle;
  const notes = ls && {
    bm: text(ls.bm),
    sleep: text(ls.sleep),
    water: text(ls.water),
    cycle: text(ls.cycle),
    exercise: text(ls.exercise),
    diet: text(ls.diet),
  };

  return {
    date: ctx.date,
    symptoms: join(note.concerns),
    foundation,
    bodyScan: text(note.nrt?.body_scan),
    protocol,
    notes: notes && Object.values(notes).some(Boolean) ? notes : undefined,
  };
}
