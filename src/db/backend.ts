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
