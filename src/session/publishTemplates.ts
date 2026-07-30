import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { getDatabase } from '../db/index.js';
import type { Client, SupplementProtocol } from '../db/interfaces/types.js';
import { logEvent, logError } from '../observability/logger';
import { sendEmail } from '../integrations/outlook';
import { coerceSessionNote } from './render';
import { toRofData, toSupplementData, toFlowSheetEntry } from './templateData';
import { fillRof } from '../integrations/docs/rof';
import { fillSupplementProtocol } from '../integrations/docs/supplement';
import { buildFlowSheetXlsx } from '../integrations/docs/flowsheetWorkbook';
import { fetchCurrentSupplements, type CurrentSupplementRow } from './supplements';
import { recordDocument } from './documents';
import type { FlowSheetEntry } from '../integrations/docs/types';
import type { SessionNote } from './extract';
import {
  publishBinaryDoc,
  publishFlowSheet,
  rewriteFlowSheetBlock,
  resolveDocFolder,
  ensureConvertedSheet,
  isDriveConfigured,
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
  currentSupplements: CurrentSupplementRow[],
): Promise<RenderedTemplates> {
  const display = displayDate(ctx.date);
  const supplement = await fillSupplementProtocol(toSupplementData(currentSupplements, note));
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
  /** Set when the Flow Sheet append failed while the other documents succeeded.
   *  A publish is not "done" just because it didn't throw. */
  flowSheetError?: string;
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
 * Interim Flow Sheet transport. The native path appends a block to a Google Sheet
 * via the Sheets API, which needs the `spreadsheets` scope + the Sheets API enabled
 * on the Google project — neither is set up in this pilot yet (see `npm run
 * check:google`). Until it is, FLOW_SHEET_AS_XLSX=true keeps the Flow Sheet as an
 * .xlsx file: we rebuild the whole sheet from the DB on each approve and overwrite
 * the one file in Drive, using only the drive.file scope we already have. Flip the
 * flag off once Sheets is live to return to native, append-in-place Google Sheets.
 */
const flowSheetAsXlsx = (): boolean => process.env.FLOW_SHEET_AS_XLSX === 'true';

/**
 * The client's Flow Sheet entries, oldest session first, for the xlsx-rebuild path.
 * Derives one entry per approved protocol from its stored note, so the rebuilt file
 * reflects the current state of every session (amendments included).
 */
async function flowSheetEntriesForClient(clientId: string): Promise<FlowSheetEntry[]> {
  // Ordered by the denormalized starts_at — when the session happened — so the
  // rebuilt sheet stacks visits in the same order Nicole's paper one does.
  const rows = await getDatabase().sessionNotes.listProtocolsByClient(clientId, {
    status: 'approved',
  });
  return rows.map((row) =>
    toFlowSheetEntry(coerceSessionNote(row.content_json), { date: displayDate(row.starts_at) }),
  );
}

/**
 * A protocol plus the client and appointment context both publish paths need.
 *
 * Three gets by known ref, replacing the two LEFT JOINs. The protocol's document
 * id is the appointment id, so the appointment lookup is free of a second query.
 */
async function loadProtocolContext(protocolId: string): Promise<{
  protocol: SupplementProtocol;
  client: Client | null;
  clientName: string;
  startsAt: string | null;
}> {
  const db = getDatabase();
  const { protocol } = await db.sessionNotes.findSessionDocs(protocolId);
  if (!protocol) throw new Error(`protocol ${protocolId} not found`);

  const [client, appointment] = await Promise.all([
    protocol.client_id ? db.clients.findById(protocol.client_id) : Promise.resolve(null),
    db.appointments.findById(protocol.appointment_id),
  ]);
  return {
    protocol,
    client,
    clientName: client?.name ?? protocol.client_name ?? 'Unknown client',
    startsAt: protocol.starts_at ?? appointment?.starts_at ?? null,
  };
}

/**
 * Rebuild the client's Flow Sheet from all their approved sessions and overwrite
 * the single .xlsx in Drive (`<Client>/AppointmentFlowSheet/`). Idempotent: same
 * inputs always produce the same file, found and PATCHed by name. Returns partial
 * ids to fold into the caller's result. `driveFolderId` is the client's stable
 * folder id when known, so we don't misfile on a renamed client.
 */
async function publishFlowSheetXlsx(
  clientId: string,
  clientName: string,
  driveFolderId: string | null,
): Promise<{ fileId?: string; clientFolderId?: string; dryRun?: boolean }> {
  const entries = await flowSheetEntriesForClient(clientId);
  const bytes = await buildFlowSheetXlsx(entries);
  const res = await publishBinaryDoc({
    clientName,
    driveFolderId,
    docType: 'AppointmentFlowSheet',
    fileName: `${clientName} Appointment Flow Sheet.xlsx`,
    bytes,
    mimeType: XLSX_MIME,
    update: true,
  });
  if (!res.dryRun) await recordDocument(clientId, 'AppointmentFlowSheet', res.fileId);
  logEvent('info', 'session.flowsheet_xlsx', res.dryRun ? '[dry-run] would overwrite Flow Sheet xlsx' : 'overwrote Flow Sheet xlsx', {
    client: clientName,
    sessions: entries.length,
    fileId: res.fileId,
  });
  return res;
}

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
  const { protocol, client, clientName, startsAt } = await loadProtocolContext(protocolId);
  const clientId = protocol.client_id ?? null;
  const note = coerceSessionNote(protocol.content_json);
  // syncClientSupplements already ran (right after the approval transaction,
  // before this fires), so the plan already reflects this session's changes
  // merged in — this is the full current plan, not just what this session
  // mentioned.
  const currentSupplements = clientId ? await fetchCurrentSupplements(clientId) : [];
  const rendered = await renderClientTemplates(note, { clientName, date: startsAt }, currentSupplements);

  const result: ClientTemplatesResult = {};

  // ROF — fill-once at intake.
  const rof = await publishBinaryDoc({
    clientName,
    driveFolderId: client?.drive_folder_id ?? null,
    docType: 'ROF',
    fileName: 'ROF.docx',
    bytes: rendered.rof,
    mimeType: DOCX_MIME,
    skipIfExists: true,
  });
  result.dryRun = rof.dryRun;
  result.rofFileId = rof.fileId;
  result.rofSkipped = rof.skipped;
  // Only when it was actually created — a skipped fill-once ROF was already recorded.
  if (!rof.skipped) await recordDocument(clientId, 'ROF', rof.fileId, protocol.appointment_id);
  let clientFolderId = rof.clientFolderId ?? client?.drive_folder_id ?? null;

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
  await recordDocument(clientId, 'SupplementProtocol', supp.fileId, protocol.appointment_id);
  clientFolderId = supp.clientFolderId ?? clientFolderId;

  // Flow Sheet. Two transports, chosen by FLOW_SHEET_AS_XLSX (see flowSheetAsXlsx):
  //   xlsx mode  — rebuild the whole sheet from the DB, overwrite one file in Drive
  //                (drive.file scope only; the interim path until Sheets is enabled).
  //   native mode— provision a Google Sheet once, then append this session's block.
  let flowSheetId: string | null = client?.flow_sheet_id ?? null;
  if (flowSheetAsXlsx()) {
    try {
      if (clientId) {
        const flow = await publishFlowSheetXlsx(clientId, clientName, clientFolderId);
        result.flowSheetId = flow.fileId ?? null;
        clientFolderId = flow.clientFolderId ?? clientFolderId;
      }
    } catch (err) {
      // Same contract as the native path: ROF/Supplement already landed, so a
      // Flow Sheet failure stays local to this doc and is surfaced (not swallowed)
      // so the caller/dashboard can say the block is missing.
      result.flowSheetError = err instanceof Error ? err.message : String(err);
      logError('session.flowsheet_publish', 'Flow Sheet xlsx publish failed', err, { client: clientName });
    }
  } else {
    // publishFlowSheet also mirrors the block into a local demo xlsx whenever
    // DEMO_OUTPUT_DIR is set, in addition to (not instead of) the real Sheet.
    try {
      if (isDriveConfigured() && !flowSheetId) {
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
      if (!flow.dryRun) {
        await recordDocument(clientId, 'AppointmentFlowSheet', flowSheetId, protocol.appointment_id);
      }
    } catch (err) {
      // ROF/Supplement already landed above — a Sheets-API failure must not lose
      // that work or block persistIds/email below, so it stays local to this doc.
      //
      // But it must not stay INVISIBLE either. This is how the Flow Sheet went
      // months without ever being written: the other two documents succeeded, the
      // publish reported success, and the one failure went to a log nobody reads.
      // Surfacing it on the result means the caller — and the dashboard — can say
      // that a session's Flow Sheet block is missing.
      result.flowSheetError = err instanceof Error ? err.message : String(err);
      logError('session.flowsheet_publish', 'Flow Sheet publish failed', err, { client: clientName });
    }
  }

  // Optionally mail the client their filled docs (off unless Nicole enables it).
  // The ROF rides along only on the session that actually created it.
  if (emailToClientEnabled() && client?.email) {
    result.emailed = await emailTemplatesToClient(client.email, clientName, rendered, {
      includeRof: !rof.skipped,
    });
  }

  // Persist the folder + sheet ids we learned, so we don't re-provision next time.
  await persistIds(clientId, { driveFolderId: clientFolderId, flowSheetId });
  return result;
}

async function persistIds(
  clientId: string | null,
  ids: { driveFolderId: string | null; flowSheetId: string | null },
): Promise<void> {
  if (!clientId) return;
  const db = getDatabase();
  // Re-read rather than reuse the row loaded at the top: provisioning happened
  // in between, and a concurrent publish may already have filed the same ids.
  const client = await db.clients.findById(clientId);
  if (!client) return;

  // COALESCE, not overwrite — a publish that didn't touch the Flow Sheet must
  // not clear an id an earlier one established.
  const driveFolderId = ids.driveFolderId ?? client.drive_folder_id ?? null;
  const flowSheetId = ids.flowSheetId ?? client.flow_sheet_id ?? null;
  if (
    driveFolderId === (client.drive_folder_id ?? null) &&
    flowSheetId === (client.flow_sheet_id ?? null)
  ) {
    return; // the `IS DISTINCT FROM` guard: nothing learned, nothing to write
  }
  await db.clients.save({
    ...client,
    drive_folder_id: driveFolderId,
    flow_sheet_id: flowSheetId,
    updated_at: new Date().toISOString(),
  });
}

/**
 * Bring the client documents back into line after an approved protocol is amended.
 *
 * The three templates cannot be treated alike, which is why this is separate from
 * publishClientTemplates rather than a flag on it:
 *
 *  - ROF is fill-once at intake. It is a record of the initial consultation, not
 *    a living document, so an amendment to a later session must not touch it.
 *  - Supplement Protocol is versioned by date, so a corrected version is simply
 *    published alongside the old one. Nothing is destroyed.
 *  - Flow Sheet is a running log with one block per visit. The block for this
 *    session is rewritten in place; appending would give the client two blocks
 *    for one appointment.
 *
 * Best-effort and off the request path, matching the approve publish.
 */
export async function republishAmended(protocolId: string): Promise<ClientTemplatesResult> {
  const { protocol, client, clientName, startsAt } = await loadProtocolContext(protocolId);
  const clientId = protocol.client_id ?? null;
  const note = coerceSessionNote(protocol.content_json);
  const currentSupplements = clientId ? await fetchCurrentSupplements(clientId) : [];
  const rendered = await renderClientTemplates(
    note,
    { clientName, date: startsAt },
    currentSupplements,
  );

  const result: ClientTemplatesResult = {};

  // Supplement Protocol — a new dated version. The superseded one stays in Drive.
  const supp = await publishBinaryDoc({
    clientName,
    driveFolderId: client?.drive_folder_id ?? null,
    docType: 'SupplementProtocol',
    fileName: rendered.supplementFileName,
    bytes: rendered.supplement,
    mimeType: XLSX_MIME,
  });
  result.dryRun = supp.dryRun;
  result.supplementFileId = supp.fileId;
  await recordDocument(clientId, 'SupplementProtocol', supp.fileId, protocol.appointment_id);

  // Flow Sheet. In xlsx mode the rebuild reads the amended note straight from the
  // DB, so re-publishing the whole file is the correction — no per-block rewrite.
  // In native mode we rewrite this session's own block in place (appending would
  // give the client two blocks for one visit).
  if (flowSheetAsXlsx()) {
    if (clientId) {
      try {
        const flow = await publishFlowSheetXlsx(
          clientId,
          clientName,
          client?.drive_folder_id ?? null,
        );
        result.flowSheetId = flow.fileId ?? null;
      } catch (err) {
        logError('session.flowsheet_amend', 'Flow Sheet xlsx rewrite failed', err, { client: clientName });
      }
    }
  } else if (client?.flow_sheet_id) {
    try {
      const flow = await rewriteFlowSheetBlock({
        clientName,
        spreadsheetId: client.flow_sheet_id,
        entry: rendered.flowEntry,
      });
      result.flowSheetId = client.flow_sheet_id;
      result.flowBlock = flow.blockIndex;
    } catch (err) {
      logError('session.flowsheet_amend', 'Flow Sheet rewrite failed', err, { client: clientName });
    }
  } else {
    logEvent('info', 'session.flowsheet_amend', 'no Flow Sheet for client — nothing to rewrite', {
      client: clientName,
    });
  }

  // Deliberately NOT re-emailed. The client already has the original; a silent
  // second copy with different contents is worse than Nicole telling them.
  logEvent('info', 'session.templates_amend', 'republished after amendment', {
    client: clientName,
    protocolId,
    supplementFile: rendered.supplementFileName,
  });
  return result;
}
