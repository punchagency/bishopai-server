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
  CheckoutStatus,
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
  IntegrationState,
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
} from '../../interfaces/repositories.js';

/**
 * Lower bound for the overlap scan in findOverlapping. No session runs longer
 * than this, so an appointment starting earlier cannot still be running when the
 * candidate window opens. Generous on purpose: too large only costs a few extra
 * document reads, too small would miss a genuine conflict and double-book Nicole.
 */
const MAX_APPOINTMENT_HOURS = 24;

/**
 * Delete every document in the given collections.
 *
 * Chunked at 500 writes because that is Firestore's hard per-batch limit (§3.7) —
 * an unchunked batch silently works in tests and throws on a real dataset.
 *
 * Every repository that owns more than one collection must pass ALL of them. An
 * incomplete clearAll() is worse than none: fixtures survive into the next test
 * and produce failures that look like logic bugs.
 */
const BATCH_LIMIT = 500;

async function deleteAllDocs(
  collections: admin.firestore.CollectionReference[],
): Promise<void> {
  const firestore = getFirestoreInstance();
  for (const collection of collections) {
    // Re-query each pass: deleting shrinks the collection, so a single snapshot
    // taken up front would go stale on anything larger than one chunk.
    for (;;) {
      const snap = await collection.limit(BATCH_LIMIT).get();
      if (snap.empty) break;
      const batch = firestore.batch();
      snap.docs.forEach((doc) => batch.delete(doc.ref));
      await batch.commit();
      if (snap.size < BATCH_LIMIT) break;
    }
  }
}

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
    await deleteAllDocs([this.db]);
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
    // Chronological — every caller wants a client's visits in order. Uses the
    // declared (client_id, starts_at) composite index.
    const snap = await this.db
      .where('client_id', '==', clientId)
      .orderBy('starts_at', 'asc')
      .get();
    return snap.docs.map((doc) => doc.data() as Appointment);
  }
  async listAll(): Promise<Appointment[]> {
    const snap = await this.db.get();
    return snap.docs.map((doc) => doc.data() as Appointment);
  }
  async findOverlapping(startsAt: string, endsAt: string): Promise<Appointment[]> {
    // Overlap is `starts_at < endsAt AND ends_at > startsAt`, but Firestore
    // cannot range-filter two different fields in one query. So we range on
    // starts_at only and bound it BELOW as well — an appointment that ends after
    // `startsAt` cannot have begun more than MAX_APPOINTMENT_HOURS before it.
    // Without that lower bound this reads every appointment ever recorded and
    // filters in JS, which grows without limit and bills per document.
    const lowerBound = new Date(
      new Date(startsAt).getTime() - MAX_APPOINTMENT_HOURS * 3_600_000,
    ).toISOString();

    const snap = await this.db
      .where('starts_at', '>=', lowerBound)
      .where('starts_at', '<', endsAt)
      .get();

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
    await deleteAllDocs([this.db]);
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
    await deleteAllDocs([this.db, this.claimsDb]);
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
    await deleteAllDocs([this.db, this.sheetsDb, this.protocolsDb, this.approvalsDb, this.revisionsDb]);
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
  // Shared with the session flow — `approvals` is one unified table (0001).
  private get approvalsDb() {
    return getFirestoreInstance().collection('approvals');
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
    // A query, not a doc lookup: the document id is appointment_id (0023), so
    // pb_appointment_id is an ordinary field.
    const snap = await this.db.where('pb_appointment_id', '==', pbAppointmentId).limit(1).get();
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

  async createIfAbsent(checkout: Checkout): Promise<{ checkout: Checkout; created: boolean }> {
    const ref = this.db.doc(checkout.id);
    return getFirestoreInstance().runTransaction(async (tx) => {
      const doc = await tx.get(ref);
      if (doc.exists) {
        return { checkout: doc.data() as Checkout, created: false };
      }
      tx.create(ref, checkout);
      return { checkout, created: true };
    });
  }

  /**
   * The compare-and-set at the heart of the money path. In Postgres this was
   * `UPDATE checkout SET status=$to WHERE id=$1 AND status=$from` and the caller
   * read rowCount. Here the read and the write must sit in one transaction, or
   * two concurrent approvals could both observe AWAITING_APPROVAL and both charge.
   */
  async transition(
    id: string,
    from: CheckoutStatus,
    to: CheckoutStatus,
    patch: Partial<Checkout> = {},
  ): Promise<boolean> {
    const ref = this.db.doc(id);
    return getFirestoreInstance().runTransaction(async (tx) => {
      const doc = await tx.get(ref);
      if (!doc.exists) return false;
      if ((doc.data() as Checkout).status !== from) return false;
      tx.update(ref, { ...patch, status: to, updated_at: new Date().toISOString() });
      return true;
    });
  }

  async transitionWithApproval(
    id: string,
    from: CheckoutStatus,
    to: CheckoutStatus,
    approval: Approval,
  ): Promise<boolean> {
    const checkoutRef = this.db.doc(id);
    const approvalRef = this.approvalsDb.doc(approval.id);
    return getFirestoreInstance().runTransaction(async (tx) => {
      const doc = await tx.get(checkoutRef);
      if (!doc.exists) return false;
      if ((doc.data() as Checkout).status !== from) return false;
      tx.update(checkoutRef, { status: to, updated_at: new Date().toISOString() });
      tx.create(approvalRef, approval);
      return true;
    });
  }

  async markChargedWithReconciliation(
    checkoutId: string,
    patch: Partial<Checkout>,
    reconciliation: PaymentReconciliation,
  ): Promise<boolean> {
    const checkoutRef = this.db.doc(checkoutId);
    // Document id == checkout_id, which is what makes enqueue idempotent —
    // the pg table had UNIQUE(checkout_id) for exactly this reason.
    const reconRef = this.reconciliationsDb.doc(reconciliation.id);

    return getFirestoreInstance().runTransaction(async (tx) => {
      // ALL reads before ANY write — Firestore rejects a transaction that reads
      // after writing, so both documents must be fetched up front.
      const [doc, existing] = await Promise.all([tx.get(checkoutRef), tx.get(reconRef)]);
      if (!doc.exists) return false;
      if ((doc.data() as Checkout).status !== 'CHARGING') return false;

      // Both writes or neither: a captured charge without its outbox row would
      // silently never reach Nicole's books.
      tx.update(checkoutRef, { ...patch, status: 'CHARGED', updated_at: new Date().toISOString() });
      if (!existing.exists) tx.create(reconRef, reconciliation);
      return true;
    });
  }

  async claimIdempotencyKey(id: string, key: string): Promise<void> {
    const ref = this.db.doc(id);
    await getFirestoreInstance().runTransaction(async (tx) => {
      const doc = await tx.get(ref);
      if (!doc.exists) return;
      // Only if unset — mirrors `WHERE charge_idempotency_key IS NULL`, so a
      // replay within an attempt reuses the original key and QB replays the
      // original charge instead of creating a second one.
      if ((doc.data() as Checkout).charge_idempotency_key) return;
      tx.update(ref, { charge_idempotency_key: key });
    });
  }

  async listStuckCharging(cutoff: string): Promise<Checkout[]> {
    const snap = await this.db
      .where('status', '==', 'CHARGING')
      .where('updated_at', '<', cutoff)
      .get();
    return snap.docs.map((doc) => doc.data() as Checkout);
  }

  async reopenFailedCharge(id: string): Promise<boolean> {
    const ref = this.db.doc(id);
    return getFirestoreInstance().runTransaction(async (tx) => {
      const doc = await tx.get(ref);
      if (!doc.exists) return false;
      const row = doc.data() as Checkout;
      // ONLY a clean decline. CHARGE_REVIEW means money may have moved.
      if (row.status !== 'CHARGE_FAILED') return false;
      tx.update(ref, {
        status: 'AWAITING_APPROVAL',
        charge_attempts: (row.charge_attempts ?? 0) + 1,
        charge_idempotency_key: null,
        qb_txn_id: null,
        updated_at: new Date().toISOString(),
      });
      return true;
    });
  }

  async listApprovalsByCheckout(checkoutId: string, limit = 10): Promise<Approval[]> {
    const snap = await this.approvalsDb
      .where('checkout_id', '==', checkoutId)
      .where('type', '==', 'checkout')
      .orderBy('created_at', 'desc')
      .limit(limit)
      .get();
    return snap.docs.map((doc) => doc.data() as Approval);
  }

  async saveApproval(approval: Approval): Promise<Approval> {
    await this.approvalsDb.doc(approval.id).set(approval, { merge: true });
    return approval;
  }

  async patchApprovalPayload(id: string, patch: Record<string, unknown>): Promise<void> {
    const ref = this.approvalsDb.doc(id);
    await getFirestoreInstance().runTransaction(async (tx) => {
      const doc = await tx.get(ref);
      if (!doc.exists) return;
      const row = doc.data() as Approval;
      // Merge into the existing payload, mirroring `payload_json || $2::jsonb`.
      tx.update(ref, { payload_json: { ...(row.payload_json ?? {}), ...patch } });
    });
  }

  async listDueReconciliations(now: string, leaseCutoff: string): Promise<PaymentReconciliation[]> {
    // Two queries merged, because Firestore cannot express
    // `(status IN (..) AND next_attempt_at <= now) OR (status = RECORDING AND updated_at < cutoff)`
    // as one indexable query (§3.5).
    const [retryable, stale] = await Promise.all([
      this.reconciliationsDb
        .where('status', 'in', ['PENDING', 'FAILED'])
        .where('next_attempt_at', '<=', now)
        .get(),
      this.reconciliationsDb
        .where('status', '==', 'RECORDING')
        .where('updated_at', '<', leaseCutoff)
        .get(),
    ]);

    const byId = new Map<string, PaymentReconciliation>();
    for (const doc of [...retryable.docs, ...stale.docs]) {
      byId.set(doc.id, doc.data() as PaymentReconciliation);
    }
    return Array.from(byId.values()).sort((a, b) =>
      a.next_attempt_at.localeCompare(b.next_attempt_at),
    );
  }

  async claimReconciliation(id: string): Promise<boolean> {
    const ref = this.reconciliationsDb.doc(id);
    return getFirestoreInstance().runTransaction(async (tx) => {
      const doc = await tx.get(ref);
      if (!doc.exists) return false;
      const row = doc.data() as PaymentReconciliation;
      // A RECORDING row whose lease expired is reclaimable: the QBO requestid
      // makes the Payment write idempotent, so reclaiming a genuinely in-flight
      // row replays the same Payment rather than creating a second.
      if (row.status !== 'PENDING' && row.status !== 'FAILED' && row.status !== 'RECORDING') {
        return false;
      }
      tx.update(ref, {
        status: 'RECORDING',
        attempts: (row.attempts ?? 0) + 1,
        updated_at: new Date().toISOString(),
      });
      return true;
    });
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
    await deleteAllDocs([this.db, this.reconciliationsDb, this.qboDb]);
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
    await deleteAllDocs([this.db, this.supplementsDb, this.ordersDb]);
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
    await deleteAllDocs([this.db, this.activitiesDb]);
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
    // Ordered by the due_sort sentinel so "no due date" sorts last instead of
    // being dropped from the result — see DUE_SORT_NEVER in tasks/service.ts.
    // Uses the declared (status, due_sort) composite index.
    const snap = await this.db
      .where('status', '==', 'open')
      .orderBy('due_sort', 'asc')
      .get();
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
  async create(task: TaskItem): Promise<boolean> {
    try {
      await this.db.doc(task.id).create(task);
      return true;
    } catch (err) {
      // ALREADY_EXISTS (code 6) is the expected outcome of a replayed approval,
      // not an error. Anything else is real and must not be swallowed.
      if ((err as { code?: number }).code === 6) return false;
      throw err;
    }
  }
  async delete(id: string): Promise<void> {
    await this.db.doc(id).delete();
  }
  async clearAll(): Promise<void> {
    await deleteAllDocs([this.db]);
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
    await deleteAllDocs([this.db]);
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
    await deleteAllDocs([this.db]);
  }
}

export class FirestoreStateRepository implements IStateRepository {
  private get db() {
    return getFirestoreInstance().collection('integration_state');
  }

  async get(key: string): Promise<string | null> {
    // Document id == key, so this is an exact lookup, never a scan.
    const doc = await this.db.doc(key).get();
    return doc.exists ? ((doc.data() as IntegrationState).value ?? null) : null;
  }
  async set(key: string, value: string): Promise<void> {
    await this.db.doc(key).set(
      { key, value, updated_at: new Date().toISOString() } satisfies IntegrationState,
      { merge: true },
    );
  }
  async delete(key: string): Promise<void> {
    await this.db.doc(key).delete();
  }
  async clearAll(): Promise<void> {
    await deleteAllDocs([this.db]);
  }
}

export class FirestoreAuditRepository implements IAuditRepository {
  private get db() {
    return getFirestoreInstance().collection('audit_logs');
  }

  async log(event: AuditLog): Promise<AuditLog> {
    // APPEND-ONLY by contract (migrations/0024_audit_log.sql): "an audit you can
    // rewrite isn't one." create() enforces that at the datastore — a merge would
    // let a later write silently rewrite history under a colliding id.
    await this.db.doc(event.id).create(event);
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
    await deleteAllDocs([this.db]);
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
  state = new FirestoreStateRepository();
  audit = new FirestoreAuditRepository();
}
