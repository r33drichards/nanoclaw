/**
 * Host sweep — Postgres-backed branch.
 *
 * Mirrors the SQLite path's per-session sweep operations against the
 * unified declarative schema. Functions are async because pg is async,
 * but the orchestrator (sweep() in host-sweep.ts) is already async.
 *
 * Three concerns map cleanly:
 *
 *   1. syncProcessingAcks  → UPDATE messages_in.status FROM processing_acks
 *      filtered by session_id, mirroring the SQLite cross-DB JOIN that
 *      happens in src/db/session-db.ts's syncProcessingAcks.
 *
 *   2. countDueMessages    → SELECT COUNT(*) … WHERE status='pending'
 *      AND trigger=1 AND (process_after IS NULL OR process_after <= now()).
 *
 *   3. resetStuckProcessingRows → DELETE FROM processing_acks +
 *      UPDATE messages_in SET status='pending', process_after=now()+backoff,
 *      tries=tries+1 (or status='failed' once tries hits MAX_TRIES).
 */
import { getPgPool } from './postgres.js';

import type { ContainerState } from './session-db.js';

export interface MessageForRetry {
  id: string;
  process_after: string | null;
  tries: number;
}

/** UPDATE messages_in.status to match processing_acks for this session. */
export async function syncProcessingAcksPg(sessionId: string): Promise<void> {
  // Two-step: rows acked completed/failed flip messages_in.status.
  // 'processing' is observational only — the host doesn't mirror it back.
  await getPgPool().query(
    `UPDATE messages_in mi
        SET status = pa.status
       FROM processing_acks pa
      WHERE mi.session_id = $1
        AND pa.session_id = $1
        AND mi.id = pa.message_id
        AND pa.status IN ('completed', 'failed')
        AND mi.status <> pa.status`,
    [sessionId],
  );
}

export async function countDueMessagesPg(sessionId: string): Promise<number> {
  const { rows } = await getPgPool().query<{ count: string }>(
    `SELECT COUNT(*)::text AS count
       FROM messages_in
      WHERE session_id = $1
        AND status = 'pending'
        AND trigger = 1
        AND (process_after IS NULL OR process_after <= now())`,
    [sessionId],
  );
  return Number(rows[0]?.count ?? 0);
}

export interface ProcessingClaim {
  message_id: string;
  status: string;
  status_changed: string;
}

export async function getProcessingClaimsPg(sessionId: string): Promise<ProcessingClaim[]> {
  const { rows } = await getPgPool().query<ProcessingClaim>(
    `SELECT message_id, status, status_changed::text AS status_changed
       FROM processing_acks
      WHERE session_id = $1`,
    [sessionId],
  );
  return rows;
}

export async function getContainerStatePg(sessionId: string): Promise<ContainerState | null> {
  const { rows } = await getPgPool().query<{
    current_tool: string | null;
    tool_declared_timeout_ms: number | string | null;
    tool_started_at: string | null;
    updated_at: string;
  }>(
    `SELECT current_tool,
            tool_declared_timeout_ms,
            tool_started_at::text AS tool_started_at,
            updated_at::text AS updated_at
       FROM container_state WHERE session_id = $1`,
    [sessionId],
  );
  const r = rows[0];
  if (!r) return null;
  return {
    current_tool: r.current_tool,
    tool_declared_timeout_ms: r.tool_declared_timeout_ms === null ? null : Number(r.tool_declared_timeout_ms),
    tool_started_at: r.tool_started_at,
  };
}

/**
 * Heartbeat age in ms, or null if no row exists yet (fresh container).
 * Null is treated as "no ceiling check" by the sweep — same semantics as
 * the SQLite path's heartbeatMtimeMs returning 0.
 */
export async function heartbeatAgeMsPg(sessionId: string): Promise<number | null> {
  const { rows } = await getPgPool().query<{ age_ms: string | null }>(
    `SELECT EXTRACT(EPOCH FROM (now() - last_beat)) * 1000 AS age_ms
       FROM heartbeats WHERE session_id = $1`,
    [sessionId],
  );
  if (!rows[0] || rows[0].age_ms === null) return null;
  return Number(rows[0].age_ms);
}

/** Lookup a single messages_in row for retry-decisioning. */
export async function getMessageForRetryPg(sessionId: string, messageId: string): Promise<MessageForRetry | null> {
  const { rows } = await getPgPool().query<MessageForRetry>(
    `SELECT id, process_after::text AS process_after, tries
       FROM messages_in
      WHERE session_id = $1 AND id = $2 AND status = 'pending'`,
    [sessionId, messageId],
  );
  return rows[0] ?? null;
}

export async function retryWithBackoffPg(sessionId: string, messageId: string, backoffSec: number): Promise<void> {
  await getPgPool().query(
    `UPDATE messages_in
        SET process_after = now() + ($3::int || ' seconds')::interval,
            tries = tries + 1
      WHERE session_id = $1 AND id = $2`,
    [sessionId, messageId, backoffSec],
  );
}

export async function markMessageFailedPg(sessionId: string, messageId: string): Promise<void> {
  await getPgPool().query(`UPDATE messages_in SET status = 'failed' WHERE session_id = $1 AND id = $2`, [
    sessionId,
    messageId,
  ]);
}

/** DELETE the 'processing' rows so the next sweep tick doesn't re-see them. */
export async function deleteOrphanProcessingClaimsPg(sessionId: string): Promise<number> {
  const r = await getPgPool().query(`DELETE FROM processing_acks WHERE session_id = $1 AND status = 'processing'`, [
    sessionId,
  ]);
  return r.rowCount ?? 0;
}
