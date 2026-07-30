import { getDatabase } from '../db/index.js';
import { combineStatus } from '../db/sessionStatus.js';
import type { Approval, DocStatus } from '../db/interfaces/types.js';
import type { SessionDocs } from '../db/interfaces/repositories.js';
import { logEvent } from '../observability/logger';
import { coerceSessionNote } from './render';
import { syncClientSupplements, removeSupplementsDroppedByAmendment } from './supplements';
import { createTasksFromNote, reconcileTasksAfterAmend } from '../tasks/service';
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
// So every write goes through here and touches both documents together, inside
// one Firestore transaction (ISessionNotesRepository.guardedWrite). The two
// collections remain, because half the codebase keys off them, but they are now
// an implementation detail of a single record.
//
// What moved in the Firestore port: everything with a side effect. In Postgres
// the supplement sync and task creation ran INSIDE the approve transaction, so a
// failure rolled the approval back. A Firestore transaction is retried on
// contention, so anything non-idempotent inside it can run twice (§3.3) — and
// those two steps span an unbounded number of documents besides. They now run
// after the transaction commits, and are idempotent by key instead of atomic.
// The order matters: transact the status change first, so a crash between the
// two leaves an approved session with an unsynced plan (recoverable, visible)
// rather than a synced plan with no approval (invisible).

export interface SessionRow {
  appointment_id: string;
  client_id: string | null;
  client_name: string | null;
  starts_at: string | null;
  updated_at: string;
  /** Combined status — see combineStatus. */
  status: DocStatus;
  sheet_id: string | null;
  protocol_id: string | null;
  content_json: unknown;
}

export { combineStatus };

const EPOCH = '1970-01-01T00:00:00.000Z';

/**
 * Assemble the session row from an appointment and its two documents.
 *
 * Everything the SQL view got from a JOIN is either denormalized onto the
 * appointment (client_name, per §3.4) or read from the documents themselves.
 */
function toSession(
  appointment: { id: string; client_id: string | null; client_name?: string | null; starts_at: string },
  docs: SessionDocs,
): SessionRow {
  const { sheet, protocol } = docs;
  return {
    appointment_id: appointment.id,
    // The document's own client_id wins when set: an appointment can be
    // reassigned, and the note belongs to whoever it was extracted for.
    client_id: sheet?.client_id ?? protocol?.client_id ?? appointment.client_id ?? null,
    client_name: appointment.client_name ?? null,
    starts_at: appointment.starts_at ?? null,
    updated_at:
      (sheet?.updated_at ?? EPOCH) > (protocol?.updated_at ?? EPOCH)
        ? (sheet?.updated_at ?? EPOCH)
        : (protocol?.updated_at ?? EPOCH),
    status: combineStatus(sheet?.status ?? null, protocol?.status ?? null),
    sheet_id: sheet?.id ?? null,
    protocol_id: protocol?.id ?? null,
    // The sheet is the fuller record (it keeps assessments), so it is the
    // canonical copy when both exist.
    content_json: sheet?.content_json ?? protocol?.content_json ?? null,
  };
}

// When searching we scan a much larger window than the default page, so a name
// hit anywhere in the archive surfaces rather than only in the recent 100. A
// solo practice never approaches this many rows; it's a safety ceiling, not a page.
const SEARCH_SCAN_LIMIT = 2000;
/** Pending is a daily working set, so its scan window is wider than one page. */
const PENDING_SCAN_LIMIT = 500;

/**
 * Sessions awaiting review, or already approved. One row per appointment.
 *
 * `query` filters by client name. Firestore has no substring match (§3.5), and
 * the combined status is computed from two documents, so both filters run in
 * memory over a bounded scan of the newest appointments — which is what the SQL
 * did too, since neither predicate was expressible there either.
 *
 * The scan is one appointments query plus one batched getAll of the documents by
 * ref (§3.4), never a scan of the sheets or protocols collections.
 */
export async function listSessions(
  scope: 'pending' | 'approved',
  limit = 100,
  query?: string,
): Promise<SessionRow[]> {
  const db = getDatabase();
  const q = query?.trim().toLowerCase();
  const scanLimit = q ? SEARCH_SCAN_LIMIT : scope === 'approved' ? limit : PENDING_SCAN_LIMIT;

  const appointments = await db.appointments.listRecent(scanLimit);
  // A name search shouldn't match sessions with no client attached.
  const candidates = q
    ? appointments.filter((a) => (a.client_name ?? '').toLowerCase().includes(q))
    : appointments;
  if (candidates.length === 0) return [];

  const docsById = await db.sessionNotes.findManySessionDocs(candidates.map((a) => a.id));

  const rows: SessionRow[] = [];
  for (const appointment of candidates) {
    const docs = docsById.get(appointment.id);
    // Only appointments that actually have a session — the `s.id IS NOT NULL OR
    // p.id IS NOT NULL` guard.
    if (!docs || (!docs.sheet && !docs.protocol)) continue;
    rows.push(toSession(appointment, docs));
  }

  const filtered =
    scope === 'approved'
      ? rows.filter((x) => x.status === 'approved')
      : rows.filter((x) => x.status !== 'approved');

  // listRecent is already newest-first; the display cap is the last step so the
  // pending scan can look past 500 approved sessions to find one stuck draft.
  return filtered.slice(0, q && scope === 'approved' ? SEARCH_SCAN_LIMIT : limit);
}

export async function getSession(appointmentId: string): Promise<SessionRow | null> {
  const db = getDatabase();
  const [appointment, docs] = await Promise.all([
    db.appointments.findById(appointmentId),
    db.sessionNotes.findSessionDocs(appointmentId),
  ]);
  if (!appointment) return null;
  if (!docs.sheet && !docs.protocol) return null;
  return toSession(appointment, docs);
}

/**
 * Resolve a legacy sheet/protocol id to the session it belongs to.
 *
 * Both collections key the document on the appointment id, so this is now the
 * identity function — kept because callers still pass ids around by table.
 */
export async function appointmentForItem(
  table: 'appointment_sheets' | 'protocols',
  id: string,
): Promise<string | null> {
  const docs = await getDatabase().sessionNotes.findSessionDocs(id);
  const doc = table === 'appointment_sheets' ? docs.sheet : docs.protocol;
  return doc?.appointment_id ?? null;
}

export type SessionOutcome =
  | { ok: true; session: SessionRow; firstApproval?: boolean; revision?: number }
  | { ok: false; code: number; error: string; detail?: string };

let approvalSeq = 0;
const approvalId = (kind: string): string =>
  `approval_${kind}_${Date.now().toString(36)}_${(approvalSeq++).toString(36)}`;

/** Edit a session's note. Refused once approved — that needs an amendment. */
export async function patchSession(
  appointmentId: string,
  note: unknown,
): Promise<SessionOutcome> {
  const res = await getDatabase().sessionNotes.guardedWrite({
    appointmentId,
    expect: ['draft', 'in_review'],
    content: note as Record<string, unknown>,
  });
  if (!res.ok) {
    if (res.reason === 'not_found') return { ok: false, code: 404, error: 'not found' };
    return {
      ok: false,
      code: 409,
      error: 'already approved',
      detail:
        'This session has been approved and its documents published. Use amend to correct it.',
    };
  }
  return { ok: true, session: (await getSession(appointmentId))! };
}

/**
 * Approve the whole session: both documents, one approval record, one supplement
 * sync, one set of tasks. Publishing is left to the caller so it stays off the
 * request path.
 */
export async function approveSession(
  appointmentId: string,
  approvedBy: string,
): Promise<SessionOutcome> {
  const db = getDatabase();

  // Read the appointment for the fields the side effects need. It is read
  // OUTSIDE the guarded write on purpose: the write's job is the compare-and-set
  // on the documents, and pulling an unrelated document into the transaction
  // would widen its contention footprint for nothing.
  const appointment = await db.appointments.findById(appointmentId);

  const approval: Approval = {
    id: approvalId('session'),
    appointment_id: appointmentId,
    type: 'session',
    payload_json: {
      appointment_id: appointmentId,
      appointment_sheet_id: appointmentId,
      protocol_id: appointmentId,
    },
    status: 'approved',
    approved_by: approvedBy,
    approved_at: new Date().toISOString(),
    created_at: new Date().toISOString(),
  };

  // Approving twice would file a second approval and replay the side effects.
  // The UI never offers it, but the API must refuse it too — "one approval per
  // session" is an invariant, not a convention. `expect` is the compare-and-set
  // that enforces it under concurrency, not just a read-then-check.
  const res = await db.sessionNotes.guardedWrite({
    appointmentId,
    expect: ['draft', 'in_review'],
    status: 'approved',
    approval,
  });
  if (!res.ok) {
    if (res.reason === 'not_found') return { ok: false, code: 404, error: 'not found' };
    return {
      ok: false,
      code: 409,
      error: 'already approved',
      detail: 'This session is already approved. Use amend to correct it.',
    };
  }

  const before = res.before;
  const clientId = before.sheet?.client_id ?? before.protocol?.client_id ?? null;
  const contentJson = before.sheet?.content_json ?? before.protocol?.content_json ?? null;
  const startsAt = appointment?.starts_at ?? null;

  if (clientId) {
    const startDate = startsAt ? new Date(startsAt).toISOString().slice(0, 10) : null;
    const sync = await syncClientSupplements(clientId, startDate, contentJson);
    const { created } = await createTasksFromNote({
      clientId,
      appointmentId,
      sessionDate: startsAt ? new Date(startsAt) : new Date(),
      note: coerceSessionNote(contentJson),
    });
    logEvent('info', 'session.approve', 'approved session', {
      appointment_id: appointmentId,
      ...sync,
      tasks_created: created,
    });
  }

  await recordAudit({
    entityType: 'session',
    entityId: appointmentId,
    action: 'session.approved',
    actor: approvedBy === 'nicole' ? 'nicole' : 'system',
    summary: `Approved session for ${appointment?.client_name ?? 'unknown client'} — documents published`,
    metadata: { client_id: clientId, approved_by: approvedBy },
  });

  return { ok: true, session: (await getSession(appointmentId))!, firstApproval: true };
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
  const db = getDatabase();
  const appointment = await db.appointments.findById(appointmentId);

  const approval: Approval = {
    id: approvalId('amend'),
    appointment_id: appointmentId,
    type: 'session',
    payload_json: {
      appointment_id: appointmentId,
      appointment_sheet_id: appointmentId,
      protocol_id: appointmentId,
      reason,
    },
    status: 'amended',
    approved_by: amendedBy,
    approved_at: new Date().toISOString(),
    created_at: new Date().toISOString(),
  };

  // One transaction: snapshot the superseded content into note_revisions, write
  // the new content to both documents, bump the revision counter, and file the
  // amendment's approval. A crash anywhere in there leaves the record exactly as
  // it was — never a live row whose history is missing the version it replaced.
  const res = await db.sessionNotes.guardedWrite({
    appointmentId,
    expect: ['approved'],
    content: note as Record<string, unknown>,
    snapshotRevision: { reason },
    approval,
  });
  if (!res.ok) {
    if (res.reason === 'not_found') return { ok: false, code: 404, error: 'not found' };
    return {
      ok: false,
      code: 409,
      error: 'not approved',
      detail: 'Only an approved session is amended. Edit this one directly instead.',
    };
  }

  const revision = res.revision;
  // The approval records which version it superseded. It is patched rather than
  // pre-filled because the number is only known inside the transaction.
  await db.sessionNotes.saveApproval({
    ...approval,
    payload_json: { ...approval.payload_json, revision },
  });

  const before = res.before;
  const clientId = before.sheet?.client_id ?? before.protocol?.client_id ?? null;
  const supersededContent = before.sheet?.content_json ?? before.protocol?.content_json ?? null;
  const startsAt = appointment?.starts_at ?? null;

  if (clientId) {
    const startDate = startsAt ? new Date(startsAt).toISOString().slice(0, 10) : null;
    await syncClientSupplements(clientId, startDate, note);
    await removeSupplementsDroppedByAmendment(clientId, supersededContent, note);
    // Follow-ups changed too: create tasks the amendment added, dismiss open
    // ones it removed. Supplements and tasks move together or the prep brief
    // keeps briefing from the superseded note.
    await reconcileTasksAfterAmend({
      clientId,
      appointmentId,
      sessionDate: startsAt ? new Date(startsAt) : new Date(),
      note: coerceSessionNote(note),
    });
  }

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
    metadata: { revision, reason, client_id: clientId, amended_by: amendedBy },
  });

  return { ok: true, session: (await getSession(appointmentId))!, revision };
}
