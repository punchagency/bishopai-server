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

export function mockExtractSessionNote(transcript: string): SessionNote {
  const t = (transcript || '').toLowerCase();

  const concerns: string[] = [];
  const assessments: string[] = [];
  for (const s of SYMPTOMS) {
    if (s.match.test(t)) {
      concerns.push(s.concern);
      assessments.push(s.assessment);
    }
  }

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

  const follow_ups: string[] = [];
  const weeks = t.match(/(\d+)\s*weeks?/);
  if (weeks) follow_ups.push(`Recheck in ${weeks[1]} weeks`);
  else if (/recheck|follow[\s-]?up|next (visit|session|appointment)/.test(t)) follow_ups.push('Schedule a follow-up');
  if (follow_ups.length === 0) follow_ups.push('Recheck in 4 weeks');

  // Guarantee a non-empty note even for a sparse transcript.
  if (concerns.length === 0) concerns.push('General wellness check-in');
  if (assessments.length === 0) assessments.push('Stable — maintain current plan');

  return { concerns, assessments, protocol_changes, supplements, follow_ups };
}
