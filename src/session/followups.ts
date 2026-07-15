import type { SessionNote } from './extract';

// follow_ups is a union: notes written before tasks existed hold bare strings,
// new ones hold {text, due_in_days}. Everything downstream reads through here so
// neither shape leaks past this file.

export interface FollowUp {
  text: string;
  dueInDays: number | null;
}

type RawFollowUp = SessionNote['follow_ups'][number];

export function normalizeFollowUps(raw: readonly RawFollowUp[] | undefined): FollowUp[] {
  if (!raw) return [];
  return raw
    .map((f): FollowUp => (typeof f === 'string' ? { text: f, dueInDays: null } : { text: f.text, dueInDays: f.due_in_days }))
    .map((f) => ({ ...f, text: f.text.trim() }))
    .filter((f) => f.text.length > 0);
}

/** The rendering view: the note, the Flow Sheet and the protocol only want text. */
export function followUpTexts(raw: readonly RawFollowUp[] | undefined): string[] {
  return normalizeFollowUps(raw).map((f) => f.text);
}

/**
 * A follow-up's due date, anchored to the session it came out of — not to now().
 * A note approved three days late still means "four weeks from the appointment".
 * Returns null when no timeframe was spoken; an undated task is a real outcome.
 */
export function dueDateFrom(sessionDate: Date, dueInDays: number | null): string | null {
  if (dueInDays === null || !Number.isFinite(dueInDays)) return null;
  const d = new Date(sessionDate);
  d.setUTCDate(d.getUTCDate() + dueInDays);
  return d.toISOString().slice(0, 10);
}
