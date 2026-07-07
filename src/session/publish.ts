import { pool } from '../db/pool';
import { coerceSessionNote, renderAppointmentSheet, renderProtocol } from './render';
import { publishDocument, type PublishResult } from '../integrations/drive';

// WF1 final step: on approval, render the document and write it into the
// client's Drive folder. Reuses the same content/rendering as the /render
// routes. Best-effort — the caller fires this off the request path.

type Kind = 'appointment_sheets' | 'protocols';

function fmtDate(v: unknown): string {
  if (!v) return 'n/a';
  const d = new Date(v as string);
  return Number.isNaN(d.getTime()) ? 'n/a' : d.toISOString().slice(0, 10);
}

export async function publishApproved(kind: Kind, id: string): Promise<PublishResult> {
  if (kind === 'appointment_sheets') {
    const r = await pool.query(
      `SELECT s.content_json, s.client_id, c.name AS client_name, c.drive_folder_id, a.starts_at
         FROM appointment_sheets s
         JOIN appointments a ON a.id = s.appointment_id
    LEFT JOIN clients c ON c.id = s.client_id
        WHERE s.id = $1`,
      [id],
    );
    if (r.rowCount === 0) throw new Error(`appointment_sheet ${id} not found`);
    const row = r.rows[0];
    const clientName = row.client_name ?? 'Unknown client';
    const date = fmtDate(row.starts_at);
    const markdown = renderAppointmentSheet(coerceSessionNote(row.content_json), {
      clientName,
      appointmentDate: date,
      billing: row.content_json?.billing ?? null, // stamped by WF2 checkout
    });
    const result = await publishDocument({
      clientName,
      driveFolderId: row.drive_folder_id,
      title: `Appointment Sheet — ${clientName} — ${date}`,
      markdown,
    });
    await persistFolderId(row.client_id, row.drive_folder_id, result.folderId);
    return result;
  }

  const r = await pool.query(
    `SELECT p.content_json, p.client_id, c.name AS client_name, c.drive_folder_id, a.starts_at
       FROM protocols p
  LEFT JOIN clients c ON c.id = p.client_id
  LEFT JOIN appointments a ON a.id = p.appointment_id
      WHERE p.id = $1`,
    [id],
  );
  if (r.rowCount === 0) throw new Error(`protocol ${id} not found`);
  const row = r.rows[0];
  const clientName = row.client_name ?? 'Unknown client';
  const date = fmtDate(row.starts_at);
  const markdown = renderProtocol(coerceSessionNote(row.content_json), { clientName, appointmentDate: date });
  const result = await publishDocument({
    clientName,
    driveFolderId: row.drive_folder_id,
    title: `Protocol — ${clientName} — ${date}`,
    markdown,
  });
  await persistFolderId(row.client_id, row.drive_folder_id, result.folderId);
  return result;
}

/** Remember the client's Drive folder id the first time we file for them, so
 *  future publishes address the folder by id (rename-proof) instead of by name. */
async function persistFolderId(clientId: string | null, existing: string | null, used: string | undefined): Promise<void> {
  if (!clientId || !used || used === existing) return;
  await pool.query(`UPDATE clients SET drive_folder_id = $2 WHERE id = $1 AND drive_folder_id IS DISTINCT FROM $2`, [clientId, used]);
}
