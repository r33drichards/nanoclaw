/**
 * Outbound message operations (container side, Postgres backend).
 *
 * Container is the sole writer to messages_out for its session.
 *
 * Seq parity invariant — preserved from the SQLite path:
 *   host writes even seqs (2, 4, 6, ...)
 *   container writes odd seqs (1, 3, 5, ...)
 *
 * Computed under a per-session advisory lock so concurrent in-process
 * writers (e.g. async tool callbacks) can't race. The lock is
 * transactional — auto-released at COMMIT/ROLLBACK.
 */
import { getPgPool, getSessionId } from './connection-pg.js';

export interface MessageOutRow {
  id: string;
  seq: number | null;
  in_reply_to: string | null;
  timestamp: string;
  deliver_after: string | null;
  recurrence: string | null;
  kind: string;
  platform_id: string | null;
  channel_type: string | null;
  thread_id: string | null;
  content: string;
}

export interface WriteMessageOut {
  id: string;
  in_reply_to?: string | null;
  deliver_after?: string | null;
  recurrence?: string | null;
  kind: string;
  platform_id?: string | null;
  channel_type?: string | null;
  thread_id?: string | null;
  content: string;
}

/**
 * Write a new outbound message, auto-assigning an odd seq.
 *
 * The advisory lock keyed on the session id (hash) serializes writers
 * within a single session. Across sessions writers proceed in
 * parallel.
 */
export async function writeMessageOut(msg: WriteMessageOut): Promise<number> {
  const sessionId = getSessionId();
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
    const nextSeq = max % 2 === 0 ? max + 1 : max + 2;

    await client.query(
      `INSERT INTO messages_out
         (session_id, id, seq, in_reply_to, timestamp, deliver_after, recurrence,
          kind, platform_id, channel_type, thread_id, content)
       VALUES ($1, $2, $3, $4, now(), $5, $6, $7, $8, $9, $10, $11::jsonb)`,
      [
        sessionId,
        msg.id,
        nextSeq,
        msg.in_reply_to ?? null,
        msg.deliver_after ?? null,
        msg.recurrence ?? null,
        msg.kind,
        msg.platform_id ?? null,
        msg.channel_type ?? null,
        msg.thread_id ?? null,
        msg.content,
      ],
    );

    await client.query('COMMIT');
    return nextSeq;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Look up a platform message id by seq, searching both inbound and
 * outbound tables. Mirrors the SQLite version's behavior:
 *   - inbound rows have id == platform message id
 *   - outbound rows need the delivered table to resolve the real
 *     platform id (host writes it after successful delivery)
 */
export async function getMessageIdBySeq(seq: number): Promise<string | null> {
  const sessionId = getSessionId();
  const inbound = await getPgPool().query<{ id: string }>(
    'SELECT id FROM messages_in WHERE session_id = $1 AND seq = $2',
    [sessionId, seq],
  );
  if (inbound.rows[0]) return inbound.rows[0].id;
  const outbound = await getPgPool().query<{ id: string; platform_message_id: string | null }>(
    `SELECT mo.id, d.platform_message_id
       FROM messages_out mo
       LEFT JOIN delivered d
         ON d.session_id = mo.session_id AND d.message_out_id = mo.id
      WHERE mo.session_id = $1 AND mo.seq = $2`,
    [sessionId, seq],
  );
  return outbound.rows[0]?.platform_message_id ?? null;
}

/** Read raw messages_out rows (used internally; the host owns delivery). */
export async function getMessageOut(id: string): Promise<MessageOutRow | undefined> {
  const { rows } = await getPgPool().query<MessageOutRow>(
    `SELECT id, seq, in_reply_to, timestamp::text AS timestamp,
            deliver_after::text AS deliver_after, recurrence, kind,
            platform_id, channel_type, thread_id, content::text AS content
       FROM messages_out
       WHERE session_id = $1 AND id = $2`,
    [getSessionId(), id],
  );
  return rows[0];
}
