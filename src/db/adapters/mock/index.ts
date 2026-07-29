import type {
  Client,
  Appointment,
  Conversation,
  AppointmentClaim,
  SessionNoteRecord,
  AppointmentSheet,
  SupplementProtocol,
  Approval,
  NoteRevision,
  Checkout,
  PaymentReconciliation,
  ClientQboMap,
  Supplement,
  Refill,
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
  IAuditRepository,
  IDatabase,
} from '../../interfaces/repositories.js';

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
    return Array.from(this.conversations.values()).filter((c) => c.status === 'unmatched');
  }
  async listAll(): Promise<Conversation[]> {
    return Array.from(this.conversations.values());
  }
  async save(conversation: Conversation): Promise<Conversation> {
    this.conversations.set(conversation.id, conversation);
    return conversation;
  }
  async claimAppointment(claim: AppointmentClaim): Promise<boolean> {
    if (this.claims.has(claim.id)) return false;
    this.claims.set(claim.id, claim);
    return true;
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
    return this.approvals.filter((a) => a.appointment_id === appointmentId);
  }
  async saveRevision(revision: NoteRevision): Promise<NoteRevision> {
    this.revisions.push(revision);
    return revision;
  }
  async listRevisions(appointmentId: string): Promise<NoteRevision[]> {
    return this.revisions.filter((r) => r.appointment_id === appointmentId);
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
  async save(checkout: Checkout): Promise<Checkout> {
    this.checkouts.set(checkout.id, checkout);
    return checkout;
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
  async findLeadByEmail(email: string): Promise<Lead | null> {
    for (const lead of this.leads.values()) {
      if (lead.email.toLowerCase() === email.toLowerCase()) return lead;
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
    return this.activities.filter((a) => a.lead_id === leadId);
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
    for (const c of this.consents.values()) {
      if (c.client_id === clientId && c.type === type) return c;
    }
    return null;
  }
  async clearAll(): Promise<void> {
    this.consents.clear();
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
  audit = new MockAuditRepository();
}
