import { logEvent } from '../observability/logger';
import { generateStructured } from '../llm/providers';
import { HANDOVER_PATTERNS, estimateTokens, prepareTurns, type Role } from './transcript';
import { scoreNameMatch, nameSignalRank } from '../correlation/nameMatch';
import { z } from 'zod';

export interface TurnSegment {
  index: number;
  speaker: string;
  text: string;
  role?: Role;
}

export interface CalendarAppointment {
  id: string;
  starts_at: string;
  ends_at: string;
  client_name: string | null;
  /** Seconds of overlap between the recording window and this appointment. */
  overlap_seconds: number;
}

export interface SessionBoundarySegment {
  from_turn: number;
  to_turn: number;
  client_name_hint?: string | null;
  /** Best appointment ID match by overlap maximisation (not positional). */
  suggested_appointment_id?: string | null;
  snippet: string;
  confidence_score?: number;
  /** Set when segmentation could not do its job, so the UI can say why rather
   *  than presenting an unsplittable recording as a confident single session. */
  detection_note?: string | null;
  /** Set when the segment's turn-proportion disagrees with the matched
   *  appointment's time-overlap by more than 25%. */
  time_disagreement_note?: string | null;
}

/**
 * A consultation is at least this many turns.
 *
 * Absolute, not a fraction of the recording. A proportional floor (n/3) reads
 * plausibly but forbids a boundary anywhere outside the middle third: a 62-turn
 * recording of two appointments that split 45/17 — one client ran long, or the
 * recorder was started late — was rejected at both ends and returned as one
 * session. Two appointments are two appointments however unevenly they divide.
 */
const MIN_SEGMENT_TURNS = 12;

/**
 * Most consecutive appointments one recording is allowed to yield.
 *
 * A backstop, not the control: the score >= 50 gate is what keeps a single
 * consultation from fragmenting. This only bounds the damage if a recording
 * defeats the gate, so it sits above any realistic back-to-back run rather than
 * clipping a genuine one.
 */
const MAX_SESSIONS = 6;

/** Utility to escape regular expression special characters in client names */
function escapeRegExp(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Majority role for each speaker label across the whole recording. */
function rolesBySpeaker(turns: { speaker: string; role?: Role }[]): Map<string, Role> {
  const counts = new Map<string, { p: number; c: number }>();
  for (const t of turns) {
    const agg = counts.get(t.speaker) ?? { p: 0, c: 0 };
    if (t.role === 'PRACTITIONER') agg.p++;
    else if (t.role === 'CLIENT') agg.c++;
    counts.set(t.speaker, agg);
  }
  const out = new Map<string, Role>();
  for (const [spk, { p, c }] of counts) {
    out.set(spk, p > c ? 'PRACTITIONER' : c > p ? 'CLIENT' : 'UNKNOWN');
  }
  return out;
}

/**
 * Parse transcript text into individual speaker turns.
 *
 * Turn numbering is `prepareTurns` + 1: the shared pipeline is 0-based and this
 * API is 1-based (the split payload and `turn_range` require positive ints), so
 * segmenter turn N is always prepared turn N-1 — a fixed offset rather than the
 * drifting one two separate parsers produced.
 *
 * Roles are resolved per speaker label, not per turn. `attributeSpeakers` scores
 * each turn on its own, so one voice can come back PRACTITIONER on a question
 * and CLIENT on the answer; a boundary signal built on that reads a single
 * person as two. The majority across the recording is the person.
 */
export function parseTurns(transcript: string): TurnSegment[] {
  const turns = prepareTurns(transcript);
  if (turns.length === 0) {
    return transcript.trim()
      ? [{ index: 1, speaker: 'SPEAKER', text: transcript.trim(), role: 'UNKNOWN' }]
      : [];
  }

  const bySpeaker = rolesBySpeaker(turns);

  return turns.map((t) => ({
    index: t.index + 1,
    speaker: t.speaker,
    text: t.text,
    role: bySpeaker.get(t.speaker) ?? t.role,
  }));
}

/**
 * Per-turn character caps, widest first. Boundary detection needs every TURN,
 * but it does not need every WORD of every turn: a handover is visible in
 * "Have fun. Hello." / "Hi." — short lines by nature — while the budget is eaten
 * by long clinical explanations, which is not where sessions change.
 *
 * So when a transcript is too large we shorten turns rather than drop them. The
 * previous code did the opposite: it sent the first 50 and last 50 turns and
 * discarded the middle, which makes a boundary anywhere in the middle of a long
 * recording undetectable at any temperature — the model is never shown it.
 */
const TURN_TEXT_CAPS = [240, 160, 100, 60, 40] as const;

/**
 * Ceiling for the rendered transcript, in estimated tokens.
 *
 * Deliberately generous. Measured over the ten production recordings on
 * 2026-08-24 the largest full-hour consultation rendered to ~8k tokens, so in
 * practice every real transcript is sent whole at the widest cap and the ladder
 * below never engages. It exists for the recording that is one day far longer
 * than anything we have seen, not for the ones we have.
 */
const PROMPT_TOKEN_CEILING = Number(process.env.SEGMENTER_PROMPT_TOKENS ?? 120_000);

/** A human is waiting on this, but a model call is not a 4-second operation. */
const LLM_TIMEOUT_MS = Number(process.env.SEGMENTER_LLM_TIMEOUT_MS ?? 30_000);

/**
 * Render every turn for the boundary prompt, narrowing turn text until the whole
 * thing fits. Never drops a turn.
 */
export function renderTurnsForBoundaryPrompt(
  turns: readonly TurnSegment[],
  ceiling: number = PROMPT_TOKEN_CEILING,
): { lines: string[]; cap: number; fits: boolean } {
  for (const cap of TURN_TEXT_CAPS) {
    const lines = turns.map((t) => `#${t.index} ${t.speaker}: ${t.text.slice(0, cap)}`);
    if (estimateTokens(lines.join('\n')) <= ceiling) return { lines, cap, fits: true };
  }
  const cap = TURN_TEXT_CAPS[TURN_TEXT_CAPS.length - 1];
  return {
    lines: turns.map((t) => `#${t.index} ${t.speaker}: ${t.text.slice(0, cap)}`),
    cap,
    fits: false,
  };
}

/**
 * Detect transition boundaries between multiple client sessions using Multi-Signal Boundary Scoring Matrix + LLM fallback.
 */
export async function detectSessionBoundaries(
  transcript: string,
  candidateClientNames: string[] = [],
  calendarAppointments: CalendarAppointment[] = [],
  recordingStartMs?: number,
  recordingEndMs?: number,
  practitionerName: string = process.env.PRACTITIONER_NAME?.trim() || 'NICOLE',
): Promise<SessionBoundarySegment[]> {
  // Count appointments with genuine time overlap (> 0 s) — that's the calendar's
  // best guess at how many sessions are in this recording.
  const overlappingAppts = calendarAppointments.filter((a) => a.overlap_seconds > 0);
  const calendarSessionCount = overlappingAppts.length;
  const turns = parseTurns(transcript);
  if (turns.length <= 1) {
    // One turn means the speaker labels never recurred enough to be believed —
    // the recording is not one long utterance, we simply could not find the
    // turns in it. Saying so is the difference between the splitter offering a
    // single confident session and admitting it has nothing to split on.
    return [
      {
        from_turn: 1,
        to_turn: Math.max(1, turns.length),
        snippet: transcript.slice(0, 200),
        confidence_score: turns.length === 0 ? 0 : 40,
        detection_note: transcript.trim()
          ? 'Could not detect speaker turns in this transcript — segmentation unavailable.'
          : 'Transcript is empty.',
      },
    ];
  }

  // The same two patterns mergeAdjacentTurns refuses to fuse across. Imported
  // rather than restated: when these were defined here and the merge had no
  // notion of them at all, the merge fused every handover the practitioner spoke
  // both halves of, and this scorer spent its time looking for a seam that had
  // already been erased.
  const { FAREWELL_RE: FAREWELL_REGEX, GREETING_RE: GREETING_REGEX } = HANDOVER_PATTERNS;

  // `parseTurns` already resolved a majority role per speaker; this only layers
  // the two things it cannot know — who the practitioner is by name, and who is
  // booked today.
  const globalSpeakerRoles = new Map<string, Role>();
  for (const t of turns) {
    if (globalSpeakerRoles.has(t.speaker)) continue;
    globalSpeakerRoles.set(t.speaker, t.role ?? 'UNKNOWN');
  }

  // A client can share the practitioner's first name. Booked-today wins: the
  // label belongs to whoever is on the calendar, not to the keyword.
  const candidateFirstNames = new Set(
    candidateClientNames.map((n) => n.split(' ')[0].toLowerCase()).filter((n) => n.length >= 2),
  );
  for (const spk of globalSpeakerRoles.keys()) {
    const lower = spk.toLowerCase();
    if (candidateFirstNames.has(lower)) continue;
    if (lower.includes('practitioner') || spk.toUpperCase().includes(practitionerName.toUpperCase())) {
      globalSpeakerRoles.set(spk, 'PRACTITIONER');
    }
  }

  // Diarized labels (SPEAKER_00) carry no name to match on, so if nothing came
  // back PRACTITIONER the role vote was inconclusive for every speaker. The
  // practitioner is the one constant across a multi-client recording: whoever
  // holds the most turns. Without this the practitioner reads as a client and
  // every alternating turn scores a diarization shift.
  if (![...globalSpeakerRoles.values()].includes('PRACTITIONER')) {
    const shares = new Map<string, number>();
    for (const t of turns) shares.set(t.speaker, (shares.get(t.speaker) ?? 0) + 1);
    const top = [...shares.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0];
    if (top) globalSpeakerRoles.set(top[0], 'PRACTITIONER');
  }

  let activeClientSpeaker = '';
  const turnScores = new Map<number, number>();

  for (let i = 1; i < turns.length; i++) {
    const turn = turns[i];
    const prevTurn = turns[i - 1];
    let score = 0;

    const role = globalSpeakerRoles.get(turn.speaker) ?? turn.role;
    const isPractitioner = role === 'PRACTITIONER';

    if (!isPractitioner && turn.speaker !== 'SPEAKER' && turn.speaker !== 'UNKNOWN') {
      if (activeClientSpeaker && activeClientSpeaker !== turn.speaker) {
        score += 40;
      }
      activeClientSpeaker = turn.speaker;
    }

    const prevFarewell = FAREWELL_REGEX.test(prevTurn.text);
    const currentGreeting = GREETING_REGEX.test(turn.text);
    if (prevFarewell && currentGreeting) {
      score += 30;
    }

    let directGreetingName = false;
    for (const name of candidateClientNames) {
      const firstName = name.split(' ')[0];
      if (firstName && firstName.length >= 2) {
        const safeName = escapeRegExp(firstName);
        const greetingNameRegex = new RegExp(`\\b(hi|hello|welcome|hey)[,\\s]+${safeName}\\b`, 'i');
        if (greetingNameRegex.test(turn.text)) {
          directGreetingName = true;
          score += 30;
          break;
        }
      }
    }

    if (prevFarewell && directGreetingName) {
      score += 20;
    }

    if (score >= 50) {
      turnScores.set(turn.index, score);
    }
  }

  const boundaryTurns: number[] = [1];
  const sortedScoredTurns = Array.from(turnScores.entries()).sort((a, b) => b[1] - a[1] || a[0] - b[0]);

  for (const [turnIdx] of sortedScoredTurns) {
    if (boundaryTurns.length >= MAX_SESSIONS) break;
    const isFarEnoughFromPrior = boundaryTurns.every((b) => Math.abs(b - turnIdx) >= MIN_SEGMENT_TURNS);
    // `+ 1` because a segment running from `turnIdx` to the last turn holds
    // `length - turnIdx + 1` turns, not `length - turnIdx`. Without it a 12-turn
    // minimum quietly demanded 13.
    const isFarEnoughFromEnd = turns.length - turnIdx + 1 >= MIN_SEGMENT_TURNS;
    if (isFarEnoughFromPrior && isFarEnoughFromEnd && turnIdx > 1) {
      boundaryTurns.push(turnIdx);
    }
  }

  // LLM Fallback: run when (a) heuristics found no boundary AND turns >= 20,
  // OR (b) the calendar expects 2+ overlapping sessions but we only have 1 segment.
  const heuristicsUndercount = calendarSessionCount >= 2 && boundaryTurns.length < calendarSessionCount;
  if (turns.length >= 20 && (boundaryTurns.length === 1 || heuristicsUndercount)) {
    let timerId: NodeJS.Timeout | undefined;
    try {
      const rendered = renderTurnsForBoundaryPrompt(turns);
      const turnSummaryLines = rendered.lines;
      if (!rendered.fits) {
        logEvent('warn', 'segmenter.prompt_narrowed', 'transcript exceeded the prompt ceiling at every cap', {
          total_turns: turns.length,
          turn_text_cap: rendered.cap,
        });
      }

      const calendarHint =
        calendarSessionCount >= 2
          ? `\nIMPORTANT: The calendar shows ${calendarSessionCount} appointments overlapping this recording. Expect ${calendarSessionCount} sessions unless the transcript clearly shows otherwise.`
          : '';

      const systemPrompt = `You are a clinical assistant analyzing a continuous recording transcript that may contain multiple consecutive client appointments recorded back-to-back.
Identify the turn numbers (#1, #2, etc.) where ONE patient consultation ends and a DIFFERENT patient consultation begins.
IMPORTANT RULES:
- A real consultation lasts at least ${MIN_SEGMENT_TURNS} turns, usually many more. Do NOT split for casual name drops in conversation.
- Only return turn numbers where a patient leaves and a NEW patient consultation begins (e.g. farewells followed by greetings like "Hi Steve").${calendarHint}
Return JSON object: {"boundary_turns": [1, 49]}`;

      const userPrompt = `Candidate Patients booked today: ${candidateClientNames.join(', ') || 'None specified'}

Transcript Turns:
${turnSummaryLines.join('\n')}`;

      const llmPromise = generateStructured({
        system: systemPrompt,
        user: userPrompt,
        zodSchema: z.object({ boundary_turns: z.array(z.number().int()) }),
        jsonSchema: {
          type: 'object',
          properties: {
            boundary_turns: { type: 'array', items: { type: 'integer' } },
          },
          required: ['boundary_turns'],
        },
        maxTokens: 1000,
      });

      const timeoutPromise = new Promise<null>((resolve) => {
        timerId = setTimeout(() => resolve(null), LLM_TIMEOUT_MS);
      });

      const res = await Promise.race([llmPromise, timeoutPromise]);

      if (res && 'parsed' in res) {
        const parsed = res.parsed as { boundary_turns?: number[] };
        if (parsed?.boundary_turns && Array.isArray(parsed.boundary_turns)) {
          // Integers only. The JSON schema asks for them and the zod schema now
          // enforces them, but a provider that ignores both would otherwise put
          // a fractional turn into `from_turn`, which the split endpoint then
          // rejects as a 400 — a confusing failure two screens away from its
          // cause, instead of a boundary quietly declined here.
          const sortedLlmTurns = parsed.boundary_turns
            .filter((n) => Number.isInteger(n))
            .sort((a, b) => a - b);
          for (const turnNum of sortedLlmTurns) {
            if (boundaryTurns.length >= MAX_SESSIONS) break;
            const isFarEnoughFromPrior = boundaryTurns.every((b) => Math.abs(b - turnNum) >= MIN_SEGMENT_TURNS);
            const isFarEnoughFromEnd = turns.length - turnNum + 1 >= MIN_SEGMENT_TURNS;
            if (isFarEnoughFromPrior && isFarEnoughFromEnd && turnNum > 1) {
              boundaryTurns.push(turnNum);
              turnScores.set(turnNum, 60);
            }
          }
        }
      }
    } catch (err) {
      logEvent('warn', 'segmenter.llm_fallback_error', 'LLM segmenter fallback failed', { error: String(err) });
    } finally {
      if (timerId) clearTimeout(timerId);
    }
  }

  // Already capped during selection, which runs highest-score-first. The old
  // post-hoc trim re-sorted by score and sliced the top 2 — but the scores are
  // quantised, so ties were the norm and a stable sort handed them back in clock
  // order: on a busy recording it kept the two earliest boundaries and lumped
  // everything after them into one trailing blob.
  const uniqueBoundaries = Array.from(new Set(boundaryTurns)).sort((a, b) => a - b);

  const segments: SessionBoundarySegment[] = [];

  // Build raw segments first so we can do multi-signal appointment assignment.
  const rawSegments: Array<{
    fromTurn: number;
    toTurn: number;
    turnShare: number;
    sliceText: string;
    clientHint: string | null;
    snippet: string;
    confidenceScore: number;
  }> = [];

  for (let i = 0; i < uniqueBoundaries.length; i++) {
    const fromTurn = uniqueBoundaries[i];
    const toTurn = i < uniqueBoundaries.length - 1 ? uniqueBoundaries[i + 1] - 1 : turns.length;

    const turnSlice = turns.filter((t) => t.index >= fromTurn && t.index <= toTurn);
    const sliceText = turnSlice.map((t) => `${t.speaker}: ${t.text}`).join('\n');

    let clientHint: string | null = null;
    let maxRank = 0;

    for (const name of candidateClientNames) {
      const sig = scoreNameMatch(sliceText, name);
      const rank = nameSignalRank(sig);
      if (rank > maxRank) {
        maxRank = rank;
        clientHint = name;
      }
    }

    rawSegments.push({
      fromTurn,
      toTurn,
      turnShare: turns.length > 0 ? (toTurn - fromTurn + 1) / turns.length : 0,
      sliceText,
      clientHint,
      snippet: sliceText.slice(0, 300),
      confidenceScore: turnScores.get(fromTurn) ?? (fromTurn === 1 ? (uniqueBoundaries.length > 1 ? 85 : 95) : 50),
    });
  }

  // Assigning segments to appointments.
  //
  // Two signals, ranked rather than added together:
  //
  //   nameRank  identity evidence from the transcript itself (nameSignalRank:
  //             0 for nothing, ~1000-3999 for a mention, +5000 for a direct
  //             address like "Hi Jodi").
  //   timeScore how much of the recording this segment shares with the
  //             appointment's calendar window, 0-1000.
  //
  // These used to be SUMMED, and that quietly made them the same currency. The
  // name tiers sit 1000 apart and a full-overlap timeScore is worth exactly
  // 1000, so time could promote a weaker name match a whole tier and outrank a
  // stronger one — the opposite of the stated design, where transcript identity
  // leads and the calendar breaks ties. Comparing them lexicographically is what
  // actually expresses "name first, then time".
  const MIN_TIME_SHARE = 0.25;

  interface Pair {
    si: number;
    appt: CalendarAppointment;
    nameRank: number;
    timeScore: number;
    overlapMs: number;
  }

  const assignedApptIds = new Set<string>();
  const segmentApptIds: (string | null)[] = rawSegments.map(() => null);
  const segmentDisagreementNotes: (string | null)[] = rawSegments.map(() => null);

  const recStartMs = recordingStartMs ?? 0;
  const recEndMs = recordingEndMs ?? 0;
  // A start with no end (or the reverse) gives no usable window at all. Falling
  // back to Math.max(1, ...) there produced a 1ms recording, against which any
  // appointment containing that instant scored a perfect 1000 — a confident
  // answer manufactured from a missing field.
  const haveWindow = recEndMs > recStartMs && recStartMs > 0;
  const recDurMs = haveWindow ? recEndMs - recStartMs : 0;

  // Only consider appointments with real overlap (>0s) for auto-assignment.
  const assignableAppts = overlappingAppts.slice().sort(
    (a, b) => new Date(a.starts_at).getTime() - new Date(b.starts_at).getTime(),
  );

  // The time winner per segment, kept for the disagreement note: it is what the
  // calendar alone would have said, and saying so is only meaningful when the
  // transcript overruled it.
  const timeWinnerBySegment: (CalendarAppointment | null)[] = rawSegments.map(() => null);

  const pairs: Pair[] = [];
  for (let si = 0; si < rawSegments.length; si++) {
    const seg = rawSegments[si];
    const segStartMs = recStartMs + Math.round(((seg.fromTurn - 1) / Math.max(1, turns.length)) * recDurMs);
    const segEndMs = recStartMs + Math.round((seg.toTurn / Math.max(1, turns.length)) * recDurMs);
    let maxOverlapMs = 0;

    for (const appt of assignableAppts) {
      const apptStartMs = new Date(appt.starts_at).getTime();
      const apptEndMs = new Date(appt.ends_at).getTime();
      const overlapMs = haveWindow
        ? Math.max(0, Math.min(segEndMs, apptEndMs) - Math.max(segStartMs, apptStartMs))
        : 0;
      if (overlapMs > maxOverlapMs) {
        maxOverlapMs = overlapMs;
        timeWinnerBySegment[si] = appt;
      }
      const nameRank = nameSignalRank(scoreNameMatch(seg.sliceText, appt.client_name));
      const timeScore = recDurMs > 0 ? (overlapMs / recDurMs) * 1000 : 0;

      // The floor. A segment used to be assigned to whatever scrap of an
      // appointment was left over: measured on a two-appointment recording, one
      // segment was bound to an appointment on a composite of ~17 out of a
      // possible ~9000 — no name evidence at all and one minute of trailing
      // overlap — and presented as a suggestion with nothing to say it was a
      // guess. Either the transcript names this person, or the windows genuinely
      // coincide. Neither, and we decline to guess.
      if (nameRank === 0 && timeScore < MIN_TIME_SHARE * 1000) continue;
      pairs.push({ si, appt, nameRank, timeScore, overlapMs });
    }
  }

  // Best match globally, never first match.
  //
  // Segments used to claim appointments in order, so segment 0 took its best
  // guess and segment 1 could not have it however much stronger its evidence
  // was. evalMatch.ts carries a long comment about being burned by exactly this
  // — greedy first-past-the-post silently mis-binding pairs that share a signal
  // — and there it only corrupted a metric. Here it decides whose chart the
  // clinical content lands on. Sorting every candidate pair and taking them
  // strongest-first means the best-evidenced claim wins regardless of where its
  // segment happens to sit in the recording.
  pairs.sort((a, b) => b.nameRank - a.nameRank || b.timeScore - a.timeScore);
  for (const pair of pairs) {
    if (segmentApptIds[pair.si] !== null) continue;
    if (assignedApptIds.has(pair.appt.id)) continue;
    segmentApptIds[pair.si] = pair.appt.id;
    assignedApptIds.add(pair.appt.id);
  }

  for (let si = 0; si < rawSegments.length; si++) {
    const seg = rawSegments[si];
    const apptId = segmentApptIds[si];
    if (!apptId) continue;
    const bestAppt = assignableAppts.find((a) => a.id === apptId)!;
    const timeWinner = timeWinnerBySegment[si];

    // The transcript overruled the calendar. Worth saying, because it is the
    // case a human should look at — and it must only be said when it is true.
    // Under the old summed score this note fired on segments whose name
    // evidence had NOT won, announcing the wrong client with real confidence.
    if (timeWinner && timeWinner.id !== bestAppt.id && timeWinner.client_name && bestAppt.client_name) {
      segmentDisagreementNotes[si] =
        `Transcript evidence points to ${bestAppt.client_name}, but calendar overlap suggested ${timeWinner.client_name}.`;
      continue;
    }

    // The name the transcript shouts and the name we filed it under are two
    // different people. Nothing checked this before, so a segment could come
    // back hinting at one client and suggesting another's appointment with no
    // sign that the two disagreed.
    if (seg.clientHint && bestAppt.client_name && seg.clientHint !== bestAppt.client_name) {
      segmentDisagreementNotes[si] =
        `This segment reads like ${seg.clientHint}, but it has been matched to ${bestAppt.client_name}'s appointment. Check before splitting.`;
      continue;
    }

    if (recDurMs > 0 && bestAppt.overlap_seconds > 0) {
      const apptOverlapShare = (bestAppt.overlap_seconds * 1000) / recDurMs;
      const diff = Math.abs(seg.turnShare - apptOverlapShare);
      if (diff > 0.25) {
        const turnPct = Math.round(seg.turnShare * 100);
        const calPct = Math.round(apptOverlapShare * 100);
        segmentDisagreementNotes[si] =
          `Turn share (${turnPct}%) differs from calendar overlap (${calPct}%) by more than 25% — ` +
          `the boundary may be in the wrong place, or the appointment ran short/long.`;
      }
    }
  }

  for (let i = 0; i < rawSegments.length; i++) {
    const s = rawSegments[i];
    segments.push({
      from_turn: s.fromTurn,
      to_turn: s.toTurn,
      client_name_hint: s.clientHint,
      suggested_appointment_id: segmentApptIds[i],
      snippet: s.snippet,
      confidence_score: s.confidenceScore,
      time_disagreement_note: segmentDisagreementNotes[i],
    });
  }

  logEvent('info', 'segmenter.detect', 'detected session boundaries', {
    total_turns: turns.length,
    segments_count: segments.length,
    boundaries: uniqueBoundaries,
  });

  return segments;
}

/**
 * Slice a raw transcript by turn range (from_turn to to_turn inclusive).
 */
export function sliceTranscriptByTurnRange(transcript: string, fromTurn: number, toTurn: number): string {
  const turns = parseTurns(transcript);
  const selectedTurns = turns.filter((t) => t.index >= fromTurn && t.index <= toTurn);
  if (selectedTurns.length === 0) return transcript;
  return selectedTurns.map((t) => `${t.speaker}: ${t.text}`).join('\n\n');
}
