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
  AuthState,
  IntegrationState,
  AuditLog,
} from './types.js';

export interface IClientsRepository {
  findById(id: string): Promise<Client | null>;
  findByEmail(email: string): Promise<Client | null>;
  listAll(): Promise<Client[]>;
  save(client: Client): Promise<Client>;
  delete(id: string): Promise<void>;
  clearAll(): Promise<void>;
}

export interface IAppointmentsRepository {
  findById(id: string): Promise<Appointment | null>;
  listByClient(clientId: string): Promise<Appointment[]>;
  listAll(): Promise<Appointment[]>;
  findOverlapping(startsAt: string, endsAt: string): Promise<Appointment[]>;
  save(appointment: Appointment): Promise<Appointment>;
  delete(id: string): Promise<void>;
  clearAll(): Promise<void>;
}

export interface IConversationsRepository {
  findById(id: string): Promise<Conversation | null>;
  findByAppointment(appointmentId: string): Promise<Conversation | null>;
  listUnmatched(): Promise<Conversation[]>;
  listAll(): Promise<Conversation[]>;
  save(conversation: Conversation): Promise<Conversation>;
  claimAppointment(claim: AppointmentClaim): Promise<boolean>;
  delete(id: string): Promise<void>;
  clearAll(): Promise<void>;
}

export interface ISessionNotesRepository {
  findById(id: string): Promise<SessionNoteRecord | null>;
  findByAppointment(appointmentId: string): Promise<SessionNoteRecord | null>;
  listDrafts(): Promise<SessionNoteRecord[]>;
  listApproved(): Promise<SessionNoteRecord[]>;
  listAll(): Promise<SessionNoteRecord[]>;
  save(note: SessionNoteRecord): Promise<SessionNoteRecord>;
  claimExtractionLock(appointmentId: string): Promise<boolean>;
  
  saveSheet(sheet: AppointmentSheet): Promise<AppointmentSheet>;
  findSheetByAppointment(appointmentId: string): Promise<AppointmentSheet | null>;
  
  saveProtocol(protocol: SupplementProtocol): Promise<SupplementProtocol>;
  findProtocolByAppointment(appointmentId: string): Promise<SupplementProtocol | null>;

  saveApproval(approval: Approval): Promise<Approval>;
  listApprovals(appointmentId: string): Promise<Approval[]>;
  
  saveRevision(revision: NoteRevision): Promise<NoteRevision>;
  listRevisions(appointmentId: string): Promise<NoteRevision[]>;
  
  clearAll(): Promise<void>;
}

export interface ICheckoutsRepository {
  findById(id: string): Promise<Checkout | null>;
  findByAppointment(appointmentId: string): Promise<Checkout | null>;
  findByPbAppointmentId(pbAppointmentId: string): Promise<Checkout | null>;
  listAll(): Promise<Checkout[]>;
  save(checkout: Checkout): Promise<Checkout>;
  
  saveReconciliation(rec: PaymentReconciliation): Promise<PaymentReconciliation>;
  findReconciliationByCheckout(checkoutId: string): Promise<PaymentReconciliation | null>;
  listPendingReconciliations(): Promise<PaymentReconciliation[]>;
  
  saveQboMap(map: ClientQboMap): Promise<ClientQboMap>;
  findQboMapByClient(clientId: string): Promise<ClientQboMap | null>;
  listQboMaps(): Promise<ClientQboMap[]>;
  deleteQboMap(clientId: string): Promise<void>;
  
  clearAll(): Promise<void>;
}

export interface IRefillsRepository {
  listAll(): Promise<Refill[]>;
  listByClient(clientId: string): Promise<Refill[]>;
  save(refill: Refill): Promise<Refill>;
  saveSupplement(supp: Supplement): Promise<Supplement>;
  listSupplementsByClient(clientId: string): Promise<Supplement[]>;
  listAllSupplements(): Promise<Supplement[]>;
  saveOrder(order: RefillOrder): Promise<RefillOrder>;
  listOrders(clientId?: string): Promise<RefillOrder[]>;
  clearAll(): Promise<void>;
}

export interface IReengagementRepository {
  listLeads(): Promise<Lead[]>;
  findLeadById(id: string): Promise<Lead | null>;
  findLeadByEmail(email: string): Promise<Lead | null>;
  saveLead(lead: Lead): Promise<Lead>;
  logActivity(activity: LeadActivity): Promise<LeadActivity>;
  listActivities(leadId: string): Promise<LeadActivity[]>;
  clearAll(): Promise<void>;
}

export interface ITasksRepository {
  findById(id: string): Promise<TaskItem | null>;
  listByClient(clientId: string): Promise<TaskItem[]>;
  listOpen(): Promise<TaskItem[]>;
  listAll(): Promise<TaskItem[]>;
  save(task: TaskItem): Promise<TaskItem>;
  /**
   * Insert-if-absent. Returns false when the document already exists, which is
   * how a replayed approval reports "created 0" without a read-then-write race.
   * This is the `ON CONFLICT … DO NOTHING` equivalent — never a merge, because a
   * merge would silently reset an already-completed task back to open.
   */
  create(task: TaskItem): Promise<boolean>;
  delete(id: string): Promise<void>;
  clearAll(): Promise<void>;
}

export interface IDocumentsRepository {
  save(doc: DocumentRecord): Promise<DocumentRecord>;
  listByAppointment(appointmentId: string): Promise<DocumentRecord[]>;
  clearAll(): Promise<void>;
}

export interface IConsentsRepository {
  save(consent: Consent): Promise<Consent>;
  findByClientAndType(clientId: string, type: string): Promise<Consent | null>;
  clearAll(): Promise<void>;
}

export interface IAuditRepository {
  log(event: AuditLog): Promise<AuditLog>;
  listForEntity(entityType: string, entityId: string, limit?: number): Promise<AuditLog[]>;
  listRecent(limit?: number, entityType?: string): Promise<AuditLog[]>;
  clearAll(): Promise<void>;
}

export interface IDatabase {
  clients: IClientsRepository;
  appointments: IAppointmentsRepository;
  conversations: IConversationsRepository;
  sessionNotes: ISessionNotesRepository;
  checkouts: ICheckoutsRepository;
  refills: IRefillsRepository;
  reengagement: IReengagementRepository;
  tasks: ITasksRepository;
  documents: IDocumentsRepository;
  consents: IConsentsRepository;
  audit: IAuditRepository;
}
