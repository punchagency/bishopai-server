import { Router } from 'express';
import { z } from 'zod';
import { getDatabase } from '../db/index.js';
import type { Appointment } from '../db/interfaces/types.js';
import { logError, logEvent } from '../observability/logger';
import { coerceSessionNote, renderAppointmentSheet, renderProtocol } from '../session/render';
import { processConversation } from '../session/process';
import { publishApproved } from '../session/publish';
import { publishClientTemplates, republishAmended } from '../session/publishTemplates';
import { fetchCurrentSupplements, previewSupplementMerge } from '../session/supplements';
import { fetchRevisions } from '../session/revisions';
import { scoreNameMatch, nameSignalRank, overlapSeconds } from '../correlation/nameMatch';
import { recordAudit } from '../audit/log';
import { isDocId } from '../db/ids.js';
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

/**
 * Appointment / document ids are still uuids, so the cheap 404 for a malformed
 * path segment is kept for those.
 *
 * It is deliberately NOT applied to conversation ids any more: a conversation's
 * document id is its bee_id (§3.1), which is an external identifier and not a
 * uuid. Leaving the guard on would have 404'd every real recording.
 */
// Path ids are Firestore document ids, not uuids — the port mints deterministic
// ones (`appt_…`, `client_…`, `${clientId}__${nameKey}`). Gating on uuid shape
// here would 404 every PB-synced record; see isDocId.
const isUuid = isDocId;

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
const PREVIEW_CHARS = 240;

reviewRouter.get('/unmatched', async (_req, res) => {
  try {
    // `correlation_status = 'unmatched'` rather than `appointment_id IS NULL`.
    // Firestore cannot query for a missing/null field the way SQL can, and the
    // two are the same set by construction: nothing sets one without the other,
    // and unmatch resets both together.
    const rows = await getDatabase().conversations.listUnmatched();
    res.json({
      conversations: rows.map((c) => ({
        id: c.id,
        bee_id: c.bee_id,
        starts_at: c.starts_at,
        ends_at: c.ends_at,
        correlation_status: c.correlation_status,
        transcript_preview: (c.transcript ?? '').slice(0, PREVIEW_CHARS),
      })),
    });
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
  try {
    const conv = await getDatabase().conversations.findById(req.params.id);
    if (!conv) return res.status(404).json({ error: 'not found' });
    if (conv.appointment_id) {
      // It's been matched (perhaps in another tab) — send her to the session.
      return res.status(409).json({ error: 'already matched', detail: 'This recording is now tied to an appointment.' });
    }
    return res.json({
      conversation: {
        id: conv.id,
        bee_id: conv.bee_id,
        starts_at: conv.starts_at,
        ends_at: conv.ends_at,
        correlation_status: conv.correlation_status,
        extraction_status: conv.extraction_status,
        transcript: conv.transcript ?? null,
      },
    });
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
/** How wide a window around the recording to consider for manual tagging. */
const CANDIDATE_WINDOW_HOURS = 36;
const CANDIDATE_SCAN = 12;

reviewRouter.get('/unmatched/:id/candidates', async (req, res) => {
  try {
    const db = getDatabase();
    const conv = await db.conversations.findById(req.params.id);
    if (!conv) return res.status(404).json({ error: 'not found' });
    const { starts_at: cs, ends_at: ce, transcript } = conv;

    // Offer only appointments a match could actually land on: not cancelled
    // (the slot's client may never have shown up — matching their chart is the
    // wrong-person error), and not already carrying a recording (one
    // conversation per appointment is an invariant; offering a taken one just
    // walks Nicole into a refusal).
    //
    // `ORDER BY abs(starts_at - $1)` has no Firestore equivalent — an ordering
    // by distance from a point isn't an index — so the nearest-first scan
    // becomes a bounded window around the recording, sorted in memory. The
    // window is generous because a mis-timed recording is exactly the case this
    // screen exists for; the LIMIT then applies to the ranked result.
    const windowMs = CANDIDATE_WINDOW_HOURS * 3_600_000;
    const inWindow = await db.appointments.listBetween(
      new Date(new Date(cs).getTime() - windowMs).toISOString(),
      new Date(new Date(cs).getTime() + windowMs).toISOString(),
    );
    const live = inWindow.filter((a) => a.status !== 'cancelled');
    const taken = await Promise.all(live.map((a) => db.conversations.findByAppointment(a.id)));
    const nearest = live
      .filter((_, i) => !taken[i])
      .sort(
        (x, y) =>
          Math.abs(new Date(x.starts_at).getTime() - new Date(cs).getTime()) -
          Math.abs(new Date(y.starts_at).getTime() - new Date(cs).getTime()),
      )
      .slice(0, CANDIDATE_SCAN);

    const scored = nearest.map((a) => {
      // client_name is denormalized onto the appointment (§3.4), so ranking by
      // name evidence no longer needs a clients join per candidate.
      const name = scoreNameMatch(transcript ?? null, a.client_name ?? null);
      return {
        id: a.id,
        starts_at: a.starts_at,
        ends_at: a.ends_at,
        client_id: a.client_id,
        client_name: a.client_name ?? null,
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

const APPOINTMENT_TAKEN = {
  error: 'appointment has a recording',
  detail: 'This appointment already has a recording attached. Detach that one first if it is wrong.',
} as const;

reviewRouter.post('/unmatched/:id/match', async (req, res) => {
  const parsed = matchSchema.safeParse(req.body);
  if (!parsed.success || !isUuid(parsed.data.appointment_id)) {
    return res.status(400).json({ error: 'invalid payload' });
  }
  const appointmentId = parsed.data.appointment_id;
  const db = getDatabase();
  let claimed = false;

  try {
    const appointment = await db.appointments.findById(appointmentId);
    if (!appointment) return res.status(404).json({ error: 'appointment not found' });
    if (appointment.status === 'cancelled') {
      return res.status(409).json({
        error: 'appointment cancelled',
        detail: 'This booking was cancelled — its client may never have been in the room. Assign the recording to the right client instead.',
      });
    }

    // Never onto a session that's already signed off: extraction would overwrite
    // the approved note and demote it to draft with no revision trail. An
    // approved session is corrected through Amend, not by re-matching a
    // recording onto it.
    const docs = await db.sessionNotes.findSessionDocs(appointmentId);
    if (docs.sheet?.status === 'approved' || docs.protocol?.status === 'approved') {
      return res.status(409).json({
        error: 'session already approved',
        detail: 'This appointment already has an approved session note. Amend that note instead of attaching a new recording.',
      });
    }

    // One recording per appointment. The claim document is the enforcement —
    // the replacement for `conversations_appointment_unique` — so it is taken
    // BEFORE the conversation is pointed at the appointment, not checked with a
    // read that a concurrent match could slip past.
    claimed = await db.conversations.claimAppointment({
      id: appointmentId,
      conversation_id: req.params.id,
      claimed_at: new Date().toISOString(),
    });
    if (!claimed) return res.status(409).json(APPOINTMENT_TAKEN);

    // Guarded on the conversation still being unassigned, so two tabs matching
    // the same recording to different appointments can't both win.
    const moved = await db.conversations.transitionExtraction(
      req.params.id,
      ['pending', 'failed', 'done', 'needs_review'],
      {
        appointment_id: appointmentId,
        client_id: appointment.client_id ?? null,
        correlation_status: 'matched',
      },
      (row) => !row.appointment_id,
    );
    if (!moved) {
      await db.conversations.releaseAppointment(appointmentId);
      claimed = false;
      return res.status(409).json({ error: 'already matched or not found' });
    }

    if (moved.transcript) {
      void processConversation(moved.id).catch((e) =>
        logError('session.process', 'post-match processing failed', e, { conversation_id: moved.id }),
      );
    }
    await recordAudit({
      entityType: 'session',
      entityId: appointmentId,
      action: 'session.matched',
      actor: 'nicole',
      summary: 'Recording manually matched to this appointment',
      metadata: { conversation_id: moved.id },
    });
    return res.json({ conversation_id: moved.id, status: 'matched' });
  } catch (err) {
    // A claim taken but never used would block the appointment forever, so it
    // is handed back on any failure after it was granted.
    if (claimed) await db.conversations.releaseAppointment(appointmentId).catch(() => {});
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

/**
 * A walk-in appointment exists only to carry one recording, so its id is derived
 * from that recording. Deterministic on purpose: a replayed assign lands on the
 * same appointment document instead of creating a second one for the same
 * session, which is the uniqueness the pg `pb_id` UNIQUE gave for free.
 */
const walkInAppointmentId = (conversationId: string) => `walkin-${conversationId}`;

reviewRouter.post('/unmatched/:id/assign-client', async (req, res) => {
  const parsed = assignClientSchema.safeParse(req.body);
  if (!parsed.success || !isUuid(parsed.data.client_id)) {
    return res.status(400).json({ error: 'invalid payload' });
  }
  const conversationId = req.params.id;
  const clientId = parsed.data.client_id;
  const appointmentId = walkInAppointmentId(conversationId);
  const db = getDatabase();
  let claimed = false;

  try {
    const conv = await db.conversations.findById(conversationId);
    if (!conv || conv.appointment_id) {
      return res.status(409).json({ error: 'already matched or not found' });
    }
    const client = await db.clients.findById(clientId);
    if (!client) return res.status(404).json({ error: 'client not found' });

    // The claim is taken first, same as /match: it is what makes one recording
    // per appointment true, and taking it before the appointment exists means a
    // concurrent retry cannot produce two walk-ins for one recording.
    claimed = await db.conversations.claimAppointment({
      id: appointmentId,
      conversation_id: conversationId,
      claimed_at: new Date().toISOString(),
    });
    if (!claimed) return res.status(409).json(APPOINTMENT_TAKEN);

    const now = new Date().toISOString();
    const appointment: Appointment = {
      id: appointmentId,
      client_id: clientId,
      client_name: client.name,
      // No PB booking exists, so the id is derived from the recording — stable,
      // and obviously not a Practice Better id to anyone reading the collection.
      pb_id: appointmentId,
      // The recording's window is the truth of when the session happened.
      starts_at: conv.starts_at,
      ends_at: conv.ends_at,
      status: 'completed',
      created_at: now,
      updated_at: now,
    };
    await db.appointments.save(appointment);

    const moved = await db.conversations.transitionExtraction(
      conversationId,
      ['pending', 'failed', 'done', 'needs_review'],
      { appointment_id: appointmentId, client_id: clientId, correlation_status: 'walk_in' },
      (row) => !row.appointment_id,
    );
    if (!moved) {
      // The appointment was created for a recording that has since been placed
      // elsewhere. Remove it rather than leaving an empty walk-in on the books.
      await db.appointments.delete(appointmentId);
      await db.conversations.releaseAppointment(appointmentId);
      claimed = false;
      return res.status(409).json({ error: 'already matched or not found' });
    }

    logEvent('info', 'review.assign_client', 'assigned a walk-in recording to a client', {
      conversation_id: conversationId,
      client_id: clientId,
      appointment_id: appointmentId,
    });
    await recordAudit({
      entityType: 'session',
      entityId: appointmentId,
      action: 'session.assigned_walkin',
      actor: 'nicole',
      summary: 'Walk-in recording assigned to a client (appointment created from the recording)',
      metadata: { conversation_id: conversationId, client_id: clientId },
    });

    if (moved.transcript) {
      void processConversation(conversationId).catch((e) =>
        logError('session.process', 'walk-in processing failed', e, { conversation_id: conversationId }),
      );
    }
    return res.json({ appointment_id: appointmentId, client_id: clientId, status: 'walk_in' });
  } catch (err) {
    if (claimed) await db.conversations.releaseAppointment(appointmentId).catch(() => {});
    logError('review.assign_client', 'walk-in assignment failed', err, { id: conversationId });
    return res.status(500).json({ error: 'internal error' });
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
  const db = getDatabase();
  try {
    const conv = await db.conversations.findById(conversationId);
    if (!conv) return { code: 404, body: { error: 'not found' } };
    const apptId = conv.appointment_id;
    if (!apptId) {
      return { code: 409, body: { error: 'not matched', detail: 'This recording is already unassigned.' } };
    }

    const docs = await db.sessionNotes.findSessionDocs(apptId);
    if (docs.sheet?.status === 'approved' || docs.protocol?.status === 'approved') {
      return {
        code: 409,
        body: {
          error: 'already approved',
          detail:
            'This session has been approved and its documents published. Amend the note instead of reassigning it.',
        },
      };
    }

    // Detach the conversation FIRST, guarded on it still pointing where we
    // think. In Postgres one transaction covered the whole teardown; here the
    // order carries the safety instead. Releasing the pointer before deleting
    // the drafts means a crash mid-way leaves an unmatched recording beside an
    // orphaned draft — recoverable, and visible in the queue — rather than a
    // matched recording whose note has already been destroyed.
    const detached = await db.conversations.transitionExtraction(
      conversationId,
      ['pending', 'processing', 'failed', 'done', 'needs_review'],
      {
        appointment_id: null,
        client_id: null,
        correlation_status: 'unmatched',
        extraction_status: 'pending',
        extraction_leased_at: null,
        extraction_next_attempt_at: new Date().toISOString(),
      },
      (row) => row.appointment_id === apptId,
    );
    if (!detached) {
      return { code: 409, body: { error: 'not matched', detail: 'This recording moved before it could be detached.' } };
    }

    // The draft note belongs to the wrong client — remove it rather than leaving
    // it in her queue attributed to someone who was never in the room.
    await db.sessionNotes.deleteSessionDocs(apptId);

    // A walk-in appointment exists only to carry this recording, so it goes too.
    if (apptId === walkInAppointmentId(conversationId)) {
      await db.appointments.delete(apptId);
    }

    // Hand the appointment back so it can be offered as a candidate again.
    await db.conversations.releaseAppointment(apptId);

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
    logError('review.unmatch', 'unmatch failed', err, { id: conversationId });
    return { code: 500, body: { error: 'internal error' } };
  }
}

reviewRouter.post('/conversations/:id/unmatch', async (req, res) => {
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
      // Both document collections key on the appointment id, so the JOIN that
      // resolved a document to its recording is now a direct lookup.
      const conv = await getDatabase().conversations.findByAppointment(req.params.id);
      if (!conv) {
        return res.status(404).json({
          error: 'no recording',
          detail: 'This session has no Bee recording attached, so there is nothing to reassign.',
        });
      }
      const out = await unmatchByConversation(conv.id);
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

/** Both collections key the document on the appointment id, so `id` IS that id. */
async function loadDoc(table: Table, id: string) {
  const docs = await getDatabase().sessionNotes.findSessionDocs(id);
  return { docs, doc: table === 'appointment_sheets' ? docs.sheet : docs.protocol };
}

function getOne(table: Table) {
  return async (req: import('express').Request, res: import('express').Response) => {
    if (!isUuid(req.params.id)) return res.status(404).json({ error: 'not found' });
    try {
      const { docs, doc } = await loadDoc(table, req.params.id);
      if (!doc) return res.status(404).json({ error: 'not found' });

      // Whether this session can still be detached from its client, so the UI can
      // avoid offering an action that would only fail. A sheet and a protocol
      // share an appointment: approving EITHER publishes documents, which pins
      // the pairing even while the other is still a draft.
      const approved = docs.sheet?.status === 'approved' || docs.protocol?.status === 'approved';
      const conv = await getDatabase().conversations.findByAppointment(doc.appointment_id);

      let canUnmatch = false;
      let blocked: string | null;
      if (approved) {
        blocked = 'This session has been approved and its documents published. Amend it instead.';
      } else if (!conv) {
        blocked = 'This session has no Bee recording attached.';
      } else {
        canUnmatch = true;
        blocked = null;
      }

      return res.json({ ...doc, can_unmatch: canUnmatch, unmatch_blocked_reason: blocked });
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
      // carries no clinical content, so it stays a direct write — but it goes
      // through the guarded write so it cannot touch an approved session.
      //
      // `approved` is refused here. The pg version accepted it as a plain UPDATE,
      // which silently skipped everything approval actually means: the supplement
      // sync, the follow-up tasks, the approval record, and the Drive publish. A
      // session marked approved that way looked signed-off in the queue while the
      // client's documents were never written. Approving goes through
      // POST /approve, which is the only path that does those.
      if (status === 'approved') {
        return res.status(409).json({
          error: 'use approve',
          detail: 'Approving publishes documents and syncs the plan. Use the approve action instead.',
        });
      }
      if (status) {
        const out = await getDatabase().sessionNotes.guardedWrite({
          appointmentId: req.params.id,
          expect: ['draft', 'in_review'],
          status,
        });
        if (!out.ok) {
          return out.reason === 'not_found'
            ? res.status(404).json({ error: 'not found' })
            : res.status(409).json({
                error: 'already approved',
                detail: 'This session has been approved. Use amend to correct it.',
              });
        }
      }

      const { doc } = await loadDoc(table, req.params.id);
      if (!doc) return res.status(404).json({ error: 'not found' });
      return res.json(doc);
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

      const { doc } = await loadDoc(table, req.params.id);
      return res.json({ ...doc, revision: out.revision });
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
      const { doc } = await loadDoc(table, req.params.id);
      if (!doc) return res.status(404).json({ error: 'not found' });
      const clientId = doc.client_id ?? null;
      if (!clientId) return res.json({ total: 0, sessions: [] });

      // The count comes back with the list, from a real count() aggregation —
      // the list is capped, and silently dropping older visits would
      // misrepresent the client's history as shorter than it is.
      const { total, sessions } = await getDatabase().sessionNotes.listApprovedHistory(clientId, {
        excludeAppointmentId: doc.appointment_id,
        before: doc.starts_at ?? null,
        limit: HISTORY_LIMIT,
      });

      return res.json({
        total,
        sessions: sessions.map((x) => ({
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

      const { doc } = await loadDoc(table, req.params.id);
      return res.json(doc);
    } catch (err) {
      logError(`review.${table}_approve`, 'approve failed', err, { id: req.params.id });
      return res.status(500).json({ error: 'internal error' });
    }
  };
}

/** The recording behind an appointment, for the review pane's source panel. */
async function fetchTranscript(
  appointmentId: string | null,
): Promise<{ text: string; recorded_at: string | null } | null> {
  if (!appointmentId) return null;
  // One conversation per appointment is an invariant (the claim document), so
  // the ORDER BY … LIMIT 1 over a possible set is now a single lookup.
  const conv = await getDatabase().conversations.findByAppointment(appointmentId);
  if (!conv?.transcript) return null;
  return { text: conv.transcript, recorded_at: conv.starts_at ?? null };
}

function contextOne(table: Table) {
  return async (req: import('express').Request, res: import('express').Response) => {
    if (!isUuid(req.params.id)) return res.status(404).json({ error: 'not found' });
    try {
      const { doc } = await loadDoc(table, req.params.id);
      if (!doc) return res.status(404).json({ error: 'not found' });
      const clientId = doc.client_id ?? null;
      const note = coerceSessionNote(doc.content_json);

      if (!clientId) {
        return res.json({
          client_id: null,
          prior: { sheet: null, protocol: null },
          supplementPlan: { current: [], merged: previewSupplementMerge([], note) },
          transcript: await fetchTranscript(doc.appointment_id),
        });
      }

      // "Prior" means the previous SESSION, so it is ordered by when the
      // appointment happened — the denormalized starts_at — not by updated_at,
      // which is a row-modification timestamp and reorders itself every time a
      // note is re-approved or a seed re-runs. Rows from THIS appointment are
      // excluded by appointment_id rather than document id: a protocol and its
      // sheet share an appointment, so excluding on id alone would offer this
      // very session back as its own history.
      const scope = {
        excludeAppointmentId: doc.appointment_id,
        before: doc.starts_at ?? null,
      };
      const db = getDatabase();
      const [priorSheet, priorProtocol, current] = await Promise.all([
        db.sessionNotes.findPriorApproved('sheet', clientId, scope),
        db.sessionNotes.findPriorApproved('protocol', clientId, scope),
        fetchCurrentSupplements(clientId),
      ]);

      return res.json({
        client_id: clientId,
        prior: {
          sheet: priorSheet
            ? { date: priorSheet.starts_at ?? null, note: coerceSessionNote(priorSheet.content_json) }
            : null,
          protocol: priorProtocol
            ? { date: priorProtocol.starts_at ?? null, note: coerceSessionNote(priorProtocol.content_json) }
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
        transcript: await fetchTranscript(doc.appointment_id),
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
function renderOne(table: Table) {
  return async (req: import('express').Request, res: import('express').Response) => {
    if (!isUuid(req.params.id)) return res.status(404).json({ error: 'not found' });
    try {
      const { doc } = await loadDoc(table, req.params.id);
      if (!doc) return res.status(404).json({ error: 'not found' });

      // client_name is denormalized onto the document at extraction time, so a
      // render needs no clients lookup. It falls back to a live read only when
      // the document predates the denormalization.
      const clientName =
        doc.client_name ??
        (doc.client_id ? (await getDatabase().clients.findById(doc.client_id))?.name : null) ??
        'Unknown client';

      const note = coerceSessionNote(doc.content_json);
      const ctx = { clientName, appointmentDate: fmtDate(doc.starts_at) };
      const md =
        table === 'appointment_sheets' ? renderAppointmentSheet(note, ctx) : renderProtocol(note, ctx);
      return res.json({ markdown: md });
    } catch (err) {
      logError(`review.${table}_render`, 'render failed', err, { id: req.params.id });
      return res.status(500).json({ error: 'internal error' });
    }
  };
}

reviewRouter.get('/sheets/:id/render', renderOne('appointment_sheets'));
reviewRouter.get('/protocols/:id/render', renderOne('protocols'));
