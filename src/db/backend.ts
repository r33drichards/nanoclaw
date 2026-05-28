/**
 * Single source of truth for which DB backend is active.
 *
 * `getBackend()` returns 'sqlite' (default) or 'postgres'. Callers that
 * have both implementations available branch on this once at start-up
 * rather than per-query.
 *
 * Selection precedence:
 *   1. NANOCLAW_DB_BACKEND env (sqlite | postgres)
 *   2. Default 'sqlite' (Docker / legacy install)
 */
export type DbBackend = 'sqlite' | 'postgres';

export function getBackend(): DbBackend {
  const v = process.env.NANOCLAW_DB_BACKEND?.toLowerCase();
  if (v === 'postgres' || v === 'pg' || v === 'postgresql') return 'postgres';
  return 'sqlite';
}

export function isPostgres(): boolean {
  return getBackend() === 'postgres';
}

/**
 * Where the host reads config tables (agent_groups, messaging_groups,
 * messaging_group_agents, users, roles, members, destinations). Independent
 * of the DB backend: an install can run Postgres for runtime state while
 * still using a DB-resident config (uncommon), or SQLite for runtime with
 * CRD-resident config (theoretically possible). The typical declarative
 * deployment uses 'postgres' + 'crd' together.
 *
 * Selection precedence:
 *   1. NANOCLAW_CONFIG_SOURCE env (db | crd)
 *   2. Default 'db' (legacy install)
 */
export type ConfigSource = 'db' | 'crd';

export function getConfigSource(): ConfigSource {
  const v = process.env.NANOCLAW_CONFIG_SOURCE?.toLowerCase();
  if (v === 'crd' || v === 'kubernetes' || v === 'k8s') return 'crd';
  return 'db';
}

export function isCrdConfig(): boolean {
  return getConfigSource() === 'crd';
}
