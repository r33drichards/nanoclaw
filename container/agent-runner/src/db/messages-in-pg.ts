/**
 * Inbound message operations (container side, Postgres backend).
 *
 * Reads from messages_in (host-written) WHERE session_id = self.
 * Writes processing_acks WHERE session_id = self.
 *
 * Function signatures mirror messages-in.ts so callers can swap with a
 * one-line import change once the boot sequence picks a backend.
 */
import { getPgPool, getSessionId } from './connection-pg.js';

export interface MessageInRow {
  id: string;
  seq: number | null;
  kind: string;
  timestamp: string;
  status: string;
  process_after: string | null;
  recurrence: string | null;
  tries: number;
  trigger: number;
  platform_id: string | null;
  channel_type: string | null;
  thread_id: string | null;
  content: string;
}

const DEFAULT_MAX = 10;

function maxMessagesPerPrompt(): number {
  const v = process.env.NANOCLAW_MAX_MESSAGES_PER_PROMPT;
  if (!v) return DEFAULT_MAX;
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_MAX;
}

/**
 * Fetch pending messages that are due for processing. Mirrors the
 * SQLite version's selection logic:
 *
 *   - status = 'pending'
 *   - process_after IS NULL OR process_after <= now()
 *   - on_wake = 0 unless isFirstPoll
 *   - ORDER BY seq DESC LIMIT N, then filter against processing_acks,
 *     then reverse so the agent sees oldest first
 */
export async function getPendingMessages(isFirstPoll = false): Promise<MessageInRow[]> {
  const sessionId = getSessionId();
  const limit = maxMessagesPerPrompt();
  const { rows } = await getPgPool().query<MessageInRow & { content_json: unknown }>(
    `SELECT id, seq, kind, timestamp::text AS timestamp, status,
            process_after::text AS process_after, recurrence, tries, trigger,
            platform_id, channel_type, thread_id, content::text AS content
       FROM messages_in
       WHERE session_id = $1
         AND status = 'pending'
         AND (process_after IS NULL OR process_after <= now())
         AND (on_wake = 0 OR $2 = TRUE)
       ORDER BY seq DESC
       LIMIT $3`,
    [sessionId, isFirstPoll, limit],
  );
  if (rows.length === 0) return [];

  const acked = await getPgPool().query<{ message_id: string }>(
    'SELECT message_id FROM processing_acks WHERE session_id = $1',
    [sessionId],
  );
  const ackedIds = new Set(acked.rows.map((r) => r.message_id));
  return rows.filter((m) => !ackedIds.has(m.id)).reverse() as MessageInRow[];
}

export async function markProcessing(ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  await upsertAck(ids, 'processing');
}

export async function markCompleted(ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  await upsertAck(ids, 'completed');
}

export async function markFailed(id: string): Promise<void> {
  await upsertAck([id], 'failed');
}

async function upsertAck(ids: string[], status: 'processing' | 'completed' | 'failed'): Promise<void> {
  // Bulk upsert via UNNEST — single round trip regardless of list size.
  await getPgPool().query(
    `INSERT INTO processing_acks (session_id, message_id, status, status_changed)
     SELECT $1, msg_id, $2, now()
       FROM unnest($3::text[]) AS msg_id
     ON CONFLICT (session_id, message_id) DO UPDATE SET
       status = excluded.status,
       status_changed = excluded.status_changed`,
    [getSessionId(), status, ids],
  );
}

export async function getMessageIn(id: string): Promise<MessageInRow | undefined> {
  const { rows } = await getPgPool().query<MessageInRow>(
    `SELECT id, seq, kind, timestamp::text AS timestamp, status,
            process_after::text AS process_after, recurrence, tries, trigger,
            platform_id, channel_type, thread_id, content::text AS content
       FROM messages_in
       WHERE session_id = $1 AND id = $2`,
    [getSessionId(), id],
  );
  return rows[0];
}

/**
 * Find a pending response by questionId embedded in content JSON.
 * Uses Postgres's @> JSONB containment instead of a LIKE pattern.
 */
export async function findQuestionResponse(questionId: string): Promise<MessageInRow | undefined> {
  const sessionId = getSessionId();
  const { rows } = await getPgPool().query<MessageInRow>(
    `SELECT id, seq, kind, timestamp::text AS timestamp, status,
            process_after::text AS process_after, recurrence, tries, trigger,
            platform_id, channel_type, thread_id, content::text AS content
       FROM messages_in
       WHERE session_id = $1
         AND status = 'pending'
         AND content @> jsonb_build_object('questionId', $2::text)`,
    [sessionId, questionId],
  );
  if (!rows[0]) return undefined;

  const acked = await getPgPool().query(
    'SELECT 1 FROM processing_acks WHERE session_id = $1 AND message_id = $2',
    [sessionId, rows[0].id],
  );
  if ((acked.rowCount ?? 0) > 0) return undefined;
  return rows[0];
}
