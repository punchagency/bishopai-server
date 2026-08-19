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
    '  or what other practitioners advised — and including what they say brings it',
    '  on or makes it worse. A client naming their own stressor (a job, a move, a',
    '  bereavement, a food, an exposure) is reporting a concern, not small talk;',
    '  keep the trigger attached to the symptom it belongs to.',
    '- goals: what the CLIENT explicitly says they want to achieve.',
    '- assessments: the PRACTITIONER\'s working conclusions and findings — capture every',
    '  distinct clinical statement made by the practitioner, verbatim or near-verbatim.',
    '  Include organ/system findings, stress-pattern conclusions, neuro/hormonal',
    '  observations, and any body-system the practitioner says needs support.',
    '  Each finding is a separate item, in the practitioner\'s own words. Do not merge,',
    '  summarise, or restate them in more clinical-sounding language than was used.',
    '  Include ONLY statements actually made in THIS transcript.',
    '',
    '  KEEP THE ATTRIBUTION — but ONLY the words that were said. Practitioners rarely',
    '  stop at naming what is wrong: they say what it is coming FROM, what it is',
    '  downstream OF, or how long it has been going on. That second half is the part',
    '  that gets dropped, and dropping it turns a specific finding into a generic one:',
    '  what something is stressed BY is a different fact from the fact that it is',
    '  stressed. So when the SAME SENTENCE carries a cause, trigger, source, duration',
    '  or knock-on effect — the clause after "because", "from", "due to", "after",',
    '  "that\'s why", "which is causing", "ever since" — keep that clause in the item.',
    '',
    '  Keeping the clause is the ONLY thing that may lengthen an item. An item is a',
    '  span of the practitioner\'s speech, trimmed of filler and nothing else. Do not',
    '  add what it implies, what it is connected to elsewhere in the session, or what',
    '  should be done about it. "The thyroid is crashing" is the finding; "the thyroid',
    '  is crashing and needs glandular support" is two findings welded together, and',
    '  the weld is yours, not theirs. If the item reads more like a chart note than',
    '  like something a person said out loud, it has been rewritten — go back to their',
    '  wording.',
    '',
    '  This is a recall task, not a summarisation task. Long sessions state findings',
    '  scattered from the first minute to the last, several of them in a single turn.',
    '  Work through the transcript in order and emit each one as you reach it rather',
    '  than writing a condensed account at the end. Twenty short, specific items is a',
    '  normal, correct result for a full appointment; five polished ones is a failed',
    '  extraction even when all five are true.',
    '',
    '  A cause is only ever RECORDED, never supplied. If the practitioner names a',
    '  problem and no cause, the item is the problem alone — connecting it to a cause',
    '  mentioned elsewhere in the session is you reasoning, and a reasoned causal claim',
    '  in a clinical record is a fabrication no matter how likely it is.',
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
