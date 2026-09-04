import { Router } from 'express';
import { z } from 'zod';
import { pool } from '../db/pool';
import { logError, logEvent } from '../observability/logger';
import { coerceSessionNote, renderAppointmentSheet, renderProtocol } from '../session/render';
import { enqueueExtraction } from '../session/queue';
import { ingestConversation } from '../conversations/ingest';
import { manualSourceId, normalizeManualTranscript } from '../conversations/manualImport';
import { publishApproved } from '../session/publish';
import { publishClientTemplates, republishAmended } from '../session/publishTemplates';
import {
  syncClientSupplements,
  fetchCurrentSupplements,
  previewSupplementMerge,
  removeSupplementsDroppedByAmendment,
} from '../session/supplements';
import { createTasksFromNote } from '../tasks/service';
import { DRAFT_REPLACED_REASON, fetchRevisions, snapshotRevision } from '../session/revisions';
import { scoreNameMatch, nameSignalRank, overlapSeconds } from '../correlation/nameMatch';
import { prepareTranscript } from '../session/transcript';
import { recordAudit } from '../audit/log';
import {
  listSessions,
  getSession,
  patchSession,
  approveSession,
  amendSession,
  appointmentForItem,
} from '../session/sessionService';
import { parseTurns, sliceTranscriptByTurnRange } from '../session/segmenter';
import { computeSegmentation, type SegmentationResult } from '../session/segmentation';
import { listUnprocessed } from '../session/unprocessed';

// Nicole's review queue: the draft Appointment Sheets + Protocols produced by
// session extraction, with edit + approve. (No auth yet — approved_by is a
// placeholder until login lands; the approve action is audited via approvals.)
export const reviewRouter = Router();

/**
 * The 409 body for a manual review action aimed at a recording that is past
 * being acted on, or `null` when the status is still actionable.
 *
 * `split` and `discarded` both carry `appointment_id IS NULL`, which is the only
 * guard the /match, /assign-client and /split handlers share — so without an
 * explicit status check a split parent could be re-filed under a neighbouring
 * booking, and a discarded noise clip could be pulled back into the pipeline, by
 * a direct API call. Neither is reachable from the UI (the unmatched list and
 * detail endpoint already exclude them), but the write guard should not depend
 * on that.
 */
function terminalCorrelationConflict(
  status: string,
): { error: string; detail: string } | null {
  if (status === 'split') {
    return {
      error: 'already split',
      detail: 'This recording was split into separate sessions. Open those instead.',
    };
  }
  if (status === 'discarded') {
    return {
      error: 'discarded',
      detail: 'This recording was a short clip with no speech in it — there is nothing to attach.',
    };
  }
  return null;
}

const statusEnum = z.enum(['draft', 'in_review', 'approved']);

const patchSchema = z
  .object({
    content_json: z.record(z.string(), z.unknown()).optional(),
    status: statusEnum.optional(),
  })
  .refine((d) => d.content_json !== undefined || d.status !== undefined, {
    message: 'provide content_json and/or status',
  });

const approveSchema = z.object({ approved_by: z.string().optional() });

// Amending an approved note is a deliberate correction, not a save: the reason
// is recorded alongside the superseded version so the change is explicable later.
const amendSchema = z.object({
  content_json: z.record(z.string(), z.unknown()),
  reason: z.string().max(500).optional(),
  amended_by: z.string().optional(),
});

const isUuid = (id: string) => z.uuid().safeParse(id).success;

function fmtDate(v: unknown): string {
  if (!v) return 'n/a';
  const d = new Date(v as string);
  return Number.isNaN(d.getTime()) ? 'n/a' : d.toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------
// GET /review/queue — one row per SESSION awaiting Nicole.
// GET /review/queue?status=approved — sessions already signed off.
//
// A session is one clinical note, not two documents. The sheet and the protocol
// hold identical content and are approved together, so listing them separately
// showed every visit twice and let the two copies drift apart.
// Approved rows are capped: this is a recent-history list, not an archive.
// ---------------------------------------------------------------------------
const APPROVED_LIMIT = 100;

reviewRouter.get('/queue', async (req, res) => {
  const scope = req.query.status === 'approved' ? 'approved' : 'pending';
  // Search is by client name. Capped so a pathological query can't be a DoS.
  const rawQ = typeof req.query.q === 'string' ? req.query.q.slice(0, 120) : undefined;
  try {
    const sessions = await listSessions(scope, APPROVED_LIMIT, rawQ);
    res.json({ sessions });
  } catch (err) {
    logError('review.queue', 'queue query failed', err);
    res.status(500).json({ error: 'internal error' });
  }
});

// ---------------------------------------------------------------------------
// GET /review/unprocessed — matched recordings with no readable note.
//
// The opposite failure to /unmatched: we know whose session this is, the
// transcript is right there, and the extraction still produced nothing. Blank
// notes filed as 'done' had no home in the app at all — they sat in Awaiting
// review looking like a session where nothing clinical was said.
// ---------------------------------------------------------------------------
reviewRouter.get('/unprocessed', async (_req, res) => {
  try {
    const sessions = await listUnprocessed();
    res.json({ sessions });
  } catch (err) {
    logError('review.unprocessed', 'unprocessed query failed', err);
    res.status(500).json({ error: 'internal error' });
  }
});

// ---------------------------------------------------------------------------
// GET /review/conversations/:id — one MATCHED recording, transcript and all.
//
// The other half of the list above. A session with no note is not a session
// with no content: the transcript is sitting in the row, fully readable, and
// until now nothing in the app would show it — the only transcript viewer was
// on /unmatched/:id, which refuses outright once a recording has an appointment
// (409 "already matched"). So the practitioner whose extraction is waiting on
// tomorrow's allowance could see that her session existed and not one word of
// what was said in it, which is the wrong way round: the recording is the
// primary record and the note is derived from it.
//
// Deliberately not folded into /unmatched/:id. That route's refusals are the
// point of it — a matched recording must not be re-assigned through the
// unmatched flow — and loosening them to serve a read would put the assign and
// split actions in reach of a session already filed against a client.
// ---------------------------------------------------------------------------
reviewRouter.get('/conversations/:id', async (req, res) => {
  if (!isUuid(req.params.id)) return res.status(404).json({ error: 'not found' });
  try {
    const r = await pool.query<{
      id: string;
      source_id: string;
      source: string;
      starts_at: string;
      ends_at: string;
      correlation_status: string;
      extraction_status: string;
      extraction_error: string | null;
      appointment_id: string | null;
      appointment_at: string | null;
      client_name: string | null;
      transcript: string | null;
    }>(
      `SELECT c.id, c.source_id, c.source, c.starts_at, c.ends_at,
              c.correlation_status, c.extraction_status, c.extraction_error,
              c.appointment_id,
              a.starts_at AS appointment_at,
              -- Same precedence as listUnprocessed: the appointment names whose
              -- session this is, the recording is the fallback. Never the
              -- sheet's client_id, which can disagree with both.
              cl.name AS client_name,
              c.transcript
         FROM conversations c
    LEFT JOIN appointments a ON a.id = c.appointment_id
    LEFT JOIN clients cl     ON cl.id = COALESCE(a.client_id, c.client_id)
        WHERE c.id = $1`,
      [req.params.id],
    );
    if (r.rowCount === 0) return res.status(404).json({ error: 'not found' });
    const row = r.rows[0];

    // Parsed HERE, through the same pipeline the extractor used — see
    // fetchTranscript. A second parse in the renderer would number the turns
    // differently, and a drifted "#133" points a reader at the wrong sentence
    // while looking perfectly correct.
    let turns: TranscriptTurn[] = [];
    if (row.transcript) {
      try {
        turns = prepareTranscript(row.transcript).turns.map((t) => ({
          index: t.index,
          role: t.role,
          speaker: t.speaker,
          at_seconds: t.startSeconds,
          text: t.text,
        }));
      } catch (err) {
        // The raw text is still worth showing; the pane degrades to plain lines.
        logError('review.conversation.turns', 'turn parsing failed', err, { id: row.id });
      }
    }

    return res.json({ conversation: { ...row, turns } });
  } catch (err) {
    logError('review.conversation.detail', 'conversation detail query failed', err, {
      id: req.params.id,
    });
    return res.status(500).json({ error: 'internal error' });
  }
});

// ---------------------------------------------------------------------------
// GET /review/unmatched — recordings the correlator couldn't tie to an
// appointment (no overlap, or ambiguous). These need Nicole to tag manually;
// we never auto-guess the client. (§8 dashboard, §9 risk 3.)
// ---------------------------------------------------------------------------
reviewRouter.get('/unmatched', async (_req, res) => {
  try {
    const r = await pool.query(
      // correlation_hold_reason is what separates the two things in this queue.
      // Most rows are "we could not tell whose this is" and want Nicole to pick
      // a client. A held row is "this audio may contain more than one client"
      // and wants her to SPLIT it first — tagging it to one person is the exact
      // mistake being prevented, and without the reason on screen the two look
      // identical.
      `SELECT id, source_id, source, starts_at, ends_at, correlation_status,
              correlation_hold_reason,
              left(coalesce(transcript, ''), 240) AS transcript_preview,
              -- The split proposal's state, so a held row can say "2 sessions
              -- detected — review the split" (done) or "working out the split…"
              -- (pending/processing) instead of only the raw hold reason.
              segmentation_status,
              CASE WHEN segmentation_status = 'done'
                THEN jsonb_array_length(coalesce(proposed_segments->'segments', '[]'::jsonb))
                ELSE NULL END AS segment_count
         FROM conversations
        WHERE appointment_id IS NULL
          -- Both are terminal states with no appointment_id, and neither is
          -- waiting on Nicole. A 'split' parent's segments are already filed; a
          -- 'discarded' recording is a short clip with no speech in it. Without
          -- this exclusion each sits here forever, indistinguishable from a
          -- recording that genuinely needs identifying.
          AND correlation_status NOT IN ('split', 'discarded')
     ORDER BY starts_at DESC`,
    );
    res.json({ conversations: r.rows });
  } catch (err) {
    logError('review.unmatched', 'unmatched query failed', err);
    res.status(500).json({ error: 'internal error' });
  }
});

// GET /review/unmatched/:id — one recording in full, for the detail view.
//
// The list only carries a 240-char preview; deciding who a recording belongs to
// usually means reading the whole thing, so this returns the full transcript
// plus the timing the candidate ranking is built on. Still unmatched-only — a
// recording that already has an appointment is read through the session, not here.
reviewRouter.get('/unmatched/:id', async (req, res) => {
  if (!isUuid(req.params.id)) return res.status(404).json({ error: 'not found' });
  try {
    const r = await pool.query<{
      id: string;
      source_id: string;
      source: string;
      starts_at: string;
      ends_at: string;
      correlation_status: string;
      correlation_hold_reason: string | null;
      segmentation_status: string | null;
      extraction_status: string;
      appointment_id: string | null;
      transcript: string | null;
    }>(
      `SELECT id, source_id, source, starts_at, ends_at, correlation_status,
              correlation_hold_reason, segmentation_status, extraction_status,
              appointment_id, transcript
         FROM conversations
        WHERE id = $1`,
      [req.params.id],
    );
    if (r.rowCount === 0) return res.status(404).json({ error: 'not found' });
    if (r.rows[0].appointment_id) {
      // It's been matched (perhaps in another tab) — send her to the session.
      return res.status(409).json({ error: 'already matched', detail: 'This recording is now tied to an appointment.' });
    }
    if (r.rows[0].correlation_status === 'split') {
      return res.status(409).json({
        error: 'already split',
        detail: 'This recording was split into separate sessions. Open those instead.',
      });
    }
    if (r.rows[0].correlation_status === 'discarded') {
      return res.status(409).json({
        error: 'discarded',
        detail:
          r.rows[0].correlation_hold_reason ??
          'This recording was a short clip with no speech in it, so there is nothing to identify.',
      });
    }
    const { appointment_id: _drop, ...conv } = r.rows[0];
    return res.json({ conversation: conv });
  } catch (err) {
    logError('review.unmatched.detail', 'detail query failed', err, { id: req.params.id });
    return res.status(500).json({ error: 'internal error' });
  }
});

// GET /review/unmatched/:id/candidates — appointments to offer for manual
// tagging.
//
// Ordered by EVIDENCE, not just clock distance. When appointments run back to
// back, a recording that starts late or runs long overlaps two of them and
// correlation rightly refuses to guess — but then offering Nicole two adjacent
// slots sorted by time tells her nothing. The transcript almost always says the
// client's name, so that becomes the primary signal, with overlap and then time
// distance breaking ties.
//
// Still never auto-assigns: a name in a transcript is evidence, not proof (a
// client can be discussed in someone else's session). The signals are returned
// so the UI can show WHY a candidate is ranked where it is.
reviewRouter.get('/unmatched/:id/candidates', async (req, res) => {
  if (!isUuid(req.params.id)) return res.status(404).json({ error: 'not found' });
  try {
    const conv = await pool.query<{ starts_at: string; ends_at: string; transcript: string | null }>(
      `SELECT starts_at, ends_at, transcript FROM conversations WHERE id = $1`,
      [req.params.id],
    );
    if (conv.rowCount === 0) return res.status(404).json({ error: 'not found' });
    const { starts_at: cs, ends_at: ce, transcript } = conv.rows[0];

    // Offer only appointments a match could actually land on: not cancelled
    // (the slot's client may never have shown up — matching their chart is the
    // wrong-person error), and not already carrying a recording (one
    // conversation per appointment is a schema invariant; offering a taken one
    // just walks Nicole into a refusal).
    const r = await pool.query<{
      id: string;
      starts_at: string;
      ends_at: string;
      client_id: string | null;
      client_name: string | null;
    }>(
      `SELECT a.id, a.starts_at, a.ends_at, a.client_id, c.name AS client_name
         FROM appointments a
    LEFT JOIN clients c ON c.id = a.client_id
        WHERE a.status <> 'cancelled'
          AND NOT EXISTS (SELECT 1 FROM conversations cv WHERE cv.appointment_id = a.id)
     ORDER BY abs(extract(epoch FROM (a.starts_at - $1::timestamptz)))
        LIMIT 12`,
      [cs],
    );

    const scored = r.rows.map((a) => {
      const name = scoreNameMatch(transcript, a.client_name);
      return {
        ...a,
        name_mentions: name.mentions,
        name_matched_on: name.matchedOn,
        overlap_seconds: overlapSeconds(cs, ce, a.starts_at, a.ends_at),
        _rank: nameSignalRank(name),
      };
    });

    scored.sort(
      (x, y) =>
        y._rank - x._rank ||
        y.overlap_seconds - x.overlap_seconds ||
        Math.abs(new Date(x.starts_at).getTime() - new Date(cs).getTime()) -
          Math.abs(new Date(y.starts_at).getTime() - new Date(cs).getTime()),
    );

    return res.json({
      appointments: scored.slice(0, 8).map(({ _rank, ...a }) => a),
    });
  } catch (err) {
    logError('review.candidates', 'candidate query failed', err, { id: req.params.id });
    return res.status(500).json({ error: 'internal error' });
  }
});

// POST /review/import — hand a transcript in directly, without a recorder.
//
// A session captured elsewhere (an Otter.ai export, a recording Pocket missed)
// has no automated way into the pipeline. This lands it as an ordinary
// conversation from source 'manual', deduplicated by a content hash so pasting
// the same text twice is a no-op. It reuses the one ingest code path, so it
// correlates by time exactly like a Pocket recording: if `occurred_at` lands on
// a booked appointment it auto-matches (and extraction fires); otherwise it sits
// in the unmatched queue for Nicole to attach via /match or /assign-client — the
// same follow-through as any recording the correlator couldn't place.
// Upper bound on a hand-imported transcript. Generous — a multi-hour session is
// well under this — but bounded so a pathological paste can't be a memory/cost
// DoS. Must stay below the express.json body limit in app.ts (see the note
// there); the desktop ImportView mirrors this number to warn before upload.
export const MAX_TRANSCRIPT_CHARS = 200_000;

const importSchema = z.object({
  transcript: z.string().trim().min(1).max(MAX_TRANSCRIPT_CHARS),
  // When the session actually happened. Drives correlation, and — since a
  // walk-in assignment builds the appointment from this window — becomes the
  // clinical session date. Defaults to now for a "just happened" paste.
  occurred_at: z.string().datetime().optional(),
});
reviewRouter.post('/import', async (req, res) => {
  const parsed = importSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'invalid payload', details: parsed.error.flatten() });
  }
  try {
    const transcript = normalizeManualTranscript(parsed.data.transcript);
    const startsAt = parsed.data.occurred_at ? new Date(parsed.data.occurred_at) : new Date();
    const endsAt = new Date(startsAt.getTime() + 60 * 60 * 1000); // synthetic 1h window

    const { conversationId, correlation } = await ingestConversation({
      source: 'manual',
      source_id: manualSourceId(transcript),
      starts_at: startsAt.toISOString(),
      ends_at: endsAt.toISOString(),
      transcript,
    });

    // Same off-request-path extraction as the webhook/match paths: only when the
    // synthetic window happened to correlate to a real appointment.
    if (correlation.status === 'matched') {
      enqueueExtraction(conversationId);
    }
    logEvent('info', 'review.import', 'imported a transcript by hand', {
      conversation_id: conversationId,
      correlation: correlation.status,
    });
    await recordAudit({
      entityType: 'conversation',
      entityId: conversationId,
      action: 'conversation.imported',
      actor: 'nicole',
      summary: 'Transcript imported by hand',
      metadata: { correlation: correlation.status },
    });
    return res.status(201).json({ conversation_id: conversationId, correlation });
  } catch (err) {
    logError('review.import', 'manual import failed', err);
    return res.status(500).json({ error: 'internal error' });
  }
});

// POST /review/unmatched/:id/match — manually tie a conversation to an
// appointment. Sets the correlation and, if there's a transcript, kicks off
// extraction off the request path (same as the automatic matched path).
const matchSchema = z.object({ appointment_id: z.string() });
reviewRouter.post('/unmatched/:id/match', async (req, res) => {
  if (!isUuid(req.params.id)) return res.status(404).json({ error: 'not found' });
  const parsed = matchSchema.safeParse(req.body);
  if (!parsed.success || !isUuid(parsed.data.appointment_id)) {
    return res.status(400).json({ error: 'invalid payload' });
  }
  try {
    const conv = await pool.query<{ correlation_status: string }>(
      `SELECT correlation_status FROM conversations WHERE id = $1`,
      [req.params.id],
    );
    if (conv.rowCount === 0) return res.status(404).json({ error: 'not found' });
    const terminal = terminalCorrelationConflict(conv.rows[0].correlation_status);
    if (terminal) return res.status(409).json(terminal);

    const appt = await pool.query<{ client_id: string | null; status: string }>(
      `SELECT client_id, status FROM appointments WHERE id = $1`,
      [parsed.data.appointment_id],
    );
    if (appt.rowCount === 0) return res.status(404).json({ error: 'appointment not found' });
    if (appt.rows[0].status === 'cancelled') {
      return res.status(409).json({
        error: 'appointment cancelled',
        detail: 'This booking was cancelled — its client may never have been in the room. Assign the recording to the right client instead.',
      });
    }

    // One recording per appointment (schema-enforced), and never onto a session
    // that's already signed off: extraction would overwrite the approved note
    // and demote it to draft with no revision trail. An approved session is
    // corrected through Amend, not by re-matching a recording onto it.
    const taken = await pool.query(
      `SELECT 1 FROM conversations WHERE appointment_id = $1 LIMIT 1`,
      [parsed.data.appointment_id],
    );
    if (taken.rowCount) {
      return res.status(409).json({
        error: 'appointment has a recording',
        detail: 'This appointment already has a recording attached. Detach that one first if it is wrong.',
      });
    }
    const approvedNote = await pool.query(
      `SELECT 1 FROM appointment_sheets WHERE appointment_id = $1 AND status = 'approved'
        UNION ALL
       SELECT 1 FROM protocols WHERE appointment_id = $1 AND status = 'approved'
        LIMIT 1`,
      [parsed.data.appointment_id],
    );
    if (approvedNote.rowCount) {
      return res.status(409).json({
        error: 'session already approved',
        detail: 'This appointment already has an approved session note. Amend that note instead of attaching a new recording.',
      });
    }

    const r = await pool.query<{ id: string; transcript: string | null }>(
      `UPDATE conversations
          SET appointment_id = $2, client_id = $3, correlation_status = 'matched'
        WHERE id = $1 AND appointment_id IS NULL
          -- Races the pre-check above: a concurrent split could land between the
          -- two, and a split parent has appointment_id NULL so the line above
          -- would not stop it.
          AND correlation_status NOT IN ('split', 'discarded')
    RETURNING id, transcript`,
      [req.params.id, parsed.data.appointment_id, appt.rows[0].client_id],
    );
    if (r.rowCount === 0) return res.status(409).json({ error: 'already matched or not found' });

    if (r.rows[0].transcript) {
      enqueueExtraction(r.rows[0].id);
    }
    await recordAudit({
      entityType: 'session',
      entityId: parsed.data.appointment_id,
      action: 'session.matched',
      actor: 'nicole',
      summary: 'Recording manually matched to this appointment',
      metadata: { conversation_id: r.rows[0].id },
    });
    return res.json({ conversation_id: r.rows[0].id, status: 'matched' });
  } catch (err) {
    // The pre-checks race a concurrent match; the unique index is the real
    // enforcement, so translate its rejection into the same friendly refusal.
    if ((err as { code?: string }).code === '23505') {
      return res.status(409).json({
        error: 'appointment has a recording',
        detail: 'This appointment already has a recording attached. Detach that one first if it is wrong.',
      });
    }
    logError('review.match', 'manual match failed', err, { id: req.params.id });
    return res.status(500).json({ error: 'internal error' });
  }
});

// POST /review/unmatched/:id/assign-client — a walk-in.
//
// Some sessions never existed in Practice Better: a walk-in, a phone follow-up,
// a booking made under the wrong name. Correlation has nothing to match against
// and the recording sits unmatched forever, because until now the only way to
// assign one was to pick an EXISTING appointment.
//
// So create the appointment from the recording itself. Its time window is the
// recording's, which is the truth of when the session happened, and it's marked
// `walk-in` so it's distinguishable from anything PB booked.
const assignClientSchema = z.object({ client_id: z.string() });

reviewRouter.post('/unmatched/:id/assign-client', async (req, res) => {
  if (!isUuid(req.params.id)) return res.status(404).json({ error: 'not found' });
  const parsed = assignClientSchema.safeParse(req.body);
  if (!parsed.success || !isUuid(parsed.data.client_id)) {
    return res.status(400).json({ error: 'invalid payload' });
  }

  const db = await pool.connect();
  try {
    await db.query('BEGIN');
    const conv = await db.query<{
      starts_at: string;
      ends_at: string;
      transcript: string | null;
      correlation_status: string;
    }>(
      `SELECT starts_at, ends_at, transcript, correlation_status FROM conversations
        WHERE id = $1 AND appointment_id IS NULL FOR UPDATE`,
      [req.params.id],
    );
    if (conv.rowCount === 0) {
      await db.query('ROLLBACK');
      return res.status(409).json({ error: 'already matched or not found' });
    }
    // A split parent or a discarded noise clip also has appointment_id NULL, so
    // the guard above lets it through. The row is locked FOR UPDATE, so this
    // check is race-safe for the rest of the transaction.
    const terminal = terminalCorrelationConflict(conv.rows[0].correlation_status);
    if (terminal) {
      await db.query('ROLLBACK');
      return res.status(409).json(terminal);
    }
    const client = await db.query(`SELECT 1 FROM clients WHERE id = $1`, [parsed.data.client_id]);
    if (client.rowCount === 0) {
      await db.query('ROLLBACK');
      return res.status(404).json({ error: 'client not found' });
    }

    const appt = await db.query<{ id: string }>(
      `INSERT INTO appointments (client_id, pb_id, starts_at, ends_at, status)
            VALUES ($1, $2, $3, $4, 'completed') RETURNING id`,
      [
        parsed.data.client_id,
        // No PB booking exists, so the id is derived from the recording — stable,
        // and obviously not a Practice Better id to anyone reading the table.
        `walkin-${req.params.id}`,
        conv.rows[0].starts_at,
        conv.rows[0].ends_at,
      ],
    );

    await db.query(
      `UPDATE conversations
          SET appointment_id = $2, client_id = $3, correlation_status = 'walk_in'
        WHERE id = $1`,
      [req.params.id, appt.rows[0].id, parsed.data.client_id],
    );
    await db.query('COMMIT');

    logEvent('info', 'review.assign_client', 'assigned a walk-in recording to a client', {
      conversation_id: req.params.id,
      client_id: parsed.data.client_id,
      appointment_id: appt.rows[0].id,
    });
    await recordAudit({
      entityType: 'session',
      entityId: appt.rows[0].id,
      action: 'session.assigned_walkin',
      actor: 'nicole',
      summary: 'Walk-in recording assigned to a client (appointment created from the recording)',
      metadata: { conversation_id: req.params.id, client_id: parsed.data.client_id },
    });

    if (conv.rows[0].transcript) {
      enqueueExtraction(req.params.id);
    }
    return res.json({ appointment_id: appt.rows[0].id, client_id: parsed.data.client_id, status: 'walk_in' });
  } catch (err) {
    await db.query('ROLLBACK').catch(() => {});
    logError('review.assign_client', 'walk-in assignment failed', err, { id: req.params.id });
    return res.status(500).json({ error: 'internal error' });
  } finally {
    db.release();
  }
});

// GET /review/unmatched/:id/segments — the proposed split for a recording.
//
// Served from `proposed_segments` when the background drain has already computed
// it (the common case for a held recording — instant, no model call). Falls back
// to computing live when the proposal is still in flight, failed, or `?refresh=1`
// asks for a fresh pass; a live result is written back so the next open is fast.
reviewRouter.get('/unmatched/:id/segments', async (req, res) => {
  if (!isUuid(req.params.id)) return res.status(404).json({ error: 'not found' });
  const refresh = req.query.refresh === '1' || req.query.refresh === 'true';
  try {
    const conv = await pool.query<{
      starts_at: string;
      ends_at: string;
      transcript: string | null;
      correlation_status: string;
      segmentation_status: string | null;
      proposed_segments: SegmentationResult | null;
    }>(
      `SELECT starts_at, ends_at, transcript, correlation_status,
              segmentation_status, proposed_segments
         FROM conversations WHERE id = $1`,
      [req.params.id],
    );
    if (conv.rowCount === 0) return res.status(404).json({ error: 'not found' });
    const row = conv.rows[0];

    if (!refresh && row.segmentation_status === 'done' && row.proposed_segments) {
      const p = row.proposed_segments;
      return res.json({
        conversation_id: req.params.id,
        segments: p.segments,
        candidates: p.candidates,
        turns: p.turns,
        computed_at: p.computed_at,
        source: 'cached',
      });
    }

    const result = await computeSegmentation({
      id: req.params.id,
      starts_at: row.starts_at,
      ends_at: row.ends_at,
      transcript: row.transcript,
    });
    // Cache the fresh result on a held recording so a reopen is instant. Scoped
    // to 'needs_review': a matched or manually-assigned conversation has no
    // splitter to feed, and a GET should not be leaving `proposed_segments`
    // behind on rows nothing reads it from.
    await pool
      .query(
        `UPDATE conversations
            SET proposed_segments = $2::jsonb,
                segmentation_status = 'done',
                segmentation_error = NULL,
                updated_at = now()
          WHERE id = $1 AND correlation_status = 'needs_review'`,
        [req.params.id, JSON.stringify(result)],
      )
      .catch(() => {});

    return res.json({
      conversation_id: req.params.id,
      segments: result.segments,
      candidates: result.candidates,
      turns: result.turns,
      computed_at: result.computed_at,
      source: refresh ? 'refreshed' : 'live',
    });
  } catch (err) {
    logError('review.segments', 'failed to detect session segments', err, { id: req.params.id });
    return res.status(500).json({ error: 'internal error' });
  }
});

const splitSegmentSchema = z.object({
  from_turn: z.number().int().positive(),
  to_turn: z.number().int().positive(),
  appointment_id: z.string().optional(),
  client_id: z.string().optional(),
});
const splitSchema = z.object({
  segments: z.array(splitSegmentSchema).min(1),
});

// POST /review/unmatched/:id/split & POST /review/conversations/:id/split
// Split a multi-session recording into separate child session conversations.
async function handleSplitConversation(req: any, res: any) {
  if (!isUuid(req.params.id)) return res.status(404).json({ error: 'not found' });
  const parsed = splitSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'invalid payload', details: parsed.error.flatten() });

  try {
    const parent = await pool.query<{
      source_id: string;
      starts_at: string;
      ends_at: string;
      transcript: string | null;
      source: string;
      appointment_id: string | null;
      correlation_status: string;
    }>(
      `SELECT source_id, starts_at, ends_at, transcript, source, appointment_id, correlation_status
         FROM conversations WHERE id = $1`,
      [req.params.id],
    );
    if (parent.rowCount === 0) return res.status(404).json({ error: 'parent conversation not found' });
    const orig = parent.rows[0];
    if (!orig.transcript) return res.status(400).json({ error: 'conversation has no transcript' });
    // 'split' here would re-split a parent whose children already exist;
    // 'discarded' would carve segments out of a clip with no speech in it.
    const terminal = terminalCorrelationConflict(orig.correlation_status);
    if (terminal) return res.status(409).json(terminal);

    // If parent was matched, unmatch it first and clear any unapproved draft notes for that appointment
    if (orig.appointment_id) {
      await pool.query(
        `UPDATE conversations SET appointment_id = NULL, client_id = NULL, correlation_status = 'unmatched' WHERE id = $1`,
        [req.params.id],
      );
      await pool.query(
        `DELETE FROM appointment_sheets WHERE appointment_id = $1 AND status <> 'approved'`,
        [orig.appointment_id],
      );
      await pool.query(
        `DELETE FROM protocols WHERE appointment_id = $1 AND status <> 'approved'`,
        [orig.appointment_id],
      );
    }

    const createdIds: string[] = [];
    const totalTurns = parseTurns(orig.transcript).length || 1;
    const pStartMs = new Date(orig.starts_at).getTime();
    const pEndMs = new Date(orig.ends_at).getTime();
    const totalDurMs = Math.max(0, pEndMs - pStartMs);

    for (let i = 0; i < parsed.data.segments.length; i++) {
      const seg = parsed.data.segments[i];
      const slicedText = sliceTranscriptByTurnRange(orig.transcript, seg.from_turn, seg.to_turn);
      // Derived from the PARENT's source_id so a re-poll of the same recording
      // collides with the child on (source, source_id) instead of silently
      // re-ingesting the unsplit original alongside its own segments.
      const childSourceId = `${orig.source_id}_slice_${i + 1}_${Date.now().toString(36)}`;

      const childStartMs = pStartMs + Math.round(((seg.from_turn - 1) / totalTurns) * totalDurMs);
      const childEndMs = pStartMs + Math.round((seg.to_turn / totalTurns) * totalDurMs);
      const childStartsAt = new Date(childStartMs).toISOString();
      const childEndsAt = new Date(childEndMs).toISOString();

      const child = await pool.query<{ id: string }>(
        `INSERT INTO conversations (source_id, starts_at, ends_at, transcript, source, parent_conversation_id, turn_range, correlation_status, appointment_id, client_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id`,
        [
          childSourceId,
          childStartsAt,
          childEndsAt,
          slicedText,
          orig.source,
          req.params.id,
          JSON.stringify({ from_turn: seg.from_turn, to_turn: seg.to_turn }),
          seg.appointment_id ? 'matched' : seg.client_id ? 'walk_in' : 'unmatched',
          seg.appointment_id ?? null,
          seg.client_id ?? null,
        ],
      );
      const childId = child.rows[0].id;
      createdIds.push(childId);

      if (seg.appointment_id || seg.client_id) {
        enqueueExtraction(childId);
      }
    }

    // The parent is superseded now: its content lives in the children, each with
    // a client a human picked. Marking it terminal is what keeps it out of the
    // review queue and out of correlation — see migration 0038.
    //
    // Deliberately after the loop. A failure part-way through leaves the parent
    // 'unmatched' and recoverable, rather than terminal with only half of its
    // segments written; the NOT EXISTS guards in correlate/sweep cover that
    // window so a half-split parent still cannot be matched to anyone.
    await pool.query(
      `UPDATE conversations
          SET correlation_status = 'split',
              appointment_id = NULL,
              client_id = NULL,
              updated_at = now()
        WHERE id = $1`,
      [req.params.id],
    );

    logEvent('info', 'review.split', 'split conversation into multi-session segments', {
      parent_id: req.params.id,
      child_ids: createdIds,
    });

    return res.status(201).json({ parent_id: req.params.id, split_conversations: createdIds });
  } catch (err) {
    logError('review.split', 'conversation split failed', err, { id: req.params.id });
    return res.status(500).json({ error: 'internal error' });
  }
}

reviewRouter.post('/unmatched/:id/split', handleSplitConversation);
reviewRouter.post('/conversations/:id/split', handleSplitConversation);

// POST /review/conversations/:id/unmatch — detach a recording from the wrong client.
//
// Correlation can be confidently wrong: two clients booked back to back, one
// runs over, and the single overlapping appointment is the wrong one. Until now
// there was no way back — /match only accepts a conversation with no appointment.
//
// Refuses once the note has been APPROVED. At that point documents are in the
// client's Drive folder and possibly with the client; silently detaching would
// leave those files orphaned under a client the app no longer links to the
// session. That needs a deliberate amendment, not a re-assignment.
type UnmatchOutcome = { code: number; body: Record<string, unknown> };

// Exported so operational scripts detach a recording through the SAME path the
// UI does — the approved-note refusal, the draft cleanup, the audit entry. A
// one-off script that reproduces this in hand-written SQL is a second
// implementation of a destructive operation, and the copy is the one that
// forgets the guard.
export async function unmatchByConversation(conversationId: string): Promise<UnmatchOutcome> {
  const db = await pool.connect();
  try {
    await db.query('BEGIN');
    const conv = await db.query<{ appointment_id: string | null }>(
      `SELECT appointment_id FROM conversations WHERE id = $1 FOR UPDATE`,
      [conversationId],
    );
    if (conv.rowCount === 0) {
      await db.query('ROLLBACK');
      return { code: 404, body: { error: 'not found' } };
    }
    const apptId = conv.rows[0].appointment_id;
    if (!apptId) {
      await db.query('ROLLBACK');
      return { code: 409, body: { error: 'not matched', detail: 'This recording is already unassigned.' } };
    }

    const approved = await db.query(
      `SELECT 1 FROM appointment_sheets WHERE appointment_id = $1 AND status = 'approved'
        UNION ALL
       SELECT 1 FROM protocols WHERE appointment_id = $1 AND status = 'approved'
        LIMIT 1`,
      [apptId],
    );
    if (approved.rowCount) {
      await db.query('ROLLBACK');
      return {
        code: 409,
        body: {
          error: 'already approved',
          detail:
            'This session has been approved and its documents published. Amend the note instead of reassigning it.',
        },
      };
    }

    // The draft note belongs to the wrong client — remove it rather than leaving
    // it in her queue attributed to someone who was never in the room.
    await db.query(`DELETE FROM appointment_sheets WHERE appointment_id = $1`, [apptId]);
    await db.query(`DELETE FROM protocols WHERE appointment_id = $1`, [apptId]);

    // A walk-in appointment exists only to carry this recording, so it goes too.
    await db.query(
      `DELETE FROM appointments WHERE id = $1 AND pb_id = $2`,
      [apptId, `walkin-${conversationId}`],
    );

    await db.query(
      `UPDATE conversations
          SET appointment_id = NULL, client_id = NULL,
              correlation_status = 'unmatched', extraction_status = 'pending'
        WHERE id = $1`,
      [conversationId],
    );
    await db.query('COMMIT');

    logEvent('info', 'review.unmatch', 'detached a recording from its appointment', {
      conversation_id: conversationId,
      appointment_id: apptId,
    });
    await recordAudit({
      entityType: 'session',
      entityId: apptId,
      action: 'session.unmatched',
      actor: 'nicole',
      summary: 'Recording detached from this appointment (draft note discarded)',
      metadata: { conversation_id: conversationId },
    });
    return { code: 200, body: { status: 'unmatched' } };
  } catch (err) {
    await db.query('ROLLBACK').catch(() => {});
    logError('review.unmatch', 'unmatch failed', err, { id: conversationId });
    return { code: 500, body: { error: 'internal error' } };
  } finally {
    db.release();
  }
}

reviewRouter.post('/conversations/:id/unmatch', async (req, res) => {
  if (!isUuid(req.params.id)) return res.status(404).json({ error: 'not found' });
  const out = await unmatchByConversation(req.params.id);
  return res.status(out.code).json(out.body);
});

/**
 * POST /review/:kind/:id/unmatch — same thing, reached from the session itself.
 *
 * Nicole discovers a wrong match while reading the note, not while looking at a
 * list of recordings, so the action has to exist where the mistake becomes
 * visible. Resolves the recording behind this session and detaches that.
 */
function unmatchOne(table: Table) {
  return async (req: import('express').Request, res: import('express').Response) => {
    if (!isUuid(req.params.id)) return res.status(404).json({ error: 'not found' });
    try {
      const conv = await pool.query<{ id: string }>(
        `SELECT c.id
           FROM conversations c
           JOIN ${table} t ON t.appointment_id = c.appointment_id
          WHERE t.id = $1
          LIMIT 1`,
        [req.params.id],
      );
      if (conv.rowCount === 0) {
        return res.status(404).json({
          error: 'no recording',
          detail: 'This session has no recording attached, so there is nothing to reassign.',
        });
      }
      const out = await unmatchByConversation(conv.rows[0].id);
      return res.status(out.code).json(out.body);
    } catch (err) {
      logError(`review.${table}_unmatch`, 'unmatch lookup failed', err, { id: req.params.id });
      return res.status(500).json({ error: 'internal error' });
    }
  };
}

// ---------------------------------------------------------------------------
// Generic handlers, reused for both 'appointment_sheets' and 'protocols'.
// ---------------------------------------------------------------------------
type Table = 'appointment_sheets' | 'protocols';

function getOne(table: Table) {
  return async (req: import('express').Request, res: import('express').Response) => {
    if (!isUuid(req.params.id)) return res.status(404).json({ error: 'not found' });
    try {
      const r = await pool.query(`SELECT * FROM ${table} WHERE id = $1`, [req.params.id]);
      if (r.rowCount === 0) return res.status(404).json({ error: 'not found' });

      // Whether this session can still be detached from its client, so the UI can
      // avoid offering an action that would only fail. A sheet and a protocol
      // share an appointment: approving EITHER publishes documents, which pins
      // the pairing even while the other is still a draft.
      const apptId = r.rows[0].appointment_id;
      let canUnmatch = false;
      let blocked: string | null = 'This session has no recording attached.';
      if (apptId) {
        const [conv, approved] = await Promise.all([
          pool.query(`SELECT 1 FROM conversations WHERE appointment_id = $1 LIMIT 1`, [apptId]),
          pool.query(
            `SELECT 1 FROM appointment_sheets WHERE appointment_id = $1 AND status = 'approved'
              UNION ALL
             SELECT 1 FROM protocols WHERE appointment_id = $1 AND status = 'approved'
              LIMIT 1`,
            [apptId],
          ),
        ]);
        if (approved.rowCount) {
          blocked = 'This session has been approved and its documents published. Amend it instead.';
        } else if (conv.rowCount === 0) {
          blocked = 'This session has no recording attached.';
        } else {
          canUnmatch = true;
          blocked = null;
        }
      }

      return res.json({ ...r.rows[0], can_unmatch: canUnmatch, unmatch_blocked_reason: blocked });
    } catch (err) {
      logError(`review.${table}_get`, 'fetch failed', err, { id: req.params.id });
      return res.status(500).json({ error: 'internal error' });
    }
  };
}

function patchOne(table: Table) {
  return async (req: import('express').Request, res: import('express').Response) => {
    if (!isUuid(req.params.id)) return res.status(404).json({ error: 'not found' });
    const parsed = patchSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'invalid payload', details: parsed.error.issues });
    }
    const { content_json, status } = parsed.data;
    try {
      // Content edits go through the session so both documents move together —
      // they hold the same note, and letting one change alone is what allowed a
      // correction to reach the brief but never the client's documents.
      if (content_json) {
        const apptId = await appointmentForItem(table, req.params.id);
        if (!apptId) return res.status(404).json({ error: 'not found' });
        const out = await patchSession(apptId, content_json);
        if (!out.ok) return res.status(out.code).json({ error: out.error, detail: out.detail });
      }

      // A bare status change (draft → in_review) is per-document bookkeeping and
      // carries no clinical content, so it stays where it is.
      if (status) {
        await pool.query(`UPDATE ${table} SET status = $2 WHERE id = $1`, [req.params.id, status]);
      }

      const r = await pool.query(`SELECT * FROM ${table} WHERE id = $1`, [req.params.id]);
      if (r.rowCount === 0) return res.status(404).json({ error: 'not found' });
      return res.json(r.rows[0]);
    } catch (err) {
      logError(`review.${table}_patch`, 'update failed', err, { id: req.params.id });
      return res.status(500).json({ error: 'internal error' });
    }
  };
}

/**
 * POST /review/:kind/:id/amend — correct a note that has already been approved.
 *
 * Not an edit: the superseded content is filed in `note_revisions` first, so
 * what Nicole originally signed off on stays recoverable and the change is
 * attributable. Then the documents are brought back into line, which is the
 * whole reason plain PATCH is refused on approved rows — republishing has to be
 * done deliberately and selectively, because the three templates behave
 * differently (see republishAmended).
 */
function amendOne(table: Table) {
  return async (req: import('express').Request, res: import('express').Response) => {
    if (!isUuid(req.params.id)) return res.status(404).json({ error: 'not found' });
    const parsed = amendSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return res.status(400).json({ error: 'invalid payload', details: parsed.error.issues });
    }
    try {
      const apptId = await appointmentForItem(table, req.params.id);
      if (!apptId) return res.status(404).json({ error: 'not found' });
      const out = await amendSession(
        apptId,
        parsed.data.content_json,
        parsed.data.reason ?? null,
        parsed.data.amended_by || 'nicole',
      );
      if (!out.ok) return res.status(out.code).json({ error: out.error, detail: out.detail });

      void publishApproved(table, req.params.id).catch((err) =>
        logError(`review.${table}_amend_publish`, 'Drive publish failed', err, { id: req.params.id }),
      );
      if (out.session.protocol_id) {
        void republishAmended(out.session.protocol_id).catch((err) =>
          logError('review.protocol_amend_republish', 'republish failed', err, { id: req.params.id }),
        );
      }

      const row = await pool.query(`SELECT * FROM ${table} WHERE id = $1`, [req.params.id]);
      return res.json({ ...row.rows[0], revision: out.revision });
    } catch (err) {
      logError(`review.${table}_amend`, 'amend failed', err, { id: req.params.id });
      return res.status(500).json({ error: 'internal error' });
    }
  };
}

/** GET /review/:kind/:id/revisions — the superseded versions, newest first. */
/**
 * GET /review/:kind/:id/history — the client's previous sessions, newest first.
 *
 * `context` returns only the single most recent session, which answers "what
 * changed since last time" but not "is this getting better", and the latter is
 * the question a running flow sheet exists to answer. Her paper sheet stacks
 * every visit in one place; this is the data behind doing the same on screen.
 *
 * One entry per APPOINTMENT, preferring the appointment sheet and falling back
 * to the protocol — the two carry the same clinical fields and either may be the
 * one she approved, so keying on the appointment avoids listing a visit twice.
 */
const HISTORY_LIMIT = 8;

function historyOne(table: Table) {
  return async (req: import('express').Request, res: import('express').Response) => {
    if (!isUuid(req.params.id)) return res.status(404).json({ error: 'not found' });
    try {
      const item = await pool.query<{
        client_id: string | null;
        appointment_id: string | null;
        starts_at: string | null;
      }>(
        `SELECT t.client_id, t.appointment_id, a.starts_at
           FROM ${table} t
      LEFT JOIN appointments a ON a.id = t.appointment_id
          WHERE t.id = $1`,
        [req.params.id],
      );
      if (item.rowCount === 0) return res.status(404).json({ error: 'not found' });
      const { client_id: clientId, appointment_id: apptId, starts_at: startsAt } = item.rows[0];
      if (!clientId) return res.json({ total: 0, sessions: [] });

      // Count first: the list is capped, and silently dropping older visits
      // would misrepresent the client's history as shorter than it is.
      const totalRow = await pool.query<{ n: string }>(
        `SELECT count(*) AS n
           FROM appointments a
      LEFT JOIN appointment_sheets s ON s.appointment_id = a.id AND s.status = 'approved'
      LEFT JOIN protocols p ON p.appointment_id = a.id AND p.status = 'approved'
          WHERE a.client_id = $1
            AND ($2::uuid IS NULL OR a.id IS DISTINCT FROM $2::uuid)
            AND ($3::timestamptz IS NULL OR a.starts_at < $3::timestamptz)
            AND (s.id IS NOT NULL OR p.id IS NOT NULL)`,
        [clientId, apptId, startsAt],
      );

      const r = await pool.query<{ starts_at: string; content_json: unknown }>(
        `SELECT a.starts_at, COALESCE(s.content_json, p.content_json) AS content_json
           FROM appointments a
      LEFT JOIN appointment_sheets s ON s.appointment_id = a.id AND s.status = 'approved'
      LEFT JOIN protocols p ON p.appointment_id = a.id AND p.status = 'approved'
          WHERE a.client_id = $1
            AND ($2::uuid IS NULL OR a.id IS DISTINCT FROM $2::uuid)
            AND ($3::timestamptz IS NULL OR a.starts_at < $3::timestamptz)
            AND (s.id IS NOT NULL OR p.id IS NOT NULL)
       ORDER BY a.starts_at DESC
          LIMIT $4`,
        [clientId, apptId, startsAt, HISTORY_LIMIT],
      );

      return res.json({
        total: Number(totalRow.rows[0]?.n ?? 0),
        sessions: r.rows.map((x) => ({
          date: x.starts_at,
          note: coerceSessionNote(x.content_json),
        })),
      });
    } catch (err) {
      logError(`review.${table}_history`, 'history query failed', err, { id: req.params.id });
      return res.status(500).json({ error: 'internal error' });
    }
  };
}

function revisionsOne(table: Table) {
  return async (req: import('express').Request, res: import('express').Response) => {
    if (!isUuid(req.params.id)) return res.status(404).json({ error: 'not found' });
    try {
      return res.json({ revisions: await fetchRevisions(table, req.params.id) });
    } catch (err) {
      logError(`review.${table}_revisions`, 'fetch failed', err, { id: req.params.id });
      return res.status(500).json({ error: 'internal error' });
    }
  };
}

function approveOne(table: Table) {
  return async (req: import('express').Request, res: import('express').Response) => {
    if (!isUuid(req.params.id)) return res.status(404).json({ error: 'not found' });
    const parsedBody = approveSchema.safeParse(req.body ?? {});
    const approvedBy = (parsedBody.success && parsedBody.data.approved_by) || 'nicole';
    try {
      const apptId = await appointmentForItem(table, req.params.id);
      if (!apptId) return res.status(404).json({ error: 'not found' });
      const out = await approveSession(apptId, approvedBy);
      if (!out.ok) return res.status(out.code).json({ error: out.error, detail: out.detail });

      // Off the request path. Both documents are written to Drive; the client
      // templates fire once, and only on the transition — the Flow Sheet append
      // and the dated Supplement are not idempotent.
      void publishApproved('appointment_sheets', out.session.sheet_id ?? '').catch(() => {});
      if (out.session.protocol_id) {
        void publishApproved('protocols', out.session.protocol_id).catch((err) =>
          logError('review.protocol_publish', 'Drive publish failed', err, { id: req.params.id }),
        );
        if (out.firstApproval) {
          void publishClientTemplates(out.session.protocol_id)
            .then((r) => {
              // The publish resolves even when the Flow Sheet append fails (the
              // ROF + Supplement already landed). That failure used to die on
              // the discarded promise — the exact way the Flow Sheet went months
              // unwritten while the publish "succeeded". Raise it explicitly so
              // it's greppable and, later, dashboard-surfaceable.
              if (r.flowSheetError) {
                logError('session.flowsheet_missing', 'session approved but Flow Sheet block not written', r.flowSheetError, {
                  id: req.params.id,
                  protocol_id: out.session.protocol_id,
                });
              }
            })
            .catch((err) =>
              logError('review.templates_publish', 'template publish failed', err, { id: req.params.id }),
            );
        }
      }

      const row = await pool.query(`SELECT * FROM ${table} WHERE id = $1`, [req.params.id]);
      return res.json(row.rows[0]);
    } catch (err) {
      logError(`review.${table}_approve`, 'approve failed', err, { id: req.params.id });
      return res.status(500).json({ error: 'internal error' });
    }
  };
}

/** One turn as the review pane reads it. `index` is the same number the model
 *  cited and verifyEvidence resolved, which is what makes a citation something
 *  the eye can check rather than something the UI has to search for. */
export interface TranscriptTurn {
  index: number;
  role: 'PRACTITIONER' | 'CLIENT' | 'UNKNOWN';
  speaker: string;
  at_seconds: number | null;
  text: string;
}

/** The recording behind an appointment, for the review pane's source panel. */
async function fetchTranscript(
  appointmentId: string | null,
): Promise<{ text: string; recorded_at: string | null; turns: TranscriptTurn[] } | null> {
  if (!appointmentId) return null;
  const r = await pool.query<{ transcript: string | null; starts_at: string | null }>(
    `SELECT transcript, starts_at FROM conversations
      WHERE appointment_id = $1 AND transcript IS NOT NULL
      ORDER BY starts_at DESC LIMIT 1`,
    [appointmentId],
  );
  if (r.rowCount === 0 || !r.rows[0].transcript) return null;
  const text = r.rows[0].transcript;
  // Parsed HERE rather than in the client, through the same pipeline the
  // extractor used. Numbering is only meaningful because both sides derive it
  // the same way; a second implementation in the renderer would drift, and a
  // drifted "#133" points review at the wrong sentence while looking correct.
  let turns: TranscriptTurn[] = [];
  try {
    turns = prepareTranscript(text).turns.map((t) => ({
      index: t.index,
      role: t.role,
      speaker: t.speaker,
      at_seconds: t.startSeconds,
      text: t.text,
    }));
  } catch (err) {
    // The raw text is still worth showing — the pane degrades to plain lines.
    logError('review.transcript_turns', 'turn parsing failed', err, { appointmentId });
  }
  return { text, recorded_at: r.rows[0].starts_at, turns };
}

function contextOne(table: Table) {
  return async (req: import('express').Request, res: import('express').Response) => {
    if (!isUuid(req.params.id)) return res.status(404).json({ error: 'not found' });
    try {
      const item = await pool.query<{
        client_id: string | null;
        content_json: unknown;
        appointment_id: string | null;
        starts_at: string | null;
      }>(
        `SELECT t.client_id, t.content_json, t.appointment_id, a.starts_at
           FROM ${table} t
      LEFT JOIN appointments a ON a.id = t.appointment_id
          WHERE t.id = $1`,
        [req.params.id],
      );
      if (item.rowCount === 0) return res.status(404).json({ error: 'not found' });
      const clientId = item.rows[0].client_id;
      const note = coerceSessionNote(item.rows[0].content_json);

      if (!clientId) {
        return res.json({
          client_id: null,
          prior: { sheet: null, protocol: null },
          supplementPlan: { current: [], merged: previewSupplementMerge([], note) },
          transcript: await fetchTranscript(item.rows[0].appointment_id),
        });
      }

      // "Prior" means the previous SESSION, so it is ordered by when the
      // appointment happened — not by updated_at, which is a row-modification
      // timestamp and reorders itself every time a note is re-approved or a
      // seed re-runs. Rows from THIS appointment are excluded by appointment_id
      // rather than row id: a protocol and its sheet share an appointment but
      // live in different tables with different ids, so excluding on id alone
      // would offer this very session back as its own history.
      const apptId = item.rows[0].appointment_id;
      const startsAt = item.rows[0].starts_at;
      const priorSql = (t: Table) => `
        SELECT x.content_json, a.starts_at
          FROM ${t} x
          JOIN appointments a ON a.id = x.appointment_id
         WHERE x.client_id = $1
           AND x.status = 'approved'
           AND ($2::uuid IS NULL OR x.appointment_id IS DISTINCT FROM $2::uuid)
           AND ($3::timestamptz IS NULL OR a.starts_at < $3::timestamptz)
      ORDER BY a.starts_at DESC LIMIT 1`;

      const [priorSheet, priorProtocol, current] = await Promise.all([
        pool.query<{ content_json: unknown; starts_at: string }>(priorSql('appointment_sheets'), [
          clientId,
          apptId,
          startsAt,
        ]),
        pool.query<{ content_json: unknown; starts_at: string }>(priorSql('protocols'), [
          clientId,
          apptId,
          startsAt,
        ]),
        fetchCurrentSupplements(clientId),
      ]);

      return res.json({
        client_id: clientId,
        prior: {
          sheet: priorSheet.rowCount
            ? { date: priorSheet.rows[0].starts_at, note: coerceSessionNote(priorSheet.rows[0].content_json) }
            : null,
          protocol: priorProtocol.rowCount
            ? { date: priorProtocol.rows[0].starts_at, note: coerceSessionNote(priorProtocol.rows[0].content_json) }
            : null,
        },
        supplementPlan: {
          current,
          merged: previewSupplementMerge(current, note),
        },
        // The source the note was extracted FROM. Review previously showed ~50
        // extracted fields with no way to check any of them against what was
        // actually said; pairing each finding with its quote is what turns
        // reviewing into confirming.
        transcript: await fetchTranscript(apptId),
      });
    } catch (err) {
      logError(`review.${table}_context`, 'context query failed', err, { id: req.params.id });
      return res.status(500).json({ error: 'internal error' });
    }
  };
}

// Appointment Sheets (internal)
/**
 * Re-run extraction on a recording whose note is already drafted.
 *
 * There was no way to do this, and it turned out to be a real gap rather than a
 * missing convenience. Extraction can come back thin for reasons that have
 * nothing to do with the recording — a rate-limited tier drops chunks, a model
 * is decommissioned mid-session, a stage times out — and the note is then
 * permanently wrong with a plausible-looking draft sitting on top of a perfectly
 * good transcript. `processConversation` only claims rows in `pending`/`failed`,
 * so once a session reached `done` nothing in the system would ever look at it
 * again. The transcript was still there; the only thing missing was a way to ask.
 *
 * Refuses to touch an approved session. A signed-off note is a clinical record,
 * and re-deriving one from a model is not a correction, it is a replacement —
 * amend it instead. (The note upsert in process.ts carries the same guard; this
 * is the earlier, explainable refusal rather than a silent no-op.)
 */
async function reextractByConversation(
  id: string,
): Promise<{ code: number; body: Record<string, unknown> }> {
  const conv = await pool.query<{
    id: string;
    appointment_id: string | null;
    has_transcript: boolean;
    extraction_status: string;
  }>(
    `SELECT id, appointment_id, transcript IS NOT NULL AS has_transcript, extraction_status
       FROM conversations WHERE id = $1`,
    [id],
  );
  if (conv.rowCount === 0) return { code: 404, body: { error: 'not found' } };
  const c = conv.rows[0];

  if (!c.has_transcript) {
    return {
      code: 409,
      body: {
        error: 'no transcript',
        detail: 'This recording has no transcript yet, so there is nothing to extract from.',
      },
    };
  }
  if (!c.appointment_id) {
    return {
      code: 409,
      body: {
        error: 'not matched',
        detail:
          'This recording is not attached to an appointment. Match it to a client first — ' +
          "extraction writes into that appointment's sheet and protocol.",
      },
    };
  }

  const approved = await pool.query(
    `SELECT 1 FROM appointment_sheets WHERE appointment_id = $1 AND status = 'approved'
      UNION ALL
     SELECT 1 FROM protocols WHERE appointment_id = $1 AND status = 'approved'
      LIMIT 1`,
    [c.appointment_id],
  );
  if (approved.rowCount) {
    return {
      code: 409,
      body: {
        error: 'session already approved',
        detail:
          'This session has been approved and its documents published. Amend the note instead — ' +
          're-running extraction would replace a signed-off record.',
      },
    };
  }

  // Snapshot the CURRENT draft before anything overwrites it.
  //
  // Learned the hard way: the first real re-extraction replaced a draft holding
  // 14 assessments with one holding none — the second run happened to lose one
  // more chunk than the first, which tripped the majority-failed rule and dropped
  // the whole narrative stage. Nothing had snapshotted the old note (revisions
  // are only written on amend), so a better draft was simply gone. Re-extraction
  // is a gamble on a nondeterministic model; it must not be a destructive one.
  const drafts = await pool.query<{ table_name: string; id: string; content_json: unknown }>(
    `SELECT 'appointment_sheets' AS table_name, id, content_json
       FROM appointment_sheets WHERE appointment_id = $1
      UNION ALL
     SELECT 'protocols', id, content_json
       FROM protocols WHERE appointment_id = $1`,
    [c.appointment_id],
  );
  const snapClient = await pool.connect();
  for (const d of drafts.rows) {
    await snapshotRevision(
      snapClient,
      d.table_name as 'appointment_sheets' | 'protocols',
      d.id,
      d.content_json,
      // Not an amendment — nothing here was ever approved, and the handler above
      // refuses outright once it has been. This exact string is what keeps these
      // rows out of the history the review pane shows.
      DRAFT_REPLACED_REASON,
    ).catch((e) =>
      // A failed snapshot must not block the re-extract, but it must be loud:
      // it means this run is unwinnable if the new note comes back worse.
      logError('review.reextract', 'could not snapshot the draft before re-extracting', e, {
        conversation_id: c.id,
        source_id: d.id,
      }),
    );
  }
  snapClient.release();

  // Back to `pending` so processConversation's locking UPDATE can claim it, with
  // the retry counters cleared so a session that previously exhausted its
  // attempts gets a genuine fresh start rather than one throttled go.
  await pool.query(
    `UPDATE conversations
        SET extraction_status = 'pending',
            extraction_attempts = 0,
            extraction_next_attempt_at = NULL,
            updated_at = now()
      WHERE id = $1`,
    [c.id],
  );

  // Off the request path, like every other extraction trigger here: a long
  // transcript on a small tier takes minutes, far longer than any sensible HTTP
  // timeout.
  enqueueExtraction(c.id);

  logEvent('info', 'review.reextract', 're-running extraction on an existing recording', {
    conversation_id: c.id,
    appointment_id: c.appointment_id,
    previous_status: c.extraction_status,
  });
  await recordAudit({
    entityType: 'session',
    entityId: c.appointment_id,
    action: 'session.reextracted',
    actor: 'nicole',
    summary: 'Re-ran extraction on the existing recording — the draft note will be replaced',
    metadata: { conversation_id: c.id, previous_status: c.extraction_status },
  });

  return {
    code: 202,
    body: {
      conversation_id: c.id,
      appointment_id: c.appointment_id,
      previous_status: c.extraction_status,
      status: 'pending',
    },
  };
}

/** POST /review/conversations/:id/reextract — by recording. */
reviewRouter.post('/conversations/:id/reextract', async (req, res) => {
  if (!isUuid(req.params.id)) return res.status(404).json({ error: 'not found' });
  try {
    const out = await reextractByConversation(req.params.id);
    return res.status(out.code).json(out.body);
  } catch (err) {
    logError('review.reextract', 're-extraction request failed', err, { id: req.params.id });
    return res.status(500).json({ error: 'internal error' });
  }
});

/**
 * POST /review/:kind/:id/reextract — the same thing, reached from the session.
 *
 * Mirrors `unmatchOne`, for the same reason: Nicole notices a thin note while
 * reading it, not while looking at a list of recordings, so the action has to
 * exist where the problem becomes visible.
 */
function reextractOne(table: Table) {
  return async (req: import('express').Request, res: import('express').Response) => {
    if (!isUuid(req.params.id)) return res.status(404).json({ error: 'not found' });
    try {
      const conv = await pool.query<{ id: string }>(
        `SELECT c.id
           FROM conversations c
           JOIN ${table} t ON t.appointment_id = c.appointment_id
          WHERE t.id = $1
          LIMIT 1`,
        [req.params.id],
      );
      if (conv.rowCount === 0) {
        return res.status(404).json({
          error: 'no recording',
          detail: 'This session has no recording attached, so there is nothing to re-extract from.',
        });
      }
      const out = await reextractByConversation(conv.rows[0].id);
      return res.status(out.code).json(out.body);
    } catch (err) {
      logError(`review.${table}_reextract`, 're-extract lookup failed', err, { id: req.params.id });
      return res.status(500).json({ error: 'internal error' });
    }
  };
}

reviewRouter.get('/sheets/:id', getOne('appointment_sheets'));
reviewRouter.patch('/sheets/:id', patchOne('appointment_sheets'));
reviewRouter.post('/sheets/:id/approve', approveOne('appointment_sheets'));
reviewRouter.get('/sheets/:id/context', contextOne('appointment_sheets'));
reviewRouter.post('/sheets/:id/amend', amendOne('appointment_sheets'));
reviewRouter.get('/sheets/:id/revisions', revisionsOne('appointment_sheets'));
reviewRouter.get('/sheets/:id/history', historyOne('appointment_sheets'));
reviewRouter.post('/sheets/:id/unmatch', unmatchOne('appointment_sheets'));
reviewRouter.post('/sheets/:id/reextract', reextractOne('appointment_sheets'));

// Protocols (client-facing)
reviewRouter.get('/protocols/:id', getOne('protocols'));
reviewRouter.patch('/protocols/:id', patchOne('protocols'));
reviewRouter.post('/protocols/:id/approve', approveOne('protocols'));
reviewRouter.get('/protocols/:id/context', contextOne('protocols'));
reviewRouter.post('/protocols/:id/amend', amendOne('protocols'));
reviewRouter.get('/protocols/:id/revisions', revisionsOne('protocols'));
reviewRouter.get('/protocols/:id/history', historyOne('protocols'));
reviewRouter.post('/protocols/:id/unmatch', unmatchOne('protocols'));
reviewRouter.post('/protocols/:id/reextract', reextractOne('protocols'));

// ---------------------------------------------------------------------------
// Rendered documents — Markdown produced from the current content_json.
// Rendered on-demand (always fresh after edits); Zapier/dashboard fetch these
// and write the Appointment Sheet / Protocol to Drive.
// ---------------------------------------------------------------------------
reviewRouter.get('/sheets/:id/render', async (req, res) => {
  if (!isUuid(req.params.id)) return res.status(404).json({ error: 'not found' });
  try {
    const r = await pool.query(
      `SELECT s.content_json, c.name AS client_name, a.starts_at
         FROM appointment_sheets s
         JOIN appointments a ON a.id = s.appointment_id
    LEFT JOIN clients c ON c.id = s.client_id
        WHERE s.id = $1`,
      [req.params.id],
    );
    if (r.rowCount === 0) return res.status(404).json({ error: 'not found' });
    const row = r.rows[0];
    const md = renderAppointmentSheet(coerceSessionNote(row.content_json), {
      clientName: row.client_name ?? 'Unknown client',
      appointmentDate: fmtDate(row.starts_at),
    });
    return res.json({ markdown: md });
  } catch (err) {
    logError('review.sheets_render', 'render failed', err, { id: req.params.id });
    return res.status(500).json({ error: 'internal error' });
  }
});

reviewRouter.get('/protocols/:id/render', async (req, res) => {
  if (!isUuid(req.params.id)) return res.status(404).json({ error: 'not found' });
  try {
    const r = await pool.query(
      `SELECT p.content_json, c.name AS client_name, a.starts_at
         FROM protocols p
    LEFT JOIN clients c ON c.id = p.client_id
    LEFT JOIN appointments a ON a.id = p.appointment_id
        WHERE p.id = $1`,
      [req.params.id],
    );
    if (r.rowCount === 0) return res.status(404).json({ error: 'not found' });
    const row = r.rows[0];
    const md = renderProtocol(coerceSessionNote(row.content_json), {
      clientName: row.client_name ?? 'Unknown client',
      appointmentDate: fmtDate(row.starts_at),
    });
    return res.json({ markdown: md });
  } catch (err) {
    logError('review.protocols_render', 'render failed', err, { id: req.params.id });
    return res.status(500).json({ error: 'internal error' });
  }
});
