import { Router } from 'express';
import { z } from 'zod';
import { pool } from '../db/pool';
import { logError, logEvent } from '../observability/logger';
import { coerceSessionNote, renderAppointmentSheet, renderProtocol } from '../session/render';
import { processConversation } from '../session/process';
import { publishApproved } from '../session/publish';
import { publishClientTemplates, republishAmended } from '../session/publishTemplates';
import {
  syncClientSupplements,
  fetchCurrentSupplements,
  previewSupplementMerge,
  removeSupplementsDroppedByAmendment,
} from '../session/supplements';
import { createTasksFromNote } from '../tasks/service';
import { fetchRevisions, snapshotRevision } from '../session/revisions';
import { scoreNameMatch, nameSignalRank, overlapSeconds } from '../correlation/nameMatch';
import { recordAudit } from '../audit/log';
import {
  listSessions,
  getSession,
  patchSession,
  approveSession,
  amendSession,
  appointmentForItem,
} from '../session/sessionService';

// Nicole's review queue: the draft Appointment Sheets + Protocols produced by
// session extraction, with edit + approve. (No auth yet — approved_by is a
// placeholder until login lands; the approve action is audited via approvals.)
export const reviewRouter = Router();

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
// GET /review/unmatched — Bee conversations the correlator couldn't tie to an
// appointment (no overlap, or ambiguous). These need Nicole to tag manually;
// we never auto-guess the client. (§8 dashboard, §9 risk 3.)
// ---------------------------------------------------------------------------
reviewRouter.get('/unmatched', async (_req, res) => {
  try {
    const r = await pool.query(
      `SELECT id, bee_id, starts_at, ends_at, correlation_status,
              left(coalesce(transcript, ''), 240) AS transcript_preview
         FROM conversations
        WHERE appointment_id IS NULL
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
      bee_id: string;
      starts_at: string;
      ends_at: string;
      correlation_status: string;
      extraction_status: string;
      appointment_id: string | null;
      transcript: string | null;
    }>(
      `SELECT id, bee_id, starts_at, ends_at, correlation_status,
              extraction_status, appointment_id, transcript
         FROM conversations
        WHERE id = $1`,
      [req.params.id],
    );
    if (r.rowCount === 0) return res.status(404).json({ error: 'not found' });
    if (r.rows[0].appointment_id) {
      // It's been matched (perhaps in another tab) — send her to the session.
      return res.status(409).json({ error: 'already matched', detail: 'This recording is now tied to an appointment.' });
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
    RETURNING id, transcript`,
      [req.params.id, parsed.data.appointment_id, appt.rows[0].client_id],
    );
    if (r.rowCount === 0) return res.status(409).json({ error: 'already matched or not found' });

    if (r.rows[0].transcript) {
      void processConversation(r.rows[0].id).catch((e) =>
        logError('session.process', 'post-match processing failed', e, { conversation_id: r.rows[0].id }),
      );
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
    const conv = await db.query<{ starts_at: string; ends_at: string; transcript: string | null }>(
      `SELECT starts_at, ends_at, transcript FROM conversations
        WHERE id = $1 AND appointment_id IS NULL FOR UPDATE`,
      [req.params.id],
    );
    if (conv.rowCount === 0) {
      await db.query('ROLLBACK');
      return res.status(409).json({ error: 'already matched or not found' });
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
      void processConversation(req.params.id).catch((e) =>
        logError('session.process', 'walk-in processing failed', e, { conversation_id: req.params.id }),
      );
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

async function unmatchByConversation(conversationId: string): Promise<UnmatchOutcome> {
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
          detail: 'This session has no Bee recording attached, so there is nothing to reassign.',
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
      let blocked: string | null = 'This session has no Bee recording attached.';
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
          blocked = 'This session has no Bee recording attached.';
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
      });
    } catch (err) {
      logError(`review.${table}_context`, 'context query failed', err, { id: req.params.id });
      return res.status(500).json({ error: 'internal error' });
    }
  };
}

// Appointment Sheets (internal)
reviewRouter.get('/sheets/:id', getOne('appointment_sheets'));
reviewRouter.patch('/sheets/:id', patchOne('appointment_sheets'));
reviewRouter.post('/sheets/:id/approve', approveOne('appointment_sheets'));
reviewRouter.get('/sheets/:id/context', contextOne('appointment_sheets'));
reviewRouter.post('/sheets/:id/amend', amendOne('appointment_sheets'));
reviewRouter.get('/sheets/:id/revisions', revisionsOne('appointment_sheets'));
reviewRouter.get('/sheets/:id/history', historyOne('appointment_sheets'));
reviewRouter.post('/sheets/:id/unmatch', unmatchOne('appointment_sheets'));

// Protocols (client-facing)
reviewRouter.get('/protocols/:id', getOne('protocols'));
reviewRouter.patch('/protocols/:id', patchOne('protocols'));
reviewRouter.post('/protocols/:id/approve', approveOne('protocols'));
reviewRouter.get('/protocols/:id/context', contextOne('protocols'));
reviewRouter.post('/protocols/:id/amend', amendOne('protocols'));
reviewRouter.get('/protocols/:id/revisions', revisionsOne('protocols'));
reviewRouter.get('/protocols/:id/history', historyOne('protocols'));
reviewRouter.post('/protocols/:id/unmatch', unmatchOne('protocols'));

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
