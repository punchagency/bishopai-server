import type {
  Client,
  Appointment,
  Conversation,
  ExtractionStatus,
  AppointmentClaim,
  SessionNoteRecord,
  AppointmentSheet,
  SupplementProtocol,
  DocStatus,
  Approval,
  NoteRevision,
  NoteTable,
  Checkout,
  CheckoutStatus,
  PaymentReconciliation,
  ClientQboMap,
  Supplement,
  Refill,
  RefillStatus,
  RefillOrder,
  Lead,
  LeadActivity,
  TaskItem,
  DocumentRecord,
  Consent,
  AuditLog,
} from '../../interfaces/types.js';
import type {
  IClientsRepository,
  IAppointmentsRepository,
  IConversationsRepository,
  ISessionNotesRepository,
  ICheckoutsRepository,
  IRefillsRepository,
  IReengagementRepository,
  ITasksRepository,
  IDocumentsRepository,
  IConsentsRepository,
  IStateRepository,
  IAuditRepository,
  IDatabase,
  SessionDocs,
  GuardedSessionWrite,
  GuardedSessionResult,
} from '../../interfaces/repositories.js';
import { consentDocId, noteRevisionDocId, supplementDocId } from '../../ids.js';
import { combineStatus } from '../../sessionStatus.js';

export class MockClientsRepository implements IClientsRepository {
  private clients = new Map<string, Client>();

  async findById(id: string): Promise<Client | null> {
    return this.clients.get(id) ?? null;
  }
  async findByEmail(email: string): Promise<Client | null> {
    for (const client of this.clients.values()) {
      if (client.email.toLowerCase() === email.toLowerCase()) return client;
    }
    return null;
  }
  async listAll(): Promise<Client[]> {
    return Array.from(this.clients.values());
  }
  async save(client: Client): Promise<Client> {
    this.clients.set(client.id, client);
    return client;
  }
  async delete(id: string): Promise<void> {
    this.clients.delete(id);
  }
  async clearAll(): Promise<void> {
    this.clients.clear();
  }
}

export class MockAppointmentsRepository implements IAppointmentsRepository {
  private appointments = new Map<string, Appointment>();

  async findById(id: string): Promise<Appointment | null> {
    return this.appointments.get(id) ?? null;
  }
  async listByClient(clientId: string): Promise<Appointment[]> {
    // Mirrors the Firestore query's orderBy('starts_at').
    return Array.from(this.appointments.values())
      .filter((a) => a.client_id === clientId)
      .sort((a, b) => a.starts_at.localeCompare(b.starts_at));
  }
  async listAll(): Promise<Appointment[]> {
    return Array.from(this.appointments.values());
  }
  async listRecent(limit: number): Promise<Appointment[]> {
    return Array.from(this.appointments.values())
      .sort((a, b) => b.starts_at.localeCompare(a.starts_at))
      .slice(0, limit);
  }
  async listBetween(fromIso: string, toIso: string): Promise<Appointment[]> {
    return Array.from(this.appointments.values())
      .filter((a) => a.starts_at >= fromIso && a.starts_at < toIso)
      .sort((a, b) => a.starts_at.localeCompare(b.starts_at));
  }
  async findByPbId(pbId: string): Promise<Appointment | null> {
    for (const a of this.appointments.values()) {
      if (a.pb_id === pbId) return a;
    }
    return null;
  }
  async findOverlapping(startsAt: string, endsAt: string): Promise<Appointment[]> {
    const start = new Date(startsAt).getTime();
    const end = new Date(endsAt).getTime();
    return Array.from(this.appointments.values()).filter((app) => {
      const appStart = new Date(app.starts_at).getTime();
      const appEnd = new Date(app.ends_at).getTime();
      return appStart < end && appEnd > start;
    });
  }
  async save(appointment: Appointment): Promise<Appointment> {
    this.appointments.set(appointment.id, appointment);
    return appointment;
  }
  async delete(id: string): Promise<void> {
    this.appointments.delete(id);
  }
  async clearAll(): Promise<void> {
    this.appointments.clear();
  }
}

export class MockConversationsRepository implements IConversationsRepository {
  private conversations = new Map<string, Conversation>();
  private claims = new Map<string, AppointmentClaim>();

  async findById(id: string): Promise<Conversation | null> {
    return this.conversations.get(id) ?? null;
  }
  async findByAppointment(appointmentId: string): Promise<Conversation | null> {
    for (const conv of this.conversations.values()) {
      if (conv.appointment_id === appointmentId) return conv;
    }
    return null;
  }
  async listUnmatched(): Promise<Conversation[]> {
    return Array.from(this.conversations.values())
      .filter((c) => c.correlation_status === 'unmatched')
      .sort((a, b) => b.starts_at.localeCompare(a.starts_at));
  }
  async listAll(): Promise<Conversation[]> {
    return Array.from(this.conversations.values());
  }
  async save(conversation: Conversation): Promise<Conversation> {
    this.conversations.set(conversation.id, conversation);
    return conversation;
  }

  async upsertByBeeId(
    conversation: Conversation,
  ): Promise<{ conversation: Conversation; created: boolean }> {
    const stored = this.conversations.get(conversation.id);
    if (!stored) {
      this.conversations.set(conversation.id, conversation);
      return { conversation, created: true };
    }
    if (stored.transcript || !conversation.transcript) {
      return { conversation: stored, created: false };
    }
    const merged: Conversation = {
      ...stored,
      transcript: conversation.transcript,
      updated_at: new Date().toISOString(),
    };
    this.conversations.set(merged.id, merged);
    return { conversation: merged, created: false };
  }

  async transitionExtraction(
    id: string,
    from: ExtractionStatus[],
    patch: Partial<Conversation>,
    guard?: (row: Conversation) => boolean,
  ): Promise<Conversation | null> {
    const row = this.conversations.get(id);
    if (!row) return null;
    if (!from.includes(row.extraction_status)) return null;
    if (guard && !guard(row)) return null;
    const next: Conversation = { ...row, ...patch, updated_at: new Date().toISOString() };
    this.conversations.set(id, next);
    return next;
  }

  async listStuckExtractions(leaseCutoff: string): Promise<Conversation[]> {
    return Array.from(this.conversations.values()).filter(
      (c) =>
        c.extraction_status === 'processing' &&
        // Matches the Firestore range filter, which EXCLUDES documents missing
        // the field (§3.5) — a mock that treated a missing lease as stuck would
        // hide exactly the bug the emulator catches.
        !!c.extraction_leased_at &&
        c.extraction_leased_at < leaseCutoff,
    );
  }

  async listExhaustedExtractions(maxAttempts: number): Promise<Conversation[]> {
    return Array.from(this.conversations.values()).filter(
      (c) => c.extraction_status === 'failed' && (c.extraction_attempts ?? 0) >= maxAttempts,
    );
  }

  async listDueExtractions(
    now: string,
    maxAttempts: number,
    limit: number,
  ): Promise<Conversation[]> {
    return Array.from(this.conversations.values())
      .filter(
        (c) =>
          c.extraction_status === 'failed' &&
          !!c.extraction_next_attempt_at &&
          c.extraction_next_attempt_at <= now &&
          (c.extraction_attempts ?? 0) < maxAttempts &&
          !!c.appointment_id &&
          !!c.transcript,
      )
      .sort((a, b) =>
        (a.extraction_next_attempt_at ?? '').localeCompare(b.extraction_next_attempt_at ?? ''),
      )
      .slice(0, limit);
  }

  async claimAppointment(claim: AppointmentClaim): Promise<boolean> {
    if (this.claims.has(claim.id)) return false;
    this.claims.set(claim.id, claim);
    return true;
  }
  async releaseAppointment(appointmentId: string): Promise<void> {
    this.claims.delete(appointmentId);
  }
  async delete(id: string): Promise<void> {
    this.conversations.delete(id);
  }
  async clearAll(): Promise<void> {
    this.conversations.clear();
    this.claims.clear();
  }
}

export class MockSessionNotesRepository implements ISessionNotesRepository {
  private notes = new Map<string, SessionNoteRecord>();
  private sheets = new Map<string, AppointmentSheet>();
  private protocols = new Map<string, SupplementProtocol>();
  private approvals: Approval[] = [];
  private revisions: NoteRevision[] = [];

  async findById(id: string): Promise<SessionNoteRecord | null> {
    return this.notes.get(id) ?? null;
  }
  async findByAppointment(appointmentId: string): Promise<SessionNoteRecord | null> {
    for (const note of this.notes.values()) {
      if (note.appointment_id === appointmentId) return note;
    }
    return null;
  }
  async listDrafts(): Promise<SessionNoteRecord[]> {
    return Array.from(this.notes.values()).filter((n) => n.status === 'draft');
  }
  async listApproved(): Promise<SessionNoteRecord[]> {
    return Array.from(this.notes.values()).filter((n) => n.status === 'approved');
  }
  async listAll(): Promise<SessionNoteRecord[]> {
    return Array.from(this.notes.values());
  }
  async save(note: SessionNoteRecord): Promise<SessionNoteRecord> {
    this.notes.set(note.id, note);
    return note;
  }
  async claimExtractionLock(appointmentId: string): Promise<boolean> {
    const existing = await this.findByAppointment(appointmentId);
    if (!existing) return true;
    if (existing.extraction_status === 'pending' || existing.extraction_status === 'failed') {
      existing.extraction_status = 'processing';
      return true;
    }
    return false;
  }
  async saveSheet(sheet: AppointmentSheet): Promise<AppointmentSheet> {
    this.sheets.set(sheet.id, sheet);
    return sheet;
  }
  async findSheetByAppointment(appointmentId: string): Promise<AppointmentSheet | null> {
    for (const s of this.sheets.values()) {
      if (s.appointment_id === appointmentId) return s;
    }
    return null;
  }
  async saveProtocol(protocol: SupplementProtocol): Promise<SupplementProtocol> {
    this.protocols.set(protocol.id, protocol);
    return protocol;
  }
  async findProtocolByAppointment(appointmentId: string): Promise<SupplementProtocol | null> {
    for (const p of this.protocols.values()) {
      if (p.appointment_id === appointmentId) return p;
    }
    return null;
  }
  async saveApproval(approval: Approval): Promise<Approval> {
    this.approvals.push(approval);
    return approval;
  }
  async listApprovals(appointmentId: string): Promise<Approval[]> {
    return this.approvals
      .filter((a) => a.appointment_id === appointmentId)
      .sort((a, b) => b.created_at.localeCompare(a.created_at));
  }
  async listRevisions(sourceTable: NoteTable, sourceId: string): Promise<NoteRevision[]> {
    return this.revisions
      .filter((r) => r.source_table === sourceTable && r.source_id === sourceId)
      .sort((a, b) => b.revision - a.revision);
  }

  async findSessionDocs(appointmentId: string): Promise<SessionDocs> {
    return {
      sheet: this.sheets.get(appointmentId) ?? null,
      protocol: this.protocols.get(appointmentId) ?? null,
    };
  }

  async findManySessionDocs(appointmentIds: string[]): Promise<Map<string, SessionDocs>> {
    const out = new Map<string, SessionDocs>();
    for (const id of appointmentIds) {
      out.set(id, {
        sheet: this.sheets.get(id) ?? null,
        protocol: this.protocols.get(id) ?? null,
      });
    }
    return out;
  }

  async guardedWrite(args: GuardedSessionWrite): Promise<GuardedSessionResult> {
    const before: SessionDocs = {
      sheet: this.sheets.get(args.appointmentId) ?? null,
      protocol: this.protocols.get(args.appointmentId) ?? null,
    };
    if (!before.sheet && !before.protocol) {
      return { ok: false, reason: 'not_found', before };
    }
    const current = combineStatus(before.sheet?.status ?? null, before.protocol?.status ?? null);
    if (!args.expect.includes(current)) {
      return { ok: false, reason: 'wrong_status', before };
    }

    const now = new Date().toISOString();
    const revision = before.sheet?.revision ?? before.protocol?.revision ?? 1;

    if (args.snapshotRevision) {
      for (const [table, doc] of [
        ['appointment_sheets', before.sheet],
        ['protocols', before.protocol],
      ] as const) {
        if (!doc) continue;
        const id = noteRevisionDocId(table, doc.id, revision);
        // create() semantics: a replayed amendment must not re-file the version
        // it already filed.
        if (this.revisions.some((r) => r.id === id)) continue;
        this.revisions.push({
          id,
          source_table: table,
          source_id: doc.id,
          appointment_id: args.appointmentId,
          revision,
          content_json: doc.content_json,
          reason: args.snapshotRevision.reason,
          created_at: now,
        });
      }
    }

    for (const [map, doc] of [
      [this.sheets, before.sheet],
      [this.protocols, before.protocol],
    ] as const) {
      if (!doc) continue;
      (map as Map<string, typeof doc>).set(doc.id, {
        ...doc,
        ...(args.content !== undefined ? { content_json: args.content } : {}),
        ...(args.status !== undefined ? { status: args.status } : {}),
        ...(args.snapshotRevision ? { revision: revision + 1 } : {}),
        updated_at: now,
      });
    }
    if (args.approval) this.approvals.push(args.approval);

    return { ok: true, before, revision };
  }

  async listProtocolsByClient(
    clientId: string,
    opts: { status?: DocStatus; limit?: number } = {},
  ): Promise<SupplementProtocol[]> {
    const rows = Array.from(this.protocols.values())
      .filter((p) => p.client_id === clientId)
      .filter((p) => (opts.status ? p.status === opts.status : true))
      // Mirrors the Firestore orderBy, which EXCLUDES documents missing the
      // field rather than sorting them first.
      .filter((p) => p.starts_at != null)
      .sort((a, b) => (a.starts_at ?? '').localeCompare(b.starts_at ?? ''));
    return opts.limit ? rows.slice(0, opts.limit) : rows;
  }

  async findPriorApproved(
    kind: 'sheet' | 'protocol',
    clientId: string,
    opts: { excludeAppointmentId: string | null; before: string | null },
  ): Promise<AppointmentSheet | SupplementProtocol | null> {
    const source: Array<AppointmentSheet | SupplementProtocol> =
      kind === 'sheet' ? [...this.sheets.values()] : [...this.protocols.values()];
    return (
      source
        .filter((r) => r.client_id === clientId && r.status === 'approved')
        .filter((r) => r.starts_at != null)
        .filter((r) => (opts.before ? (r.starts_at ?? '') < opts.before : true))
        .filter((r) => r.appointment_id !== opts.excludeAppointmentId)
        .sort((a, b) => (b.starts_at ?? '').localeCompare(a.starts_at ?? ''))[0] ?? null
    );
  }

  async listApprovedHistory(
    clientId: string,
    opts: { excludeAppointmentId: string | null; before: string | null; limit: number },
  ): Promise<{ total: number; sessions: Array<{ starts_at: string | null; content_json: unknown }> }> {
    const eligible = (rows: Array<AppointmentSheet | SupplementProtocol>) =>
      rows
        .filter((r) => r.client_id === clientId && r.status === 'approved')
        .filter((r) => r.starts_at != null)
        .filter((r) => (opts.before ? (r.starts_at ?? '') < opts.before : true));

    const sheets = eligible([...this.sheets.values()]);
    const protocols = eligible([...this.protocols.values()]);

    const byAppointment = new Map<string, { starts_at: string | null; content_json: unknown }>();
    for (const r of sheets) {
      byAppointment.set(r.appointment_id, { starts_at: r.starts_at ?? null, content_json: r.content_json });
    }
    for (const r of protocols) {
      if (byAppointment.has(r.appointment_id)) continue; // the sheet wins
      byAppointment.set(r.appointment_id, { starts_at: r.starts_at ?? null, content_json: r.content_json });
    }
    if (opts.excludeAppointmentId) byAppointment.delete(opts.excludeAppointmentId);

    const counted = Math.max(sheets.length, protocols.length);
    const total = opts.excludeAppointmentId ? Math.max(0, counted - 1) : counted;
    const sessions = [...byAppointment.values()]
      .sort((a, b) => (b.starts_at ?? '').localeCompare(a.starts_at ?? ''))
      .slice(0, opts.limit);
    return { total, sessions };
  }

  async saveExtractedNote(args: {
    appointmentId: string;
    clientId: string | null;
    startsAt: string | null;
    clientName: string | null;
    content: Record<string, unknown>;
  }): Promise<{ written: boolean }> {
    const sheet = this.sheets.get(args.appointmentId) ?? null;
    const protocol = this.protocols.get(args.appointmentId) ?? null;
    if (sheet?.status === 'approved' || protocol?.status === 'approved') {
      return { written: false };
    }
    const now = new Date().toISOString();
    this.sheets.set(args.appointmentId, {
      id: args.appointmentId,
      appointment_id: args.appointmentId,
      client_id: args.clientId,
      starts_at: args.startsAt,
      client_name: args.clientName,
      content_json: args.content,
      status: 'draft',
      revision: sheet?.revision ?? 1,
      created_at: sheet?.created_at ?? now,
      updated_at: now,
    });
    if (args.clientId) {
      this.protocols.set(args.appointmentId, {
        id: args.appointmentId,
        appointment_id: args.appointmentId,
        client_id: args.clientId,
        starts_at: args.startsAt,
        client_name: args.clientName,
        content_json: args.content,
        status: 'draft',
        revision: protocol?.revision ?? 1,
        created_at: protocol?.created_at ?? now,
        updated_at: now,
      });
    }
    return { written: true };
  }

  async deleteSessionDocs(appointmentId: string): Promise<void> {
    this.sheets.delete(appointmentId);
    this.protocols.delete(appointmentId);
  }

  async clearAll(): Promise<void> {
    this.notes.clear();
    this.sheets.clear();
    this.protocols.clear();
    this.approvals = [];
    this.revisions = [];
  }
}

export class MockCheckoutsRepository implements ICheckoutsRepository {
  private checkouts = new Map<string, Checkout>();
  private reconciliations = new Map<string, PaymentReconciliation>();
  private qboMaps = new Map<string, ClientQboMap>();
  // `approvals` is one unified collection shared with the session flow.
  private approvals: Approval[] = [];

  async findById(id: string): Promise<Checkout | null> {
    return this.checkouts.get(id) ?? null;
  }
  async findByAppointment(appointmentId: string): Promise<Checkout | null> {
    for (const item of this.checkouts.values()) {
      if (item.appointment_id === appointmentId) return item;
    }
    return null;
  }
  async findByPbAppointmentId(pbAppointmentId: string): Promise<Checkout | null> {
    for (const item of this.checkouts.values()) {
      if (item.pb_appointment_id === pbAppointmentId) return item;
    }
    return null;
  }
  async listAll(): Promise<Checkout[]> {
    return Array.from(this.checkouts.values());
  }
  async listByClient(clientId: string): Promise<Checkout[]> {
    return Array.from(this.checkouts.values()).filter((c) => c.client_id === clientId);
  }
  async save(checkout: Checkout): Promise<Checkout> {
    this.checkouts.set(checkout.id, checkout);
    return checkout;
  }
  async createIfAbsent(checkout: Checkout): Promise<{ checkout: Checkout; created: boolean }> {
    const existing = this.checkouts.get(checkout.id);
    if (existing) return { checkout: existing, created: false };
    this.checkouts.set(checkout.id, checkout);
    return { checkout, created: true };
  }
  // Single-threaded JS makes this atomic by construction; the point is to mirror
  // the Firestore contract exactly — returns true only if the row was in `from`.
  async transition(
    id: string,
    from: CheckoutStatus,
    to: CheckoutStatus,
    patch: Partial<Checkout> = {},
  ): Promise<boolean> {
    const row = this.checkouts.get(id);
    if (!row || row.status !== from) return false;
    this.checkouts.set(id, { ...row, ...patch, status: to, updated_at: new Date().toISOString() });
    return true;
  }
  async transitionWithApproval(
    id: string,
    from: CheckoutStatus,
    to: CheckoutStatus,
    approval: Approval,
  ): Promise<boolean> {
    const row = this.checkouts.get(id);
    if (!row || row.status !== from) return false;
    this.checkouts.set(id, { ...row, status: to, updated_at: new Date().toISOString() });
    this.approvals.push(approval);
    return true;
  }
  async markChargedWithReconciliation(
    checkoutId: string,
    patch: Partial<Checkout>,
    reconciliation: PaymentReconciliation,
  ): Promise<boolean> {
    const row = this.checkouts.get(checkoutId);
    if (!row || row.status !== 'CHARGING') return false;
    this.checkouts.set(checkoutId, {
      ...row,
      ...patch,
      status: 'CHARGED',
      updated_at: new Date().toISOString(),
    });
    if (!this.reconciliations.has(reconciliation.id)) {
      this.reconciliations.set(reconciliation.id, reconciliation);
    }
    return true;
  }
  async claimIdempotencyKey(id: string, key: string): Promise<void> {
    const row = this.checkouts.get(id);
    if (!row || row.charge_idempotency_key) return;
    this.checkouts.set(id, { ...row, charge_idempotency_key: key });
  }
  async listStuckCharging(cutoff: string): Promise<Checkout[]> {
    return Array.from(this.checkouts.values()).filter(
      (c) => c.status === 'CHARGING' && c.updated_at < cutoff,
    );
  }
  async reopenFailedCharge(id: string): Promise<boolean> {
    const row = this.checkouts.get(id);
    if (!row || row.status !== 'CHARGE_FAILED') return false;
    this.checkouts.set(id, {
      ...row,
      status: 'AWAITING_APPROVAL',
      charge_attempts: (row.charge_attempts ?? 0) + 1,
      charge_idempotency_key: null,
      qb_txn_id: null,
      updated_at: new Date().toISOString(),
    });
    return true;
  }
  async listApprovalsByCheckout(checkoutId: string, limit = 10): Promise<Approval[]> {
    return this.approvals
      .filter((a) => a.checkout_id === checkoutId && a.type === 'checkout')
      .sort((a, b) => b.created_at.localeCompare(a.created_at))
      .slice(0, limit);
  }
  async saveApproval(approval: Approval): Promise<Approval> {
    const i = this.approvals.findIndex((a) => a.id === approval.id);
    if (i >= 0) this.approvals[i] = approval;
    else this.approvals.push(approval);
    return approval;
  }
  async patchApprovalPayload(id: string, patch: Record<string, unknown>): Promise<void> {
    const i = this.approvals.findIndex((a) => a.id === id);
    if (i < 0) return;
    this.approvals[i] = {
      ...this.approvals[i],
      payload_json: { ...(this.approvals[i].payload_json ?? {}), ...patch },
    };
  }
  async listDueReconciliations(now: string, leaseCutoff: string): Promise<PaymentReconciliation[]> {
    return Array.from(this.reconciliations.values())
      .filter(
        (r) =>
          ((r.status === 'PENDING' || r.status === 'FAILED') && r.next_attempt_at <= now) ||
          (r.status === 'RECORDING' && r.updated_at < leaseCutoff),
      )
      .sort((a, b) => a.next_attempt_at.localeCompare(b.next_attempt_at));
  }
  async claimReconciliation(id: string): Promise<boolean> {
    const row = this.reconciliations.get(id);
    if (!row) return false;
    if (row.status !== 'PENDING' && row.status !== 'FAILED' && row.status !== 'RECORDING') {
      return false;
    }
    this.reconciliations.set(id, {
      ...row,
      status: 'RECORDING',
      attempts: (row.attempts ?? 0) + 1,
      updated_at: new Date().toISOString(),
    });
    return true;
  }
  async saveReconciliation(rec: PaymentReconciliation): Promise<PaymentReconciliation> {
    this.reconciliations.set(rec.id, rec);
    return rec;
  }
  async findReconciliationByCheckout(checkoutId: string): Promise<PaymentReconciliation | null> {
    for (const r of this.reconciliations.values()) {
      if (r.checkout_id === checkoutId) return r;
    }
    return null;
  }
  async listPendingReconciliations(): Promise<PaymentReconciliation[]> {
    return Array.from(this.reconciliations.values()).filter((r) => r.status === 'PENDING');
  }
  async saveQboMap(map: ClientQboMap): Promise<ClientQboMap> {
    this.qboMaps.set(map.client_id, map);
    return map;
  }
  async findQboMapByClient(clientId: string): Promise<ClientQboMap | null> {
    return this.qboMaps.get(clientId) ?? null;
  }
  async listQboMaps(): Promise<ClientQboMap[]> {
    return Array.from(this.qboMaps.values());
  }
  async deleteQboMap(clientId: string): Promise<void> {
    this.qboMaps.delete(clientId);
  }
  async clearAll(): Promise<void> {
    this.checkouts.clear();
    this.reconciliations.clear();
    this.qboMaps.clear();
    this.approvals = [];
  }
}

export class MockRefillsRepository implements IRefillsRepository {
  private refills = new Map<string, Refill>();
  private supplements = new Map<string, Supplement>();
  private orders: RefillOrder[] = [];

  async listAll(): Promise<Refill[]> {
    return Array.from(this.refills.values());
  }
  async listByClient(clientId: string): Promise<Refill[]> {
    return Array.from(this.refills.values()).filter((r) => r.client_id === clientId);
  }
  async save(refill: Refill): Promise<Refill> {
    this.refills.set(refill.id, refill);
    return refill;
  }
  async saveSupplement(supp: Supplement): Promise<Supplement> {
    this.supplements.set(supp.id, supp);
    return supp;
  }
  async findSupplement(clientId: string, nameKey: string): Promise<Supplement | null> {
    return this.supplements.get(supplementDocId(clientId, nameKey)) ?? null;
  }
  async deleteSupplement(clientId: string, nameKey: string): Promise<boolean> {
    return this.supplements.delete(supplementDocId(clientId, nameKey));
  }
  async listSupplementsByClient(clientId: string): Promise<Supplement[]> {
    return Array.from(this.supplements.values()).filter((s) => s.client_id === clientId);
  }
  async listAllSupplements(): Promise<Supplement[]> {
    return Array.from(this.supplements.values());
  }
  async saveOrder(order: RefillOrder): Promise<RefillOrder> {
    this.orders.push(order);
    return order;
  }
  async listOrdersForRefills(refillIds: string[]): Promise<RefillOrder[]> {
    const wanted = new Set(refillIds);
    return this.orders.filter((o) => o.refill_id != null && wanted.has(o.refill_id));
  }
  async listDue(onOrBefore: string, limit?: number): Promise<Refill[]> {
    const rows = Array.from(this.refills.values())
      .filter((r) => r.due_date <= onOrBefore)
      .sort((a, b) => a.due_date.localeCompare(b.due_date));
    return limit ? rows.slice(0, limit) : rows;
  }
  async listByStatus(status: RefillStatus): Promise<Refill[]> {
    return Array.from(this.refills.values()).filter((r) => r.status === status);
  }
  async findRefillBySupplement(supplementId: string): Promise<Refill | null> {
    for (const r of this.refills.values()) {
      if (r.supplement_id === supplementId) return r;
    }
    return null;
  }
  async listOrders(clientId?: string): Promise<RefillOrder[]> {
    if (clientId) return this.orders.filter((o) => o.client_id === clientId);
    return this.orders;
  }
  async clearAll(): Promise<void> {
    this.refills.clear();
    this.supplements.clear();
    this.orders = [];
  }
}

export class MockReengagementRepository implements IReengagementRepository {
  private leads = new Map<string, Lead>();
  private activities: LeadActivity[] = [];

  async listLeads(): Promise<Lead[]> {
    return Array.from(this.leads.values());
  }
  async findLeadById(id: string): Promise<Lead | null> {
    return this.leads.get(id) ?? null;
  }
  async listActiveLeads(): Promise<Lead[]> {
    return Array.from(this.leads.values()).filter(
      (l) => l.status !== 'closed' && l.status !== 'booked',
    );
  }
  async findLeadByEmail(email: string): Promise<Lead | null> {
    for (const lead of this.leads.values()) {
      if ((lead.email ?? '').toLowerCase() === email.toLowerCase()) return lead;
    }
    return null;
  }
  async saveLead(lead: Lead): Promise<Lead> {
    this.leads.set(lead.id, lead);
    return lead;
  }
  async logActivity(activity: LeadActivity): Promise<LeadActivity> {
    this.activities.push(activity);
    return activity;
  }
  async listActivities(leadId: string): Promise<LeadActivity[]> {
    return this.activities
      .filter((a) => a.lead_id === leadId)
      .sort((a, b) => b.occurred_at.localeCompare(a.occurred_at));
  }
  async listRecentActivity(since: string, limit = 500): Promise<LeadActivity[]> {
    return this.activities
      .filter((a) => a.occurred_at >= since)
      .sort((a, b) => b.occurred_at.localeCompare(a.occurred_at))
      .slice(0, limit);
  }
  async clearAll(): Promise<void> {
    this.leads.clear();
    this.activities = [];
  }
}

export class MockTasksRepository implements ITasksRepository {
  private tasks = new Map<string, TaskItem>();

  async findById(id: string): Promise<TaskItem | null> {
    return this.tasks.get(id) ?? null;
  }
  async listByClient(clientId: string): Promise<TaskItem[]> {
    return Array.from(this.tasks.values()).filter((t) => t.client_id === clientId);
  }
  async listOpen(): Promise<TaskItem[]> {
    // Mirrors the Firestore query: ordered by due_sort, and documents MISSING
    // due_sort are excluded exactly as Firestore's orderBy would exclude them —
    // otherwise the mock would hide that class of bug from the suite.
    return Array.from(this.tasks.values())
      .filter((t) => t.status === 'open' && t.due_sort !== undefined)
      .sort((a, b) => (a.due_sort ?? '').localeCompare(b.due_sort ?? ''));
  }
  async listAll(): Promise<TaskItem[]> {
    return Array.from(this.tasks.values());
  }
  async save(task: TaskItem): Promise<TaskItem> {
    this.tasks.set(task.id, task);
    return task;
  }
  async create(task: TaskItem): Promise<boolean> {
    // Must mirror Firestore's create(): insert-if-absent, report whether it
    // landed. A mock that merged instead would hide replay bugs from the suite.
    if (this.tasks.has(task.id)) return false;
    this.tasks.set(task.id, task);
    return true;
  }
  async delete(id: string): Promise<void> {
    this.tasks.delete(id);
  }
  async clearAll(): Promise<void> {
    this.tasks.clear();
  }
}

export class MockDocumentsRepository implements IDocumentsRepository {
  private docs = new Map<string, DocumentRecord>();

  async listByClient(clientId: string, limit = 100): Promise<DocumentRecord[]> {
    return Array.from(this.docs.values())
      .filter((d) => d.client_id === clientId)
      .sort((a, b) => b.created_at.localeCompare(a.created_at))
      .slice(0, limit);
  }
  async save(doc: DocumentRecord): Promise<DocumentRecord> {
    this.docs.set(doc.id, doc);
    return doc;
  }
  async listByAppointment(appointmentId: string): Promise<DocumentRecord[]> {
    return Array.from(this.docs.values()).filter((d) => d.appointment_id === appointmentId);
  }
  async clearAll(): Promise<void> {
    this.docs.clear();
  }
}

export class MockConsentsRepository implements IConsentsRepository {
  private consents = new Map<string, Consent>();

  async save(consent: Consent): Promise<Consent> {
    this.consents.set(consent.id, consent);
    return consent;
  }
  async findByClientAndType(clientId: string, type: string): Promise<Consent | null> {
    // By document id, matching the Firestore lookup — a scan would hide a caller
    // that built the id differently from consentDocId.
    return this.consents.get(consentDocId(clientId, type)) ?? null;
  }
  async listByClient(clientId: string): Promise<Consent[]> {
    return Array.from(this.consents.values())
      .filter((c) => c.client_id === clientId)
      .sort((a, b) => a.type.localeCompare(b.type));
  }
  async clearAll(): Promise<void> {
    this.consents.clear();
  }
}

export class MockStateRepository implements IStateRepository {
  private state = new Map<string, string>();

  async get(key: string): Promise<string | null> {
    return this.state.get(key) ?? null;
  }
  async set(key: string, value: string): Promise<void> {
    this.state.set(key, value);
  }
  async delete(key: string): Promise<void> {
    this.state.delete(key);
  }
  async clearAll(): Promise<void> {
    this.state.clear();
  }
}

export class MockAuditRepository implements IAuditRepository {
  private logs: AuditLog[] = [];

  async log(event: AuditLog): Promise<AuditLog> {
    // Mirrors Firestore's create(): append-only, so a colliding id is an error
    // rather than a silent overwrite of existing history.
    if (this.logs.some((l) => l.id === event.id)) {
      throw Object.assign(new Error('ALREADY_EXISTS'), { code: 6 });
    }
    this.logs.push(event);
    return event;
  }
  async listForEntity(entityType: string, entityId: string, limit = 100): Promise<AuditLog[]> {
    return this.logs
      .filter((l) => l.entity_type === entityType && l.entity_id === entityId)
      .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())
      .slice(0, limit);
  }
  async listRecent(limit = 100, entityType?: string): Promise<AuditLog[]> {
    return this.logs
      .filter((l) => !entityType || l.entity_type === entityType)
      .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())
      .slice(0, limit);
  }
  async clearAll(): Promise<void> {
    this.logs = [];
  }
}

export class InMemoryMockDatabase implements IDatabase {
  clients = new MockClientsRepository();
  appointments = new MockAppointmentsRepository();
  conversations = new MockConversationsRepository();
  sessionNotes = new MockSessionNotesRepository();
  checkouts = new MockCheckoutsRepository();
  refills = new MockRefillsRepository();
  reengagement = new MockReengagementRepository();
  tasks = new MockTasksRepository();
  documents = new MockDocumentsRepository();
  consents = new MockConsentsRepository();
  state = new MockStateRepository();
  audit = new MockAuditRepository();
}
