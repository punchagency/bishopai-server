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

  /**
   * Insert-if-absent, keyed on the document id (== appointment_id). Returns the
   * existing row when one is already there, so re-detection is idempotent — the
   * `ON CONFLICT (appointment_id) DO NOTHING` equivalent.
   */
  createIfAbsent(checkout: Checkout): Promise<{ checkout: Checkout; created: boolean }>;

  /**
   * Atomic guarded transition — the compare-and-set that the entire
   * no-double-charge guarantee rests on. Returns true ONLY if the checkout was
   * in `from` and is now in `to`; a caller that loses the race MUST back off.
   *
   * `patch` is applied in the same atomic write, for fields that must land with
   * the transition (qb_txn_id on CHARGED) and never separately.
   */
  transition(
    id: string,
    from: CheckoutStatus,
    to: CheckoutStatus,
    patch?: Partial<Checkout>,
  ): Promise<boolean>;

  /**
   * AWAITING_APPROVAL → CHARGING *and* the approval record, in ONE transaction.
   * The approval is the authorization for the charge that follows; it must never
   * be missing for a checkout that went CHARGING, nor exist for one that didn't.
   * Returns false when the transition was lost, in which case NO approval is
   * written and the caller must not charge.
   */
  transitionWithApproval(
    id: string,
    from: CheckoutStatus,
    to: CheckoutStatus,
    approval: Approval,
  ): Promise<boolean>;

  /**
   * CHARGING → CHARGED *and* the reconciliation intent, in ONE transaction.
   * A captured charge must never exist without its outbox row, and an outbox row
   * must never exist for a checkout that isn't CHARGED.
   *
   * Returns false when the transition was lost (e.g. the stuck-charge sweeper
   * moved the row to CHARGE_REVIEW while a slow charge was succeeding), in which
   * case NO reconciliation is enqueued.
   */
  markChargedWithReconciliation(
    checkoutId: string,
    patch: Partial<Checkout>,
    reconciliation: PaymentReconciliation,
  ): Promise<boolean>;

  /** Claim the idempotency key only if unset — mirrors the `IS NULL` guard. */
  claimIdempotencyKey(id: string, key: string): Promise<void>;

  /** Checkouts stranded in CHARGING before `cutoff` — presumed crashed mid-flight. */
  listStuckCharging(cutoff: string): Promise<Checkout[]>;

  /**
   * CHARGE_FAILED → AWAITING_APPROVAL, bumping charge_attempts and clearing the
   * stored key so the next approve mints a NEW idempotency key and is genuinely a
   * new charge rather than a replay of the decline.
   *
   * Deliberately refuses CHARGE_REVIEW: there, money may already have moved, and
   * re-charging would double-charge.
   */
  reopenFailedCharge(id: string): Promise<boolean>;

  /** Money approvals for a checkout, newest first. */
  listApprovalsByCheckout(checkoutId: string, limit?: number): Promise<Approval[]>;
  saveApproval(approval: Approval): Promise<Approval>;
  /** Merge fields into an approval's payload_json (the charge-outcome stamp). */
  patchApprovalPayload(id: string, patch: Record<string, unknown>): Promise<void>;

  saveReconciliation(rec: PaymentReconciliation): Promise<PaymentReconciliation>;
  findReconciliationByCheckout(checkoutId: string): Promise<PaymentReconciliation | null>;
  listPendingReconciliations(): Promise<PaymentReconciliation[]>;
  /** Rows due for a reconciliation attempt: backoff elapsed, or lease expired. */
  listDueReconciliations(now: string, leaseCutoff: string): Promise<PaymentReconciliation[]>;
  /** Claim PENDING/FAILED → RECORDING atomically so two workers can't both record. */
  claimReconciliation(id: string): Promise<boolean>;

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
