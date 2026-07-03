import { pool } from '../db/pool';
import { logEvent, logError } from '../observability/logger';

// WF4 — Refill projection. Turn each client's supplements (dose, qty, start
// date) into a projected run-out date and upsert it onto `refills.due_date`, so
// the daily digest can surface who is running low. Pure math lives in
// `computeRunOut`/`parseDailyDose` (unit-tested); `projectRefills` is the DB
// pass the nightly scheduler runs.

export interface SupplementInput {
  dose?: string | null; // e.g. "2 caps twice daily", "400mg"
  qty?: number | null; // units in the bottle Nicole dispensed / ordered
  start_date?: string | Date | null;
}

export interface RunOut {
  /** ISO date (yyyy-mm-dd) the supply is projected to run out, or null if it can't be projected. */
  dueDate: string | null;
  /** Units consumed per day (unitsPerDose × dosesPerDay). */
  perDay: number;
  /** Whole days the bottle lasts, or null when qty is missing. */
  daysSupply: number | null;
}

const FREQUENCY: ReadonlyArray<[RegExp, number]> = [
  [/\b(?:tid|three times|thrice|3\s*x)\b/, 3],
  [/\b(?:bid|twice|two times|2\s*x)\b/, 2],
  [/\b(?:every other day|eod|alternate days?)\b/, 0.5],
  [/\b(?:qd|once|one time|1\s*x|daily|per day|a day|nightly|each morning|each night)\b/, 1],
];

/**
 * Estimate units consumed per day from a free-text dose. Multiplies the leading
 * unit count ("2 caps") by the daily frequency ("twice daily" → 2). Unknown
 * frequency defaults to once daily; unknown unit count defaults to 1. Never
 * returns <= 0 (callers divide by it).
 */
export function parseDailyDose(dose: string | null | undefined): number {
  if (!dose) return 1;
  const s = dose.toLowerCase();

  // Leading unit count before a form word ("2 capsules", "3 tabs", "1 scoop").
  const unitMatch = s.match(/(\d+(?:\.\d+)?)\s*(?:caps?|capsules?|tab(?:let)?s?|pills?|softgels?|scoops?|gummies|drops?)\b/);
  const unitsPerDose = unitMatch ? Number(unitMatch[1]) : 1;

  let dosesPerDay = 1;
  for (const [re, n] of FREQUENCY) {
    if (re.test(s)) {
      dosesPerDay = n;
      break;
    }
  }

  const perDay = unitsPerDose * dosesPerDay;
  return perDay > 0 ? perDay : 1;
}

function toDate(v: string | Date | null | undefined): Date | null {
  if (!v) return null;
  const d = v instanceof Date ? v : new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * Project a supply's run-out date: days_supply = floor(qty / perDay), run-out =
 * start_date + days_supply days. Returns dueDate=null when qty or start_date is
 * missing (nothing to project) — perDay is still reported for diagnostics.
 */
export function computeRunOut(supp: SupplementInput): RunOut {
  const perDay = parseDailyDose(supp.dose);
  const start = toDate(supp.start_date ?? null);
  const qty = typeof supp.qty === 'number' && supp.qty > 0 ? supp.qty : null;

  if (qty === null || start === null) return { dueDate: null, perDay, daysSupply: null };

  const daysSupply = Math.floor(qty / perDay);
  const runOut = new Date(start);
  runOut.setUTCDate(runOut.getUTCDate() + daysSupply);
  return { dueDate: runOut.toISOString().slice(0, 10), perDay, daysSupply };
}

export interface ProjectionResult {
  scanned: number;
  projected: number; // rows we could compute a due_date for and upserted
  skipped: number; // missing qty/start_date
}

/**
 * Nightly pass: read every supplement, compute its run-out, and upsert a
 * `refills` row (one per supplement). Idempotent — re-running only refreshes
 * `due_date`; it never resets a refill Nicole has already actioned
 * (notified/snoozed/closed keep their status).
 */
export async function projectRefills(): Promise<ProjectionResult> {
  const { rows } = await pool.query<{
    id: string;
    client_id: string;
    dose: string | null;
    qty: number | null;
    start_date: string | null;
  }>(`SELECT id, client_id, dose, qty, start_date FROM supplements`);

  let projected = 0;
  let skipped = 0;

  for (const s of rows) {
    const { dueDate } = computeRunOut(s);
    if (dueDate === null) {
      skipped++;
      continue;
    }
    try {
      await pool.query(
        `INSERT INTO refills (client_id, supplement_id, due_date, status)
              VALUES ($1, $2, $3, 'pending')
         ON CONFLICT (supplement_id) WHERE supplement_id IS NOT NULL
           DO UPDATE SET due_date = EXCLUDED.due_date`,
        [s.client_id, s.id, dueDate],
      );
      projected++;
    } catch (err) {
      logError('refills.project', 'upsert failed', err, { supplement_id: s.id });
    }
  }

  logEvent('info', 'refills.project', 'refill projection complete', {
    scanned: rows.length,
    projected,
    skipped,
  });
  return { scanned: rows.length, projected, skipped };
}
