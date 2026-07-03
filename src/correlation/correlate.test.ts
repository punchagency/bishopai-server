import { describe, it, expect } from 'vitest';
import type { PoolClient } from 'pg';
import { correlateConversation } from './correlate';

// Minimal fake PoolClient: returns canned rows so we test the decision logic
// (match / no-match / ambiguous) without a database.
function fakeDb(rows: Array<{ id: string; client_id: string | null }>): PoolClient {
  return { query: async () => ({ rows, rowCount: rows.length }) } as unknown as PoolClient;
}

const START = '2026-07-01T15:00:00Z';
const END = '2026-07-01T16:00:00Z';

describe('correlateConversation', () => {
  it('matches when exactly one appointment overlaps', async () => {
    const r = await correlateConversation(fakeDb([{ id: 'a1', client_id: 'c1' }]), START, END);
    expect(r).toEqual({ status: 'matched', appointmentId: 'a1', clientId: 'c1' });
  });

  it('returns no_candidates when nothing overlaps', async () => {
    const r = await correlateConversation(fakeDb([]), START, END);
    expect(r).toEqual({ status: 'unmatched', reason: 'no_candidates', candidateCount: 0 });
  });

  it('never auto-guesses: multiple overlaps -> ambiguous', async () => {
    const r = await correlateConversation(
      fakeDb([
        { id: 'a1', client_id: 'c1' },
        { id: 'a2', client_id: 'c2' },
      ]),
      START,
      END,
    );
    expect(r).toEqual({ status: 'unmatched', reason: 'ambiguous', candidateCount: 2 });
  });

  it('passes the conversation window as the query parameters', async () => {
    let captured: unknown[] | undefined;
    const db = {
      query: async (_sql: string, params?: unknown[]) => {
        captured = params;
        return { rows: [], rowCount: 0 };
      },
    } as unknown as PoolClient;
    await correlateConversation(db, START, END);
    expect(captured).toEqual([START, END]);
  });
});
