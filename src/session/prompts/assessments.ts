import { preamble, type PromptContext } from './shared';

// Stage A2 — the assessments pass: what the practitioner concluded.
//
// This was part of the narrative stage until the eval showed what that cost.
// Assessments are the highest-count field a session produces — a full
// appointment states twenty-odd of them — and they were competing for one
// response with concerns, goals, follow-ups and the six-slot lifestyle log. A
// model asked for five things at once economises on the long list: assessments
// came back at 22% recall while the fields beside them in the same call scored
// three and four times that.
//
// Splitting them out also lets them be WINDOWED, which the narrative pass cannot
// be. A concern is mentioned once, in passing, so a window that does not contain
// it cannot know it exists — the narrative stage has to see the whole session.
// An assessment is one sentence the practitioner says in one breath, and stays
// intact when the session is read a window at a time. That matters because the
// findings this pass misses are not distributed evenly: they cluster in the
// middle of a long transcript, which is exactly what a window fixes.
export function assessmentsPrompt(ctx: PromptContext): string {
  return [
    preamble(ctx),
    '',
    'Extract ONE field in this pass: assessments — the PRACTITIONER\'s working',
    'conclusions and findings. Ignore everything else in the session: what the client',
    'reports, what they want, what anyone committed to, the supplements and the NRT',
    'readings all have their own pass. This pass is only what the practitioner',
    'concluded.',
    '',
    'Capture EVERY distinct clinical statement the practitioner makes, verbatim or',
    'near-verbatim.',
    '',
    'Include organ/system findings, stress-pattern conclusions, neuro/hormonal',
    'observations, and any body-system the practitioner says needs support.',
    'Each finding is a separate item, in the practitioner\'s own words. Do not merge,',
    'summarise, or restate them in more clinical-sounding language than was used.',
    'Include ONLY statements actually made in THIS transcript.',
    '',
    'KEEP THE ATTRIBUTION — but ONLY the words that were said. Practitioners rarely',
    'stop at naming what is wrong: they say what it is coming FROM, what it is',
    'downstream OF, or how long it has been going on. That second half is the part',
    'that gets dropped, and dropping it turns a specific finding into a generic one:',
    'what something is stressed BY is a different fact from the fact that it is',
    'stressed. So when the SAME SENTENCE carries a cause, trigger, source, duration',
    'or knock-on effect — the clause after "because", "from", "due to", "after",',
    '"that\'s why", "which is causing", "ever since" — keep that clause in the item.',
    '',
    'Keeping the clause is the ONLY thing that may lengthen an item. An item is a',
    'span of the practitioner\'s speech, trimmed of filler and nothing else. Do not',
    'add what it implies, what it is connected to elsewhere in the session, or what',
    'should be done about it. "The thyroid is crashing" is the finding; "the thyroid',
    'is crashing and needs glandular support" is two findings welded together, and',
    'the weld is yours, not theirs. If the item reads more like a chart note than',
    'like something a person said out loud, it has been rewritten — go back to their',
    'wording.',
    '',
    'The item and the quote you cite for it should be the SAME WORDS. You are asked',
    'for a verbatim quote from the turn either way — if what you write in the item',
    'differs from that quote by more than the filler you trimmed, you have composed a',
    'sentence rather than recorded one.',
    '',
    'This is a recall task, not a summarisation task. Long sessions state findings',
    'scattered from the first minute to the last, several of them in a single turn.',
    'Work through the text in order and emit each one as you reach it rather than',
    'writing a condensed account at the end. Twenty short, specific items is a',
    'normal, correct result for a full appointment — proportionally fewer when you',
    'are reading one part of one — and five polished ones is a failed extraction',
    'even when all five are true.',
    '',
    'A cause is only ever RECORDED, never supplied. If the practitioner names a',
    'problem and no cause, the item is the problem alone — connecting it to a cause',
    'mentioned elsewhere in the session is you reasoning, and a reasoned causal claim',
    'in a clinical record is a fabrication no matter how likely it is.',
  ].join('\n');
}
