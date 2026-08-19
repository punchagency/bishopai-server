import { preamble, type PromptContext } from './shared';

// Stage A — the narrative pass: what the client said and what anyone committed
// to. Gets the WHOLE session (boilerplate stripped) rather than chunks: concerns
// and goals are stated once, often in passing, and a chunk that doesn't contain
// them can't know they exist.
//
// What the practitioner CONCLUDED used to be extracted here too, and moved out
// to its own stage — see prompts/assessments.ts for why.
export function narrativePrompt(ctx: PromptContext): string {
  return [
    preamble(ctx),
    '',
    'Extract ONLY these fields in this pass: concerns, goals, follow_ups,',
    'lifestyle. Ignore supplements, NRT test readings and the practitioner\'s own',
    'clinical findings entirely — they are extracted separately.',
    '',
    'Field guidance:',
    // NOTE: this section deliberately contains NO example clinical findings.
    // It used to, and models copied them into the output verbatim — a session
    // with none of those problems came back asserting "HPA axis under stress"
    // and "adrenal cortex needs support" because the prompt said those words.
    // Illustrating the SHAPE of a good answer is safe; illustrating its CONTENT
    // in a clinical extractor manufactures findings. Describe, never exemplify.
    '- concerns: what the CLIENT reports as wrong with them. Symptoms and complaints,',
    '  and equally the things they have already been TOLD they have: a diagnosis, a',
    '  condition they were treated for, an operation they had, something a test found,',
    '  a medication they were put on. Those arrive early and in passing, phrased as',
    '  history rather than as a complaint ("they took my thyroid out", "I did the',
    '  antibiotics for it years ago") — and they are the reason the client is in the',
    '  room, so a note without them describes a stranger. Record them as the client',
    '  tells them.',
    '  Keep the context they give with them — investigations, what another practitioner',
    '  advised, and what they say brings it on or makes it worse. A client naming their',
    '  own stressor (a job, a move, a bereavement, a food, an exposure) is reporting a',
    '  concern, not small talk; keep the trigger attached to the symptom it belongs to.',
    '  A condition the PRACTITIONER concludes from testing is not this — that is an',
    '  assessment, and the two stay apart even when they name the same illness.',
    '',
    '  ONE COMPLAINT PER ITEM, and an item is a complaint — not a slice of the',
    '  transcript. Symptoms arrive mid-conversation, interrupted, restarted and talked',
    '  over, so the run of text around one reads "In the— It\'s. This time it-- Usually',
    '  it\'s like, but now-". Copying that is not verbatim capture, it is a paste: what',
    '  the client is describing there is one complaint, said badly, and where they',
    '  describe two things it is two items. Drop the false starts, the cut-off words,',
    '  the other speaker\'s interjections and the crosstalk — and drop nothing else. If',
    '  an item cannot be read aloud as one complaint, it has not been extracted yet.',
    '- goals: what this session is setting out to achieve for the client. A goal the',
    '  CLIENT states is a goal; so is one the PRACTITIONER sets for them, which is how',
    '  most of them arrive here — dictated in a short run, announced as goals and listed',
    '  one after another in a single turn. Every item in that run is its own goal, in',
    '  the words used, and a run of five is five entries. What neither party frames as',
    '  something to work towards is not one: a symptom is a concern, a finding is an',
    '  assessment, and a supplement is neither.',
    '- lifestyle: the client\'s self-reported log — bowel movements (bm), sleep, water',
    '  intake, menstrual cycle, exercise, and diet. Null any the client did not mention.',
    '  Record the reported value only, never the label: "7 hours, broken", not',
    '  "SLEEP: 7 hours". A value that only repeats the label is a blank — leave it null.',
    '  And record the VALUE, not the sentence it arrived in. These are cells in a log,',
    '  read at a glance beside the previous visit\'s: the answer to how they sleep is',
    '  "seven hours, solid", not "I\'m a great sleeper" and not "Great. I do great."',
    '  A MEASUREMENT BEATS A DESCRIPTION. Where the client gives both — a number of',
    '  hours and how it felt, a count and a comment — the number is what the cell is',
    '  for, because it is the part that can be compared with last time. Keep the',
    '  description only if it fits alongside in a few words. If they gave no figure at',
    '  all, their own word is the value. Never carry the question, the small talk, or a',
    '  second topic into the cell.',
    '- follow_ups: each is an action someone committed to, as {text, due_in_days}.',
    '  Set due_in_days ONLY from a timeframe actually spoken ("recheck in 4 weeks" → 28,',
    '  "back in a month" → 30, "next week" → 7). If no timeframe was given, due_in_days',
    '  is null — an undated task is correct. Do not assign a default interval.',
    '',
    '  KEEP THE CONDITION AND WHAT FOLLOWS FROM IT. These are spoken as a pair — the',
    '  sign to watch for, and what is to be done when it appears — and the second half',
    '  is the half that gets dropped. An instruction to make contact if something',
    '  changes, with the change named but not the response, is not a task anyone can',
    '  act on months later: it tells the client to ring and tells nobody what happens',
    '  next. Keep both halves in `text`, in the words they were said in.',
  ].join('\n');
}
