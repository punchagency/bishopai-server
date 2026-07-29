import { preamble, type PromptContext } from './shared';

// Stage A — the narrative pass: what the client said, what the practitioner
// concluded, what anyone committed to. Gets the WHOLE session (boilerplate
// stripped) rather than chunks: concerns and goals are stated once, often in
// passing, and a chunk that doesn't contain them can't know they exist.
export function narrativePrompt(ctx: PromptContext): string {
  return [
    preamble(ctx),
    '',
    'Extract ONLY these fields in this pass: concerns, goals, assessments,',
    'follow_ups, lifestyle. Ignore supplements and NRT test readings entirely —',
    'they are extracted separately.',
    '',
    'Field guidance:',
    // NOTE: this section deliberately contains NO example clinical findings.
    // It used to, and models copied them into the output verbatim — a session
    // with none of those problems came back asserting "HPA axis under stress"
    // and "adrenal cortex needs support" because the prompt said those words.
    // Illustrating the SHAPE of a good answer is safe; illustrating its CONTENT
    // in a clinical extractor manufactures findings. Describe, never exemplify.
    '- concerns: symptoms/complaints the CLIENT reports. Capture them verbatim in',
    '  full, including any context the client gives about history, investigations,',
    '  or what other practitioners advised.',
    '- goals: what the CLIENT explicitly says they want to achieve.',
    '- assessments: the PRACTITIONER\'s working conclusions and findings — capture every',
    '  distinct clinical statement made by the practitioner, verbatim or near-verbatim.',
    '  Include organ/system findings, stress-pattern conclusions, neuro/hormonal',
    '  observations, and any body-system the practitioner says needs support.',
    '  Each finding is a separate item, in the practitioner\'s own words. Do not merge,',
    '  summarise, or restate them in more clinical-sounding language than was used.',
    '  Include ONLY statements actually made in THIS transcript.',
    '- lifestyle: the client\'s self-reported log — bowel movements (bm), sleep, water',
    '  intake, menstrual cycle, exercise, and diet. Null any the client did not mention.',
    '  Record the reported value only, never the label: "7 hours, broken", not',
    '  "SLEEP: 7 hours". A value that only repeats the label is a blank — leave it null.',
    '- follow_ups: each is an action someone committed to, as {text, due_in_days}.',
    '  Set due_in_days ONLY from a timeframe actually spoken ("recheck in 4 weeks" → 28,',
    '  "back in a month" → 30, "next week" → 7). If no timeframe was given, due_in_days',
    '  is null — an undated task is correct. Do not assign a default interval.',
  ].join('\n');
}
