import { preamble, type PromptContext } from './shared';

// Stage C — the NRT grid. A fundamentally different task from the narrative
// pass: this is transcribing a dictated checklist whose readings are terse, are
// interleaved with the hand-position script, and mean nothing out of slot order.
// Sharing a prompt with the narrative stage meant this guidance competed for
// attention with everything else; alone, it can be as specific as the grid is.
export function nrtPrompt(ctx: PromptContext): string {
  return [
    preamble(ctx),
    '',
    'Extract ONLY the NRT test findings in this pass. Ignore client symptoms,',
    'supplements, and follow-ups — they are extracted separately.',
    '',
    'The practitioner works down a fixed list of muscle-testing prompts and calls out',
    'a result for some of them. Fill ONLY the prompts a result was actually called for.',
    'Most sessions leave most slots empty; that is the normal, correct outcome.',
    '',
    '- nrt.pulse0: the Pulse 0 / pulse-point reading, verbatim as spoken.',
    '- nrt.priority1: the stated "Priority #1" finding.',
    '- nrt.k27: the K-27 (kidney-27 reflex point) result.',
    '- nrt.stressors: the stressors identified (immune, food, metal, chemical, scar, etc.).',
    '- nrt.foundation: the foundation muscle-testing pass, prompt by prompt:',
    '    laying1 = "LAYING 1 FOUNDATIONS", standing = "STANDING FOUNDATIONS",',
    '    hta = "HTA", hta_post_run = "HTA POST RUN", laying2 = "LAYING 2 FOUNDATIONS",',
    '    art_open = ART "OPEN", art_switch = ART "SWITCH", art_cns = ART "CNS",',
    '    art_dental = ART "DENTAL", art_hormonal = ART "HORMONAL",',
    '    additional = any foundation finding that fits none of the above.',
    '- nrt.body_scan: the body-scan pass, prompt by prompt. TWO SEPARATE testing rounds:',
    '    ART W/ POL → art_ectoderm ("ECTODERM"), art_priority ("PRIORITY"),',
    '      art_matrix ("MATRIX"), art_cell ("CELL"), additional_art ("ADDITIONAL ART"),',
    '    NRT W/O POL → scan_priority ("PRIORITY"), scan_matrix ("MATRIX"),',
    '      scan_cell ("CELL"), additional_nrt ("ADDITIONAL NRT").',
    '  Do not copy an ART reading into the NRT round or vice versa — they are separate',
    '  tests and the practitioner compares them. If you cannot tell which round a',
    '  reading belongs to, put it in additional_art or additional_nrt rather than',
    '  guessing a slot. A reading in the wrong slot is worse than one in ADDITIONAL.',
    '',
    'Record ONLY the result, never the prompt name: "negative", not "HTA is negative"',
    'and never just "HTA". A value that only repeats the prompt name is a blank —',
    'leave it null.',
  ].join('\n');
}
