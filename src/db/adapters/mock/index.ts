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
    return Array.from(this.appointments.values()).filter((a) => a.client_id === clientId);
  }
  async listAll(): Promise<Appointment[]> {
    return Array.from(this.appointments.values());
  }
  async findOverlapping(startTime: string, endTime: string): Promise<Appointment[]> {
    const start = new Date(startTime).getTime();
    const end = new Date(endTime).getTime();
    return Array.from(this.appointments.values()).filter((app) => {
      const appStart = new Date(app.start_time).getTime();
      const appEnd = new Date(app.end_time).getTime();
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
  async delete(id: string): Promise<void> {
    this.conversations.delete(id);
  }
  async clearAll(): Promise<void> {
    this.conversations.clear();
  }
}

export class MockSessionNotesRepository implements ISessionNotesRepository {
  private notes = new Map<string, SessionNoteRecord>();
  private approvals: Approval[] = [];
  private revisions: Revision[] = [];

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
  async saveApproval(approval: Approval): Promise<Approval> {
    this.approvals.push(approval);
    return approval;
  }
  async listApprovals(appointmentId: string): Promise<Approval[]> {
    return this.approvals.filter((a) => a.appointment_id === appointmentId);
  }
  async saveRevision(revision: Revision): Promise<Revision> {
    this.revisions.push(revision);
    return revision;
  }
  async listRevisions(appointmentId: string): Promise<Revision[]> {
    return this.revisions.filter((r) => r.appointment_id === appointmentId);
  }
  async clearAll(): Promise<void> {
    this.notes.clear();
    this.approvals = [];
    this.revisions = [];
  }
}

export class MockCheckoutsRepository implements ICheckoutsRepository {
  private checkouts = new Map<string, Checkout>();

  async findById(id: string): Promise<Checkout | null> {
    return this.checkouts.get(id) ?? null;
  }
  async findByAppointment(appointmentId: string): Promise<Checkout | null> {
    for (const item of this.checkouts.values()) {
      if (item.appointment_id === appointmentId) return item;
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
  async clearAll(): Promise<void> {
    this.checkouts.clear();
  }
}

export class MockRefillsRepository implements IRefillsRepository {
  private refills = new Map<string, Refill>();
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
  async listAll(): Promise<TaskItem[]> {
    return Array.from(this.tasks.values());
  }
  async save(task: TaskItem): Promise<TaskItem> {
    this.tasks.set(task.id, task);
    return task;
  }
  async delete(id: string): Promise<void> {
    this.tasks.delete(id);
  }
  async clearAll(): Promise<void> {
    this.tasks.clear();
  }
}

export class MockAuditRepository implements IAuditRepository {
  private logs: AuditLog[] = [];

  async log(event: AuditLog): Promise<AuditLog> {
    this.logs.push(event);
    return event;
  }
  async listAll(): Promise<AuditLog[]> {
    return this.logs;
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
  audit = new MockAuditRepository();
}
