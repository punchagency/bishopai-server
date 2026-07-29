import admin from 'firebase-admin';
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

function getFirestoreInstance(): admin.firestore.Firestore {
  if (admin.apps.length === 0) {
    admin.initializeApp();
  }
  return admin.firestore();
}

export class FirestoreClientsRepository implements IClientsRepository {
  private get db() {
    return getFirestoreInstance().collection('clients');
  }

  async findById(id: string): Promise<Client | null> {
    const doc = await this.db.doc(id).get();
    return doc.exists ? (doc.data() as Client) : null;
  }
  async findByEmail(email: string): Promise<Client | null> {
    const snap = await this.db.where('email', '==', email.toLowerCase()).limit(1).get();
    if (snap.empty) return null;
    return snap.docs[0].data() as Client;
  }
  async listAll(): Promise<Client[]> {
    const snap = await this.db.get();
    return snap.docs.map((doc) => doc.data() as Client);
  }
  async save(client: Client): Promise<Client> {
    await this.db.doc(client.id).set(client, { merge: true });
    return client;
  }
  async delete(id: string): Promise<void> {
    await this.db.doc(id).delete();
  }
  async clearAll(): Promise<void> {
    const snap = await this.db.get();
    const batch = getFirestoreInstance().batch();
    snap.docs.forEach((doc) => batch.delete(doc.ref));
    await batch.commit();
  }
}

export class FirestoreAppointmentsRepository implements IAppointmentsRepository {
  private get db() {
    return getFirestoreInstance().collection('appointments');
  }

  async findById(id: string): Promise<Appointment | null> {
    const doc = await this.db.doc(id).get();
    return doc.exists ? (doc.data() as Appointment) : null;
  }
  async listByClient(clientId: string): Promise<Appointment[]> {
    const snap = await this.db.where('client_id', '==', clientId).get();
    return snap.docs.map((doc) => doc.data() as Appointment);
  }
  async listAll(): Promise<Appointment[]> {
    const snap = await this.db.get();
    return snap.docs.map((doc) => doc.data() as Appointment);
  }
  async findOverlapping(startTime: string, endTime: string): Promise<Appointment[]> {
    const all = await this.listAll();
    const start = new Date(startTime).getTime();
    const end = new Date(endTime).getTime();
    return all.filter((app) => {
      const appStart = new Date(app.start_time).getTime();
      const appEnd = new Date(app.end_time).getTime();
      return appStart < end && appEnd > start;
    });
  }
  async save(appointment: Appointment): Promise<Appointment> {
    await this.db.doc(appointment.id).set(appointment, { merge: true });
    return appointment;
  }
  async delete(id: string): Promise<void> {
    await this.db.doc(id).delete();
  }
  async clearAll(): Promise<void> {
    const snap = await this.db.get();
    const batch = getFirestoreInstance().batch();
    snap.docs.forEach((doc) => batch.delete(doc.ref));
    await batch.commit();
  }
}

export class FirestoreConversationsRepository implements IConversationsRepository {
  private get db() {
    return getFirestoreInstance().collection('conversations');
  }

  async findById(id: string): Promise<Conversation | null> {
    const doc = await this.db.doc(id).get();
    return doc.exists ? (doc.data() as Conversation) : null;
  }
  async findByAppointment(appointmentId: string): Promise<Conversation | null> {
    const snap = await this.db.where('appointment_id', '==', appointmentId).limit(1).get();
    if (snap.empty) return null;
    return snap.docs[0].data() as Conversation;
  }
  async listUnmatched(): Promise<Conversation[]> {
    const snap = await this.db.where('status', '==', 'unmatched').get();
    return snap.docs.map((doc) => doc.data() as Conversation);
  }
  async listAll(): Promise<Conversation[]> {
    const snap = await this.db.get();
    return snap.docs.map((doc) => doc.data() as Conversation);
  }
  async save(conversation: Conversation): Promise<Conversation> {
    await this.db.doc(conversation.id).set(conversation, { merge: true });
    return conversation;
  }
  async delete(id: string): Promise<void> {
    await this.db.doc(id).delete();
  }
  async clearAll(): Promise<void> {
    const snap = await this.db.get();
    const batch = getFirestoreInstance().batch();
    snap.docs.forEach((doc) => batch.delete(doc.ref));
    await batch.commit();
  }
}

export class FirestoreSessionNotesRepository implements ISessionNotesRepository {
  private get db() {
    return getFirestoreInstance().collection('session_notes');
  }
  private get approvalsDb() {
    return getFirestoreInstance().collection('approvals');
  }
  private get revisionsDb() {
    return getFirestoreInstance().collection('revisions');
  }

  async findById(id: string): Promise<SessionNoteRecord | null> {
    const doc = await this.db.doc(id).get();
    return doc.exists ? (doc.data() as SessionNoteRecord) : null;
  }
  async findByAppointment(appointmentId: string): Promise<SessionNoteRecord | null> {
    const snap = await this.db.where('appointment_id', '==', appointmentId).limit(1).get();
    if (snap.empty) return null;
    return snap.docs[0].data() as SessionNoteRecord;
  }
  async listDrafts(): Promise<SessionNoteRecord[]> {
    const snap = await this.db.where('status', '==', 'draft').get();
    return snap.docs.map((doc) => doc.data() as SessionNoteRecord);
  }
  async listApproved(): Promise<SessionNoteRecord[]> {
    const snap = await this.db.where('status', '==', 'approved').get();
    return snap.docs.map((doc) => doc.data() as SessionNoteRecord);
  }
  async listAll(): Promise<SessionNoteRecord[]> {
    const snap = await this.db.get();
    return snap.docs.map((doc) => doc.data() as SessionNoteRecord);
  }
  async save(note: SessionNoteRecord): Promise<SessionNoteRecord> {
    await this.db.doc(note.id).set(note, { merge: true });
    return note;
  }
  async claimExtractionLock(appointmentId: string): Promise<boolean> {
    const firestore = getFirestoreInstance();
    const docRef = this.db.doc(appointmentId);

    return firestore.runTransaction(async (transaction) => {
      const doc = await transaction.get(docRef);
      if (!doc.exists) {
        transaction.set(docRef, {
          id: appointmentId,
          appointment_id: appointmentId,
          extraction_status: 'processing',
          status: 'draft',
          note_data: {},
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        });
        return true;
      }
      const data = doc.data() as SessionNoteRecord;
      if (data.extraction_status === 'pending' || data.extraction_status === 'failed') {
        transaction.update(docRef, {
          extraction_status: 'processing',
          updated_at: new Date().toISOString(),
        });
        return true;
      }
      return false;
    });
  }
  async saveApproval(approval: Approval): Promise<Approval> {
    await this.approvalsDb.doc(approval.id).set(approval, { merge: true });
    return approval;
  }
  async listApprovals(appointmentId: string): Promise<Approval[]> {
    const snap = await this.approvalsDb.where('appointment_id', '==', appointmentId).get();
    return snap.docs.map((doc) => doc.data() as Approval);
  }
  async saveRevision(revision: Revision): Promise<Revision> {
    await this.revisionsDb.doc(revision.id).set(revision, { merge: true });
    return revision;
  }
  async listRevisions(appointmentId: string): Promise<Revision[]> {
    const snap = await this.revisionsDb.where('appointment_id', '==', appointmentId).get();
    return snap.docs.map((doc) => doc.data() as Revision);
  }
  async clearAll(): Promise<void> {
    const snap = await this.db.get();
    const batch = getFirestoreInstance().batch();
    snap.docs.forEach((doc) => batch.delete(doc.ref));
    await batch.commit();
  }
}

export class FirestoreCheckoutsRepository implements ICheckoutsRepository {
  private get db() {
    return getFirestoreInstance().collection('checkouts');
  }

  async findById(id: string): Promise<Checkout | null> {
    const doc = await this.db.doc(id).get();
    return doc.exists ? (doc.data() as Checkout) : null;
  }
  async findByAppointment(appointmentId: string): Promise<Checkout | null> {
    const snap = await this.db.where('appointment_id', '==', appointmentId).limit(1).get();
    if (snap.empty) return null;
    return snap.docs[0].data() as Checkout;
  }
  async listAll(): Promise<Checkout[]> {
    const snap = await this.db.get();
    return snap.docs.map((doc) => doc.data() as Checkout);
  }
  async save(checkout: Checkout): Promise<Checkout> {
    await this.db.doc(checkout.id).set(checkout, { merge: true });
    return checkout;
  }
  async clearAll(): Promise<void> {
    const snap = await this.db.get();
    const batch = getFirestoreInstance().batch();
    snap.docs.forEach((doc) => batch.delete(doc.ref));
    await batch.commit();
  }
}

export class FirestoreRefillsRepository implements IRefillsRepository {
  private get db() {
    return getFirestoreInstance().collection('refills');
  }
  private get ordersDb() {
    return getFirestoreInstance().collection('refill_orders');
  }

  async listAll(): Promise<Refill[]> {
    const snap = await this.db.get();
    return snap.docs.map((doc) => doc.data() as Refill);
  }
  async listByClient(clientId: string): Promise<Refill[]> {
    const snap = await this.db.where('client_id', '==', clientId).get();
    return snap.docs.map((doc) => doc.data() as Refill);
  }
  async save(refill: Refill): Promise<Refill> {
    await this.db.doc(refill.id).set(refill, { merge: true });
    return refill;
  }
  async saveOrder(order: RefillOrder): Promise<RefillOrder> {
    await this.ordersDb.doc(order.id).set(order, { merge: true });
    return order;
  }
  async listOrders(clientId?: string): Promise<RefillOrder[]> {
    if (clientId) {
      const snap = await this.ordersDb.where('client_id', '==', clientId).get();
      return snap.docs.map((doc) => doc.data() as RefillOrder);
    }
    const snap = await this.ordersDb.get();
    return snap.docs.map((doc) => doc.data() as RefillOrder);
  }
  async clearAll(): Promise<void> {
    const snap = await this.db.get();
    const batch = getFirestoreInstance().batch();
    snap.docs.forEach((doc) => batch.delete(doc.ref));
    await batch.commit();
  }
}

export class FirestoreReengagementRepository implements IReengagementRepository {
  private get db() {
    return getFirestoreInstance().collection('leads');
  }
  private get activitiesDb() {
    return getFirestoreInstance().collection('lead_activity');
  }

  async listLeads(): Promise<Lead[]> {
    const snap = await this.db.get();
    return snap.docs.map((doc) => doc.data() as Lead);
  }
  async findLeadById(id: string): Promise<Lead | null> {
    const doc = await this.db.doc(id).get();
    return doc.exists ? (doc.data() as Lead) : null;
  }
  async saveLead(lead: Lead): Promise<Lead> {
    await this.db.doc(lead.id).set(lead, { merge: true });
    return lead;
  }
  async logActivity(activity: LeadActivity): Promise<LeadActivity> {
    await this.activitiesDb.doc(activity.id).set(activity, { merge: true });
    return activity;
  }
  async listActivities(leadId: string): Promise<LeadActivity[]> {
    const snap = await this.activitiesDb.where('lead_id', '==', leadId).get();
    return snap.docs.map((doc) => doc.data() as LeadActivity);
  }
  async clearAll(): Promise<void> {
    const snap = await this.db.get();
    const batch = getFirestoreInstance().batch();
    snap.docs.forEach((doc) => batch.delete(doc.ref));
    await batch.commit();
  }
}

export class FirestoreTasksRepository implements ITasksRepository {
  private get db() {
    return getFirestoreInstance().collection('tasks');
  }

  async findById(id: string): Promise<TaskItem | null> {
    const doc = await this.db.doc(id).get();
    return doc.exists ? (doc.data() as TaskItem) : null;
  }
  async listByClient(clientId: string): Promise<TaskItem[]> {
    const snap = await this.db.where('client_id', '==', clientId).get();
    return snap.docs.map((doc) => doc.data() as TaskItem);
  }
  async listAll(): Promise<TaskItem[]> {
    const snap = await this.db.get();
    return snap.docs.map((doc) => doc.data() as TaskItem);
  }
  async save(task: TaskItem): Promise<TaskItem> {
    await this.db.doc(task.id).set(task, { merge: true });
    return task;
  }
  async delete(id: string): Promise<void> {
    await this.db.doc(id).delete();
  }
  async clearAll(): Promise<void> {
    const snap = await this.db.get();
    const batch = getFirestoreInstance().batch();
    snap.docs.forEach((doc) => batch.delete(doc.ref));
    await batch.commit();
  }
}

export class FirestoreAuditRepository implements IAuditRepository {
  private get db() {
    return getFirestoreInstance().collection('audit_logs');
  }

  async log(event: AuditLog): Promise<AuditLog> {
    await this.db.doc(event.id).set(event, { merge: true });
    return event;
  }
  async listAll(): Promise<AuditLog[]> {
    const snap = await this.db.get();
    return snap.docs.map((doc) => doc.data() as AuditLog);
  }
  async clearAll(): Promise<void> {
    const snap = await this.db.get();
    const batch = getFirestoreInstance().batch();
    snap.docs.forEach((doc) => batch.delete(doc.ref));
    await batch.commit();
  }
}

export class FirestoreDatabase implements IDatabase {
  clients = new FirestoreClientsRepository();
  appointments = new FirestoreAppointmentsRepository();
  conversations = new FirestoreConversationsRepository();
  sessionNotes = new FirestoreSessionNotesRepository();
  checkouts = new FirestoreCheckoutsRepository();
  refills = new FirestoreRefillsRepository();
  reengagement = new FirestoreReengagementRepository();
  tasks = new FirestoreTasksRepository();
  audit = new FirestoreAuditRepository();
}
