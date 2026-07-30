import { getDatabase } from '../db/index.js';

// Shared machinery for the two client-enrollment passes (maintenance and
// first-appointment).
//
// In Postgres they were two near-identical GROUP BY … HAVING queries differing
// only in `count(*) = 1` vs `>= 2` and the wait window. That aggregate has no
// Firestore equivalent — it filters clients by a property of their appointments
// — so the shape inverts: walk the clients, read each one's appointments (an
// indexed, already-chronological query), and apply the conditions in memory.
//
// Writing that inversion once is the point of this module. Two copies of it
// would be two places for the disjointness rule to drift, and the tracks are
// only disjoint *because* one requires exactly one completed session and the
// other requires two or more.

export interface EligibleClient {
  id: string;
  email: string;
  name: string | null;
  /** The session the wait window is measured from. */
  session_at: string;
}

export interface EnrollmentSpec {
  /** How many completed sessions this track requires. */
  sessionCount: (n: number) => boolean;
  /** Days since that session before the client is eligible. */
  afterDays: number;
  /** leads.source and leads.status — the two are the same value on both tracks. */
  track: string;
  /** The lead_activity detail line. */
  detail: (client: EligibleClient, sessionDate: string) => string;
}

export interface EnrollmentResult {
  scanned: number;
  enrolled: number;
  /** Already had an active lead on any track — not double-enrolled. */
  skipped: number;
}

let seq = 0;
const newId = (kind: string): string =>
  `${kind}_${Date.now().toString(36)}_${(seq++).toString(36)}_${Math.random().toString(36).slice(2, 7)}`;

async function eligibleClients(spec: EnrollmentSpec, now: Date): Promise<EligibleClient[]> {
  const db = getDatabase();
  const cutoff = new Date(now.getTime() - spec.afterDays * 86_400_000).toISOString();
  const nowIso = now.toISOString();
  const out: EligibleClient[] = [];

  for (const client of await db.clients.listAll()) {
    const email = client.email?.trim();
    if (!email) continue; // `WHERE c.email IS NOT NULL`

    const appointments = await db.appointments.listByClient(client.id);
    const completed = appointments.filter((a) => a.status === 'completed');
    if (!spec.sessionCount(completed.length)) continue;

    // `max(a.ends_at)` — the most recent completed session.
    const sessionAt = completed.reduce((max, a) => (a.ends_at > max ? a.ends_at : max), '');
    if (!(sessionAt < cutoff)) continue;

    // NOT EXISTS (a future, non-cancelled booking) — someone already booked in
    // does not need re-engaging.
    if (appointments.some((a) => a.starts_at > nowIso && a.status !== 'cancelled')) continue;

    out.push({ id: client.id, email, name: client.name ?? null, session_at: sessionAt });
  }
  return out;
}

/**
 * Enroll every eligible client not already in an active sequence.
 *
 * Idempotent across runs: a client with any active lead (their email, status not
 * closed/booked) is skipped, so a daily re-run never stacks duplicate leads or
 * fights an in-flight cadence.
 */
export async function runEnrollmentPass(
  spec: EnrollmentSpec,
  now: Date = new Date(),
): Promise<EnrollmentResult> {
  const db = getDatabase();
  const rows = await eligibleClients(spec, now);

  let enrolled = 0;
  let skipped = 0;

  for (const c of rows) {
    const email = c.email.toLowerCase();
    const active = (await db.reengagement.listLeadsByEmail(email)).some(
      (l) => l.status !== 'closed' && l.status !== 'booked',
    );
    if (active) {
      skipped++;
      continue;
    }

    const leadId = newId('lead');
    const stamp = new Date().toISOString();
    await db.reengagement.saveLead({
      id: leadId,
      email,
      source: spec.track,
      status: spec.track,
      sequence_state: { sent: [] },
      last_touch: null,
      cadence_cancelled_at: null,
      created_at: stamp,
      updated_at: stamp,
    });
    await db.reengagement.logActivity({
      id: newId('activity'),
      lead_id: leadId,
      type: spec.track,
      path: null,
      detail: spec.detail(c, new Date(c.session_at).toISOString().slice(0, 10)),
      occurred_at: stamp,
      created_at: stamp,
    });
    enrolled++;
  }

  return { scanned: rows.length, enrolled, skipped };
}
