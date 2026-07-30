import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { correlateConversation } from './correlate';
import { setDatabaseAdapter, resetDatabaseAdapter, InMemoryMockDatabase } from '../db/index.js';
import type { Appointment, Conversation } from '../db/interfaces/types.js';

// The decision logic (match / no-match / ambiguous) against the in-memory
// adapter. What's under test is the REFUSAL to guess, so the fixtures are built
// as real appointment documents rather than canned query rows — the exclusions
// correlate applies (cancelled, already-recorded) are now filters over those
// documents, and a canned-rows fake would assert nothing about them.
const START = '2026-07-01T15:00:00Z';
const END = '2026-07-01T16:00:00Z';

let db: InMemoryMockDatabase;

const appointment = (id: string, over: Partial<Appointment> = {}): Appointment => ({
  id,
  client_id: `client-of-${id}`,
  client_name: id,
  starts_at: START,
  ends_at: END,
  status: 'scheduled',
  created_at: START,
  updated_at: START,
  ...over,
});

const conversation = (id: string, appointmentId: string): Conversation => ({
  id,
  bee_id: id,
  appointment_id: appointmentId,
  starts_at: START,
  ends_at: END,
  correlation_status: 'matched',
  extraction_status: 'pending',
  extraction_attempts: 0,
  created_at: START,
  updated_at: START,
});

beforeEach(() => {
  db = new InMemoryMockDatabase();
  setDatabaseAdapter(db);
});

// The adapter is a process-level singleton, so leaving it pointed at this
// suite's fixtures would leak into whatever runs next in the same worker.
afterAll(() => resetDatabaseAdapter());

describe('correlateConversation', () => {
  it('matches when exactly one appointment overlaps', async () => {
    await db.appointments.save(appointment('a1'));
    const r = await correlateConversation(START, END);
    expect(r).toEqual({ status: 'matched', appointmentId: 'a1', clientId: 'client-of-a1' });
  });

  it('returns no_candidates when nothing overlaps', async () => {
    await db.appointments.save(
      appointment('a1', { starts_at: '2026-07-02T15:00:00Z', ends_at: '2026-07-02T16:00:00Z' }),
    );
    const r = await correlateConversation(START, END);
    expect(r).toEqual({ status: 'unmatched', reason: 'no_candidates', candidateCount: 0 });
  });

  it('never auto-guesses: multiple overlaps -> ambiguous', async () => {
    await db.appointments.save(appointment('a1'));
    await db.appointments.save(appointment('a2'));
    const r = await correlateConversation(START, END);
    expect(r).toEqual({ status: 'unmatched', reason: 'ambiguous', candidateCount: 2 });
  });

  it('never matches a cancelled booking — its client may never have been in the room', async () => {
    await db.appointments.save(appointment('a1', { status: 'cancelled' }));
    const r = await correlateConversation(START, END);
    expect(r).toEqual({ status: 'unmatched', reason: 'no_candidates', candidateCount: 0 });
  });

  it('never matches an appointment that already carries a recording', async () => {
    await db.appointments.save(appointment('a1'));
    await db.conversations.save(conversation('bee-1', 'a1'));
    const r = await correlateConversation(START, END);
    expect(r).toEqual({ status: 'unmatched', reason: 'no_candidates', candidateCount: 0 });
  });

  it('resolves to a match when the only OTHER candidate is already taken', async () => {
    await db.appointments.save(appointment('a1'));
    await db.appointments.save(appointment('a2'));
    await db.conversations.save(conversation('bee-1', 'a1'));
    const r = await correlateConversation(START, END);
    expect(r).toEqual({ status: 'matched', appointmentId: 'a2', clientId: 'client-of-a2' });
  });
});
