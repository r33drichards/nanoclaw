/**
 * Host-side messages_in writer (Postgres backend).
 *
 * In declarative mode the host writes inbound messages directly to the
 * unified `messages_in` table (filtered by session_id) instead of opening
 * a per-session inbound.db. NOTIFY trigger on insert wakes the
 * containerized agent via LISTEN.
 *
 * Seq parity preserved by per-session pg_advisory_xact_lock + GREATEST
 * over messages_in/messages_out, rounded up to the next EVEN value
 * (host parity).
 *
 * Used by:
 *   - session-manager.writeSessionMessage (declarative mode)
 *   - modules/scheduling/actions.ts (recurrence inserts)
 *   - modules/agent-to-agent (cross-agent routing)
 */
import { getPgPool } from './postgres.js';

export interface HostInboundInsert {
  id: string;
  kind: string;
  timestamp: string;
  platform_id: string | null;
  channel_type: string | null;
  thread_id: string | null;
  content: string; // JSON-stringified
  process_after?: string | null;
  recurrence?: string | null;
  series_id?: string | null;
  on_wake?: boolean;
  trigger?: 0 | 1;
  source_session_id?: string | null;
}

/**
 * Insert a row into messages_in for the given session. Assigns an even
 * seq under a per-session advisory lock so concurrent host writers
 * (router, scheduling, approvals) don't race.
 *
 * Returns the assigned seq. Throws if the session row doesn't exist
 * (FK enforced).
 */
export async function insertInboundMessage(sessionId: string, msg: HostInboundInsert): Promise<number> {
  const client = await getPgPool().connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`ncl-session-${sessionId}`]);

    const { rows } = await client.query<{ max: number }>(
      `SELECT GREATEST(
                COALESCE((SELECT MAX(seq) FROM messages_in  WHERE session_id = $1), 0),
                COALESCE((SELECT MAX(seq) FROM messages_out WHERE session_id = $1), 0)
              ) AS max`,
      [sessionId],
    );
    const max = Number(rows[0]?.max ?? 0);
    // Round up to next even (host parity). max=0 → 2, max=1 → 2, max=2 → 4, max=3 → 4.
    const nextSeq = max < 2 ? 2 : max + 2 - (max % 2);

    await client.query(
      `INSERT INTO messages_in
         (session_id, id, seq, kind, timestamp, status, process_after, recurrence,
          series_id, tries, trigger, platform_id, channel_type, thread_id,
          content, on_wake, source_session_id)
       VALUES ($1, $2, $3, $4, $5::timestamptz, 'pending', $6, $7, $8, 0, $9,
               $10, $11, $12, $13::jsonb, $14, $15)`,
      [
        sessionId,
        msg.id,
        nextSeq,
        msg.kind,
        msg.timestamp,
        msg.process_after ?? null,
        msg.recurrence ?? null,
        msg.series_id ?? null,
        msg.trigger ?? 1,
        msg.platform_id,
        msg.channel_type,
        msg.thread_id,
        msg.content,
        msg.on_wake ? 1 : 0,
        msg.source_session_id ?? null,
      ],
    );

    await client.query('COMMIT');
    return nextSeq;
    // The AFTER INSERT trigger fires pg_notify('ncl_session_<id>') here,
    // which wakes any LISTENing container immediately.
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Mark a host-issued message_out as delivered. Idempotent — re-insert
 * on retry collides with the PK and is silently swallowed.
 */
export async function markDelivered(
  sessionId: string,
  messageOutId: string,
  platformMessageId: string | null,
  status: 'delivered' | 'failed' = 'delivered',
): Promise<void> {
  await getPgPool().query(
    `INSERT INTO delivered (session_id, message_out_id, platform_message_id, status, delivered_at)
     VALUES ($1, $2, $3, $4, now())
     ON CONFLICT (session_id, message_out_id) DO NOTHING`,
    [sessionId, messageOutId, platformMessageId, status],
  );
}

/**
 * Write the session's default reply routing — channel/platform/thread
 * the container uses when sending without an explicit destination.
 */
export async function upsertSessionRouting(
  sessionId: string,
  routing: { channel_type: string | null; platform_id: string | null; thread_id: string | null },
): Promise<void> {
  await getPgPool().query(
    `INSERT INTO session_routing (session_id, channel_type, platform_id, thread_id, updated_at)
     VALUES ($1, $2, $3, $4, now())
     ON CONFLICT (session_id) DO UPDATE SET
       channel_type = excluded.channel_type,
       platform_id  = excluded.platform_id,
       thread_id    = excluded.thread_id,
       updated_at   = excluded.updated_at`,
    [sessionId, routing.channel_type, routing.platform_id, routing.thread_id],
  );
}

export interface DestinationRow {
  name: string;
  display_name: string | null;
  type: 'channel' | 'agent';
  channel_type: string | null;
  platform_id: string | null;
  agent_group_id: string | null;
}

/** Wholesale replace of the session's destinations projection. */
export async function replaceDestinations(sessionId: string, entries: DestinationRow[]): Promise<void> {
  const client = await getPgPool().connect();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM destinations WHERE session_id = $1', [sessionId]);
    if (entries.length > 0) {
      // One round-trip via UNNEST. Each row's fields become an array
      // column; UNNEST expands them in parallel.
      await client.query(
        `INSERT INTO destinations (session_id, name, display_name, type, channel_type, platform_id, agent_group_id)
         SELECT $1, n, dn, t, ct, pi, ag
         FROM unnest($2::text[], $3::text[], $4::text[], $5::text[], $6::text[], $7::text[])
              AS r(n, dn, t, ct, pi, ag)`,
        [
          sessionId,
          entries.map((e) => e.name),
          entries.map((e) => e.display_name),
          entries.map((e) => e.type),
          entries.map((e) => e.channel_type),
          entries.map((e) => e.platform_id),
          entries.map((e) => e.agent_group_id),
        ],
      );
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}
