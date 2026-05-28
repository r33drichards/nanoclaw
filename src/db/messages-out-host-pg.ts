/**
 * Host-side messages_out reader (Postgres backend).
 *
 * The host's delivery loop reads outbound messages the agent has
 * produced for delivery to channel adapters. In declarative mode this
 * queries the unified `messages_out` table filtered by session_id and
 * cross-references the `delivered` table to skip already-sent rows.
 *
 * Wake signaling: the `notify_outbound_deliver` trigger fires
 * pg_notify('ncl_outbound', ...) on insert. Future commits can have
 * the host LISTEN on that channel to react instantly instead of
 * polling. For now, the existing 1s active poll cadence works fine —
 * it just rolls over to a SELECT against this table.
 */
import type { OutboundFile } from '../channels/adapter.js';

import { getPgPool } from './postgres.js';

export interface OutboundDue {
  id: string;
  seq: number;
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

/**
 * Outbound rows ready for delivery: deliver_after in the past (or null)
 * AND not yet recorded in the delivered table for this session.
 *
 * Ordered by seq so the agent's reply sequence stays preserved.
 */
export async function getDueOutboundMessages(sessionId: string, limit = 100): Promise<OutboundDue[]> {
  const { rows } = await getPgPool().query<OutboundDue>(
    `SELECT mo.id, mo.seq, mo.in_reply_to,
            mo.timestamp::text AS timestamp,
            mo.deliver_after::text AS deliver_after,
            mo.recurrence, mo.kind,
            mo.platform_id, mo.channel_type, mo.thread_id,
            mo.content::text AS content
       FROM messages_out mo
      WHERE mo.session_id = $1
        AND (mo.deliver_after IS NULL OR mo.deliver_after <= now())
        AND NOT EXISTS (
          SELECT 1 FROM delivered d
           WHERE d.session_id = mo.session_id AND d.message_out_id = mo.id
        )
      ORDER BY mo.seq ASC
      LIMIT $2`,
    [sessionId, limit],
  );
  return rows;
}

/**
 * Get attachment files written by the container for a given message_out.
 * Mirrors session-manager.readOutboxFiles for the Postgres path: returns
 * the bytes the channel adapter should attach to its delivery.
 */
export async function getOutboundAttachments(sessionId: string, messageId: string): Promise<OutboundFile[]> {
  const { rows } = await getPgPool().query<{ filename: string; content_type: string | null; content: Buffer }>(
    `SELECT filename, content_type, content
       FROM attachments_outbound
      WHERE session_id = $1 AND message_id = $2
      ORDER BY filename`,
    [sessionId, messageId],
  );
  return rows.map((r) => ({
    filename: r.filename,
    contentType: r.content_type ?? undefined,
    data: r.content,
  }));
}

/** Delete an outbox attachment row after successful delivery. */
export async function clearOutboundAttachments(sessionId: string, messageId: string): Promise<void> {
  await getPgPool().query('DELETE FROM attachments_outbound WHERE session_id = $1 AND message_id = $2', [
    sessionId,
    messageId,
  ]);
}

/**
 * Read the container's heartbeat for a session. Used by host-sweep.
 * Returns the age (ms) since the last touch, or null if never beat.
 */
export async function heartbeatAgeMs(sessionId: string): Promise<number | null> {
  const { rows } = await getPgPool().query<{ age_ms: string | null }>(
    `SELECT EXTRACT(EPOCH FROM (now() - last_beat)) * 1000 AS age_ms
       FROM heartbeats WHERE session_id = $1`,
    [sessionId],
  );
  if (!rows[0] || rows[0].age_ms === null) return null;
  return Number(rows[0].age_ms);
}

/**
 * Read the agent's processing claims (for stuck-message detection).
 * Mirrors the SQLite host-sweep query.
 */
export async function getProcessingClaims(
  sessionId: string,
): Promise<Array<{ message_id: string; status: string; status_changed: string }>> {
  const { rows } = await getPgPool().query<{ message_id: string; status: string; status_changed: string }>(
    `SELECT message_id, status, status_changed::text AS status_changed
       FROM processing_acks
      WHERE session_id = $1`,
    [sessionId],
  );
  return rows;
}

/**
 * Read the container's current-tool state (for sweep tolerance widening
 * when a long-running tool with a declared timeout is active).
 */
export async function getContainerState(sessionId: string): Promise<{
  current_tool: string | null;
  tool_declared_timeout_ms: number | null;
  tool_started_at: string | null;
} | null> {
  const { rows } = await getPgPool().query<{
    current_tool: string | null;
    tool_declared_timeout_ms: number | null;
    tool_started_at: string | null;
  }>(
    `SELECT current_tool, tool_declared_timeout_ms,
            tool_started_at::text AS tool_started_at
       FROM container_state WHERE session_id = $1`,
    [sessionId],
  );
  return rows[0] ?? null;
}

/** Reset stale 'processing' rows back to pending for retry. */
export async function clearOrphanProcessingClaims(sessionId: string): Promise<number> {
  const result = await getPgPool().query(
    "DELETE FROM processing_acks WHERE session_id = $1 AND status = 'processing'",
    [sessionId],
  );
  return result.rowCount ?? 0;
}
