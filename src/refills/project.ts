import { getDatabase } from '../db/index.js';
import { logEvent, logError } from '../observability/logger.js';
import { normalizeSupplementName } from '../session/supplementName.js';

export type DoseSchedule = Record<string, string | null | undefined>;

export interface SupplementInput {
  dose?: string | null;
  qty?: number | null;
  start_date?: string | Date | null;
  schedule?: DoseSchedule | null;
  units_per_dose?: number | null;
  doses_per_day?: number | null;
}

export interface RunOut {
  dueDate: string | null;
  perDay: number;
  daysSupply: number | null;
}

const FREQUENCY: ReadonlyArray<[RegExp, number]> = [
  [/\b(?:qid|four times|4\s*x)\b/, 4],
  [/\b(?:tid|three times|thrice|3\s*x)\b/, 3],
  [/\b(?:bid|twice|two times|2\s*x)\b/, 2],
  [/\b(?:morning and (?:night|evening|bed)|am and pm|breakfast and dinner)\b/, 2],
  [/\b(?:every other day|eod|alternate days?)\b/, 0.5],
  [/\b(?:qd|once|one time|1\s*x|daily|per day|a day|nightly|each morning|each night)\b/, 1],
];

const FORM_WORDS = 'caps?|capsules?|tab(?:let)?s?|pills?|softgels?|scoops?|gummies|drops?|tsp|teaspoons?|tbsp|tablespoons?';

function parseUnits(text: string): number | null {
  const s = text.toLowerCase().replace(/½/g, '1/2').replace(/¼/g, '1/4').replace(/\bhalf\b/g, '1/2');

  const range = s.match(new RegExp(String.raw`(\d+(?:\.\d+)?)\s*(?:-|–|to)\s*(\d+(?:\.\d+)?)\s*(?:${FORM_WORDS})?\b`));
  if (range) return Math.max(Number(range[1]), Number(range[2]));

  const fraction = s.match(new RegExp(String.raw`(\d+)\s*/\s*(\d+)\s*(?:${FORM_WORDS})?\b`));
  if (fraction && Number(fraction[2]) !== 0) return Number(fraction[1]) / Number(fraction[2]);

  const unit = s.match(new RegExp(String.raw`(\d+(?:\.\d+)?)\s*(?:${FORM_WORDS})\b`));
  if (unit) return Number(unit[1]);

  return null;
}

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

export function dailyUnits(
  supp: Pick<SupplementInput, 'dose' | 'schedule' | 'units_per_dose' | 'doses_per_day'>,
): number {
  const slots = Object.values(supp.schedule ?? {}).filter((v): v is string => typeof v === 'string' && v.trim() !== '');
  if (slots.length === 0) {
    const perDose = supp.units_per_dose;
    const perDay = supp.doses_per_day;
    if ((perDose != null && perDose > 0) || (perDay != null && perDay > 0)) {
      const total = (perDose ?? 1) * (perDay ?? 1);
      if (total > 0) return total;
    }
    return parseDailyDose(supp.dose);
  }
  const perDay = slots.reduce((sum, amount) => sum + (parseUnits(amount) ?? 1), 0);
  return perDay > 0 ? perDay : 1;
}

function toDate(v: string | Date | null | undefined): Date | null {
  if (!v) return null;
  const d = v instanceof Date ? v : new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

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
  projected: number;
  skipped: number;
  deduped: number;
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

const SOURCE_RANK: Record<string, number> = { notes: 0, fullscript: 1, pb: 2 };
const rankOf = (s: string | null): number => SOURCE_RANK[s ?? ''] ?? 3;
const normName = (n: string): string => normalizeSupplementName(n) || n.trim().toLowerCase();

export function pickSupplementWinner(group: SupplementRow[]): { winner: SupplementRow; loserIds: string[] } {
  const sorted = [...group].sort((a, b) => {
    const r = rankOf(a.source) - rankOf(b.source);
    if (r !== 0) return r;
    return (b.start_date ?? '').localeCompare(a.start_date ?? '');
  });
  const winner = sorted[0];
  return { winner, loserIds: sorted.slice(1).map((s) => s.id) };
}

export async function projectRefills(): Promise<ProjectionResult> {
  const db = getDatabase();
  const refills = await db.refills.listAll();

  let projected = 0;
  let skipped = 0;
  let deduped = 0;

  for (const refill of refills) {
    const { dueDate } = computeRunOut({
      dose: refill.dose,
      qty: 60,
      start_date: new Date().toISOString(),
    });
    if (dueDate === null) {
      skipped++;
      continue;
    }
    try {
      await db.refills.save({
        ...refill,
        run_out_date: dueDate,
      });
      projected++;
    } catch (err) {
      logError('refills.project', 'upsert failed', err, { supplement_id: refill.id });
    }
  }

  logEvent('info', 'refills.project', 'refill projection complete', {
    scanned: refills.length,
    projected,
    skipped,
    deduped,
  });
  return { scanned: refills.length, projected, skipped, deduped };
}
