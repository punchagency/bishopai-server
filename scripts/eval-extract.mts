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
 */
import 'dotenv/config';
import { readFileSync, readdirSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractSessionNote } from '../src/session/extract.js';
import { llmConfig } from '../src/llm/config.js';
import type { SessionNote } from '../src/session/schema.js';

const FIXTURE_DIR = resolve(fileURLToPath(new URL('../test/fixtures/transcripts', import.meta.url)));

// --- scoring primitives ------------------------------------------------------

function tokens(s: string): Set<string> {
  return new Set(
    s.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(Boolean),
  );
}

/** Token-set overlap. Extraction is verbatim-ish, not exact, so exact string
 *  equality would score a correct capture as a miss over one dropped article. */
function similarity(a: string, b: string): number {
  const ta = tokens(a);
  const tb = tokens(b);
  if (!ta.size || !tb.size) return 0;
  let shared = 0;
  for (const t of ta) if (tb.has(t)) shared++;
  return shared / Math.max(ta.size, tb.size);
}

const MATCH_THRESHOLD = 0.5;

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
    const i = unclaimed.findIndex((g) => similarity(g, w) >= MATCH_THRESHOLD);
    if (i === -1) missing.push(w);
    else {
      matched++;
      unclaimed.splice(i, 1);
    }
  }
  // Anything left that matches an `acceptable` entry is set aside, not penalised.
  const spurious = unclaimed.filter(
    (g) => !acceptable.some((a) => similarity(g, a) >= MATCH_THRESHOLD),
  );
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
  lifestyle?: Record<string, string>;
  expect_null?: string[];
  expect_null_acceptable?: string[];
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
  slots: { correct: number; expected: number; wrong: string[] };
  fabrication: { filled: number; total: number; fields: string[] };
  provenance: { total: number; unverified: number; missingFor: number };
}

// --- per-fixture evaluation --------------------------------------------------

function scoreSupplements(note: SessionNote, gold: Gold): FixtureReport['supplements'] {
  const want = gold.supplements ?? [];
  const acceptable = gold.supplements_acceptable ?? [];
  const unclaimed = [...note.supplements];
  const missing: string[] = [];
  const wrongChange: string[] = [];
  let matched = 0;

  const nameMatches = (got: string, g: GoldSupplement): boolean =>
    [g.name, ...(g.name_variants ?? [])].some((n) => similarity(got, n) >= 0.5);

  for (const g of want) {
    const i = unclaimed.findIndex((s) => nameMatches(s.name, g));
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
  const extra = unclaimed.filter((s) => !acceptable.some((a) => nameMatches(s.name, a))).length;
  return { matched, expected: want.length, extra, wrongChange, missing };
}

function scoreSlots(note: SessionNote, gold: Gold): FixtureReport['slots'] {
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
      if (typeof got === 'string' && similarity(got, String(value)) >= MATCH_THRESHOLD) correct++;
      else wrong.push(`${path}: expected "${value}", got ${JSON.stringify(got ?? null)}`);
    }
  };
  walk(gold.nrt, 'nrt');
  walk(gold.lifestyle, 'lifestyle');
  return { correct, expected, wrong };
}

/** The headline metric: fields the transcript never states that got filled anyway. */
function scoreFabrication(note: SessionNote, gold: Gold): FixtureReport['fabrication'] {
  const paths = gold.expect_null ?? [];
  const fields = paths.filter((p) => {
    const v = get(note, p);
    return v !== null && v !== undefined && String(v).trim() !== '';
  });
  return { filled: fields.length, total: paths.length, fields };
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

async function evaluate(name: string): Promise<FixtureReport> {
  const transcript = readFileSync(join(FIXTURE_DIR, `${name}.txt`), 'utf8');
  const gold: Gold = JSON.parse(readFileSync(join(FIXTURE_DIR, `${name}.expected.json`), 'utf8'));

  const empty: FixtureReport = {
    fixture: name,
    ok: false,
    lists: {},
    supplements: { matched: 0, expected: 0, extra: 0, wrongChange: [], missing: [] },
    slots: { correct: 0, expected: 0, wrong: [] },
    fabrication: { filled: 0, total: 0, fields: [] },
    provenance: { total: 0, unverified: 0, missingFor: 0 },
  };

  let note: SessionNote;
  try {
    note = await extractSessionNote(transcript, {
      // The real pipeline knows both; withholding them here would measure a
      // harder task than production actually runs.
      clientName: null,
      practitionerName: 'Nicole',
      catalog: (gold.supplements ?? []).map((s) => s.name),
    });
  } catch (err) {
    return { ...empty, error: err instanceof Error ? err.message : String(err) };
  }

  const lists: Record<string, Score> = {};
  if (gold.concerns) lists.concerns = scoreList(note.concerns, gold.concerns, gold.concerns_acceptable);
  if (gold.goals) lists.goals = scoreList(note.goals, gold.goals, gold.goals_acceptable);
  if (gold.assessments) {
    lists.assessments = scoreList(note.assessments, gold.assessments, gold.assessments_acceptable);
  }
  if (gold.follow_ups) {
    const texts = note.follow_ups.map((f) => (typeof f === 'string' ? f : f.text));
    lists.follow_ups = scoreList(texts, gold.follow_ups, gold.follow_ups_acceptable);
  }

  return {
    fixture: name,
    ok: true,
    lists,
    supplements: scoreSupplements(note, gold),
    slots: scoreSlots(note, gold),
    fabrication: scoreFabrication(note, gold),
    provenance: scoreProvenance(note),
  };
}

// --- reporting ---------------------------------------------------------------

const pct = (n: number, d: number): string => (d === 0 ? '  n/a' : `${((n / d) * 100).toFixed(0).padStart(4)}%`);

function print(reports: FixtureReport[]): void {
  console.log(`\nProvider: ${llmConfig.provider}  Fixtures: ${reports.length}\n`);

  for (const r of reports) {
    console.log(`── ${r.fixture}`);
    if (!r.ok) {
      console.log(`   EXTRACTION FAILED: ${r.error}\n`);
      continue;
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

    const p = r.provenance;
    console.log(
      `   ${'provenance'.padEnd(16)} quotes ${p.total}, unverified ${p.unverified}, uncited findings ${p.missingFor}`,
    );
    console.log();
  }

  // Totals — the numbers to paste into plan.md as the baseline.
  const ok = reports.filter((r) => r.ok);
  const sum = (f: (r: FixtureReport) => number): number => ok.reduce((n, r) => n + f(r), 0);
  const recallM = sum((r) => Object.values(r.lists).reduce((n, s) => n + s.matched, 0)) + sum((r) => r.supplements.matched);
  const recallE = sum((r) => Object.values(r.lists).reduce((n, s) => n + s.expected, 0)) + sum((r) => r.supplements.expected);
  const fabF = sum((r) => r.fabrication.filled);
  const fabT = sum((r) => r.fabrication.total);
  const slotC = sum((r) => r.slots.correct);
  const slotE = sum((r) => r.slots.expected);

  console.log('══ TOTALS ' + '═'.repeat(50));
  console.log(`   recall             ${pct(recallM, recallE)}  (${recallM}/${recallE})`);
  console.log(`   slot accuracy      ${pct(slotC, slotE)}  (${slotC}/${slotE})`);
  console.log(`   FABRICATION RATE   ${pct(fabF, fabT)}  (${fabF}/${fabT})   ← release blocker if it rises`);
  console.log(`   extraction failures ${reports.length - ok.length}/${reports.length}`);
  console.log();
}

// --- main --------------------------------------------------------------------

const args = process.argv.slice(2);
const only = args.includes('--fixture') ? args[args.indexOf('--fixture') + 1] : null;
const asJson = args.includes('--json');

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

const reports: FixtureReport[] = [];
for (const name of names) reports.push(await evaluate(name));

clearInterval(keepAlive);

if (asJson) console.log(JSON.stringify({ provider: llmConfig.provider, reports }, null, 2));
else print(reports);

// Non-zero exit on any hard failure, so CI can gate on it.
process.exit(reports.some((r) => !r.ok) ? 1 : 0);
