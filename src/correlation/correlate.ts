import { getDatabase } from '../db/index.js';

export type CorrelationResult =
  | { status: 'matched'; appointmentId: string; clientId: string | null }
  | { status: 'unmatched'; reason: 'no_candidates' | 'ambiguous'; candidateCount: number };

/**
 * The make-or-break join: match a Bee conversation to a PB appointment by
 * overlapping time window.
 *
 * Hard rule (build plan §4/§9): never auto-guess. Exactly one candidate =>
 * matched. Zero or many => unmatched, routed to manual tagging.
 *
 * Firestore cannot range-filter two fields in one query, so the overlap test
 * itself lives in the appointments repository (findOverlapping), which bounds
 * the starts_at scan and then applies the second half of the predicate in
 * memory. The exclusions below stay here because they are policy, not indexing.
 */
export async function correlateConversation(
  startsAt: string,
  endsAt: string,
): Promise<CorrelationResult> {
  const db = getDatabase();

  // Two exclusions, both misattribution guards:
  // - cancelled bookings: the slot may have been filled by someone else (a
  //   walk-in), and matching their recording to the cancelled client's chart is
  //   exactly the wrong-person error auto-matching must never make;
  // - appointments that already carry a recording: a second overlapping chunk
  //   (a split Bee recording) must go to a human, not silently overwrite the
  //   first chunk's extracted note.
  const overlapping = await db.appointments.findOverlapping(startsAt, endsAt);
  const live = overlapping.filter((a) => a.status !== 'cancelled');

  // One lookup per candidate replaces the `NOT EXISTS` subquery. Bounded by how
  // many appointments can overlap one recording — one or two in practice, and
  // never more than a handful, since findOverlapping is itself a narrow window.
  const taken = await Promise.all(live.map((a) => db.conversations.findByAppointment(a.id)));
  const available = live
    .filter((_, i) => !taken[i])
    .sort((a, b) => a.starts_at.localeCompare(b.starts_at));

  if (available.length === 1) {
    return {
      status: 'matched',
      appointmentId: available[0].id,
      clientId: available[0].client_id ?? null,
    };
  }
  return {
    status: 'unmatched',
    reason: available.length === 0 ? 'no_candidates' : 'ambiguous',
    candidateCount: available.length,
  };
}
