import { pool } from '../db/pool';

/**
 * Which of these Pocket recording ids we already hold a transcript for.
 *
 * The poller uses this to avoid re-fetching detail for recordings the webhook
 * already delivered — one request per recording per sweep would otherwise be
 * the dominant cost of running the backstop at all.
 *
 * Deliberately keyed on "has a transcript", not "row exists": a conversation
 * ingested from a `recording.created`-shaped payload, or one whose transcript
 * arrived empty, still needs its detail fetched. Re-ingest is idempotent, so
 * the worst case of a false negative here is a wasted request.
 *
 * This is the ONLY database-aware part of the poller, isolated so the rest
 * ports to a different store unchanged.
 */
export async function existingWithTranscript(sourceIds: string[]): Promise<Set<string>> {
  if (!sourceIds.length) return new Set();
  const { rows } = await pool.query<{ source_id: string }>(
    `SELECT source_id
       FROM conversations
      WHERE source = 'pocket'
        AND source_id = ANY($1::text[])
        AND transcript IS NOT NULL
        AND transcript <> ''`,
    [sourceIds],
  );
  return new Set(rows.map((r) => r.source_id));
}
