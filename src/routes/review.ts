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
// GET /review/queue — everything awaiting Nicole (draft + in_review).
// GET /review/queue?status=approved — what she has already signed off on, so a
// finished session stays reachable instead of vanishing from the app entirely.
// Approved rows are capped: this is a recent-history list, not an archive.
// ---------------------------------------------------------------------------
const APPROVED_LIMIT = 100;

reviewRouter.get('/queue', async (req, res) => {
  const approved = req.query.status === 'approved';
  const statuses = approved ? ['approved'] : ['draft', 'in_review'];
  const limit = approved ? `LIMIT ${APPROVED_LIMIT}` : '';
  try {
    const sheets = await pool.query(
      `SELECT s.id, s.status, s.content_json, s.updated_at,
              a.id AS appointment_id, a.starts_at, a.ends_at,
              c.id AS client_id, c.name AS client_name
         FROM appointment_sheets s
         JOIN appointments a ON a.id = s.appointment_id
    LEFT JOIN clients c ON c.id = s.client_id
        WHERE s.status = ANY($1)
     ORDER BY a.starts_at DESC ${limit}`,
      [statuses],
    );
    // Join appointments for starts_at: without it the list falls back to
    // updated_at, which is when the ROW was written. A client with several
    // sessions then shows a stack of protocols all stamped the same day —
    // indistinguishable, and wrong.
    const protocols = await pool.query(
      `SELECT p.id, p.status, p.content_json, p.updated_at, p.appointment_id,
              a.starts_at, a.ends_at,
              c.id AS client_id, c.name AS client_name
         FROM protocols p
    LEFT JOIN appointments a ON a.id = p.appointment_id
    LEFT JOIN clients c ON c.id = p.client_id
        WHERE p.status = ANY($1)
     ORDER BY COALESCE(a.starts_at, p.updated_at) DESC ${limit}`,
      [statuses],
    );
    res.json({ appointment_sheets: sheets.rows, protocols: protocols.rows });
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

// GET /review/unmatched/:id/candidates — appointments to offer for manual
// tagging, nearest in time to the conversation first.
reviewRouter.get('/unmatched/:id/candidates', async (req, res) => {
  if (!isUuid(req.params.id)) return res.status(404).json({ error: 'not found' });
  try {
    const conv = await pool.query<{ starts_at: string }>(
      `SELECT starts_at FROM conversations WHERE id = $1`,
      [req.params.id],
    );
    if (conv.rowCount === 0) return res.status(404).json({ error: 'not found' });
    const r = await pool.query(
      `SELECT a.id, a.starts_at, a.ends_at, c.name AS client_name
         FROM appointments a
    LEFT JOIN clients c ON c.id = a.client_id
     ORDER BY abs(extract(epoch FROM (a.starts_at - $1::timestamptz)))
        LIMIT 8`,
      [conv.rows[0].starts_at],
    );
    return res.json({ appointments: r.rows });
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
    const appt = await pool.query<{ client_id: string | null }>(
      `SELECT client_id FROM appointments WHERE id = $1`,
      [parsed.data.appointment_id],
    );
    if (appt.rowCount === 0) return res.status(404).json({ error: 'appointment not found' });

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
    return res.json({ conversation_id: r.rows[0].id, status: 'matched' });
  } catch (err) {
    logError('review.match', 'manual match failed', err, { id: req.params.id });
    return res.status(500).json({ error: 'internal error' });
  }
});

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
      return res.json(r.rows[0]);
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
      // An approved note has already been published to Drive and may have been
      // emailed to the client. Editing it here would leave the record and the
      // delivered document disagreeing, with nothing to show it happened — and
      // re-approving does NOT republish (see firstApproval below), so the drift
      // would be permanent and silent. Corrections go through /amend, which
      // snapshots the superseded version and republishes what it safely can.
      if (content_json) {
        const cur = await pool.query<{ status: string }>(
          `SELECT status FROM ${table} WHERE id = $1`,
          [req.params.id],
        );
        if (cur.rowCount === 0) return res.status(404).json({ error: 'not found' });
        if (cur.rows[0].status === 'approved') {
          return res.status(409).json({
            error: 'already approved',
            detail: 'This note has been approved and its documents published. Use amend to correct it.',
          });
        }
      }

      const r = await pool.query(
        `UPDATE ${table}
            SET content_json = COALESCE($2, content_json),
                status       = COALESCE($3, status)
          WHERE id = $1
      RETURNING *`,
        [req.params.id, content_json ? JSON.stringify(content_json) : null, status ?? null],
      );
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
function amendOne(table: Table, approvalType: string) {
  return async (req: import('express').Request, res: import('express').Response) => {
    if (!isUuid(req.params.id)) return res.status(404).json({ error: 'not found' });
    const parsed = amendSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return res.status(400).json({ error: 'invalid payload', details: parsed.error.issues });
    }
    const { content_json, reason } = parsed.data;
    const amendedBy = parsed.data.amended_by || 'nicole';

    const db = await pool.connect();
    try {
      await db.query('BEGIN');
      const cur = await db.query<{ status: string; content_json: unknown; client_id: string | null; appointment_id: string | null }>(
        `SELECT status, content_json, client_id, appointment_id FROM ${table} WHERE id = $1 FOR UPDATE`,
        [req.params.id],
      );
      if (cur.rowCount === 0) {
        await db.query('ROLLBACK');
        return res.status(404).json({ error: 'not found' });
      }
      if (cur.rows[0].status !== 'approved') {
        await db.query('ROLLBACK');
        return res.status(409).json({
          error: 'not approved',
          detail: 'Only an approved note is amended. Edit this one directly instead.',
        });
      }

      const revision = await snapshotRevision(
        db,
        table,
        req.params.id,
        cur.rows[0].content_json,
        reason ?? null,
      );

      const upd = await db.query(
        `UPDATE ${table} SET content_json = $2 WHERE id = $1 RETURNING *`,
        [req.params.id, JSON.stringify(content_json)],
      );

      await db.query(
        `INSERT INTO approvals (type, payload_json, status, approved_by, approved_at)
              VALUES ($1, $2, 'amended', $3, now())`,
        [
          approvalType,
          JSON.stringify({ [`${approvalType}_id`]: req.params.id, revision, reason: reason ?? null }),
          amendedBy,
        ],
      );

      // An amended protocol changes the supplement plan, so re-run the same sync
      // the approval does. It's keyed by name and idempotent, so re-applying the
      // corrected note converges rather than duplicating.
      if (table === 'protocols' && cur.rows[0].client_id) {
        const appt = await db.query<{ starts_at: string | null }>(
          `SELECT starts_at FROM appointments WHERE id = $1`,
          [cur.rows[0].appointment_id],
        );
        const startDate = appt.rows[0]?.starts_at
          ? new Date(appt.rows[0].starts_at).toISOString().slice(0, 10)
          : null;
        await syncClientSupplements(db, cur.rows[0].client_id, startDate, content_json);
        // Sync alone can't retract: it only ever removes on an explicit 'stop'.
        const dropped = await removeSupplementsDroppedByAmendment(
          db,
          cur.rows[0].client_id,
          cur.rows[0].content_json,
          content_json,
        );
        if (dropped > 0) {
          logEvent('info', 'review.protocol_amend', 'removed supplements retracted by amendment', {
            id: req.params.id,
            dropped,
          });
        }
      }

      await db.query('COMMIT');

      logEvent('info', `review.${table}_amend`, 'amended an approved note', {
        id: req.params.id,
        revision,
        amendedBy,
      });

      // Off the request path, like the approve publish. Which documents can be
      // safely rewritten differs per template — republishAmended decides.
      void publishApproved(table, req.params.id).catch((err) =>
        logError(`review.${table}_amend_publish`, 'Drive publish failed', err, { id: req.params.id }),
      );
      if (table === 'protocols') {
        void republishAmended(req.params.id).catch((err) =>
          logError('review.protocol_amend_republish', 'republish failed', err, { id: req.params.id }),
        );
      }

      return res.json({ ...upd.rows[0], revision });
    } catch (err) {
      await db.query('ROLLBACK').catch(() => {});
      logError(`review.${table}_amend`, 'amend failed', err, { id: req.params.id });
      return res.status(500).json({ error: 'internal error' });
    } finally {
      db.release();
    }
  };
}

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

/** GET /review/:kind/:id/revisions — the superseded versions, newest first. */
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

function approveOne(table: Table, approvalType: string) {
  return async (req: import('express').Request, res: import('express').Response) => {
    if (!isUuid(req.params.id)) return res.status(404).json({ error: 'not found' });
    const parsedBody = approveSchema.safeParse(req.body ?? {});
    const approvedBy = (parsedBody.success && parsedBody.data.approved_by) || 'nicole';

    const db = await pool.connect();
    try {
      await db.query('BEGIN');
      // Capture the prior status atomically so we can tell a genuine first
      // approval from a re-approval — the Flow Sheet append + dated Supplement
      // are NOT idempotent, so they must fire only on the transition.
      const r = await db.query(
        `WITH prev AS (SELECT status AS old_status FROM ${table} WHERE id = $1 FOR UPDATE)
         UPDATE ${table} t SET status = 'approved'
           FROM prev WHERE t.id = $1
         RETURNING t.*, prev.old_status`,
        [req.params.id],
      );
      if (r.rowCount === 0) {
        await db.query('ROLLBACK');
        return res.status(404).json({ error: 'not found' });
      }
      const firstApproval = r.rows[0].old_status !== 'approved';
      delete r.rows[0].old_status; // internal — don't leak into the response
      // Audit the approval through the shared approvals table (§7).
      await db.query(
        `INSERT INTO approvals (type, payload_json, status, approved_by, approved_at)
              VALUES ($1, $2, 'approved', $3, now())`,
        [approvalType, JSON.stringify({ [`${approvalType}_id`]: req.params.id }), approvedBy],
      );
      // Approving a Protocol commits its supplement changes into the shared
      // `supplements` plan (atomic with the approval) — this is what feeds WF2
      // checkout summaries and WF4 refill projection with real data.
      if (table === 'protocols' && r.rows[0].client_id) {
        const appt = await db.query<{ starts_at: string | null }>(
          `SELECT starts_at FROM appointments WHERE id = $1`,
          [r.rows[0].appointment_id],
        );
        const startDate = appt.rows[0]?.starts_at
          ? new Date(appt.rows[0].starts_at).toISOString().slice(0, 10)
          : null;
        const sync = await syncClientSupplements(db, r.rows[0].client_id, startDate, r.rows[0].content_json);
        logEvent('info', 'review.protocol_sync', 'synced supplements from approved protocol', {
          id: req.params.id,
          ...sync,
        });
      }
      // The note's follow-ups become tracked tasks. Both the sheet and the protocol
      // carry the same follow_ups and either may be approved first, so this runs for
      // both and leans on the unique index to dedupe rather than picking a winner.
      if (r.rows[0].client_id) {
        const appt = await db.query<{ starts_at: string | null }>(
          `SELECT starts_at FROM appointments WHERE id = $1`,
          [r.rows[0].appointment_id],
        );
        const { created } = await createTasksFromNote(db, {
          clientId: r.rows[0].client_id,
          appointmentId: r.rows[0].appointment_id ?? null,
          sessionDate: appt.rows[0]?.starts_at ? new Date(appt.rows[0].starts_at) : new Date(),
          note: coerceSessionNote(r.rows[0].content_json),
        });
        if (created > 0) {
          logEvent('info', 'review.tasks', 'created tasks from approved follow-ups', {
            id: req.params.id,
            created,
          });
        }
      }
      await db.query('COMMIT');
      // WF1 final step: render + write to the client's Drive folder, off the
      // request path (best-effort; dry-run until Google OAuth is configured).
      void publishApproved(table, req.params.id).catch((err) =>
        logError(`review.${table}_publish`, 'Drive publish failed', err, { id: req.params.id }),
      );
      // Client-facing deliverables in Nicole's own templates (ROF/Supplement/Flow
      // Sheet) fire on the FIRST Protocol approval only — re-approval must not
      // append a second Flow Sheet block or a duplicate dated Supplement.
      if (table === 'protocols' && firstApproval) {
        void publishClientTemplates(req.params.id).catch((err) =>
          logError('review.protocol_templates', 'template publish failed', err, { id: req.params.id }),
        );
      }
      return res.json(r.rows[0]);
    } catch (err) {
      await db.query('ROLLBACK');
      logError(`review.${table}_approve`, 'approve failed', err, { id: req.params.id });
      return res.status(500).json({ error: 'internal error' });
    } finally {
      db.release();
    }
  };
}

// ---------------------------------------------------------------------------
// GET /review/:kind/:id/context — everything Nicole needs to compare this
// draft against what's already on file before she approves: the last
// APPROVED sheet/protocol for the same client (never a draft — a draft isn't
// yet her word), and the client's running supplement plan both as it stands
// now and as this draft would leave it (a pure preview; nothing is written).
// ---------------------------------------------------------------------------
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
reviewRouter.post('/sheets/:id/approve', approveOne('appointment_sheets', 'appointment_sheet'));
reviewRouter.get('/sheets/:id/context', contextOne('appointment_sheets'));
reviewRouter.post('/sheets/:id/amend', amendOne('appointment_sheets', 'appointment_sheet'));
reviewRouter.get('/sheets/:id/revisions', revisionsOne('appointment_sheets'));
reviewRouter.get('/sheets/:id/history', historyOne('appointment_sheets'));

// Protocols (client-facing)
reviewRouter.get('/protocols/:id', getOne('protocols'));
reviewRouter.patch('/protocols/:id', patchOne('protocols'));
reviewRouter.post('/protocols/:id/approve', approveOne('protocols', 'protocol'));
reviewRouter.get('/protocols/:id/context', contextOne('protocols'));
reviewRouter.post('/protocols/:id/amend', amendOne('protocols', 'protocol'));
reviewRouter.get('/protocols/:id/revisions', revisionsOne('protocols'));
reviewRouter.get('/protocols/:id/history', historyOne('protocols'));

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
