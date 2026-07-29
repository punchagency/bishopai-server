import admin from 'firebase-admin';
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
  async findOverlapping(startsAt: string, endsAt: string): Promise<Appointment[]> {
    // Range query on starts_at indexed field
    const snap = await this.db.where('starts_at', '<', endsAt).get();
    const end = new Date(endsAt).getTime();
    const start = new Date(startsAt).getTime();

    return snap.docs
      .map((doc) => doc.data() as Appointment)
      .filter((app) => {
        const appStart = new Date(app.starts_at).getTime();
        const appEnd = new Date(app.ends_at).getTime();
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
  private get claimsDb() {
    return getFirestoreInstance().collection('appointment_claims');
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
  async claimAppointment(claim: AppointmentClaim): Promise<boolean> {
    try {
      await this.claimsDb.doc(claim.id).create(claim);
      return true;
    } catch {
      return false; // Doc already exists (collision)
    }
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
  private get sheetsDb() {
    return getFirestoreInstance().collection('appointment_sheets');
  }
  private get protocolsDb() {
    return getFirestoreInstance().collection('supplement_protocols');
  }
  private get approvalsDb() {
    return getFirestoreInstance().collection('approvals');
  }
  private get revisionsDb() {
    return getFirestoreInstance().collection('note_revisions');
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
  async saveSheet(sheet: AppointmentSheet): Promise<AppointmentSheet> {
    await this.sheetsDb.doc(sheet.id).set(sheet, { merge: true });
    return sheet;
  }
  async findSheetByAppointment(appointmentId: string): Promise<AppointmentSheet | null> {
    const snap = await this.sheetsDb.where('appointment_id', '==', appointmentId).limit(1).get();
    if (snap.empty) return null;
    return snap.docs[0].data() as AppointmentSheet;
  }
  async saveProtocol(protocol: SupplementProtocol): Promise<SupplementProtocol> {
    await this.protocolsDb.doc(protocol.id).set(protocol, { merge: true });
    return protocol;
  }
  async findProtocolByAppointment(appointmentId: string): Promise<SupplementProtocol | null> {
    const snap = await this.protocolsDb.where('appointment_id', '==', appointmentId).limit(1).get();
    if (snap.empty) return null;
    return snap.docs[0].data() as SupplementProtocol;
  }
  async saveApproval(approval: Approval): Promise<Approval> {
    await this.approvalsDb.doc(approval.id).set(approval, { merge: true });
    return approval;
  }
  async listApprovals(appointmentId: string): Promise<Approval[]> {
    const snap = await this.approvalsDb.where('appointment_id', '==', appointmentId).get();
    return snap.docs.map((doc) => doc.data() as Approval);
  }
  async saveRevision(revision: NoteRevision): Promise<NoteRevision> {
    await this.revisionsDb.doc(revision.id).set(revision, { merge: true });
    return revision;
  }
  async listRevisions(appointmentId: string): Promise<NoteRevision[]> {
    const snap = await this.revisionsDb.where('appointment_id', '==', appointmentId).get();
    return snap.docs.map((doc) => doc.data() as NoteRevision);
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
  private get reconciliationsDb() {
    return getFirestoreInstance().collection('payment_reconciliations');
  }
  private get qboDb() {
    return getFirestoreInstance().collection('client_qbo_map');
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
  async findByPbAppointmentId(pbAppointmentId: string): Promise<Checkout | null> {
    const doc = await this.db.doc(pbAppointmentId).get();
    return doc.exists ? (doc.data() as Checkout) : null;
  }
  async listAll(): Promise<Checkout[]> {
    const snap = await this.db.get();
    return snap.docs.map((doc) => doc.data() as Checkout);
  }
  async save(checkout: Checkout): Promise<Checkout> {
    await this.db.doc(checkout.id).set(checkout, { merge: true });
    return checkout;
  }
  async saveReconciliation(rec: PaymentReconciliation): Promise<PaymentReconciliation> {
    await this.reconciliationsDb.doc(rec.id).set(rec, { merge: true });
    return rec;
  }
  async findReconciliationByCheckout(checkoutId: string): Promise<PaymentReconciliation | null> {
    const snap = await this.reconciliationsDb.where('checkout_id', '==', checkoutId).limit(1).get();
    if (snap.empty) return null;
    return snap.docs[0].data() as PaymentReconciliation;
  }
  async listPendingReconciliations(): Promise<PaymentReconciliation[]> {
    const snap = await this.reconciliationsDb.where('status', '==', 'PENDING').get();
    return snap.docs.map((doc) => doc.data() as PaymentReconciliation);
  }
  async saveQboMap(map: ClientQboMap): Promise<ClientQboMap> {
    await this.qboDb.doc(map.client_id).set(map, { merge: true });
    return map;
  }
  async findQboMapByClient(clientId: string): Promise<ClientQboMap | null> {
    const doc = await this.qboDb.doc(clientId).get();
    return doc.exists ? (doc.data() as ClientQboMap) : null;
  }
  async listQboMaps(): Promise<ClientQboMap[]> {
    const snap = await this.qboDb.get();
    return snap.docs.map((doc) => doc.data() as ClientQboMap);
  }
  async deleteQboMap(clientId: string): Promise<void> {
    await this.qboDb.doc(clientId).delete();
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
  private get supplementsDb() {
    return getFirestoreInstance().collection('supplements');
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
  async saveSupplement(supp: Supplement): Promise<Supplement> {
    await this.supplementsDb.doc(supp.id).set(supp, { merge: true });
    return supp;
  }
  async listSupplementsByClient(clientId: string): Promise<Supplement[]> {
    const snap = await this.supplementsDb.where('client_id', '==', clientId).get();
    return snap.docs.map((doc) => doc.data() as Supplement);
  }
  async listAllSupplements(): Promise<Supplement[]> {
    const snap = await this.supplementsDb.get();
    return snap.docs.map((doc) => doc.data() as Supplement);
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
  async findLeadByEmail(email: string): Promise<Lead | null> {
    const snap = await this.db.where('email', '==', email.toLowerCase()).limit(1).get();
    if (snap.empty) return null;
    return snap.docs[0].data() as Lead;
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
  async listOpen(): Promise<TaskItem[]> {
    const snap = await this.db.where('status', '==', 'open').get();
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

export class FirestoreDocumentsRepository implements IDocumentsRepository {
  private get db() {
    return getFirestoreInstance().collection('documents');
  }

  async save(doc: DocumentRecord): Promise<DocumentRecord> {
    await this.db.doc(doc.id).set(doc, { merge: true });
    return doc;
  }
  async listByAppointment(appointmentId: string): Promise<DocumentRecord[]> {
    const snap = await this.db.where('appointment_id', '==', appointmentId).get();
    return snap.docs.map((d) => d.data() as DocumentRecord);
  }
  async clearAll(): Promise<void> {
    const snap = await this.db.get();
    const batch = getFirestoreInstance().batch();
    snap.docs.forEach((doc) => batch.delete(doc.ref));
    await batch.commit();
  }
}

export class FirestoreConsentsRepository implements IConsentsRepository {
  private get db() {
    return getFirestoreInstance().collection('consents');
  }

  async save(consent: Consent): Promise<Consent> {
    await this.db.doc(consent.id).set(consent, { merge: true });
    return consent;
  }
  async findByClientAndType(clientId: string, type: string): Promise<Consent | null> {
    const doc = await this.db.doc(`${clientId}__${type}`).get();
    return doc.exists ? (doc.data() as Consent) : null;
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
  async listForEntity(entityType: string, entityId: string, limit = 100): Promise<AuditLog[]> {
    const snap = await this.db
      .where('entity_type', '==', entityType)
      .where('entity_id', '==', entityId)
      .orderBy('created_at', 'desc')
      .limit(limit)
      .get();
    return snap.docs.map((doc) => doc.data() as AuditLog);
  }
  async listRecent(limit = 100, entityType?: string): Promise<AuditLog[]> {
    let query: admin.firestore.Query = this.db;
    if (entityType) {
      query = query.where('entity_type', '==', entityType);
    }
    const snap = await query.orderBy('created_at', 'desc').limit(limit).get();
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
  documents = new FirestoreDocumentsRepository();
  consents = new FirestoreConsentsRepository();
  audit = new FirestoreAuditRepository();
}
