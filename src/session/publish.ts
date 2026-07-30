import { getDatabase } from '../db/index.js';
import { coerceSessionNote, renderAppointmentSheet, renderProtocol } from './render';
import { publishDocument, type PublishResult } from '../integrations/drive';

// WF1 final step: on approval, render the document and write it into the
// client's Drive folder. Reuses the same content/rendering as the /render
// routes. Best-effort — the caller fires this off the request path.
//
// Both collections key the document on the appointment id, so `id` here is the
// appointment id whichever kind is asked for.

type Kind = 'appointment_sheets' | 'protocols';

function fmtDate(v: unknown): string {
  if (!v) return 'n/a';
  const d = new Date(v as string);
  return Number.isNaN(d.getTime()) ? 'n/a' : d.toISOString().slice(0, 10);
}

export async function publishApproved(kind: Kind, id: string): Promise<PublishResult> {
  const db = getDatabase();
  const docs = await db.sessionNotes.findSessionDocs(id);
  const doc = kind === 'appointment_sheets' ? docs.sheet : docs.protocol;
  if (!doc) throw new Error(`${kind === 'appointment_sheets' ? 'appointment_sheet' : 'protocol'} ${id} not found`);

  const [client, appointment] = await Promise.all([
    doc.client_id ? db.clients.findById(doc.client_id) : Promise.resolve(null),
    db.appointments.findById(doc.appointment_id),
  ]);
  const clientName = client?.name ?? 'Unknown client';
  const date = fmtDate(appointment?.starts_at);
  const content = doc.content_json as Record<string, unknown> | null;

  const markdown =
    kind === 'appointment_sheets'
      ? renderAppointmentSheet(coerceSessionNote(content), {
          clientName,
          appointmentDate: date,
          billing: (content?.billing as never) ?? null, // stamped by WF2 checkout
        })
      : renderProtocol(coerceSessionNote(content), { clientName, appointmentDate: date });

  const result = await publishDocument({
    clientName,
    driveFolderId: client?.drive_folder_id ?? null,
    title: `${kind === 'appointment_sheets' ? 'Appointment Sheet' : 'Protocol'} — ${clientName} — ${date}`,
    markdown,
  });
  await persistFolderId(doc.client_id ?? null, client?.drive_folder_id ?? null, result.folderId);
  return result;
}

/** Remember the client's Drive folder id the first time we file for them, so
 *  future publishes address the folder by id (rename-proof) instead of by name. */
async function persistFolderId(
  clientId: string | null,
  existing: string | null,
  used: string | undefined,
): Promise<void> {
  if (!clientId || !used || used === existing) return;
  const db = getDatabase();
  const client = await db.clients.findById(clientId);
  // Re-read before writing: the `IS DISTINCT FROM` guard existed so a concurrent
  // publish that already filed the folder isn't overwritten with the same value
  // and a fresh updated_at.
  if (!client || client.drive_folder_id === used) return;
  await db.clients.save({ ...client, drive_folder_id: used, updated_at: new Date().toISOString() });
}
