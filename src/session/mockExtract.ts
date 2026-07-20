import type { SessionNote } from './extract';

// Deterministic, no-API-key transcript extractor for LLM_PROVIDER=mock. Light
// heuristics over the transcript text so seeded/demo conversations produce
// varied, plausible, *stable* SessionNotes — enough to exercise the whole WF1
// chain (extract → render → review → Drive dry-run) and demo the cockpit before
// any real LLM key is configured. Never throws; always returns valid schema.

interface SymptomCue {
  match: RegExp;
  concern: string;
  assessment: string;
}
const SYMPTOMS: SymptomCue[] = [
  { match: /\bsleep|insomnia|waking\b/, concern: 'Trouble sleeping', assessment: 'Sleep disruption — consider magnesium and evening routine' },
  { match: /\bfatigue|tired|energy|exhaust/, concern: 'Low energy / fatigue', assessment: 'Fatigue — screen for B-vitamin and iron status' },
  { match: /\bbloat|digest|gut|stomach|ibs\b/, concern: 'Digestive discomfort', assessment: 'GI symptoms — support with probiotic and meal spacing' },
  { match: /\banxiet|stress|overwhelm|mood\b/, concern: 'Stress and anxiety', assessment: 'Elevated stress load — adaptogen support appropriate' },
  { match: /\bheadache|migraine\b/, concern: 'Headaches', assessment: 'Recurrent headaches — hydration and magnesium' },
  { match: /\bjoint|inflam|ach(e|ing)\b/, concern: 'Joint aches / inflammation', assessment: 'Inflammatory signs — omega-3 support' },
];

interface SupplementCue {
  match: RegExp;
  name: string;
  dose: string;
}
const SUPPLEMENTS: SupplementCue[] = [
  { match: /\bmagnesium\b/, name: 'Magnesium glycinate', dose: '2 caps nightly' },
  { match: /\bb-?complex|b vitamin|b12\b/, name: 'B-complex', dose: '1 cap daily' },
  { match: /\bomega|fish oil|epa|dha\b/, name: 'Omega-3', dose: '2 softgels daily' },
  { match: /\bvitamin d|vit d\b/, name: 'Vitamin D3', dose: '1 softgel daily' },
  { match: /\bprobiotic\b/, name: 'Probiotic', dose: '1 cap daily' },
  { match: /\bzinc\b/, name: 'Zinc', dose: '1 cap daily' },
  { match: /\bashwagandha|adaptogen\b/, name: 'Ashwagandha', dose: '1 cap twice daily' },
];

// NRT findings + the lifestyle log are spoken aloud in a real session, so the mock
// pulls them out of the transcript when the cue is there and leaves them null when
// it isn't — same contract as the LLM path (never invent a clinical value).
// Captured against the ORIGINAL transcript (case-insensitively), not a lowercased
// copy: these strings land verbatim in Nicole's documents, so their casing matters.
// Every field cue, so a capture can be told to stop when the next one begins —
// otherwise "BM is daily, sleep is 7 hours" hands BM the whole rest of the clause.
const CUES = String.raw`bm|bowel movements?|sleep(?:ing)?|water|cycle|exercise|diet|pulse|priority|k[\s-]?27|stressors?|foundation|body[\s-]?scan`;

/**
 * Match `<label> <is|was|shows|:> <value>`, capturing lazily up to a sentence end or
 * the next field cue. The connector is mandatory: without it "trouble sleeping and
 * low energy" would hand SLEEP the value "and low energy".
 */
function field(label: string, connectors = 'is|was|are|were|shows?|reads?'): RegExp {
  // The next cue may be introduced conversationally — "…, and her diet is …" — so the
  // terminator tolerates a leading conjunction/possessive before the cue word.
  const nextCue = String.raw`[,;]?\s*(?:and\s+)?(?:her|his|their|the)?\s*(?:${CUES})\b\s*(?:${connectors}|:)`;
  return new RegExp(
    String.raw`\b(?:${label})\s*(?:\s(?:${connectors})\s|\s*:\s*)\s*(.{1,80}?)` +
      String.raw`(?=\s*${nextCue}|[.;\n]|$)`,
    'i',
  );
}

const capture = (raw: string, re: RegExp): string | null => {
  const m = raw.match(re);
  return m?.[1]?.trim().replace(/[,\s]+$/, '') || null;
};

// FOUNDATION (col D) and BODY SCAN (col E) are prompt-by-prompt on the real sheet.
// The mock captures whichever prompts the transcript happens to name; anything it
// finds under a bare "foundation …" / "body scan …" phrasing lands in the
// ADDITIONAL slot rather than being guessed into a specific prompt.
/** A pass where no prompt was called is null, not an object of nulls. */
const orNull = <T extends object>(o: T): T | null =>
  Object.values(o).some(Boolean) ? o : null;

function mockFoundation(raw: string): NonNullable<SessionNote['nrt']>['foundation'] {
  return orNull({
    laying1: capture(raw, field(String.raw`laying\s*1(?:\s+foundations?)?`)),
    standing: capture(raw, field(String.raw`standing(?:\s+foundations?)?`)),
    hta: capture(raw, field(String.raw`hta`)),
    hta_post_run: capture(raw, field(String.raw`hta\s+post[\s-]?run`)),
    laying2: capture(raw, field(String.raw`laying\s*2(?:\s+foundations?)?`)),
    art_open: capture(raw, field(String.raw`open`)),
    art_switch: capture(raw, field(String.raw`switch(?:ed|ing)?`)),
    art_cns: capture(raw, field(String.raw`cns`)),
    art_dental: capture(raw, field(String.raw`dental`)),
    art_hormonal: capture(raw, field(String.raw`hormonal`)),
    additional: capture(raw, field(String.raw`foundations?(?:\s+testing)?`)),
  });
}

function mockBodyScan(raw: string): NonNullable<SessionNote['nrt']>['body_scan'] {
  return orNull({
    art_ectoderm: capture(raw, field(String.raw`ectoderm`)),
    art_priority: capture(raw, field(String.raw`art\s+priority`)),
    art_matrix: capture(raw, field(String.raw`art\s+matrix`)),
    art_cell: capture(raw, field(String.raw`art\s+cell`)),
    additional_art: capture(raw, field(String.raw`additional\s+art`)),
    // These must NOT fall back to a bare "matrix"/"cell": the ART pass states
    // the same three readings earlier in the session, so a bare match would take
    // the ART value and file it under NRT — silently attributing a finding to a
    // test that was never run. The prefix is required.
    scan_priority: capture(raw, field(String.raw`scan\s+priority`)),
    scan_matrix: capture(raw, field(String.raw`scan\s+matrix`)),
    scan_cell: capture(raw, field(String.raw`scan\s+cell`)),
    additional_nrt: capture(raw, field(String.raw`body[\s-]?scan`)),
  });
}

function mockNrt(raw: string): SessionNote['nrt'] {
  return {
    pulse0: capture(raw, field(String.raw`pulse\s*0?`)),
    priority1: capture(raw, field(String.raw`priority\s*#?\s*1`)),
    k27: capture(raw, field(String.raw`k[\s-]?27`)),
    stressors: capture(raw, field(String.raw`stressors?`)),
    foundation: mockFoundation(raw),
    body_scan: mockBodyScan(raw),
  };
}

function mockLifestyle(raw: string): SessionNote['lifestyle'] {
  return {
    bm: capture(raw, field(String.raw`bowel movements?|bm`)),
    sleep: capture(raw, field(String.raw`sleep`)),
    water: capture(raw, field(String.raw`water(?:\s+intake)?`)),
    cycle: capture(raw, field(String.raw`(?:menstrual\s+)?cycle`)),
    exercise: capture(raw, field(String.raw`exercise`)),
    diet: capture(raw, field(String.raw`diet`)),
  };
}

export function mockExtractSessionNote(transcript: string): SessionNote {
  const raw = transcript || '';
  const t = raw.toLowerCase(); // cue matching only; captured values come from `raw`

  const concerns: string[] = [];
  const assessments: string[] = [];
  for (const s of SYMPTOMS) {
    if (s.match.test(t)) {
      concerns.push(s.concern);
      assessments.push(s.assessment);
    }
  }

  const goals: string[] = [];
  const goalMatch = raw.match(/(?:goal is|goal:|wants? to|hoping to|would like to)\s+([^.;\n]{3,60})/i);
  if (goalMatch) goals.push(goalMatch[1].trim());

  const starting = /\b(start|begin|add|introduce|let'?s try|put you on)\b/.test(t);
  const supplements: SessionNote['supplements'] = [];
  const protocol_changes: SessionNote['protocol_changes'] = [];
  for (const s of SUPPLEMENTS) {
    if (s.match.test(t)) {
      const change = starting ? 'start' : 'continue';
      supplements.push({ name: s.name, dose: s.dose, quantity: 60, change });
      protocol_changes.push({
        description: `${change === 'start' ? 'Start' : 'Continue'} ${s.name} — ${s.dose}`,
        type: change === 'start' ? 'add' : 'continue',
      });
    }
  }

  // Follow-ups become real, dated tasks on approval, so a due date is only set when
  // a timeframe was actually spoken. There is deliberately no default: an unstated
  // recheck interval must not become a task with an invented date.
  const follow_ups: SessionNote['follow_ups'] = [];
  const weeks = t.match(/(\d+)\s*weeks?/);
  const months = t.match(/(\d+)\s*months?/);
  if (weeks) follow_ups.push({ text: `Recheck in ${weeks[1]} weeks`, due_in_days: Number(weeks[1]) * 7 });
  else if (months) follow_ups.push({ text: `Recheck in ${months[1]} months`, due_in_days: Number(months[1]) * 30 });
  else if (/recheck|follow[\s-]?up|next (visit|session|appointment)/.test(t))
    follow_ups.push({ text: 'Schedule a follow-up', due_in_days: null });

  // Guarantee a non-empty note even for a sparse transcript.
  if (concerns.length === 0) concerns.push('General wellness check-in');
  if (assessments.length === 0) assessments.push('Stable — maintain current plan');

  return {
    concerns,
    goals,
    assessments,
    protocol_changes,
    supplements,
    follow_ups,
    nrt: mockNrt(raw),
    lifestyle: mockLifestyle(raw),
  };
}
