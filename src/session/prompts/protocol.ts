import { catalogBlock, preamble, type PromptContext } from './shared';

// Stage B — the protocol pass: supplements and the changes made to them. This is
// the stage whose output moves money and gets swallowed, so it carries the
// catalog vocabulary and the hardest line on guessing.
export function protocolPrompt(ctx: PromptContext): string {
  return [
    preamble(ctx),
    '',
    'Extract ONLY these fields in this pass: supplements, protocol_changes.',
    'Ignore client symptoms and NRT test readings — they are extracted separately.',
    '',
    'Field guidance:',
    '- protocol_changes: every supplement change the practitioner states — match the',
    '  type field to the action: "add"/"start" → add, "stop"/"remove"/"take out" → remove,',
    '  "continue"/"keep" → continue, dose or frequency changes → adjust.',
    '  Include ALL changes mentioned: continues, removals, additions.',
    '- supplements: every supplement the practitioner names with an action for it.',
    '  change is one of start | stop | increase | decrease | continue. Use the word',
    '  that matches what was said. If the practitioner NEGATES an action ("we\'re NOT',
    '  going to add that", "don\'t increase it yet"), that is not the action — either',
    '  record the action actually taken or omit the supplement.',
    '- supplements[].dose: the dose verbatim as spoken ("two caps twice a day").',
    '- supplements[].units_per_dose / unit / doses_per_day: the same dose as numbers,',
    '  when it was stated plainly. "two caps twice a day" → 2 / "cap" / 2. Leave null',
    '  if you have to reason about it; the verbatim string is what matters most.',
    '- supplements[].quantity: bottle/package count, only if stated.',
    '- supplements[].func: what the supplement is FOR, only if the practitioner says',
    '  so ("this one is for the adrenals"). Never invent a purpose from the name.',
    '- supplements[].obtained_from: "Here" or "Fullscript", only if stated.',
    '- supplements[].schedule: when the practitioner states WHEN a supplement is taken,',
    '  put the amount in that slot: uponWaking, breakfast, midMorning, lunch,',
    '  midAfternoon, dinner, beforeBed. "two caps with breakfast and one before bed"',
    '  → {breakfast: "2 caps", beforeBed: "1 cap"}. Leave every slot null if no timing',
    '  was spoken — do NOT spread a daily dose across meals to make it add up.',
    catalogBlock(ctx.catalog),
  ]
    .filter(Boolean)
    .join('\n');
}
