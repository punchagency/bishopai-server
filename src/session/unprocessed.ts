import { pool } from '../db/pool';
import { isQuotaExhausted } from '../llm/errors';

// Matched recordings that never became a readable note.
//
// The gap this closes: a conversation is matched to an appointment, its
// transcript is sitting in the row, and yet there is nothing to review — and
// until now that state was reachable in four different ways, none of which
// appeared anywhere in the app.
//
//   pending / processing   the queue's "processing" banner covers this one
//   failed / needs_review  counted on the dashboard, listed nowhere
//   done, note blank       INVISIBLE — the session shows up in Awaiting review
//                          as a normal draft with every field empty
//
// The third is the one that hurt. On 2026-08-24 seven sessions were extracted
// against a Gemini free-tier daily cap that had been spent since that morning;
// every stage was refused, the merge produced a valid note with nothing in it,
// and `extraction_status` was set to 'done'. 'done' is terminal — the retry
// sweep only looks at 'failed' — so all seven were finished, unretryable, and
// indistinguishable from a session where nobody said anything clinical.
//
// extract.ts now throws when every stage fails, so a total loss lands in
// 'failed' rather than 'done'. That fixes the next one; it does nothing for a
// note already filed, and nothing for the partial case where two stages of four
// came back and the note is real but half-read. Both need somewhere to be seen,
// which is what this is.

/** A recording that is matched and transcribed but has no note worth reading. */
export interface UnprocessedSession {
  conversation_id: string;
  appointment_id: string;
  client_id: string | null;
  client_name: string | null;
  appointment_at: string | null;
  recorded_at: string;
  /** How long the recording runs. The UI says "a 48-minute session"; nobody
   *  reviewing a chart thinks in characters of transcript. */
  duration_seconds: number | null;
  transcript_chars: number;
  extraction_status: string;
  extraction_attempts: number;
  extraction_error: string | null;
  next_attempt_at: string | null;
  reason: UnprocessedReason;
  /** Stages the model never read, from `extraction.partial`. */
  partial: string[];
  /** Findings the note does hold — 0 for a blank one. */
  findings: number;
  sheet_id: string | null;
}

export type UnprocessedReason =
  /** The day's model allowance is spent. Nothing is wrong; it needs tomorrow. */
  | 'quota'
  /** Extraction ran and errored for some other reason. */
  | 'failed'
  /** Gave up after its retries — waiting on a human. */
  | 'needs_review'
  /** Waiting its turn. */
  | 'queued'
  /** In flight right now. */
  | 'running'
  /** Extraction "succeeded" and produced a note with nothing in it. */
  | 'blank'
  /** Some stages landed, others were dropped — the note is real but half-read. */
  | 'incomplete';

/** The note fields that carry clinical content. `evidence` and `extraction` are
 *  metadata about the extraction, not findings from the session, so a note
 *  holding only those is empty however long its JSON is — which is exactly what
 *  a fully-refused run produces. */
const CONTENT_FIELDS = [
  'concerns',
  'goals',
  'assessments',
  'protocol_changes',
  'supplements',
  'follow_ups',
  'nrt',
  'lifestyle',
] as const;

/**
 * How many findings a note actually holds.
 *
 * Walks rather than counting array lengths, because `nrt` and `lifestyle` are
 * objects of mostly-null slots: a session whose only finding is one NRT stressor
 * has six empty arrays and must not read as blank. Nulls, empty strings and
 * empty containers count for nothing; anything else is a finding.
 */
export function countFindings(note: unknown): number {
  if (!note || typeof note !== 'object') return 0;
  const root = note as Record<string, unknown>;
  let n = 0;
  const walk = (v: unknown): void => {
    if (v === null || v === undefined) return;
    if (Array.isArray(v)) {
      v.forEach(walk);
      return;
    }
    if (typeof v === 'object') {
      Object.values(v as Record<string, unknown>).forEach(walk);
      return;
    }
    if (typeof v === 'string' && v.trim() === '') return;
    n++;
  };
  for (const f of CONTENT_FIELDS) walk(root[f]);
  return n;
}

/** Why this recording has no readable note, in the words the UI shows. */
function classify(
  status: string,
  error: string | null,
  findings: number,
  partial: string[],
): UnprocessedReason | null {
  if (status === 'processing') return 'running';
  if (status === 'pending') return 'queued';
  if (status === 'failed' || status === 'needs_review') {
    // A spent allowance is not a fault to investigate — it is a wait. Saying so
    // is the difference between "this is broken" and "this runs tomorrow", and
    // the stored error text is the only place that distinction survives.
    if (error && isQuotaExhausted({ message: error })) return 'quota';
    return status === 'needs_review' ? 'needs_review' : 'failed';
  }
  // status === 'done'
  if (findings === 0) return 'blank';
  if (partial.length > 0) return 'incomplete';
  return null; // a real note — belongs in the review queue, not here
}

interface Row {
  conversation_id: string;
  appointment_id: string;
  client_id: string | null;
  client_name: string | null;
  appointment_at: string | null;
  recorded_at: string;
  duration_seconds: number | null;
  transcript_chars: number;
  extraction_status: string;
  extraction_attempts: number;
  extraction_error: string | null;
  next_attempt_at: string | null;
  sheet_id: string | null;
  content_json: unknown;
}

/**
 * Matched, transcribed recordings with no readable note, newest first.
 *
 * Emptiness is decided in JS, not SQL, for the same reason `listSessions`
 * combines its status there: it is a judgement about the note's shape across
 * eight fields of three different types, and expressing that as a WHERE clause
 * would make it both unreadable and unshared with the UI. The candidate set is
 * bounded by the SQL — one row per matched recording — so the walk is over a
 * handful of rows, not the table.
 */
export async function listUnprocessed(): Promise<UnprocessedSession[]> {
  const r = await pool.query<Row>(
    `SELECT c.id                    AS conversation_id,
            c.appointment_id,
            COALESCE(a.client_id, c.client_id) AS client_id,
            cl.name                 AS client_name,
            a.starts_at             AS appointment_at,
            c.starts_at             AS recorded_at,
            EXTRACT(EPOCH FROM (c.ends_at - c.starts_at))::int AS duration_seconds,
            length(c.transcript)    AS transcript_chars,
            c.extraction_status,
            c.extraction_attempts,
            c.extraction_error,
            c.extraction_next_attempt_at AS next_attempt_at,
            s.id                    AS sheet_id,
            s.content_json
       FROM conversations c
       LEFT JOIN appointments a       ON a.id = c.appointment_id
       -- Whose session this is comes from the APPOINTMENT, which is what the
       -- note is filed against, with the recording's own client as the fallback
       -- for a row that has one before its appointment does.
       --
       -- Deliberately NOT appointment_sheets.client_id. Two live sheets carry a
       -- client that disagrees with both the appointment's and the recording's
       -- (2026-08-26: the sheet on Jodi Hess's appointment is stamped Jenn
       -- Hazzard, and Steve Broderick's is stamped a demo client) — both of them
       -- segments of one split recording, both written by the ON CONFLICT in
       -- processConversation, which sets client_id from the conversation at
       -- extraction time while keying the row on the appointment. A list whose
       -- entire job is to say "this session was never read" must not be the
       -- thing that names the wrong person while saying it.
       LEFT JOIN clients cl           ON cl.id = COALESCE(a.client_id, c.client_id)
       LEFT JOIN appointment_sheets s ON s.appointment_id = c.appointment_id
      WHERE c.appointment_id IS NOT NULL
        AND c.transcript IS NOT NULL
        -- The same two exclusions processConversation claims on. A held or
        -- split recording is not waiting to be extracted, it is waiting on a
        -- decision about whose it is, and it already has a queue of its own.
        AND c.correlation_status NOT IN ('needs_review', 'split')
        -- An approved note is finished clinical content. If it were ever thin,
        -- that was read and signed off, and re-opening it here would invite a
        -- re-extract that the approve path refuses anyway.
        AND (s.status IS NULL OR s.status <> 'approved')
      ORDER BY COALESCE(a.starts_at, c.starts_at) DESC`,
  );

  const out: UnprocessedSession[] = [];
  for (const row of r.rows) {
    const note = (row.content_json ?? null) as Record<string, unknown> | null;
    const meta = (note?.extraction ?? null) as Record<string, unknown> | null;
    const partial = Array.isArray(meta?.partial) ? (meta.partial as string[]) : [];
    const findings = countFindings(note);
    const reason = classify(row.extraction_status, row.extraction_error, findings, partial);
    if (!reason) continue;
    out.push({
      conversation_id: row.conversation_id,
      appointment_id: row.appointment_id,
      client_id: row.client_id,
      client_name: row.client_name,
      appointment_at: row.appointment_at,
      recorded_at: row.recorded_at,
      duration_seconds: row.duration_seconds ?? null,
      transcript_chars: row.transcript_chars ?? 0,
      extraction_status: row.extraction_status,
      extraction_attempts: row.extraction_attempts,
      extraction_error: row.extraction_error,
      next_attempt_at: row.next_attempt_at,
      reason,
      partial,
      findings,
      sheet_id: row.sheet_id,
    });
  }
  return out;
}
