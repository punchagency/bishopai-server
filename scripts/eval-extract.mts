#!/usr/bin/env node
/**
 * Golden-set evaluation for transcript extraction.
 *
 * The thing that decays in an extraction product is ACCURACY, not types — and
 * until this existed there was no way to tell whether changing a prompt, a
 * model, or the chunking strategy made the output better or worse. The old
 * smoke script pretty-printed a note for a human to eyeball; this scores it.
 *
 * The headline number is FABRICATION RATE: of the fields the transcript never
 * states, how many did the model fill in anyway. That is the direct measurement
 * of the promise the whole pipeline is built on ("a blank is correct; a
 * fabricated value is a clinical error"), and a regression in it is a release
 * blocker regardless of what recall did.
 *
 * Usage:
 *   npm run eval:extract                 # every fixture, configured provider
 *   npm run eval:extract -- --fixture health-supplement-consultation
 *   LLM_PROVIDER=anthropic npm run eval:extract
 *   npm run eval:extract -- --json       # machine-readable, for CI
 *   npm run eval:extract -- --save       # keep each extraction under eval-runs/
 *   npm run eval:extract -- --replay     # re-score the kept extractions, no API calls
 *   npm run eval:extract -- --runs 3     # three extractions per fixture, with the spread
 *   npm run eval:extract -- --stages narrative,assessments
 *
 * --stages runs only the stages a change touches, which halves the cost of a
 * measurement. On a free tier metered per day that is not thrift: an A/B at
 * three runs a side costs more requests than a day allows, so without it the
 * comparison cannot be made at all.
 *
 * --replay is what makes the scoring safe to change. The gold matcher decides
 * what every number here MEANS, and it has been wrong in ways indistinguishable
 * from the model being wrong — but re-measuring a scoring fix used to mean
 * re-running the extraction, which on a free tier is a day's quota to answer a
 * question that involves no model at all. Extract once, score as often as the
 * rules change.
 */
import 'dotenv/config';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { STAGE_FIELDS, extractSessionNote, type StageName } from '../src/session/extract.js';
import { prepareTranscript } from '../src/session/transcript.js';
import { findUnstatedNumbers } from '../src/session/verifyNumbers.js';
import { wordingFidelity } from '../src/session/verifyEvidence.js';
import {
  MATCH_THRESHOLD,
  bestMatch,
  matchScore,
  matches,
  nameScore,
  similarity,
} from '../src/session/evalMatch.js';
import { llmConfig } from '../src/llm/config.js';
import { SessionNoteSchema, type SessionNote } from '../src/session/schema.js';

const FIXTURE_DIR = resolve(fileURLToPath(new URL('../test/fixtures/transcripts', import.meta.url)));

// --- scoring primitives ------------------------------------------------------
//
// These live in src/session/evalMatch.ts, WITH TESTS. They decide what every
// number below means, and they can be wrong in ways indistinguishable from the
// model being wrong — which is exactly what happened here: a first-past-the-post
// name match bound gold "Beta Plus" to the extracted "Livatrit Plus" (they score
// 0.5 against each other on the shared word "Plus") and reported a swapped
// supplement action, twice over, that the extraction had never made.

interface Score {
  matched: number;
  expected: number;
  extra: number;
  missing: string[];
  spurious: string[];
}

/**
 * Score a list of extracted strings against the gold list. `acceptable` items
 * are defensible-either-way readings: they neither count as a hit nor as a false
 * positive, so the eval measures accuracy rather than taste.
 */
function scoreList(got: string[], want: string[], acceptable: string[] = []): Score {
  const unclaimed = [...got];
  const missing: string[] = [];
  let matched = 0;

  for (const w of want) {
    // Best match, never first match — see evalMatch.ts.
    const i = bestMatch(unclaimed, (g) => matchScore(g, w));
    if (i === -1) missing.push(w);
    else {
      matched++;
      unclaimed.splice(i, 1);
    }
  }
  // Anything left that matches an `acceptable` entry is set aside, not penalised.
  const spurious = unclaimed.filter((g) => !acceptable.some((a) => matches(g, a)));
  return { matched, expected: want.length, extra: spurious.length, missing, spurious };
}

function get(obj: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>(
    (acc, k) => (acc && typeof acc === 'object' ? (acc as Record<string, unknown>)[k] : undefined),
    obj,
  );
}

// --- fixture shape -----------------------------------------------------------

interface Gold {
  _meta?: { complete?: boolean; notes?: string[] };
  concerns?: string[];
  concerns_acceptable?: string[];
  goals?: string[];
  goals_acceptable?: string[];
  assessments?: string[];
  assessments_acceptable?: string[];
  follow_ups?: string[];
  follow_ups_acceptable?: string[];
  supplements?: GoldSupplement[];
  supplements_acceptable?: GoldSupplement[];
  nrt?: Record<string, unknown>;
  /** Scored separately from the nrt slot walk: a list, matched by content
   *  rather than by position, and split into the category and the SOURCE so a
   *  run that finds "food" but never "food — dairy" scores as the half-answer
   *  it is. */
  stressors?: GoldStressor[];
  stressors_acceptable?: GoldStressor[];
  lifestyle?: Record<string, string>;
  expect_null?: string[];
  expect_null_acceptable?: string[];
}

interface GoldStressor {
  category: string;
  /** Null/absent means the practitioner named no specific source, and filling
   *  one in is a fabrication — scored as such, not as extra credit. */
  source?: string | null;
  body_area?: string;
}

interface GoldSupplement {
  name: string;
  change?: string;
  func?: string;
  dose_contains?: string;
  schedule_slots?: string[];
  name_variants?: string[];
}

interface FixtureReport {
  fixture: string;
  ok: boolean;
  error?: string;
  lists: Record<string, Score>;
  supplements: {
    matched: number;
    expected: number;
    extra: number;
    wrongChange: string[];
    missing: string[];
  };
  stressors: {
    matched: number;
    expected: number;
    extra: number;
    /** Found the category but missed the source the practitioner named. This is
     *  the exact complaint that prompted structured stressors, so it is counted
     *  rather than folded into a plain hit. */
    missingSource: string[];
    /** A source we produced that the transcript never named — the fabrication
     *  this field is most exposed to, since "food" begs to be narrowed. */
    inventedSource: string[];
    missing: string[];
  };
  slots: { correct: number; expected: number; wrong: string[] };
  fabrication: { filled: number; total: number; fields: string[] };
  /**
   * Findings that state a figure the transcript never states. The gold set
   * cannot catch this: an extraction can match a gold concern on every word that
   * counts and still carry a weight, a dose or a duration nobody said, because
   * the match is on overlap and the invented part is one token. Scored against
   * the transcript itself rather than against gold, so it needs no fixture
   * maintenance and works on any session.
   */
  unstated: { fields: number; detail: string[] };
  /**
   * How much of each assessment is still the practitioner's wording.
   *
   * The model rewrites clinical speech into chart-note prose by default, and
   * that rewrite passes every check we had: the cited turn is real, the quote is
   * copied out of it, and only the sentence Nicole reads has changed. Recall
   * catches the extreme case (the paraphrase no longer matches gold) and misses
   * the ordinary one. This measures it directly.
   */
  wording: { scored: number; faithful: number; worst: string[] };
  provenance: { total: number; unverified: number; missingFor: number };
  /** Substantial practitioner turns, and how many produced any finding. */
  coverage: { turns: number; read: number };
  /**
   * Fingerprint of the extraction itself, ignoring server-side bookkeeping.
   *
   * Every provider here runs at temperature 0, and some models are then
   * genuinely deterministic: three runs of this fixture came back byte for byte
   * identical. Repeating a deterministic extraction buys one answer at three
   * times the price — and, worse, prints a spread of "81% (81–81%)" that reads
   * as measured stability when nothing was measured at all.
   */
  fingerprint: string;
  /** Stages the caller deliberately did not run — their fields are not scored. */
  skipped: string[];
  /**
   * Stages the extractor never completed, straight off the note.
   *
   * A run that lost a stage is not a worse extraction, it is an ABSENT one: the
   * fields that stage fills come back empty, score zero, and look exactly like a
   * model that read the session and found nothing. That happened here — a
   * quota-exhausted key dropped the narrative and protocol stages, and the
   * harness printed "extraction failures 0/1" above a 24% recall as though it
   * had measured something. Whatever else this reports, it must never let a
   * failed run pass as a bad result.
   */
  degraded: string[];
}

// --- per-fixture evaluation --------------------------------------------------

function scoreSupplements(note: SessionNote, gold: Gold): FixtureReport['supplements'] {
  const want = gold.supplements ?? [];
  const acceptable = gold.supplements_acceptable ?? [];
  const unclaimed = [...note.supplements];
  const missing: string[] = [];
  const wrongChange: string[] = [];
  let matched = 0;

  // The production normaliser, so pack sizes and punctuation are handled the one
  // way — and scored, not thresholded, so the closest product wins.
  const nameMatches = (got: string, g: GoldSupplement): number =>
    nameScore(got, [g.name, ...(g.name_variants ?? [])]);

  for (const g of want) {
    const i = bestMatch(unclaimed, (s) => nameMatches(s.name, g));
    if (i === -1) {
      missing.push(g.name);
      continue;
    }
    const [hit] = unclaimed.splice(i, 1);
    matched++;
    // The change verb decides whether a supplement joins or leaves the client's
    // plan, so it's scored separately from merely finding the product.
    if (g.change && hit.change !== g.change) {
      wrongChange.push(`${g.name}: expected ${g.change}, got ${hit.change}`);
    }
  }
  const extra = unclaimed.filter((s) => !acceptable.some((a) => nameMatches(s.name, a) > 0)).length;
  return { matched, expected: want.length, extra, wrongChange, missing };
}

function scoreStressors(note: SessionNote, gold: Gold): FixtureReport['stressors'] {
  const want = gold.stressors ?? [];
  const acceptable = gold.stressors_acceptable ?? [];
  const got = note.nrt?.stressors ?? [];
  const unclaimed = [...got];
  const missing: string[] = [];
  const missingSource: string[] = [];
  const inventedSource: string[] = [];
  let matched = 0;

  const label = (g: GoldStressor): string => (g.source ? `${g.category} — ${g.source}` : g.category);

  for (const g of want) {
    // Match on the category, then judge the source separately: a run that says
    // "food" when the gold says "food — dairy" HAS found the stressor and has
    // NOT found the answer, and collapsing those into one number is what let the
    // gap ship in the first place.
    const i = bestMatch(unclaimed, (s) => {
      const score = similarity(s.category, g.category);
      return score >= MATCH_THRESHOLD ? score : 0;
    });
    if (i === -1) {
      missing.push(label(g));
      continue;
    }
    const [hit] = unclaimed.splice(i, 1);
    matched++;
    const wantSource = g.source ?? null;
    const gotSource = hit.source ?? hit.detail ?? null;
    // A shorter but correct naming of the same source ("Lyme" for "bacteria
    // number four, which is Lyme") is a defensible reading, not a miss — so an
    // `acceptable` entry for the same category counts too. Without this the
    // eval measures phrasing rather than whether the source was found.
    const sourceOk =
      !!gotSource &&
      [wantSource, ...acceptable.filter((a) => a.category === g.category).map((a) => a.source)]
        .filter((x): x is string => !!x)
        .some((want) => similarity(gotSource, want) >= MATCH_THRESHOLD);
    if (wantSource && !sourceOk) {
      missingSource.push(`${g.category}: expected source "${wantSource}", got ${JSON.stringify(gotSource)}`);
    }
    if (!wantSource && hit.source) {
      inventedSource.push(`${g.category}: invented source "${hit.source}" (transcript names none)`);
    }
  }
  const extra = unclaimed.filter(
    (s) => !acceptable.some((a) => similarity(s.category, a.category) >= MATCH_THRESHOLD),
  ).length;
  return { matched, expected: want.length, extra, missingSource, inventedSource, missing };
}

function scoreSlots(
  note: SessionNote,
  gold: Gold,
  scored: (field: string) => boolean,
): FixtureReport['slots'] {
  const wrong: string[] = [];
  let correct = 0;
  let expected = 0;

  const walk = (want: unknown, prefix: string): void => {
    if (!want || typeof want !== 'object') return;
    for (const [key, value] of Object.entries(want as Record<string, unknown>)) {
      const path = `${prefix}.${key}`;
      if (value && typeof value === 'object') {
        walk(value, path);
        continue;
      }
      expected++;
      const got = get(note, path);
      // matchScore, not bare similarity — the same rule the list fields use.
      // similarity divides by the LONGER string, so gold "very active" against an
      // extracted "Very active, always on the go, but no formal exercise" scored
      // 0.22 and was marked wrong. That is a correct value carrying context, not
      // a wrong one; the cell being too verbose is a separate complaint from the
      // cell being incorrect, and only one of them belongs in slot accuracy.
      if (typeof got === 'string' && matchScore(got, String(value)) > 0) correct++;
      else wrong.push(`${path}: expected "${value}", got ${JSON.stringify(got ?? null)}`);
    }
  };
  if (scored('nrt')) walk(gold.nrt, 'nrt');
  if (scored('lifestyle')) walk(gold.lifestyle, 'lifestyle');
  return { correct, expected, wrong };
}

/** The headline metric: fields the transcript never states that got filled anyway. */
function scoreFabrication(
  note: SessionNote,
  gold: Gold,
  scored: (field: string) => boolean,
): FixtureReport['fabrication'] {
  // A never-stated field can only be fabricated by a stage that ran.
  const paths = (gold.expect_null ?? []).filter((p) => scored(p.split('.')[0]));
  const fields = paths.filter((p) => {
    const v = get(note, p);
    return v !== null && v !== undefined && String(v).trim() !== '';
  });
  return { filled: fields.length, total: paths.length, fields };
}

/** Assessments still in the words they were said in, judged against the turn
 *  each one cites. Items with no resolved turn are not scored — there is nothing
 *  to compare them to, and guessing would move the number without meaning. */
const FAITHFUL = 0.8;

function scoreWording(note: SessionNote): FixtureReport['wording'] {
  const byPath = new Map((note.evidence ?? []).map((e) => [e.path, e]));
  const scored: { text: string; fidelity: number }[] = [];
  note.assessments.forEach((text, i) => {
    const turnText = byPath.get(`assessments.${i}`)?.turn_text;
    if (!turnText) return;
    scored.push({ text, fidelity: wordingFidelity(text, turnText) });
  });
  const worst = scored
    .filter((s) => s.fidelity < FAITHFUL)
    .sort((a, b) => a.fidelity - b.fidelity)
    .slice(0, 5)
    .map((s) => `${s.fidelity.toFixed(2)}  ${s.text}`);
  return { scored: scored.length, faithful: scored.filter((s) => s.fidelity >= FAITHFUL).length, worst };
}

/**
 * How much of the session produced no finding at all.
 *
 * Every other number here needs gold, which two of the four transcripts on file
 * do not have. This one needs only the transcript and the citations the model
 * already returns, so it works on any session — and it measures the failure that
 * the gold sets say is half the recall gap: substantial practitioner turns that
 * the extraction never reports anything from. 44% and 56% on the two golden
 * fixtures, which is where the missing findings live.
 */
function scoreCoverage(note: SessionNote, transcript: string): FixtureReport['coverage'] {
  const prepared = prepareTranscript(transcript);
  const cited = new Set((note.evidence ?? []).map((e) => e.turn));
  // Short turns are "mm-hmm" and "okay" — counting them would bury the signal in
  // backchannel the practitioner never put a finding in.
  const substantial = prepared.turns.filter(
    (t) => t.role === 'PRACTITIONER' && t.text.split(/\s+/).length >= 25,
  );
  const read = substantial.filter((t) => cited.has(t.index)).length;
  return { turns: substantial.length, read };
}

/** The findings only — `extraction` carries timing and model metadata that
 *  differ between identical runs and would mask a true repeat. */
function fingerprint(note: SessionNote): string {
  const { extraction: _ignored, ...findings } = note;
  return createHash('sha256').update(JSON.stringify(findings)).digest('hex').slice(0, 12);
}

function scoreProvenance(note: SessionNote): FixtureReport['provenance'] {
  const evidence = note.evidence ?? [];
  // Findings with no quote at all: the model asserted something it wouldn't
  // point at. Counted separately from quotes that failed verification.
  const cited = new Set(evidence.map((e) => e.path));
  let missingFor = 0;
  note.concerns.forEach((_, i) => { if (!cited.has(`concerns.${i}`)) missingFor++; });
  note.assessments.forEach((_, i) => { if (!cited.has(`assessments.${i}`)) missingFor++; });
  note.supplements.forEach((_, i) => { if (!cited.has(`supplements.${i}`)) missingFor++; });
  return {
    total: evidence.length,
    unverified: evidence.filter((e) => e.unverified).length,
    missingFor,
  };
}

const RUN_DIR = resolve(fileURLToPath(new URL('../eval-runs', import.meta.url)));

/** Where a saved extraction lives. One per fixture: the point is to re-score the
 *  LAST run, not to accumulate an archive nobody prunes. */
const runPath = (name: string): string => join(RUN_DIR, `${name}.note.json`);

function saveNotes(name: string, notes: SessionNote[]): void {
  mkdirSync(RUN_DIR, { recursive: true });
  writeFileSync(
    runPath(name),
    JSON.stringify({ saved_at: new Date().toISOString(), notes }, null, 2),
  );
}

function loadNotes(name: string): { notes: SessionNote[]; savedAt: string } {
  let text: string;
  try {
    text = readFileSync(runPath(name), 'utf8');
  } catch {
    throw new Error(
      `no saved extraction for ${name} — run \`npm run eval:extract\` once without --replay first`,
    );
  }
  // `note` is the single-run shape this file used before repeat runs existed.
  const raw = JSON.parse(text) as { saved_at?: string; note?: unknown; notes?: unknown[] };
  const raws = raw.notes ?? (raw.note ? [raw.note] : []);
  return {
    notes: raws.map((n) => SessionNoteSchema.parse(n)),
    savedAt: raw.saved_at ?? 'unknown',
  };
}

/**
 * Every extraction for one fixture: N fresh ones, or whatever was saved.
 *
 * Repeat runs are not a luxury here. Two runs of an identical configuration came
 * back six points apart on total recall, which is larger than most changes worth
 * making — so a single run cannot tell an improvement from the weather, and
 * every number this harness printed before now carried that uncertainty
 * silently. Reporting the spread is the difference between "72%" and "72%, and
 * this fixture moves ±6 on its own".
 */
async function extractAll(name: string, gold: Gold, runs: number): Promise<SessionNote[]> {
  const transcript = readFileSync(join(FIXTURE_DIR, `${name}.txt`), 'utf8');
  if (replay) {
    const loaded = loadNotes(name);
    const meta = loaded.notes[0]?.extraction;
    console.log(
      `   (replay of ${loaded.notes.length} run(s) saved ${loaded.savedAt} —` +
        ` ${meta?.model ?? 'unknown model'}, prompts ${meta?.prompt_version ?? 'unknown'};` +
        ' no API calls)',
    );
    return loaded.notes;
  }
  const notes: SessionNote[] = [];
  for (let i = 0; i < runs; i++) {
    notes.push(
      await extractSessionNote(transcript, {
        // The real pipeline knows both; withholding them here would measure a
        // harder task than production actually runs.
        clientName: null,
        practitionerName: 'Nicole',
        catalog: (gold.supplements ?? []).map((s) => s.name),
        stages,
      }),
    );
    // Save after EVERY run, not at the end. These are minutes apiece and cost
    // metered requests; a job killed on run three used to throw away runs one and
    // two, which is the most expensive way to lose data in this project.
    if (save) saveNotes(name, notes);
    if (runs > 1) console.log(`   run ${i + 1}/${runs} extracted`);
  }
  return notes;
}

function scoreNote(name: string, note: SessionNote, gold: Gold, transcript: string): FixtureReport {
  const empty: FixtureReport = {
    fixture: name,
    ok: false,
    lists: {},
    supplements: { matched: 0, expected: 0, extra: 0, wrongChange: [], missing: [] },
    stressors: { matched: 0, expected: 0, extra: 0, missingSource: [], inventedSource: [], missing: [] },
    slots: { correct: 0, expected: 0, wrong: [] },
    fabrication: { filled: 0, total: 0, fields: [] },
    unstated: { fields: 0, detail: [] },
    wording: { scored: 0, faithful: 0, worst: [] },
    provenance: { total: 0, unverified: 0, missingFor: 0 },
    coverage: { turns: 0, read: 0 },
    fingerprint: '',
    skipped: [],
    degraded: [],
  };

  void empty;
  // Bare stage names mean the stage was dropped entirely; ':partial' and
  // ':chunked-fallback' are qualifiers on a stage that did run.
  const degraded = (note.extraction?.partial ?? []).filter((p) => !p.includes(':'));
  const skipped = note.extraction?.skipped ?? [];
  // A field whose stage was never asked to run is not a miss. Scoring it as one
  // would report a deliberate two-stage measurement as a catastrophic failure of
  // the other two.
  const off = new Set(skipped.flatMap((st) => STAGE_FIELDS[st as StageName] ?? []));
  const scored = (field: string): boolean => !off.has(field);
  const unstated = findUnstatedNumbers(note, transcript);
  const lists: Record<string, Score> = {};
  if (gold.concerns && scored('concerns')) {
    lists.concerns = scoreList(note.concerns, gold.concerns, gold.concerns_acceptable);
  }
  if (gold.goals && scored('goals')) lists.goals = scoreList(note.goals, gold.goals, gold.goals_acceptable);
  if (gold.assessments && scored('assessments')) {
    lists.assessments = scoreList(note.assessments, gold.assessments, gold.assessments_acceptable);
  }
  if (gold.follow_ups && scored('follow_ups')) {
    const texts = note.follow_ups.map((f) => (typeof f === 'string' ? f : f.text));
    lists.follow_ups = scoreList(texts, gold.follow_ups, gold.follow_ups_acceptable);
  }

  return {
    fixture: name,
    ok: true,
    lists,
    supplements: scored('supplements')
      ? scoreSupplements(note, gold)
      : { matched: 0, expected: 0, extra: 0, wrongChange: [], missing: [] },
    stressors: scored('nrt')
      ? scoreStressors(note, gold)
      : { matched: 0, expected: 0, extra: 0, missingSource: [], inventedSource: [], missing: [] },
    slots: scoreSlots(note, gold, scored),
    fabrication: scoreFabrication(note, gold, scored),
    unstated: {
      fields: unstated.length,
      detail: unstated.map((u) => `${u.path} states ${u.numbers.join(', ')} — "${u.value}"`),
    },
    wording: scoreWording(note),
    provenance: scoreProvenance(note),
    coverage: scoreCoverage(note, transcript),
    fingerprint: fingerprint(note),
    skipped,
    degraded,
  };
}

// --- reporting ---------------------------------------------------------------

const pct = (n: number, d: number): string => (d === 0 ? '  n/a' : `${((n / d) * 100).toFixed(0).padStart(4)}%`);

const STAGES_RUN = (r: FixtureReport): string =>
  (Object.keys(STAGE_FIELDS) as StageName[]).filter((s) => !r.skipped.includes(s)).join(' + ');

function print(reports: FixtureReport[]): void {
  const how = replay ? 'REPLAY (scored from saved extractions)' : llmConfig.provider;
  console.log(`\nProvider: ${how}  Fixtures: ${reports.length}\n`);

  for (const r of reports) {
    console.log(`── ${r.fixture}`);
    if (!r.ok) {
      console.log(`   EXTRACTION FAILED: ${r.error}\n`);
      continue;
    }
    if (r.skipped.length) {
      console.log(`   (only ${STAGES_RUN(r)} ran — ${r.skipped.join(', ')} not scored)`);
    }
    if (r.degraded.length) {
      console.log(
        `   !! NOT A MEASUREMENT — these stages never ran: ${r.degraded.join(', ')}.\n` +
          '      Their fields are empty because nothing read them, not because the\n' +
          '      session was quiet. Every number below is a floor, not a score.',
      );
    }
    for (const [field, s] of Object.entries(r.lists)) {
      console.log(
        `   ${field.padEnd(16)} recall ${pct(s.matched, s.expected)}` +
          `  (${s.matched}/${s.expected})   spurious ${s.extra}`,
      );
      for (const m of s.missing) console.log(`       missed:   ${m.slice(0, 90)}`);
      for (const x of s.spurious) console.log(`       invented: ${x.slice(0, 90)}`);
    }
    const sup = r.supplements;
    console.log(
      `   ${'supplements'.padEnd(16)} recall ${pct(sup.matched, sup.expected)}` +
        `  (${sup.matched}/${sup.expected})   spurious ${sup.extra}`,
    );
    for (const m of sup.missing) console.log(`       missed:   ${m}`);
    for (const w of sup.wrongChange) console.log(`       WRONG ACTION: ${w}`);

    const st = r.stressors;
    if (st.expected || st.extra) {
      console.log(
        `   ${'stressors'.padEnd(16)} recall ${pct(st.matched, st.expected)}` +
          `  (${st.matched}/${st.expected})   spurious ${st.extra}` +
          `   sources ${pct(st.matched - st.missingSource.length, st.matched)}`,
      );
      for (const m of st.missing) console.log(`       missed:   ${m}`);
      for (const m of st.missingSource) console.log(`       NO SOURCE: ${m}`);
      for (const m of st.inventedSource) console.log(`       FABRICATED: ${m}`);
    }

    console.log(
      `   ${'nrt/lifestyle'.padEnd(16)} slots  ${pct(r.slots.correct, r.slots.expected)}` +
        `  (${r.slots.correct}/${r.slots.expected})`,
    );
    for (const w of r.slots.wrong) console.log(`       ${w.slice(0, 110)}`);

    const f = r.fabrication;
    console.log(
      `   ${'FABRICATION'.padEnd(16)}        ${pct(f.filled, f.total)}` +
        `  (${f.filled}/${f.total} never-stated fields filled)`,
    );
    for (const field of f.fields) console.log(`       FABRICATED: ${field}`);

    const u = r.unstated;
    console.log(
      `   ${'UNSTATED NUMBERS'.padEnd(16)}        ${String(u.fields).padStart(5)}  (fields stating a figure the session never did)`,
    );
    for (const d of u.detail) console.log(`       ${d.slice(0, 110)}`);

    const w = r.wording;
    console.log(
      `   ${'assessment words'.padEnd(16)} theirs ${pct(w.faithful, w.scored)}  (${w.faithful}/${w.scored} still in the practitioner's wording)`,
    );
    for (const item of w.worst) console.log(`       REWRITTEN ${item.slice(0, 100)}`);

    const c = r.coverage;
    if (c.turns) {
      console.log(
        `   ${'session read'.padEnd(16)} turns  ${pct(c.read, c.turns)}` +
          `  (${c.read}/${c.turns} substantial practitioner turns produced a finding)`,
      );
    }

    const p = r.provenance;
    console.log(
      `   ${'provenance'.padEnd(16)} quotes ${p.total}, unverified ${p.unverified}, uncited findings ${p.missingFor}`,
    );
    console.log();
  }

  // Totals — the numbers to paste into plan.md as the baseline.
  const ok = reports.filter((r) => r.ok);
  const sum = (f: (r: FixtureReport) => number): number => ok.reduce((n, r) => n + f(r), 0);
  const recallM =
    sum((r) => Object.values(r.lists).reduce((n, s) => n + s.matched, 0)) +
    sum((r) => r.supplements.matched) +
    sum((r) => r.stressors.matched);
  const recallE =
    sum((r) => Object.values(r.lists).reduce((n, s) => n + s.expected, 0)) +
    sum((r) => r.supplements.expected) +
    sum((r) => r.stressors.expected);
  const fabF = sum((r) => r.fabrication.filled);
  const fabT = sum((r) => r.fabrication.total);
  const slotC = sum((r) => r.slots.correct);
  const slotE = sum((r) => r.slots.expected);

  const degradedRuns = ok.filter((r) => r.degraded.length);
  console.log('══ TOTALS ' + '═'.repeat(50));
  if (degradedRuns.length) {
    console.log(
      `   ⚠ ${degradedRuns.length} of ${ok.length} fixture(s) lost a stage — the totals` +
        ' below are NOT comparable with a clean run.',
    );
  }
  console.log(`   recall             ${pct(recallM, recallE)}  (${recallM}/${recallE})`);
  console.log(`   slot accuracy      ${pct(slotC, slotE)}  (${slotC}/${slotE})`);
  console.log(`   FABRICATION RATE   ${pct(fabF, fabT)}  (${fabF}/${fabT})   ← release blocker if it rises`);
  const unstatedTotal = sum((r) => r.unstated.fields);
  console.log(`   unstated numbers   ${String(unstatedTotal).padStart(5)}  (fields stating a figure nobody said)`);
  const covTurns = sum((r) => r.coverage.turns);
  const covRead = sum((r) => r.coverage.read);
  if (covTurns) {
    console.log(`   session read       ${pct(covRead, covTurns)}  (${covRead}/${covTurns} substantial turns produced a finding)`);
  }
  const wordScored = sum((r) => r.wording.scored);
  const wordFaithful = sum((r) => r.wording.faithful);
  console.log(`   assessment wording ${pct(wordFaithful, wordScored)}  (${wordFaithful}/${wordScored} still the practitioner's)`);
  console.log(`   extraction failures ${reports.length - ok.length}/${reports.length}`);
  console.log();
}

/**
 * What the run-to-run spread is, when there is more than one run.
 *
 * Printed as median and range rather than a mean: with three runs a single bad
 * extraction drags a mean somewhere no run actually was, and the question this
 * answers is "what does this configuration typically do, and how far does it
 * wander" — which is the median and the range, not the average.
 */
function printSpread(byFixture: FixtureReport[][]): void {
  const runCount = Math.max(...byFixture.map((r) => r.length));
  if (runCount < 2) return;

  const recallOf = (r: FixtureReport): number => {
    const m =
      Object.values(r.lists).reduce((n, s) => n + s.matched, 0) +
      r.supplements.matched +
      r.stressors.matched;
    const e =
      Object.values(r.lists).reduce((n, s) => n + s.expected, 0) +
      r.supplements.expected +
      r.stressors.expected;
    return e === 0 ? 0 : (m / e) * 100;
  };
  const median = (xs: number[]): number => {
    const sorted = [...xs].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  };

  console.log(`══ SPREAD over ${runCount} runs ` + '═'.repeat(38));

  // Identical output is not a narrow spread, it is no sample at all.
  const identical = byFixture.filter(
    (rs) => rs.length > 1 && new Set(rs.map((r) => r.fingerprint)).size === 1,
  );
  if (identical.length === byFixture.length) {
    console.log(
      '   Every run returned BYTE-IDENTICAL output. At temperature 0 this model is\n' +
        '   deterministic for these inputs, so the range below is not a measurement of\n' +
        '   stability — it is the same answer counted three times. Use --runs 1 here and\n' +
        '   spend the quota on a second configuration instead.\n',
    );
  } else {
    console.log('   A change smaller than the range below cannot be told from noise.\n');
    for (const rs of identical) {
      console.log(`   ${rs[0].fixture}: identical across all runs (deterministic).`);
    }
  }
  for (const runsForFixture of byFixture) {
    const usable = runsForFixture.filter((r) => r.ok && !r.degraded.length);
    const lost = runsForFixture.length - usable.length;
    if (!usable.length) {
      console.log(
        `   ${runsForFixture[0].fixture.padEnd(34)} no usable run —` +
          ` all ${runsForFixture.length} lost a stage. Nothing was measured.`,
      );
      continue;
    }
    if (lost) {
      console.log(
        `   ${''.padEnd(34)} (${lost} of ${runsForFixture.length} runs excluded: stage never ran)`,
      );
    }
    const recalls = usable.map(recallOf);
    const fabs = usable.map((r) => r.fabrication.filled);
    console.log(
      `   ${runsForFixture[0].fixture.padEnd(34)}` +
        ` recall ${median(recalls).toFixed(0).padStart(3)}%` +
        ` (${Math.min(...recalls).toFixed(0)}–${Math.max(...recalls).toFixed(0)}%)` +
        `   fabricated fields ${Math.min(...fabs)}–${Math.max(...fabs)}`,
    );
  }

  // Per-run totals, so a single catastrophic run is visible rather than averaged
  // into looking like a mediocre one.
  const perRun: number[] = [];
  for (let i = 0; i < runCount; i++) {
    const runReports = byFixture
      .map((r) => r[i])
      .filter((r): r is FixtureReport => !!r && r.ok && !r.degraded.length);
    if (!runReports.length) continue;
    const m = runReports.reduce(
      (n, r) =>
        n +
        Object.values(r.lists).reduce((k, sc) => k + sc.matched, 0) +
        r.supplements.matched +
        r.stressors.matched,
      0,
    );
    const e = runReports.reduce(
      (n, r) =>
        n +
        Object.values(r.lists).reduce((k, sc) => k + sc.expected, 0) +
        r.supplements.expected +
        r.stressors.expected,
      0,
    );
    perRun.push(e === 0 ? 0 : (m / e) * 100);
  }
  if (perRun.length > 1) {
    console.log(
      `\n   overall recall by run: ${perRun.map((x) => `${x.toFixed(0)}%`).join(', ')}` +
        `  → median ${median(perRun).toFixed(0)}%`,
    );
  }
  console.log();
}

// --- main --------------------------------------------------------------------

const args = process.argv.slice(2);
const only = args.includes('--fixture') ? args[args.indexOf('--fixture') + 1] : null;
const asJson = args.includes('--json');
const replay = args.includes('--replay');
/**
 * How many times to extract each fixture.
 *
 * The default stays 1 because every run costs provider quota, but anything
 * whose effect is smaller than the run-to-run spread cannot be judged from one:
 * two runs of an identical configuration differed by six points on total recall.
 * `--runs 3` is the smallest number that shows a spread at all.
 */
const runs = args.includes('--runs') ? Math.max(1, Number(args[args.indexOf('--runs') + 1])) : 1;
/** Only these stages, halving the cost of measuring a change that touches two. */
const stages: StageName[] | undefined = args.includes('--stages')
  ? (args[args.indexOf('--stages') + 1].split(',').map((x) => x.trim()) as StageName[])
  : undefined;
// Replaying implies keeping what is replayed; saving on every run costs nothing
// and is what makes the next scoring change free to measure.
const save = args.includes('--save') || !replay;

const names = readdirSync(FIXTURE_DIR)
  .filter((f) => f.endsWith('.expected.json'))
  .map((f) => basename(f, '.expected.json'))
  .filter((n) => !only || n === only)
  .sort();

if (names.length === 0) {
  console.error(`No fixtures found in ${FIXTURE_DIR}${only ? ` matching "${only}"` : ''}`);
  process.exit(1);
}

// The LLM rate limiter unrefs its pacing timer so it can never hold a server
// process open. In a one-shot script that backfires: while a stage waits for
// token budget there is nothing else keeping the event loop alive, so Node
// exits 0 with the eval silently producing no output at all — which reads as
// "no problems found" rather than "never ran". Pin the loop open for the run.
const keepAlive = setInterval(() => {}, 1000);

/** All runs, grouped by fixture — one entry per fixture, N reports inside. */
const byFixture: FixtureReport[][] = [];
for (const name of names) {
  const gold: Gold = JSON.parse(readFileSync(join(FIXTURE_DIR, `${name}.expected.json`), 'utf8'));
  const transcript = readFileSync(join(FIXTURE_DIR, `${name}.txt`), 'utf8');
  try {
    const notes = await extractAll(name, gold, runs);
    byFixture.push(notes.map((n) => scoreNote(name, n, gold, transcript)));
  } catch (err) {
    byFixture.push([
      {
        fixture: name,
        ok: false,
        error: err instanceof Error ? err.message : String(err),
        lists: {},
        supplements: { matched: 0, expected: 0, extra: 0, wrongChange: [], missing: [] },
        stressors: { matched: 0, expected: 0, extra: 0, missingSource: [], inventedSource: [], missing: [] },
        slots: { correct: 0, expected: 0, wrong: [] },
        fabrication: { filled: 0, total: 0, fields: [] },
        unstated: { fields: 0, detail: [] },
        wording: { scored: 0, faithful: 0, worst: [] },
        provenance: { total: 0, unverified: 0, missingFor: 0 },
        coverage: { turns: 0, read: 0 },
        fingerprint: '',
        skipped: [],
        degraded: [],
      },
    ]);
  }
}
// The detail sections describe ONE extraction, so they show the first run; the
// spread below is what says whether that run was typical.
const reports: FixtureReport[] = byFixture.map((r) => r[0]);

clearInterval(keepAlive);

if (asJson) console.log(JSON.stringify({ provider: llmConfig.provider, runs: byFixture }, null, 2));
else {
  print(reports);
  printSpread(byFixture);
}

// Non-zero exit on any hard failure, so CI can gate on it.
process.exit(reports.some((r) => !r.ok) ? 1 : 0);
