/**
 * Postgres equivalent of src/db/sessions.ts.
 *
 * All functions are async. Schema is the unified declarative-mode schema
 * defined in deploy/postgres/10-schema.sql. Subsequent commits port the
 * remaining accessors and the call graph that consumes them.
 *
 * Function signatures intentionally mirror their sync counterparts so a
 * future router file can pick one or the other based on
 * `getBackend()` with no shape change at the call site.
 */
import type { PendingApproval, PendingQuestion, Session } from '../types.js';

import { getPgPool } from './postgres.js';

// ── Sessions ──

export async function createSession(session: Session): Promise<void> {
  await getPgPool().query(
    `INSERT INTO sessions
       (id, agent_group_id, messaging_group_id, thread_id,
        agent_provider, status, container_status, last_active, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     ON CONFLICT (id) DO NOTHING`,
    [
      session.id,
      session.agent_group_id,
      session.messaging_group_id,
      session.thread_id,
      session.agent_provider,
      session.status,
      session.container_status,
      session.last_active,
      session.created_at,
    ],
  );
}

export async function getSession(id: string): Promise<Session | undefined> {
  const { rows } = await getPgPool().query<Session>('SELECT * FROM sessions WHERE id = $1', [id]);
  return rows[0];
}

export async function findSession(messagingGroupId: string, threadId: string | null): Promise<Session | undefined> {
  if (threadId !== null) {
    const { rows } = await getPgPool().query<Session>(
      `SELECT * FROM sessions
        WHERE messaging_group_id = $1 AND thread_id = $2 AND status = 'active'`,
      [messagingGroupId, threadId],
    );
    return rows[0];
  }
  const { rows } = await getPgPool().query<Session>(
    `SELECT * FROM sessions
      WHERE messaging_group_id = $1 AND thread_id IS NULL AND status = 'active'`,
    [messagingGroupId],
  );
  return rows[0];
}

export async function findSessionForAgent(
  agentGroupId: string,
  messagingGroupId: string,
  threadId: string | null,
): Promise<Session | undefined> {
  if (threadId !== null) {
    const { rows } = await getPgPool().query<Session>(
      `SELECT * FROM sessions
        WHERE agent_group_id = $1 AND messaging_group_id = $2
          AND thread_id = $3 AND status = 'active'`,
      [agentGroupId, messagingGroupId, threadId],
    );
    return rows[0];
  }
  const { rows } = await getPgPool().query<Session>(
    `SELECT * FROM sessions
      WHERE agent_group_id = $1 AND messaging_group_id = $2
        AND thread_id IS NULL AND status = 'active'`,
    [agentGroupId, messagingGroupId],
  );
  return rows[0];
}

export async function findSessionByAgentGroup(agentGroupId: string): Promise<Session | undefined> {
  const { rows } = await getPgPool().query<Session>(
    `SELECT * FROM sessions
      WHERE agent_group_id = $1 AND status = 'active'
      ORDER BY created_at DESC LIMIT 1`,
    [agentGroupId],
  );
  return rows[0];
}

export async function getSessionsByAgentGroup(agentGroupId: string): Promise<Session[]> {
  const { rows } = await getPgPool().query<Session>('SELECT * FROM sessions WHERE agent_group_id = $1', [agentGroupId]);
  return rows;
}

export async function getActiveSessions(): Promise<Session[]> {
  const { rows } = await getPgPool().query<Session>("SELECT * FROM sessions WHERE status = 'active'");
  return rows;
}

export async function getRunningSessions(): Promise<Session[]> {
  const { rows } = await getPgPool().query<Session>(
    "SELECT * FROM sessions WHERE container_status IN ('running', 'idle')",
  );
  return rows;
}

export async function updateSession(
  id: string,
  updates: Partial<Pick<Session, 'status' | 'container_status' | 'last_active' | 'agent_provider'>>,
): Promise<void> {
  const fields: string[] = [];
  const values: unknown[] = [];
  let i = 1;
  for (const [key, value] of Object.entries(updates)) {
    if (value !== undefined) {
      fields.push(`${key} = $${i++}`);
      values.push(value);
    }
  }
  if (fields.length === 0) return;
  values.push(id);
  await getPgPool().query(`UPDATE sessions SET ${fields.join(', ')} WHERE id = $${i}`, values);
}

export async function deleteSession(id: string): Promise<void> {
  await getPgPool().query('DELETE FROM sessions WHERE id = $1', [id]);
}

// ── Pending Questions ──

export async function createPendingQuestion(pq: PendingQuestion): Promise<boolean> {
  const result = await getPgPool().query(
    `INSERT INTO pending_questions
       (question_id, session_id, message_out_id, platform_id, channel_type, thread_id,
        title, options, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9)
     ON CONFLICT (question_id) DO NOTHING`,
    [
      pq.question_id,
      pq.session_id,
      pq.message_out_id,
      pq.platform_id,
      pq.channel_type,
      pq.thread_id,
      pq.title,
      JSON.stringify(pq.options),
      pq.created_at,
    ],
  );
  return (result.rowCount ?? 0) > 0;
}

export async function getPendingQuestion(questionId: string): Promise<PendingQuestion | undefined> {
  const { rows } = await getPgPool().query<Omit<PendingQuestion, 'options'> & { options: string }>(
    'SELECT * FROM pending_questions WHERE question_id = $1',
    [questionId],
  );
  if (!rows[0]) return undefined;
  // postgres.ts overrides jsonb to return raw strings (matches SQLite
  // TEXT contract). `options` is a JSON string; parse it for callers.
  return { ...rows[0], options: JSON.parse(rows[0].options) };
}

export async function deletePendingQuestion(questionId: string): Promise<void> {
  await getPgPool().query('DELETE FROM pending_questions WHERE question_id = $1', [questionId]);
}

// ── Pending Approvals ──

export async function createPendingApproval(
  pa: Partial<PendingApproval> &
    Pick<
      PendingApproval,
      'approval_id' | 'request_id' | 'action' | 'payload' | 'created_at' | 'title' | 'options_json'
    >,
): Promise<boolean> {
  const result = await getPgPool().query(
    `INSERT INTO pending_approvals
       (approval_id, session_id, request_id, action, payload, created_at,
        agent_group_id, channel_type, platform_id, platform_message_id, expires_at, status,
        title, options_json)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14::jsonb)
     ON CONFLICT (approval_id) DO NOTHING`,
    [
      pa.approval_id,
      pa.session_id ?? null,
      pa.request_id,
      pa.action,
      pa.payload,
      pa.created_at,
      pa.agent_group_id ?? null,
      pa.channel_type ?? null,
      pa.platform_id ?? null,
      pa.platform_message_id ?? null,
      pa.expires_at ?? null,
      pa.status ?? 'pending',
      pa.title,
      pa.options_json,
    ],
  );
  return (result.rowCount ?? 0) > 0;
}

export async function getPendingApproval(approvalId: string): Promise<PendingApproval | undefined> {
  const { rows } = await getPgPool().query<PendingApproval>('SELECT * FROM pending_approvals WHERE approval_id = $1', [
    approvalId,
  ]);
  return rows[0];
}

export async function updatePendingApprovalStatus(
  approvalId: string,
  status: PendingApproval['status'],
): Promise<void> {
  await getPgPool().query('UPDATE pending_approvals SET status = $1 WHERE approval_id = $2', [status, approvalId]);
}

export async function deletePendingApproval(approvalId: string): Promise<void> {
  await getPgPool().query('DELETE FROM pending_approvals WHERE approval_id = $1', [approvalId]);
}

export async function getPendingApprovalsByAction(action: string): Promise<PendingApproval[]> {
  const { rows } = await getPgPool().query<PendingApproval>('SELECT * FROM pending_approvals WHERE action = $1', [
    action,
  ]);
  return rows;
}
