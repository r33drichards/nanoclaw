/**
 * Persistent key/value state for the container (Postgres backend).
 *
 * Mirrors session-state.ts. Stored in the shared `session_state` table
 * keyed by (session_id, key). The agent's primary use is remembering
 * each provider's opaque continuation id so the conversation resumes
 * across container restarts.
 */
import { getPgPool, getSessionId } from './connection-pg.js';

const LEGACY_KEY = 'sdk_session_id';

function continuationKey(providerName: string): string {
  return `continuation:${providerName.toLowerCase()}`;
}

async function getValue(key: string): Promise<string | undefined> {
  const { rows } = await getPgPool().query<{ value: string }>(
    'SELECT value::text AS value FROM session_state WHERE session_id = $1 AND key = $2',
    [getSessionId(), key],
  );
  if (!rows[0]) return undefined;
  // value is JSONB on the wire (parser returns raw string). Continuations
  // are stored as JSON strings like `"abc-123"`, so JSON.parse to unwrap.
  try {
    const parsed = JSON.parse(rows[0].value);
    return typeof parsed === 'string' ? parsed : rows[0].value;
  } catch {
    return rows[0].value;
  }
}

async function setValue(key: string, value: string): Promise<void> {
  await getPgPool().query(
    `INSERT INTO session_state (session_id, key, value, updated_at)
     VALUES ($1, $2, $3::jsonb, now())
     ON CONFLICT (session_id, key) DO UPDATE SET
       value = excluded.value,
       updated_at = excluded.updated_at`,
    [getSessionId(), key, JSON.stringify(value)],
  );
}

async function deleteValue(key: string): Promise<void> {
  await getPgPool().query('DELETE FROM session_state WHERE session_id = $1 AND key = $2', [getSessionId(), key]);
}

/**
 * One-time migration of the pre-per-provider continuation row. See
 * session-state.ts for the rationale — same logic, async DB.
 */
export async function migrateLegacyContinuation(providerName: string): Promise<string | undefined> {
  const legacy = await getValue(LEGACY_KEY);
  const currentKey = continuationKey(providerName);
  const current = await getValue(currentKey);

  if (legacy === undefined) return current;

  await deleteValue(LEGACY_KEY);

  if (current !== undefined) return current;

  await setValue(currentKey, legacy);
  return legacy;
}

export async function getContinuation(providerName: string): Promise<string | undefined> {
  return getValue(continuationKey(providerName));
}

export async function setContinuation(providerName: string, id: string): Promise<void> {
  await setValue(continuationKey(providerName), id);
}

export async function clearContinuation(providerName: string): Promise<void> {
  await deleteValue(continuationKey(providerName));
}
