import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pool } from '../db/pool';
import { logEvent, logError } from '../observability/logger';
import { sendEmail } from '../integrations/outlook';
import { coerceSessionNote } from './render';
import { toRofData, toSupplementData, toFlowSheetEntry } from './templateData';
import { fillRof } from '../integrations/docs/rof';
import { fillSupplementProtocol } from '../integrations/docs/supplement';
import type { FlowSheetEntry } from '../integrations/docs/types';
import type { SessionNote } from './extract';
import {
  publishBinaryDoc,
  publishFlowSheet,
  resolveDocFolder,
  ensureConvertedSheet,
  isDriveConfigured,
  isDemoMode,
  driveConfig,
  DOCX_MIME,
  XLSX_MIME,
} from '../integrations/drive';

// WF1 client-facing deliverables in Nicole's own templates, published on Protocol
// approval alongside the Markdown docs. Three docs, three update models:
//   ROF (docx)        — fill-once at intake; skip if one already exists.
//   Supplement (xlsx) — a new date-versioned file each time.
//   Flow Sheet (Sheet)— append one block to the client's native Google Sheet.
// Best-effort, off the request path; dry-run until Google OAuth is configured.

const FLOW_TEMPLATE = join(__dirname, '../../assets/templates/appointment-flow-sheet.xlsx');

/** Human date for inside the docs, e.g. "July 9, 2026". */
function displayDate(v: unknown): string {
  const d = v ? new Date(v as string) : null;
  return d && !Number.isNaN(d.getTime())
    ? d.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })
    : 'n/a';
}

/** Date stamp for the versioned Supplement filename, matching Nicole's "7_9_26". */
function fileStamp(v: unknown): string {
  const d = v ? new Date(v as string) : null;
  if (!d || Number.isNaN(d.getTime())) return 'undated';
  return `${d.getMonth() + 1}_${d.getDate()}_${String(d.getFullYear()).slice(2)}`;
}

export interface RenderedTemplates {
  rof: Buffer;
  supplement: Buffer;
  supplementFileName: string;
  flowEntry: FlowSheetEntry;
}

/**
 * Pure render of all three templates from a note — no Drive, no DB, so it's
 * offline-testable. Async because the xlsx fill (exceljs) is async.
 */
export async function renderClientTemplates(
  note: SessionNote,
  ctx: { clientName: string; date: unknown },
): Promise<RenderedTemplates> {
  const display = displayDate(ctx.date);
  const supplement = await fillSupplementProtocol(toSupplementData(note));
  return {
    rof: fillRof(toRofData(note, { name: ctx.clientName, date: display })),
    supplement,
    supplementFileName: `Supplement Protocol ${fileStamp(ctx.date)}.xlsx`,
    flowEntry: toFlowSheetEntry(note, { date: display }),
  };
}

export interface ClientTemplatesResult {
  dryRun?: boolean;
  rofFileId?: string;
  rofSkipped?: boolean;
  supplementFileId?: string;
  flowSheetId?: string | null;
  flowBlock?: number;
  emailed?: boolean;
}

/**
 * Emailing a client their filled protocol sends clinical documents out of the
 * practice, so it stays OFF unless Nicole turns it on — approving a protocol in the
 * cockpit is an internal review step, not consent to mail the client. Set
 * EMAIL_PROTOCOL_TO_CLIENT=true to enable. (Sends are still dry-run until Outlook
 * is connected, so enabling it early is safe.)
 */
const emailToClientEnabled = (): boolean => process.env.EMAIL_PROTOCOL_TO_CLIENT === 'true';

/**
 * Mail the client their filled documents as attachments: the Supplement Protocol
 * every time, plus the ROF on the intake session that created it. Best-effort — a
 * mail failure must not fail the publish (the docs are already in Drive).
 */
async function emailTemplatesToClient(
  to: string,
  clientName: string,
  rendered: RenderedTemplates,
  opts: { includeRof: boolean },
): Promise<boolean> {
  const attachments = [
    {
      name: rendered.supplementFileName,
      content: rendered.supplement,
      contentType: XLSX_MIME,
    },
  ];
  if (opts.includeRof) {
    attachments.unshift({ name: 'ROF.docx', content: rendered.rof, contentType: DOCX_MIME });
  }

  const firstName = clientName.split(/\s+/)[0];
  const res = await sendEmail({
    to,
    subject: `Your updated protocol from Innerlume`,
    body: [
      `Hi ${firstName},`,
      '',
      'Your updated protocol from our session is attached.',
      opts.includeRof ? 'Your Report of Findings is attached as well.' : '',
      '',
      'Reach out any time with questions.',
      '',
      'Nicole',
    ]
      .filter((l, i, a) => l !== '' || a[i - 1] !== '') // collapse the blank left by an omitted line
      .join('\n'),
    attachments,
  });

  if (!res.ok) {
    logError('session.templates_email', 'failed to email templates to client', new Error(res.error ?? 'unknown'));
    return false;
  }
  logEvent('info', 'session.templates_email', res.dryRun ? '[dry-run] would email templates' : 'emailed templates', {
    client: clientName,
    attachments: attachments.map((a) => a.name),
  });
  return true;
}

/**
 * Render and publish Nicole's three client templates for an approved protocol.
 * Provisions the client's Flow Sheet (xlsx → native Google Sheet) on first use
 * and remembers its id. Best-effort: logs and returns partial results on failure
 * of any one doc rather than throwing (it runs off the request path).
 */
export async function publishClientTemplates(protocolId: string): Promise<ClientTemplatesResult> {
  const r = await pool.query(
    `SELECT p.content_json, p.client_id, c.name AS client_name, c.email AS client_email,
            c.drive_folder_id, c.flow_sheet_id, a.starts_at
       FROM protocols p
  LEFT JOIN clients c ON c.id = p.client_id
  LEFT JOIN appointments a ON a.id = p.appointment_id
      WHERE p.id = $1`,
    [protocolId],
  );
  if (r.rowCount === 0) throw new Error(`protocol ${protocolId} not found`);
  const row = r.rows[0];
  const clientName: string = row.client_name ?? 'Unknown client';
  const note = coerceSessionNote(row.content_json);
  const rendered = await renderClientTemplates(note, { clientName, date: row.starts_at });

  const result: ClientTemplatesResult = {};

  // ROF — fill-once at intake.
  const rof = await publishBinaryDoc({
    clientName,
    driveFolderId: row.drive_folder_id,
    docType: 'ROF',
    fileName: 'ROF.docx',
    bytes: rendered.rof,
    mimeType: DOCX_MIME,
    skipIfExists: true,
  });
  result.dryRun = rof.dryRun;
  result.rofFileId = rof.fileId;
  result.rofSkipped = rof.skipped;
  let clientFolderId = rof.clientFolderId ?? row.drive_folder_id ?? null;

  // Supplement Protocol — new dated version each time.
  const supp = await publishBinaryDoc({
    clientName,
    driveFolderId: clientFolderId,
    docType: 'SupplementProtocol',
    fileName: rendered.supplementFileName,
    bytes: rendered.supplement,
    mimeType: XLSX_MIME,
  });
  result.supplementFileId = supp.fileId;
  clientFolderId = supp.clientFolderId ?? clientFolderId;

  // Flow Sheet — provision once (xlsx → Google Sheet), then append a block. In
  // demo mode we skip real provisioning; publishFlowSheet writes a local xlsx.
  let flowSheetId: string | null = row.flow_sheet_id ?? null;
  if (isDriveConfigured() && !isDemoMode() && !flowSheetId) {
    const { folderId, clientFolderId: cfid } = await resolveDocFolder(clientName, 'AppointmentFlowSheet', {
      clientFolderId,
      rootFolderId: driveConfig().rootFolderId,
    });
    clientFolderId = cfid;
    const sheet = await ensureConvertedSheet(folderId, `${clientName} Appointment Flow Sheet`, readFileSync(FLOW_TEMPLATE));
    flowSheetId = sheet.id;
    logEvent('info', 'session.flowsheet_provision', 'provisioned client Flow Sheet', {
      client: clientName,
      spreadsheetId: flowSheetId,
      created: sheet.created,
    });
  }
  const flow = await publishFlowSheet({
    clientName,
    spreadsheetId: flowSheetId ?? 'unprovisioned',
    entry: rendered.flowEntry,
  });
  result.flowSheetId = flowSheetId;
  result.flowBlock = flow.blockIndex;

  // Optionally mail the client their filled docs (off unless Nicole enables it).
  // The ROF rides along only on the session that actually created it.
  if (emailToClientEnabled() && row.client_email) {
    result.emailed = await emailTemplatesToClient(row.client_email, clientName, rendered, {
      includeRof: !rof.skipped,
    });
  }

  // Persist the folder + sheet ids we learned, so we don't re-provision next time.
  await persistIds(row.client_id, { driveFolderId: clientFolderId, flowSheetId });
  return result;
}

async function persistIds(
  clientId: string | null,
  ids: { driveFolderId: string | null; flowSheetId: string | null },
): Promise<void> {
  if (!clientId) return;
  await pool.query(
    `UPDATE clients
        SET drive_folder_id = COALESCE($2, drive_folder_id),
            flow_sheet_id   = COALESCE($3, flow_sheet_id)
      WHERE id = $1
        AND (drive_folder_id IS DISTINCT FROM COALESCE($2, drive_folder_id)
          OR flow_sheet_id   IS DISTINCT FROM COALESCE($3, flow_sheet_id))`,
    [clientId, ids.driveFolderId, ids.flowSheetId],
  );
}
