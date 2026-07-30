import { getDatabase } from '../db/index.js';
import type { DoseSchedule } from './project';

// The pending-refill working set, with the client and supplement each one needs.
//
// Two callers want exactly this: the daily reminder cadence (which sends) and
// the upcoming-reminders listing (which only previews). In Postgres they shared
// a SELECT/FROM pair of string constants; here they share the loader, which
// matters more, because the join is now three lookups whose batching is easy to
// get subtly different between two copies.

export interface PendingRefill {
  id: string;
  status: string;
  due_date: string | null;
  reminder_stage: number;
  reminder_next_at: string | null;
  client_id: string;
  client_name: string | null;
  email: string | null;
  supplement_name: string | null;
  dose: string | null;
  qty: number | null;
  start_date: string | null;
  schedule: DoseSchedule | null;
}

/**
 * Every pending, projected, non-silenced refill, with its client and supplement.
 *
 * A refill whose client is gone is dropped — that was `JOIN clients`, and there
 * is nobody to remind. The supplement is a LEFT JOIN: a refill can outlive the
 * supplement row it was projected from, and it still has a due date worth
 * chasing.
 *
 * Both lookups are memoised per client, so a client with four refills costs one
 * client read and one plan read rather than four of each.
 */
export async function loadPendingRefills(): Promise<PendingRefill[]> {
  const db = getDatabase();
  const pending = (await db.refills.listByStatus('pending')).filter(
    (r) => !!r.due_date && !r.reminders_cancelled_at,
  );

  const clients = new Map<string, Awaited<ReturnType<typeof db.clients.findById>>>();
  const plans = new Map<string, Map<string, Awaited<ReturnType<typeof db.refills.listSupplementsByClient>>[number]>>();

  const out: PendingRefill[] = [];
  for (const rf of pending) {
    if (!clients.has(rf.client_id)) clients.set(rf.client_id, await db.clients.findById(rf.client_id));
    const client = clients.get(rf.client_id) ?? null;
    if (!client) continue;

    if (!plans.has(rf.client_id)) {
      const rows = await db.refills.listSupplementsByClient(rf.client_id);
      plans.set(rf.client_id, new Map(rows.map((s) => [s.id, s])));
    }
    const supplement = rf.supplement_id ? plans.get(rf.client_id)!.get(rf.supplement_id) : undefined;

    out.push({
      id: rf.id,
      status: rf.status,
      due_date: rf.due_date,
      reminder_stage: rf.reminder_stage ?? 0,
      reminder_next_at: rf.reminder_next_at ?? null,
      client_id: client.id,
      client_name: client.name,
      email: client.email || null,
      // The refill carries a denormalized copy, which is what keeps the row
      // readable after its supplement is dropped from the plan.
      supplement_name: supplement?.name ?? rf.supplement_name ?? null,
      dose: supplement?.dose ?? rf.dose ?? null,
      qty: supplement?.qty ?? null,
      start_date: supplement?.start_date ?? null,
      schedule: (supplement?.schedule as DoseSchedule | null) ?? null,
    });
  }
  return out;
}
