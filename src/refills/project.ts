import { pool } from '../db/pool';
import { logEvent, logError } from '../observability/logger';
import { normalizeSupplementName } from '../session/supplementName';

// WF4 — Refill projection. Turn each client's supplements (dose, qty, start
// date) into a projected run-out date and upsert it onto `refills.due_date`, so
// the daily digest can surface who is running low. Pure math lives in
// `computeRunOut`/`parseDailyDose` (unit-tested); `projectRefills` is the DB
// pass the nightly scheduler runs.

/**
 * Per-slot dosing from `supplements.schedule` — the Daily Schedule grid on the
 * Supplement Protocol ({"uponWaking": "2 caps", "beforeBed": "1 cap"}). A slot
 * that is absent/blank means "not taken then", so the stated slots ARE the daily
 * frequency — more reliable than parsing it back out of the free-text dose.
 */
export type DoseSchedule = Record<string, string | null | undefined>;

export interface SupplementInput {
  dose?: string | null; // e.g. "2 caps twice daily", "400mg"
  qty?: number | null; // units in the bottle Nicole dispensed / ordered
  start_date?: string | Date | null;
  schedule?: DoseSchedule | null;
  /** Structured dose, when extraction captured it. The model already read
   *  "two caps twice a day"; taking the numbers from it beats regex-parsing
   *  them back out of the string here and silently defaulting to 1 on a miss. */
  units_per_dose?: number | null;
  doses_per_day?: number | null;
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
  [/\b(?:qid|four times|4\s*x)\b/, 4],
  [/\b(?:tid|three times|thrice|3\s*x)\b/, 3],
  [/\b(?:bid|twice|two times|2\s*x)\b/, 2],
  // "1 cap morning and night" / "am and pm" — two dosings stated longhand.
  [/\b(?:morning and (?:night|evening|bed)|am and pm|breakfast and dinner)\b/, 2],
  [/\b(?:every other day|eod|alternate days?)\b/, 0.5],
  [/\b(?:qd|once|one time|1\s*x|daily|per day|a day|nightly|each morning|each night)\b/, 1],
];

const FORM_WORDS = 'caps?|capsules?|tab(?:let)?s?|pills?|softgels?|scoops?|gummies|drops?|tsp|teaspoons?|tbsp|tablespoons?';

/**
 * Units in a single dosing, from text like "2 caps", "1/2 tab", "1-2 capsules".
 * A range takes the high end: the point of the projection is to warn before the
 * bottle empties, and the client taking the top of the range empties it first.
 * Returns null when no unit count is stated (the caller decides the default).
 */
function parseUnits(text: string): number | null {
  const s = text.toLowerCase().replace(/½/g, '1/2').replace(/¼/g, '1/4').replace(/\bhalf\b/g, '1/2');

  // "1-2 caps" / "1 to 2 caps" — high end.
  const range = s.match(new RegExp(String.raw`(\d+(?:\.\d+)?)\s*(?:-|–|to)\s*(\d+(?:\.\d+)?)\s*(?:${FORM_WORDS})?\b`));
  if (range) return Math.max(Number(range[1]), Number(range[2]));

  // "1/2 tab" — a fraction of a unit.
  const fraction = s.match(new RegExp(String.raw`(\d+)\s*/\s*(\d+)\s*(?:${FORM_WORDS})?\b`));
  if (fraction && Number(fraction[2]) !== 0) return Number(fraction[1]) / Number(fraction[2]);

  // "2 capsules", "3 tabs", "1 scoop" — a count attached to a form word.
  const unit = s.match(new RegExp(String.raw`(\d+(?:\.\d+)?)\s*(?:${FORM_WORDS})\b`));
  if (unit) return Number(unit[1]);

  return null;
}

/**
 * Estimate units consumed per day from a free-text dose. Multiplies the units
 * per dosing ("2 caps") by the daily frequency ("twice daily" → 2). Unknown
 * frequency defaults to once daily; unknown unit count defaults to 1. Never
 * returns <= 0 (callers divide by it).
 */
export function parseDailyDose(dose: string | null | undefined): number {
  if (!dose) return 1;
  const s = dose.toLowerCase();
  const unitsPerDose = parseUnits(s) ?? 1;

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

/**
 * Units consumed per day for a supplement, in descending order of trust:
 *
 *   1. the per-slot Daily Schedule — Nicole states it explicitly, and "2 caps
 *      upon waking, 1 before bed" is 3/day, a shape no frequency word captures;
 *   2. structured dose fields from extraction, read once from the sentence
 *      itself rather than recovered from a stringified version of it;
 *   3. regex over the free-text dose — the legacy path, still needed for rows
 *      that predate structured extraction.
 */
export function dailyUnits(
  supp: Pick<SupplementInput, 'dose' | 'schedule' | 'units_per_dose' | 'doses_per_day'>,
): number {
  const slots = Object.values(supp.schedule ?? {}).filter((v): v is string => typeof v === 'string' && v.trim() !== '');
  if (slots.length === 0) {
    const perDose = supp.units_per_dose;
    const perDay = supp.doses_per_day;
    // Only when at least one was actually stated; a pair of nulls means the
    // transcript never gave a countable dose, which is the regex path's job.
    if ((perDose != null && perDose > 0) || (perDay != null && perDay > 0)) {
      const total = (perDose ?? 1) * (perDay ?? 1);
      if (total > 0) return total;
    }
    return parseDailyDose(supp.dose);
  }
  // Every stated slot is one dosing that day; a slot with no number counts as 1.
  const perDay = slots.reduce((sum, amount) => sum + (parseUnits(amount) ?? 1), 0);
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
  const perDay = dailyUnits(supp);
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
  deduped: number; // duplicate rows (same client+supplement across sources) collapsed
}

export interface SupplementRow {
  id: string;
  client_id: string;
  name: string;
  dose: string | null;
  qty: number | null;
  start_date: string | null;
  source: string | null;
  schedule?: DoseSchedule | null;
  units_per_dose?: number | null;
  doses_per_day?: number | null;
}

// Source authority for reconciliation: the practitioner's note beats a vendor
// feed. Lower rank wins; ties break on the more recent start_date.
const SOURCE_RANK: Record<string, number> = { notes: 0, fullscript: 1, pb: 2 };
const rankOf = (s: string | null): number => SOURCE_RANK[s ?? ''] ?? 3;
// Same identity rule the plan tables key on, so cross-source dedupe collapses
// "Bio-C Plus" and "Bio C Plus" here too rather than projecting two refills.
const normName = (n: string): string => normalizeSupplementName(n) || n.trim().toLowerCase();

/**
 * Pure: from all of one client's supplement rows with the same normalized name
 * (the "same supplement seen across sources"), pick the single timeline to keep
 * — most authoritative source, then most recent start_date. Returns the winner
 * id and the ids to collapse. Exported for tests.
 */
export function pickSupplementWinner(group: SupplementRow[]): { winner: SupplementRow; loserIds: string[] } {
  const sorted = [...group].sort((a, b) => {
    const r = rankOf(a.source) - rankOf(b.source);
    if (r !== 0) return r;
    return (b.start_date ?? '').localeCompare(a.start_date ?? '');
  });
  const winner = sorted[0];
  return { winner, loserIds: sorted.slice(1).map((s) => s.id) };
}

/**
 * Nightly pass: read every supplement, compute its run-out, and upsert a
 * `refills` row (one per supplement). Idempotent — re-running only refreshes
 * `due_date`; it never resets a refill Nicole has already actioned
 * (notified/snoozed/closed keep their status).
 */
export async function projectRefills(): Promise<ProjectionResult> {
  const { rows } = await pool.query<SupplementRow>(
    `SELECT id, client_id, name, dose, qty, start_date, source, schedule,
            units_per_dose::float8 AS units_per_dose,
            doses_per_day::float8 AS doses_per_day FROM supplements`,
  );

  // Multi-source reconciliation: collapse the same supplement (client + name)
  // seen across sources into one timeline before projecting, so the digest shows
  // one refill per supplement rather than a duplicate per source.
  const groups = new Map<string, SupplementRow[]>();
  for (const s of rows) {
    const key = `${s.client_id}|${normName(s.name)}`;
    (groups.get(key) ?? groups.set(key, []).get(key)!).push(s);
  }

  let projected = 0;
  let skipped = 0;
  let deduped = 0;

  for (const group of groups.values()) {
    const { winner, loserIds } = pickSupplementWinner(group);
    deduped += loserIds.length;

    // Close any stale refills tied to the collapsed duplicates.
    if (loserIds.length > 0) {
      await pool
        .query(`UPDATE refills SET status = 'closed' WHERE supplement_id = ANY($1::uuid[]) AND status = 'pending'`, [loserIds])
        .catch((err) => logError('refills.project', 'dedupe close failed', err, { loser_ids: loserIds }));
    }

    const { dueDate } = computeRunOut(winner);
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
        [winner.client_id, winner.id, dueDate],
      );
      projected++;
    } catch (err) {
      logError('refills.project', 'upsert failed', err, { supplement_id: winner.id });
    }
  }

  logEvent('info', 'refills.project', 'refill projection complete', {
    scanned: rows.length,
    projected,
    skipped,
    deduped,
  });
  return { scanned: rows.length, projected, skipped, deduped };
}
