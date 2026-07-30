import admin from 'firebase-admin';
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
  SessionDocs,
  GuardedSessionWrite,
  GuardedSessionResult,
} from '../../interfaces/repositories.js';
import { noteRevisionDocId, supplementDocId } from '../../ids.js';
import { combineStatus } from '../../sessionStatus.js';

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
  async listRecent(limit: number): Promise<Appointment[]> {
    const snap = await this.db.orderBy('starts_at', 'desc').limit(limit).get();
    return snap.docs.map((doc) => doc.data() as Appointment);
  }
  async listBetween(fromIso: string, toIso: string): Promise<Appointment[]> {
    const snap = await this.db
      .where('starts_at', '>=', fromIso)
      .where('starts_at', '<', toIso)
      .orderBy('starts_at', 'asc')
      .get();
    return snap.docs.map((doc) => doc.data() as Appointment);
  }
  async findByPbId(pbId: string): Promise<Appointment | null> {
    const snap = await this.db.where('pb_id', '==', pbId).limit(1).get();
    if (snap.empty) return null;
    return snap.docs[0].data() as Appointment;
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
    // `correlation_status`, not `status` — the earlier draft queried a field
    // this collection does not have, so the review queue's unmatched list was
    // always empty and every recording looked placed.
    const snap = await this.db
      .where('correlation_status', '==', 'unmatched')
      .orderBy('starts_at', 'desc')
      .get();
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

  async upsertByBeeId(
    conversation: Conversation,
  ): Promise<{ conversation: Conversation; created: boolean }> {
    const ref = this.db.doc(conversation.id);
    return getFirestoreInstance().runTransaction(async (tx) => {
      const doc = await tx.get(ref);
      if (!doc.exists) {
        tx.create(ref, conversation);
        return { conversation, created: true };
      }
      // Replay: keep the STORED assignment — it may be a manual one Nicole made
      // — and only fill a transcript that was missing. `COALESCE(EXCLUDED.
      // transcript, conversations.transcript)`, nothing else.
      const stored = doc.data() as Conversation;
      if (stored.transcript || !conversation.transcript) {
        return { conversation: stored, created: false };
      }
      const merged: Conversation = {
        ...stored,
        transcript: conversation.transcript,
        updated_at: new Date().toISOString(),
      };
      tx.update(ref, { transcript: merged.transcript, updated_at: merged.updated_at });
      return { conversation: merged, created: false };
    });
  }

  async transitionExtraction(
    id: string,
    from: ExtractionStatus[],
    patch: Partial<Conversation>,
    guard?: (row: Conversation) => boolean,
  ): Promise<Conversation | null> {
    const ref = this.db.doc(id);
    return getFirestoreInstance().runTransaction(async (tx) => {
      const doc = await tx.get(ref);
      if (!doc.exists) return null;
      const row = doc.data() as Conversation;
      if (!from.includes(row.extraction_status)) return null;
      if (guard && !guard(row)) return null;
      const next: Conversation = { ...row, ...patch, updated_at: new Date().toISOString() };
      tx.update(ref, { ...patch, updated_at: next.updated_at });
      return next;
    });
  }

  async listStuckExtractions(leaseCutoff: string): Promise<Conversation[]> {
    // COALESCE(extraction_leased_at, updated_at) has no Firestore equivalent, so
    // the lease is always written at claim time (see process.ts) and this is a
    // plain range on it. Uses the (extraction_status, extraction_leased_at) index.
    const snap = await this.db
      .where('extraction_status', '==', 'processing')
      .where('extraction_leased_at', '<', leaseCutoff)
      .get();
    return snap.docs.map((doc) => doc.data() as Conversation);
  }

  async listExhaustedExtractions(maxAttempts: number): Promise<Conversation[]> {
    const snap = await this.db
      .where('extraction_status', '==', 'failed')
      .where('extraction_attempts', '>=', maxAttempts)
      .get();
    return snap.docs.map((doc) => doc.data() as Conversation);
  }

  async listDueExtractions(
    now: string,
    maxAttempts: number,
    limit: number,
  ): Promise<Conversation[]> {
    // Firestore allows range filters on only one field per query, and this
    // predicate ranges on two (attempts < max, next_attempt_at <= now). Range on
    // the selective one — the due time — and apply the attempt cap in memory
    // over an already-small result. `matched && transcribed` are equality-free
    // NULL checks with no equivalent either, so they filter here too.
    const snap = await this.db
      .where('extraction_status', '==', 'failed')
      .where('extraction_next_attempt_at', '<=', now)
      .orderBy('extraction_next_attempt_at', 'asc')
      .limit(limit * 4)
      .get();
    return snap.docs
      .map((doc) => doc.data() as Conversation)
      .filter(
        (c) =>
          (c.extraction_attempts ?? 0) < maxAttempts &&
          !!c.appointment_id &&
          !!c.transcript,
      )
      .slice(0, limit);
  }

  async claimAppointment(claim: AppointmentClaim): Promise<boolean> {
    try {
      await this.claimsDb.doc(claim.id).create(claim);
      return true;
    } catch (err) {
      // ALREADY_EXISTS (6) means another conversation holds this appointment —
      // the `conversations_appointment_unique` rejection. Anything else is real.
      if ((err as { code?: number }).code === 6) return false;
      throw err;
    }
  }

  async releaseAppointment(appointmentId: string): Promise<void> {
    await this.claimsDb.doc(appointmentId).delete();
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
    const snap = await this.approvalsDb
      .where('appointment_id', '==', appointmentId)
      .orderBy('created_at', 'desc')
      .get();
    return snap.docs.map((doc) => doc.data() as Approval);
  }

  async listRevisions(sourceTable: NoteTable, sourceId: string): Promise<NoteRevision[]> {
    const snap = await this.revisionsDb
      .where('source_table', '==', sourceTable)
      .where('source_id', '==', sourceId)
      .orderBy('revision', 'desc')
      .get();
    return snap.docs.map((doc) => doc.data() as NoteRevision);
  }

  async findSessionDocs(appointmentId: string): Promise<SessionDocs> {
    // Document id == appointment_id for both, so this is two gets by ref rather
    // than the LEFT JOIN it replaces.
    const [sheet, protocol] = await getFirestoreInstance().getAll(
      this.sheetsDb.doc(appointmentId),
      this.protocolsDb.doc(appointmentId),
    );
    return {
      sheet: sheet.exists ? (sheet.data() as AppointmentSheet) : null,
      protocol: protocol.exists ? (protocol.data() as SupplementProtocol) : null,
    };
  }

  async findManySessionDocs(appointmentIds: string[]): Promise<Map<string, SessionDocs>> {
    const out = new Map<string, SessionDocs>();
    if (appointmentIds.length === 0) return out;

    // getAll is a single round trip but the request itself has a size ceiling,
    // so chunk it. Interleaved sheet/protocol refs keep the two halves of one
    // session in the same chunk, which is what lets the reassembly below be a
    // simple positional walk.
    const CHUNK = 100;
    for (let i = 0; i < appointmentIds.length; i += CHUNK) {
      const slice = appointmentIds.slice(i, i + CHUNK);
      const refs = slice.flatMap((id) => [this.sheetsDb.doc(id), this.protocolsDb.doc(id)]);
      const docs = await getFirestoreInstance().getAll(...refs);
      slice.forEach((id, n) => {
        const sheet = docs[n * 2];
        const protocol = docs[n * 2 + 1];
        out.set(id, {
          sheet: sheet.exists ? (sheet.data() as AppointmentSheet) : null,
          protocol: protocol.exists ? (protocol.data() as SupplementProtocol) : null,
        });
      });
    }
    return out;
  }

  /**
   * The session-path compare-and-set. Everything that must land with the status
   * change lands here, in one transaction: both documents, the approval record,
   * and the revision snapshots.
   *
   * Deliberately contains no I/O beyond Firestore. A transaction is RETRIED on
   * contention, so a Drive write or an email sent from inside would go out twice
   * (§3.3) — publishing is sequenced after this returns.
   */
  async guardedWrite(args: GuardedSessionWrite): Promise<GuardedSessionResult> {
    const firestore = getFirestoreInstance();
    const sheetRef = this.sheetsDb.doc(args.appointmentId);
    const protocolRef = this.protocolsDb.doc(args.appointmentId);

    return firestore.runTransaction(async (tx) => {
      // ALL reads first — Firestore rejects a transaction that reads after it
      // has written.
      const [sheetDoc, protocolDoc] = await tx.getAll(sheetRef, protocolRef);
      const before: SessionDocs = {
        sheet: sheetDoc.exists ? (sheetDoc.data() as AppointmentSheet) : null,
        protocol: protocolDoc.exists ? (protocolDoc.data() as SupplementProtocol) : null,
      };

      if (!before.sheet && !before.protocol) {
        return { ok: false, reason: 'not_found', before } as const;
      }
      const current = combineStatus(before.sheet?.status ?? null, before.protocol?.status ?? null);
      if (!args.expect.includes(current)) {
        return { ok: false, reason: 'wrong_status', before } as const;
      }

      const now = new Date().toISOString();
      // The two documents always carry the same revision, because every write
      // touches both. Reading it off whichever exists keeps a session with no
      // protocol numbering correctly.
      const revision = before.sheet?.revision ?? before.protocol?.revision ?? 1;

      if (args.snapshotRevision) {
        const reason = args.snapshotRevision.reason;
        for (const [table, doc] of [
          ['appointment_sheets', before.sheet],
          ['protocols', before.protocol],
        ] as const) {
          if (!doc) continue;
          // create(), not set(): the deterministic id IS note_revisions_unique,
          // so a double-submitted amendment collides instead of overwriting the
          // history it already filed.
          tx.create(this.revisionsDb.doc(noteRevisionDocId(table, doc.id, revision)), {
            id: noteRevisionDocId(table, doc.id, revision),
            source_table: table,
            source_id: doc.id,
            appointment_id: args.appointmentId,
            revision,
            content_json: doc.content_json,
            reason,
            created_at: now,
          } satisfies NoteRevision);
        }
      }

      const patch: Record<string, unknown> = { updated_at: now };
      if (args.content !== undefined) patch.content_json = args.content;
      if (args.status !== undefined) patch.status = args.status;
      if (args.snapshotRevision) patch.revision = revision + 1;

      if (before.sheet) tx.update(sheetRef, patch);
      if (before.protocol) tx.update(protocolRef, patch);
      if (args.approval) tx.create(this.approvalsDb.doc(args.approval.id), args.approval);

      return { ok: true, before, revision } as const;
    });
  }

  async listProtocolsByClient(
    clientId: string,
    opts: { status?: DocStatus; limit?: number } = {},
  ): Promise<SupplementProtocol[]> {
    let query: admin.firestore.Query = this.protocolsDb.where('client_id', '==', clientId);
    if (opts.status) query = query.where('status', '==', opts.status);
    // Ordered by when the session happened. Documents MISSING starts_at are
    // dropped from an orderBy result (§3.5), which is correct here — a protocol
    // with no appointment date has no place in a chronological flow sheet — but
    // it is why saveExtractedNote always writes the field, even as null.
    query = query.orderBy('starts_at', 'asc');
    if (opts.limit) query = query.limit(opts.limit);
    const snap = await query.get();
    return snap.docs.map((doc) => doc.data() as SupplementProtocol);
  }

  async findPriorApproved(
    kind: 'sheet' | 'protocol',
    clientId: string,
    opts: { excludeAppointmentId: string | null; before: string | null },
  ): Promise<AppointmentSheet | SupplementProtocol | null> {
    const collection = kind === 'sheet' ? this.sheetsDb : this.protocolsDb;
    let query: admin.firestore.Query = collection
      .where('client_id', '==', clientId)
      .where('status', '==', 'approved');
    if (opts.before) query = query.where('starts_at', '<', opts.before);
    // Fetch two so the excluded appointment can be skipped without a second
    // round trip — Firestore has no `!=` that composes with a range filter.
    const snap = await query.orderBy('starts_at', 'desc').limit(2).get();
    for (const doc of snap.docs) {
      const row = doc.data() as AppointmentSheet | SupplementProtocol;
      if (opts.excludeAppointmentId && row.appointment_id === opts.excludeAppointmentId) continue;
      return row;
    }
    return null;
  }

  async listApprovedHistory(
    clientId: string,
    opts: { excludeAppointmentId: string | null; before: string | null; limit: number },
  ): Promise<{ total: number; sessions: Array<{ starts_at: string | null; content_json: unknown }> }> {
    // One entry per APPOINTMENT, preferring the sheet and falling back to the
    // protocol — the two carry the same clinical fields and either may be the
    // one she approved, so keying on the appointment avoids listing a visit twice.
    const build = (collection: admin.firestore.CollectionReference) => {
      let q: admin.firestore.Query = collection
        .where('client_id', '==', clientId)
        .where('status', '==', 'approved');
      if (opts.before) q = q.where('starts_at', '<', opts.before);
      return q.orderBy('starts_at', 'desc');
    };

    // The count is a real aggregation query, not a read of every document (§3.4),
    // so capping the list never misreports the client's history as shorter than
    // it is. Sheets and protocols are counted from the merged appointment set
    // below rather than summed, since a visit usually has both.
    const [sheetSnap, protocolSnap] = await Promise.all([
      build(this.sheetsDb).limit(opts.limit * 2).get(),
      build(this.protocolsDb).limit(opts.limit * 2).get(),
    ]);

    const byAppointment = new Map<string, { starts_at: string | null; content_json: unknown }>();
    for (const doc of sheetSnap.docs) {
      const row = doc.data() as AppointmentSheet;
      byAppointment.set(row.appointment_id, {
        starts_at: row.starts_at ?? null,
        content_json: row.content_json,
      });
    }
    for (const doc of protocolSnap.docs) {
      const row = doc.data() as SupplementProtocol;
      if (byAppointment.has(row.appointment_id)) continue; // the sheet wins
      byAppointment.set(row.appointment_id, {
        starts_at: row.starts_at ?? null,
        content_json: row.content_json,
      });
    }
    if (opts.excludeAppointmentId) byAppointment.delete(opts.excludeAppointmentId);

    const [sheetCount, protocolCount] = await Promise.all([
      build(this.sheetsDb).count().get(),
      build(this.protocolsDb).count().get(),
    ]);
    // An appointment with both documents is one visit. Sheets exist for every
    // session and protocols only for those with a client, so the sheet count is
    // the visit count whenever it is the larger of the two.
    const counted = Math.max(sheetCount.data().count, protocolCount.data().count);
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
    const firestore = getFirestoreInstance();
    const sheetRef = this.sheetsDb.doc(args.appointmentId);
    const protocolRef = this.protocolsDb.doc(args.appointmentId);

    return firestore.runTransaction(async (tx) => {
      const [sheetDoc, protocolDoc] = await tx.getAll(sheetRef, protocolRef);
      const sheet = sheetDoc.exists ? (sheetDoc.data() as AppointmentSheet) : null;
      const protocol = protocolDoc.exists ? (protocolDoc.data() as SupplementProtocol) : null;

      // Approved content only ever changes through amend, which snapshots what
      // it supersedes. An extraction landing on an approved appointment means a
      // recording was matched where a signed-off session already lives — refused
      // upstream, and refused again here so no path can silently demote approved
      // clinical content back to draft.
      if (sheet?.status === 'approved' || protocol?.status === 'approved') {
        return { written: false };
      }

      const now = new Date().toISOString();
      tx.set(
        sheetRef,
        {
          id: args.appointmentId,
          appointment_id: args.appointmentId,
          client_id: args.clientId,
          starts_at: args.startsAt,
          client_name: args.clientName,
          content_json: args.content,
          status: 'draft' as DocStatus,
          revision: sheet?.revision ?? 1,
          created_at: sheet?.created_at ?? now,
          updated_at: now,
        } satisfies AppointmentSheet,
        { merge: true },
      );

      // Client-facing; an appointment with no client attached has no protocol.
      if (args.clientId) {
        tx.set(
          protocolRef,
          {
            id: args.appointmentId,
            appointment_id: args.appointmentId,
            client_id: args.clientId,
            starts_at: args.startsAt,
            client_name: args.clientName,
            content_json: args.content,
            status: 'draft' as DocStatus,
            revision: protocol?.revision ?? 1,
            created_at: protocol?.created_at ?? now,
            updated_at: now,
          } satisfies SupplementProtocol,
          { merge: true },
        );
      }
      return { written: true };
    });
  }

  async deleteSessionDocs(appointmentId: string): Promise<void> {
    const batch = getFirestoreInstance().batch();
    batch.delete(this.sheetsDb.doc(appointmentId));
    batch.delete(this.protocolsDb.doc(appointmentId));
    await batch.commit();
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
  async findSupplement(clientId: string, nameKey: string): Promise<Supplement | null> {
    const doc = await this.supplementsDb.doc(supplementDocId(clientId, nameKey)).get();
    return doc.exists ? (doc.data() as Supplement) : null;
  }
  async deleteSupplement(clientId: string, nameKey: string): Promise<boolean> {
    const ref = this.supplementsDb.doc(supplementDocId(clientId, nameKey));
    return getFirestoreInstance().runTransaction(async (tx) => {
      // Read first so the caller gets the pg rowCount semantics — "removed 0"
      // and "removed 1" are different answers in the sync result Nicole sees.
      const doc = await tx.get(ref);
      if (!doc.exists) return false;
      tx.delete(ref);
      return true;
    });
  }
  async listSupplementsByClient(clientId: string): Promise<Supplement[]> {
    const snap = await this.supplementsDb
      .where('client_id', '==', clientId)
      .orderBy('name', 'asc')
      .get();
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
  async listByClient(clientId: string, limit = 100): Promise<DocumentRecord[]> {
    const snap = await this.db
      .where('client_id', '==', clientId)
      .orderBy('created_at', 'desc')
      .limit(limit)
      .get();
    return snap.docs.map((d) => d.data() as DocumentRecord);
  }
  async listByAppointment(appointmentId: string): Promise<DocumentRecord[]> {
    const snap = await this.db
      .where('appointment_id', '==', appointmentId)
      .orderBy('created_at', 'desc')
      .get();
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
