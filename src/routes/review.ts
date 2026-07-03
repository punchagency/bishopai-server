import { Router } from 'express';
import { z } from 'zod';
import { pool } from '../db/pool';
import { logError } from '../observability/logger';
import { coerceSessionNote, renderAppointmentSheet, renderProtocol } from '../session/render';
import { processConversation } from '../session/process';
import { publishApproved } from '../session/publish';

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

const isUuid = (id: string) => z.uuid().safeParse(id).success;

function fmtDate(v: unknown): string {
  if (!v) return 'n/a';
  const d = new Date(v as string);
  return Number.isNaN(d.getTime()) ? 'n/a' : d.toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------
// GET /review/queue — everything awaiting Nicole (draft + in_review).
// ---------------------------------------------------------------------------
reviewRouter.get('/queue', async (_req, res) => {
  try {
    const sheets = await pool.query(
      `SELECT s.id, s.status, s.content_json, s.updated_at,
              a.id AS appointment_id, a.starts_at, a.ends_at,
              c.id AS client_id, c.name AS client_name
         FROM appointment_sheets s
         JOIN appointments a ON a.id = s.appointment_id
    LEFT JOIN clients c ON c.id = s.client_id
        WHERE s.status IN ('draft', 'in_review')
     ORDER BY a.starts_at DESC`,
    );
    const protocols = await pool.query(
      `SELECT p.id, p.status, p.content_json, p.updated_at, p.appointment_id,
              c.id AS client_id, c.name AS client_name
         FROM protocols p
    LEFT JOIN clients c ON c.id = p.client_id
        WHERE p.status IN ('draft', 'in_review')
     ORDER BY p.updated_at DESC`,
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

function approveOne(table: Table, approvalType: string) {
  return async (req: import('express').Request, res: import('express').Response) => {
    if (!isUuid(req.params.id)) return res.status(404).json({ error: 'not found' });
    const parsedBody = approveSchema.safeParse(req.body ?? {});
    const approvedBy = (parsedBody.success && parsedBody.data.approved_by) || 'nicole';

    const db = await pool.connect();
    try {
      await db.query('BEGIN');
      const r = await db.query(
        `UPDATE ${table} SET status = 'approved' WHERE id = $1 RETURNING *`,
        [req.params.id],
      );
      if (r.rowCount === 0) {
        await db.query('ROLLBACK');
        return res.status(404).json({ error: 'not found' });
      }
      // Audit the approval through the shared approvals table (§7).
      await db.query(
        `INSERT INTO approvals (type, payload_json, status, approved_by, approved_at)
              VALUES ($1, $2, 'approved', $3, now())`,
        [approvalType, JSON.stringify({ [`${approvalType}_id`]: req.params.id }), approvedBy],
      );
      await db.query('COMMIT');
      // WF1 final step: render + write to the client's Drive folder, off the
      // request path (best-effort; dry-run until Google OAuth is configured).
      void publishApproved(table, req.params.id).catch((err) =>
        logError(`review.${table}_publish`, 'Drive publish failed', err, { id: req.params.id }),
      );
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

// Appointment Sheets (internal)
reviewRouter.get('/sheets/:id', getOne('appointment_sheets'));
reviewRouter.patch('/sheets/:id', patchOne('appointment_sheets'));
reviewRouter.post('/sheets/:id/approve', approveOne('appointment_sheets', 'appointment_sheet'));

// Protocols (client-facing)
reviewRouter.get('/protocols/:id', getOne('protocols'));
reviewRouter.patch('/protocols/:id', patchOne('protocols'));
reviewRouter.post('/protocols/:id/approve', approveOne('protocols', 'protocol'));

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
