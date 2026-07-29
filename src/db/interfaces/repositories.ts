import type {
  Client,
  Appointment,
  Conversation,
  SessionNoteRecord,
  Approval,
  Revision,
  Checkout,
  Refill,
  RefillOrder,
  Lead,
  LeadActivity,
  TaskItem,
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
  findOverlapping(startTime: string, endTime: string): Promise<Appointment[]>;
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
  saveApproval(approval: Approval): Promise<Approval>;
  listApprovals(appointmentId: string): Promise<Approval[]>;
  saveRevision(revision: Revision): Promise<Revision>;
  listRevisions(appointmentId: string): Promise<Revision[]>;
  clearAll(): Promise<void>;
}

export interface ICheckoutsRepository {
  findById(id: string): Promise<Checkout | null>;
  findByAppointment(appointmentId: string): Promise<Checkout | null>;
  listAll(): Promise<Checkout[]>;
  save(checkout: Checkout): Promise<Checkout>;
  clearAll(): Promise<void>;
}

export interface IRefillsRepository {
  listAll(): Promise<Refill[]>;
  listByClient(clientId: string): Promise<Refill[]>;
  save(refill: Refill): Promise<Refill>;
  saveOrder(order: RefillOrder): Promise<RefillOrder>;
  listOrders(clientId?: string): Promise<RefillOrder[]>;
  clearAll(): Promise<void>;
}

export interface IReengagementRepository {
  listLeads(): Promise<Lead[]>;
  findLeadById(id: string): Promise<Lead | null>;
  saveLead(lead: Lead): Promise<Lead>;
  logActivity(activity: LeadActivity): Promise<LeadActivity>;
  listActivities(leadId: string): Promise<LeadActivity[]>;
  clearAll(): Promise<void>;
}

export interface ITasksRepository {
  findById(id: string): Promise<TaskItem | null>;
  listByClient(clientId: string): Promise<TaskItem[]>;
  listAll(): Promise<TaskItem[]>;
  save(task: TaskItem): Promise<TaskItem>;
  delete(id: string): Promise<void>;
  clearAll(): Promise<void>;
}

export interface IAuditRepository {
  log(event: AuditLog): Promise<AuditLog>;
  listAll(): Promise<AuditLog[]>;
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
  audit: IAuditRepository;
}
