import type {
  Client,
  Appointment,
  Conversation,
  ExtractionStatus,
  AppointmentClaim,
  SessionNoteRecord,
  AppointmentSheet,
  SupplementProtocol,
  PbProtocol,
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
  MessageRecord,
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
  findByPbId(pbId: string): Promise<Client | null>;
  listAll(): Promise<Client[]>;
  save(client: Client): Promise<Client>;

  /**
   * `ON CONFLICT (pb_id) DO UPDATE` — find-or-create the client behind a PB
   * record, keyed on the PB id.
   *
   * `clients.pb_id` was a UNIQUE column, and Firestore has no unique index on a
   * non-ID field, so uniqueness moves to an index document keyed on the PB id
   * (§3.1). It is claimed inside the same transaction that creates the client,
   * which is what stops two concurrent poll ticks creating two client records
   * for one person — a duplicate that would then split their chart in half.
   */
  upsertByPbId(pbId: string, fields: { name: string; email?: string | null }): Promise<Client>;

  delete(id: string): Promise<void>;
  clearAll(): Promise<void>;
}

export interface IAppointmentsRepository {
  findById(id: string): Promise<Appointment | null>;
  listByClient(clientId: string): Promise<Appointment[]>;
  listAll(): Promise<Appointment[]>;
  /** Newest first, capped — the working window every listing scans. */
  listRecent(limit: number): Promise<Appointment[]>;
  /** Bookings still ahead of `nowIso`. A count() aggregation — reads no documents. */
  countUpcoming(nowIso: string): Promise<number>;
  /** The next `limit` bookings after `nowIso`, soonest first. */
  listUpcoming(nowIso: string, limit: number): Promise<Appointment[]>;
  /** Appointments starting inside a window, chronological. */
  listBetween(fromIso: string, toIso: string): Promise<Appointment[]>;
  findByPbId(pbId: string): Promise<Appointment | null>;
  findOverlapping(startsAt: string, endsAt: string): Promise<Appointment[]>;
  save(appointment: Appointment): Promise<Appointment>;

  /**
   * `ON CONFLICT (pb_id) DO UPDATE` — land a PB booking, keyed on the PB id.
   *
   * Same index-document mechanism as clients.upsertByPbId. Returns the row as
   * it now stands plus the status it had BEFORE, because the caller fires
   * checkout detection and cancellation enrollment only on an actual change —
   * without that, every poll tick would re-fire them.
   */
  upsertByPbId(
    pbId: string,
    fields: { client_id: string; client_name: string | null; starts_at: string; ends_at: string; status: string },
  ): Promise<{ appointment: Appointment; previousStatus: string | null }>;
  delete(id: string): Promise<void>;
  clearAll(): Promise<void>;
}

export interface IConversationsRepository {
  findById(id: string): Promise<Conversation | null>;
  findByAppointment(appointmentId: string): Promise<Conversation | null>;
  listUnmatched(): Promise<Conversation[]>;
  listAll(): Promise<Conversation[]>;
  save(conversation: Conversation): Promise<Conversation>;

  /**
   * Insert-if-absent keyed on the document id (== bee_id), replacing
   * `ON CONFLICT (bee_id) DO UPDATE SET transcript = COALESCE(...)`.
   *
   * On a replay this keeps the STORED assignment — which may be a manual one a
   * human made — and only fills in a transcript that was missing. Recomputing
   * the correlation and overwriting would undo Nicole's corrections.
   */
  upsertByBeeId(conversation: Conversation): Promise<{ conversation: Conversation; created: boolean }>;

  /**
   * Guarded extraction-state transition, the equivalent of the `UPDATE …
   * WHERE extraction_status IN (…)` that doubles as claim and lock.
   *
   * Returns the POST-write row, or null when the guard refused — a caller that
   * gets null must drop whatever it was about to write. `guard` runs inside the
   * transaction against the row just read, so it must be pure and re-runnable
   * (Firestore aborts and RETRIES a losing transaction rather than blocking it).
   */
  transitionExtraction(
    id: string,
    from: ExtractionStatus[],
    patch: Partial<Conversation>,
    guard?: (row: Conversation) => boolean,
  ): Promise<Conversation | null>;

  /** Rows whose extraction lease has expired — their owner is presumed dead. */
  listStuckExtractions(leaseCutoff: string): Promise<Conversation[]>;
  /** `failed` rows that have exhausted their attempts and need a human. */
  listExhaustedExtractions(maxAttempts: number): Promise<Conversation[]>;
  /** `failed` rows whose backoff has elapsed and which are actually processable. */
  listDueExtractions(now: string, maxAttempts: number, limit: number): Promise<Conversation[]>;

  /** Recordings still waiting for a human to place. */
  countUnmatched(): Promise<number>;

  claimAppointment(claim: AppointmentClaim): Promise<boolean>;
  /** Release an appointment claim — an unmatch hands the slot back. */
  releaseAppointment(appointmentId: string): Promise<void>;
  delete(id: string): Promise<void>;
  clearAll(): Promise<void>;
}

/**
 * Both halves of one session note. They hold byte-identical content and differ
 * only in how they render, so every write touches both — see the header comment
 * in session/sessionService.ts for why divergence was reachable before.
 */
export interface SessionDocs {
  sheet: AppointmentSheet | null;
  protocol: SupplementProtocol | null;
}

export interface GuardedSessionWrite {
  appointmentId: string;
  /**
   * Combined status (see combineStatus) the session must already be in. This is
   * the compare-and-set: patch requires not-approved, amend requires approved,
   * and a caller that loses the race gets `ok: false` rather than a half-applied
   * second approval.
   */
  expect: DocStatus[];
  /** Written to BOTH documents. */
  content?: Record<string, unknown>;
  /** Written to BOTH documents. */
  status?: DocStatus;
  /**
   * File the PRE-write content into note_revisions and bump each document's
   * revision counter, in the same transaction. The counter lives on the document
   * itself so numbering needs no MAX() aggregate — and the revision document id
   * still carries `note_revisions_unique`, so a double-submitted amendment
   * cannot file the same superseded version twice.
   */
  snapshotRevision?: { reason: string | null };
  /**
   * Created in the SAME transaction as the status change. An approval that
   * exists for a session that didn't move, or a session that moved without its
   * approval, are both corruption — this is the session-path equivalent of the
   * money path's transitionWithApproval.
   */
  approval?: Approval;
}

export type GuardedSessionResult =
  | { ok: true; before: SessionDocs; revision: number }
  | { ok: false; reason: 'not_found' | 'wrong_status'; before: SessionDocs };

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
  /**
   * Remove an approval by id.
   *
   * Approvals are a sign-off record, so nothing operator-facing deletes one —
   * this exists for teardown (the demo seed, tests). It matters because approval
   * ids are DETERMINISTIC (`approval_${checkoutId}_${attempt}`): an approval
   * left behind by a previous run makes the next approve of the same checkout
   * fail on ALREADY_EXISTS rather than proceed.
   */
  deleteApproval(id: string): Promise<void>;

  /** History behind one live row, newest superseded version first. */
  listRevisions(sourceTable: NoteTable, sourceId: string): Promise<NoteRevision[]>;

  /**
   * PB-synced protocol metadata, keyed on the PB protocol id so a re-sync
   * overwrites rather than appends. Kept out of the session protocols
   * collection — see PbProtocol for why.
   */
  savePbProtocol(protocol: PbProtocol): Promise<PbProtocol>;
  listPbProtocolsByClient(clientId: string): Promise<PbProtocol[]>;

  /** Sessions with at least one document not yet approved. */
  countAwaitingReview(): Promise<number>;
  /** Approvals filed at or after `sinceIso` — the "approved today" tile. */
  countApprovalsSince(sinceIso: string): Promise<number>;

  /** Both halves of a session, by known ref — never a scan. */
  findSessionDocs(appointmentId: string): Promise<SessionDocs>;

  /**
   * Read both documents, assert the combined status, and write them together —
   * the replacement for `SELECT … FOR UPDATE` on both rows followed by two
   * UPDATEs. Everything that must land with the status change (the approval
   * record, the revision snapshots) lands inside the same transaction.
   *
   * NOTHING that touches Drive, email, or the LLM may be called from here: a
   * Firestore transaction is retried on contention, so a side effect inside it
   * can run twice (§3.3). Sequence is: transact, then publish, then record.
   */
  guardedWrite(args: GuardedSessionWrite): Promise<GuardedSessionResult>;

  /**
   * Land an extraction result on both documents unless the session is already
   * approved. Returns false when an approved note was left untouched — approved
   * clinical content only ever changes through amend, which snapshots what it
   * supersedes.
   */
  saveExtractedNote(args: {
    appointmentId: string;
    clientId: string | null;
    /** Denormalized onto both documents — see AppointmentSheet.starts_at. */
    startsAt: string | null;
    clientName: string | null;
    content: Record<string, unknown>;
  }): Promise<{ written: boolean }>;

  /**
   * A client's sessions, oldest first, optionally only the approved ones.
   *
   * Ordered by the denormalized `starts_at` — when the session happened — not by
   * updated_at. The Flow Sheet rebuild depends on this being visit order, since
   * it stacks one block per visit in the same sequence Nicole's paper sheet does.
   */
  listProtocolsByClient(
    clientId: string,
    opts?: { status?: DocStatus; limit?: number },
  ): Promise<SupplementProtocol[]>;

  /**
   * The client's most recent approved session BEFORE `before`, excluding
   * `excludeAppointmentId`.
   *
   * The exclusion is by appointment, not document id: a sheet and its protocol
   * share an appointment but are different documents, so excluding on id alone
   * would offer this very session back as its own prior history.
   */
  findPriorApproved(
    kind: 'sheet' | 'protocol',
    clientId: string,
    opts: { excludeAppointmentId: string | null; before: string | null },
  ): Promise<AppointmentSheet | SupplementProtocol | null>;

  /** A client's approved sessions before a cutoff, newest first, plus the count. */
  listApprovedHistory(
    clientId: string,
    opts: { excludeAppointmentId: string | null; before: string | null; limit: number },
  ): Promise<{ total: number; sessions: Array<{ starts_at: string | null; content_json: unknown }> }>;

  /**
   * Both halves for many appointments at once, by known ref. Document id ==
   * appointment_id, so this is a parallel getAll rather than a join (§3.4) —
   * which is what lets listSessions stay one appointments query plus one batch
   * fetch instead of a collection scan.
   */
  findManySessionDocs(appointmentIds: string[]): Promise<Map<string, SessionDocs>>;

  /** Drop both documents for an appointment — an unmatch discards its drafts. */
  deleteSessionDocs(appointmentId: string): Promise<void>;

  clearAll(): Promise<void>;
}

export interface ICheckoutsRepository {
  findById(id: string): Promise<Checkout | null>;
  findByAppointment(appointmentId: string): Promise<Checkout | null>;
  findByPbAppointmentId(pbAppointmentId: string): Promise<Checkout | null>;
  listAll(): Promise<Checkout[]>;
  /** One client's checkouts. Small by construction — a client has a few visits. */
  listByClient(clientId: string): Promise<Checkout[]>;
  /** Checkouts still needing attention — anything not settled or cleanly failed. */
  countAwaiting(): Promise<number>;
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
  /** The whole ledger, newest first; optionally one status (the review queue). */
  listReconciliations(status?: string | null): Promise<PaymentReconciliation[]>;
  /**
   * FAILED/NEEDS_REVIEW → PENDING with the backoff cleared, so Nicole's "retry
   * now" actually re-drives the row. A compare-and-set, not a blind update: a
   * row that has since RECORDED must not be dragged back into the queue and
   * recorded a second time. Returns the reset row, or null if it wasn't in a
   * retryable status.
   */
  retryReconciliation(id: string): Promise<PaymentReconciliation | null>;
  /** Rows due for a reconciliation attempt: backoff elapsed, or lease expired. */
  listDueReconciliations(now: string, leaseCutoff: string): Promise<PaymentReconciliation[]>;
  /** Claim PENDING/FAILED → RECORDING atomically so two workers can't both record. */
  claimReconciliation(id: string): Promise<boolean>;

  saveQboMap(map: ClientQboMap): Promise<ClientQboMap>;
  findQboMapByClient(clientId: string): Promise<ClientQboMap | null>;
  listQboMaps(): Promise<ClientQboMap[]>;
  deleteQboMap(clientId: string): Promise<void>;
  /**
   * Remove a checkout with its reconciliation row. Money-path data — this exists
   * for teardown (the demo seed, tests), NOT for any operator-facing flow: a
   * charged checkout is a financial record and nothing in the app deletes one.
   */
  deleteCheckout(id: string): Promise<void>;
  
  clearAll(): Promise<void>;
}

export interface IRefillsRepository {
  listAll(): Promise<Refill[]>;
  listByClient(clientId: string): Promise<Refill[]>;
  save(refill: Refill): Promise<Refill>;
  saveSupplement(supp: Supplement): Promise<Supplement>;
  /** By normalized identity, not spoken name — see Supplement.name_key. */
  findSupplement(clientId: string, nameKey: string): Promise<Supplement | null>;
  /** Returns false when there was nothing to remove (the pg rowCount). */
  deleteSupplement(clientId: string, nameKey: string): Promise<boolean>;
  listSupplementsByClient(clientId: string): Promise<Supplement[]>;
  listAllSupplements(): Promise<Supplement[]>;
  saveOrder(order: RefillOrder): Promise<RefillOrder>;
  listOrders(clientId?: string): Promise<RefillOrder[]>;
  /** Orders against specific refills — what the brief's "ordered" flag reads. */
  listOrdersForRefills(refillIds: string[]): Promise<RefillOrder[]>;
  /** Refills due on or before `onOrBefore`, soonest first. */
  listDue(onOrBefore: string, limit?: number): Promise<Refill[]>;
  /** One status's refills — the cadence and digest both scan `pending`. */
  listByStatus(status: RefillStatus): Promise<Refill[]>;
  /** Several statuses at once, soonest due first — the digest's open set. */
  listByStatuses(statuses: RefillStatus[]): Promise<Refill[]>;
  /** How many refills sit in any of these statuses. */
  countByStatuses(statuses: RefillStatus[]): Promise<number>;
  /** By document id (`${client_id}__${name_key}`) — the refill's supplement_id. */
  findSupplementById(id: string): Promise<Supplement | null>;
  findById(id: string): Promise<Refill | null>;
  findRefillBySupplement(supplementId: string): Promise<Refill | null>;
  /**
   * Remove a refill and the orders raised against it.
   *
   * `refill_orders.refill_id REFERENCES refills ON DELETE CASCADE` is gone with
   * Postgres (§7), so the cascade is written by hand here rather than left to
   * each caller to remember.
   */
  deleteRefill(id: string): Promise<void>;
  clearAll(): Promise<void>;
}

export interface IReengagementRepository {
  listLeads(): Promise<Lead[]>;
  /** Leads still in a cadence — everything not closed or booked. */
  listActiveLeads(): Promise<Lead[]>;
  /** Leads in one status, e.g. the 'booked' claims the reconcile sweep checks. */
  listLeadsByStatus(status: string): Promise<Lead[]>;
  /** How many leads sit in any of these statuses. */
  countLeadsByStatuses(statuses: string[]): Promise<number>;
  findLeadById(id: string): Promise<Lead | null>;
  findLeadByEmail(email: string): Promise<Lead | null>;
  /**
   * Every lead ever recorded for an address, newest first.
   *
   * Deliberately plural: one address legitimately has several leads over time
   * (they enquired, went quiet, closed, then enquired again a year later), and
   * intake must be able to tell an active one from a settled one.
   */
  listLeadsByEmail(email: string): Promise<Lead[]>;
  saveLead(lead: Lead): Promise<Lead>;
  /**
   * A lead replied: flip the status and file the 'reply' activity together, or
   * neither. This was a pg `BEGIN … COMMIT` around the two statements, because
   * a status of 'replied' with no activity row loses the reply itself, and an
   * activity row against a lead still in a cadence means the automation keeps
   * emailing someone who already answered. Returns null when the lead is gone.
   */
  markLeadReplied(leadId: string, activity: LeadActivity): Promise<Lead | null>;
  /**
   * Compare-and-set the lead to 'booked' — the optimistic claim the public
   * click-to-book flow takes BEFORE calling Practice Better, so no lock is held
   * across a network call. A concurrent submit for the same lead loses the race
   * and gets null, which is the whole point: two clicks must not create two
   * sessions. Returns the status it held before, so a failed booking can put it
   * back exactly where it was.
   */
  claimLeadForBooking(leadId: string): Promise<{ lead: Lead; previousStatus: string } | null>;
  /** Undo the claim above, but only while we still own it (`status = 'booked'`). */
  releaseLeadBookingClaim(leadId: string, previousStatus: string): Promise<void>;
  logActivity(activity: LeadActivity): Promise<LeadActivity>;
  listActivities(leadId: string): Promise<LeadActivity[]>;
  /** Activity across all leads since a cutoff, newest first — the engagement view. */
  listRecentActivity(since: string, limit?: number): Promise<LeadActivity[]>;
  /** The newest `limit` activity rows regardless of age — the live feed. */
  listActivityFeed(limit: number): Promise<LeadActivity[]>;
  /**
   * Per-lead activity count and latest timestamp.
   *
   * Replaces the two correlated subqueries on the leads listing. A count()
   * aggregation plus a `limit(1)` read per lead costs one document read each,
   * where loading every activity row to count them in JS would be unbounded.
   */
  summarizeActivity(
    leadIds: string[],
  ): Promise<Map<string, { count: number; last_activity: string | null }>>;

  /**
   * Record a sent message. Throws when it is addressed to both a client and a
   * lead, or to neither — that was `messages_one_recipient`, and Firestore has
   * no CHECK constraint to enforce it (§7), so it is enforced here.
   */
  logMessage(message: MessageRecord): Promise<MessageRecord>;
  listMessagesForLead(leadId: string): Promise<MessageRecord[]>;
  /**
   * Remove a lead with its activity and messages — the hand-written replacement
   * for the two `ON DELETE CASCADE` FKs that pointed at `leads` (§7).
   */
  deleteLead(id: string): Promise<void>;
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
  /** Everything published for a client, newest first — the real access path. */
  listByClient(clientId: string, limit?: number): Promise<DocumentRecord[]>;
  listByAppointment(appointmentId: string): Promise<DocumentRecord[]>;
  clearAll(): Promise<void>;
}

export interface IConsentsRepository {
  save(consent: Consent): Promise<Consent>;
  findByClientAndType(clientId: string, type: string): Promise<Consent | null>;
  listByClient(clientId: string): Promise<Consent[]>;
  clearAll(): Promise<void>;
}

/**
 * Durable key/value for integration sync cursors and OAuth state
 * (`integration_state`). MUST be persistent: the Outlook and QuickBooks token
 * managers keep refresh cursors here, so an in-memory implementation loses them
 * on every restart — and on every Cloud Function cold start — which silently
 * breaks token refresh.
 */
export interface IStateRepository {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
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
  state: IStateRepository;
  audit: IAuditRepository;
}
