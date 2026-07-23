import type { PoolClient } from 'pg';
import { pool } from '../db/pool';
import { logEvent } from '../observability/logger';
import { coerceSessionNote } from './render';
import { syncClientSupplements, removeSupplementsDroppedByAmendment } from './supplements';
import { createTasksFromNote, reconcileTasksAfterAmend } from '../tasks/service';
import { snapshotRevision } from './revisions';
import { recordAudit } from '../audit/log';

// A session is ONE clinical note, not two documents.
//
// `appointment_sheets` and `protocols` hold byte-identical content_json —
// processConversation writes the same note to both. They differ only in how they
// RENDER: the sheet keeps the practitioner's assessments, the protocol is the
// client-facing plan. Nothing ever writes different content to them deliberately.
//
// Treating them as two independently editable, independently approvable records
// made divergence reachable, and different consumers read different copies:
// client documents (ROF / Supplement / Flow Sheet) build from the PROTOCOL, while
// the prep brief reads the SHEET. Editing one and approving it left the other
// stale, so a correction could reach Nicole's brief but never the client's
// documents — silently, with both rows claiming to be the same session.
//
// So every write goes through here and touches both rows together. The two
// tables remain, because half the codebase keys off them, but they are now an
// implementation detail of a single record.

export interface SessionRow {
  appointment_id: string;
  client_id: string | null;
  client_name: string | null;
  starts_at: string | null;
  updated_at: string;
  /** Combined status — see combineStatus. */
  status: 'draft' | 'in_review' | 'approved';
  sheet_id: string | null;
  protocol_id: string | null;
  content_json: unknown;
}

/**
 * One status for the session.
 *
 * A session counts as approved only when every document it actually has is
 * approved. A session with no protocol (no client attached yet) is decided by
 * its sheet alone — "both approved" would be unreachable for it.
 */
export function combineStatus(
  sheet: string | null,
  protocol: string | null,
): 'draft' | 'in_review' | 'approved' {
  const present = [sheet, protocol].filter(Boolean) as string[];
  if (present.length === 0) return 'draft';
  if (present.every((s) => s === 'approved')) return 'approved';
  if (present.some((s) => s === 'in_review')) return 'in_review';
  return 'draft';
}

const SESSION_SELECT = `
  SELECT a.id   AS appointment_id,
         a.starts_at,
         c.id   AS client_id,
         c.name AS client_name,
         s.id   AS sheet_id,
         p.id   AS protocol_id,
         s.status AS sheet_status,
         p.status AS protocol_status,
         -- The sheet is the fuller record (it keeps assessments), so it is the
         -- canonical copy when both exist.
         COALESCE(s.content_json, p.content_json) AS content_json,
         GREATEST(COALESCE(s.updated_at, 'epoch'::timestamptz),
                  COALESCE(p.updated_at, 'epoch'::timestamptz)) AS updated_at
    FROM appointments a
    LEFT JOIN appointment_sheets s ON s.appointment_id = a.id
    LEFT JOIN protocols p          ON p.appointment_id = a.id
    LEFT JOIN clients c            ON c.id = a.client_id`;

interface RawSession {
  appointment_id: string;
  starts_at: string | null;
  client_id: string | null;
  client_name: string | null;
  sheet_id: string | null;
  protocol_id: string | null;
  sheet_status: string | null;
  protocol_status: string | null;
  content_json: unknown;
  updated_at: string;
}

const toSession = (r: RawSession): SessionRow => ({
  appointment_id: r.appointment_id,
  client_id: r.client_id,
  client_name: r.client_name,
  starts_at: r.starts_at,
  updated_at: r.updated_at,
  status: combineStatus(r.sheet_status, r.protocol_status),
  sheet_id: r.sheet_id,
  protocol_id: r.protocol_id,
  content_json: r.content_json,
});

/** Escape LIKE wildcards so a client name with % or _ is matched literally. */
function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

// When searching we scan a much larger window than the default page, so a name
// hit anywhere in the archive surfaces rather than only in the recent 100. A
// solo practice never approaches this many rows; it's a safety ceiling, not a page.
const SEARCH_SCAN_LIMIT = 2000;

/**
 * Sessions awaiting review, or already approved. One row per appointment.
 *
 * `query` filters by client name. Status is combined from two documents in JS,
 * so it can't be a SQL WHERE — but the name filter can, which is what lets an
 * approved-archive search reach past the default cap: with a query we widen the
 * SQL scan and only then apply the status filter and the display limit.
 */
export async function listSessions(
  scope: 'pending' | 'approved',
  limit = 100,
  query?: string,
): Promise<SessionRow[]> {
  const q = query?.trim();
  const params: unknown[] = [];
  let nameClause = '';
  if (q) {
    params.push(`%${escapeLike(q)}%`);
    // A name search shouldn't match sessions with no client attached.
    nameClause = ` AND c.name ILIKE $${params.length}`;
  }
  // Pending is a daily working set; approved is capped unless a query widens it.
  const scanLimit = q ? SEARCH_SCAN_LIMIT : scope === 'approved' ? limit : 500;
  params.push(scanLimit);

  // The combined status lives in JS, but "every present document approved" is
  // expressible in SQL — so the pending scan excludes fully-approved sessions
  // up front. Without this, the newest-500 window silently hid any stuck draft
  // older than the last 500 sessions: exactly the row most likely to be old.
  const pendingClause =
    scope === 'pending'
      ? ` AND NOT ((s.id IS NULL OR s.status = 'approved') AND (p.id IS NULL OR p.status = 'approved'))`
      : '';

  const r = await pool.query<RawSession>(
    `${SESSION_SELECT}
      WHERE (s.id IS NOT NULL OR p.id IS NOT NULL)${nameClause}${pendingClause}
   ORDER BY a.starts_at DESC
      LIMIT $${params.length}`,
    params,
  );
  const all = r.rows.map(toSession);
  const wanted = scope === 'approved' ? 'approved' : null;
  const filtered = all.filter((x) => (wanted ? x.status === 'approved' : x.status !== 'approved'));
  return scope === 'approved' ? filtered.slice(0, q ? SEARCH_SCAN_LIMIT : limit) : filtered;
}

export async function getSession(appointmentId: string): Promise<SessionRow | null> {
  const r = await pool.query<RawSession>(`${SESSION_SELECT} WHERE a.id = $1`, [appointmentId]);
  return r.rowCount ? toSession(r.rows[0]) : null;
}

/** Resolve a legacy sheet/protocol id to the session it belongs to. */
export async function appointmentForItem(
  table: 'appointment_sheets' | 'protocols',
  id: string,
): Promise<string | null> {
  const r = await pool.query<{ appointment_id: string | null }>(
    `SELECT appointment_id FROM ${table} WHERE id = $1`,
    [id],
  );
  return r.rows[0]?.appointment_id ?? null;
}

/** Write the note to BOTH documents, so they can never disagree. */
async function writeBoth(db: PoolClient, appointmentId: string, note: unknown): Promise<void> {
  const json = JSON.stringify(note);
  await db.query(`UPDATE appointment_sheets SET content_json = $2 WHERE appointment_id = $1`, [
    appointmentId,
    json,
  ]);
  await db.query(`UPDATE protocols SET content_json = $2 WHERE appointment_id = $1`, [
    appointmentId,
    json,
  ]);
}

export type SessionOutcome =
  | { ok: true; session: SessionRow; firstApproval?: boolean; revision?: number }
  | { ok: false; code: number; error: string; detail?: string };

/** Edit a session's note. Refused once approved — that needs an amendment. */
export async function patchSession(
  appointmentId: string,
  note: unknown,
): Promise<SessionOutcome> {
  const db = await pool.connect();
  try {
    await db.query('BEGIN');
    const cur = await lockSession(db, appointmentId);
    if (!cur) {
      await db.query('ROLLBACK');
      return { ok: false, code: 404, error: 'not found' };
    }
    if (cur.status === 'approved') {
      await db.query('ROLLBACK');
      return {
        ok: false,
        code: 409,
        error: 'already approved',
        detail: 'This session has been approved and its documents published. Use amend to correct it.',
      };
    }
    await writeBoth(db, appointmentId, note);
    await db.query('COMMIT');
    return { ok: true, session: (await getSession(appointmentId))! };
  } catch (err) {
    await db.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    db.release();
  }
}

async function lockSession(db: PoolClient, appointmentId: string): Promise<SessionRow | null> {
  // Lock both documents up front so a concurrent approve can't half-apply.
  await db.query(`SELECT id FROM appointment_sheets WHERE appointment_id = $1 FOR UPDATE`, [
    appointmentId,
  ]);
  await db.query(`SELECT id FROM protocols WHERE appointment_id = $1 FOR UPDATE`, [appointmentId]);
  const r = await db.query<RawSession>(`${SESSION_SELECT} WHERE a.id = $1`, [appointmentId]);
  return r.rowCount ? toSession(r.rows[0]) : null;
}

/**
 * Approve the whole session: both documents, one audit entry, one supplement
 * sync, one set of tasks. Publishing is left to the caller so it stays off the
 * request path.
 */
export async function approveSession(
  appointmentId: string,
  approvedBy: string,
): Promise<SessionOutcome> {
  const db = await pool.connect();
  try {
    await db.query('BEGIN');
    const cur = await lockSession(db, appointmentId);
    if (!cur) {
      await db.query('ROLLBACK');
      return { ok: false, code: 404, error: 'not found' };
    }
    // Approving twice would insert a second audit row and replay the side
    // effects. The UI never offers it, but the API must refuse it too — "one
    // approval per session" is an invariant, not a convention.
    if (cur.status === 'approved') {
      await db.query('ROLLBACK');
      return {
        ok: false,
        code: 409,
        error: 'already approved',
        detail: 'This session is already approved. Use amend to correct it.',
      };
    }
    const firstApproval = true;

    await db.query(
      `UPDATE appointment_sheets SET status = 'approved' WHERE appointment_id = $1`,
      [appointmentId],
    );
    await db.query(`UPDATE protocols SET status = 'approved' WHERE appointment_id = $1`, [
      appointmentId,
    ]);

    await db.query(
      `INSERT INTO approvals (type, payload_json, status, approved_by, approved_at)
            VALUES ('session', $1, 'approved', $2, now())`,
      [
        JSON.stringify({
          appointment_id: appointmentId,
          appointment_sheet_id: cur.sheet_id,
          protocol_id: cur.protocol_id,
        }),
        approvedBy,
      ],
    );

    const note = coerceSessionNote(cur.content_json);
    const startDate = cur.starts_at ? new Date(cur.starts_at).toISOString().slice(0, 10) : null;

    if (cur.client_id) {
      const sync = await syncClientSupplements(db, cur.client_id, startDate, cur.content_json);
      const { created } = await createTasksFromNote(db, {
        clientId: cur.client_id,
        appointmentId,
        sessionDate: cur.starts_at ? new Date(cur.starts_at) : new Date(),
        note,
      });
      logEvent('info', 'session.approve', 'approved session', {
        appointment_id: appointmentId,
        ...sync,
        tasks_created: created,
      });
    }

    await db.query('COMMIT');
    await recordAudit({
      entityType: 'session',
      entityId: appointmentId,
      action: 'session.approved',
      actor: approvedBy === 'nicole' ? 'nicole' : 'system',
      summary: `Approved session for ${cur.client_name ?? 'unknown client'} — documents published`,
      metadata: { client_id: cur.client_id, approved_by: approvedBy },
    });
    return { ok: true, session: (await getSession(appointmentId))!, firstApproval };
  } catch (err) {
    await db.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    db.release();
  }
}

/**
 * Correct an approved session. Files the superseded note against BOTH documents
 * so either one's history is complete, then re-syncs the plan.
 */
export async function amendSession(
  appointmentId: string,
  note: unknown,
  reason: string | null,
  amendedBy: string,
): Promise<SessionOutcome> {
  const db = await pool.connect();
  try {
    await db.query('BEGIN');
    const cur = await lockSession(db, appointmentId);
    if (!cur) {
      await db.query('ROLLBACK');
      return { ok: false, code: 404, error: 'not found' };
    }
    if (cur.status !== 'approved') {
      await db.query('ROLLBACK');
      return {
        ok: false,
        code: 409,
        error: 'not approved',
        detail: 'Only an approved session is amended. Edit this one directly instead.',
      };
    }

    let revision = 1;
    if (cur.sheet_id) {
      revision = await snapshotRevision(db, 'appointment_sheets', cur.sheet_id, cur.content_json, reason);
    }
    if (cur.protocol_id) {
      revision = await snapshotRevision(db, 'protocols', cur.protocol_id, cur.content_json, reason);
    }

    await writeBoth(db, appointmentId, note);

    await db.query(
      `INSERT INTO approvals (type, payload_json, status, approved_by, approved_at)
            VALUES ('session', $1, 'amended', $2, now())`,
      [
        JSON.stringify({
          appointment_id: appointmentId,
          appointment_sheet_id: cur.sheet_id,
          protocol_id: cur.protocol_id,
          revision,
          reason,
        }),
        amendedBy,
      ],
    );

    if (cur.client_id) {
      const startDate = cur.starts_at ? new Date(cur.starts_at).toISOString().slice(0, 10) : null;
      await syncClientSupplements(db, cur.client_id, startDate, note);
      await removeSupplementsDroppedByAmendment(db, cur.client_id, cur.content_json, note);
      // Follow-ups changed too: create tasks the amendment added, dismiss open
      // ones it removed. Supplements and tasks move together or the prep brief
      // keeps briefing from the superseded note.
      await reconcileTasksAfterAmend(db, {
        clientId: cur.client_id,
        appointmentId,
        sessionDate: cur.starts_at ? new Date(cur.starts_at) : new Date(),
        note: coerceSessionNote(note),
      });
    }

    await db.query('COMMIT');
    logEvent('info', 'session.amend', 'amended an approved session', {
      appointment_id: appointmentId,
      revision,
      amendedBy,
    });
    await recordAudit({
      entityType: 'session',
      entityId: appointmentId,
      action: 'session.amended',
      actor: amendedBy === 'nicole' ? 'nicole' : 'system',
      summary: `Amended approved session (v${revision})${reason ? ` — ${reason}` : ''}`,
      metadata: { revision, reason, client_id: cur.client_id, amended_by: amendedBy },
    });
    return { ok: true, session: (await getSession(appointmentId))!, revision };
  } catch (err) {
    await db.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    db.release();
  }
}
