/**
 * Container-side Postgres connection layer.
 *
 * Used in declarative mode (NANOCLAW_DB_BACKEND=postgres) instead of
 * the cross-mount SQLite path in connection.ts. The two layers
 * coexist — the SQLite path remains for legacy Docker installs.
 *
 * Connection parameters follow the standard libpq env contract
 * (PGHOST/PGPORT/PGDATABASE/PGUSER/PGPASSWORD). The chart injects
 * these via env on the SandboxTemplate; the controller stamps them
 * into each Sandbox pod.
 *
 * NANOCLAW_SESSION_ID is the session this pod belongs to and is
 * stamped into every query as a WHERE filter.
 */
import pg from 'pg';

// Same JSONB-as-string contract as the host (src/db/postgres.ts) so
// container code can stay shape-compatible with the existing SQLite
// path that stored JSON-in-TEXT.
pg.types.setTypeParser(3802, (v: string) => v);
pg.types.setTypeParser(114, (v: string) => v);

let _pool: pg.Pool | null = null;
let _listenClient: pg.PoolClient | null = null;

export interface PgInitOptions {
  config?: pg.PoolConfig;
  maxConnectRetries?: number;
}

export function getPgPool(): pg.Pool {
  if (!_pool) throw new Error('Postgres not initialized. Call initContainerPg() first.');
  return _pool;
}

export function getSessionId(): string {
  const id = process.env.NANOCLAW_SESSION_ID;
  if (!id) throw new Error('NANOCLAW_SESSION_ID env is required for container PG mode');
  return id;
}

/**
 * Initialize the Postgres pool. Container retries connect for a long
 * time because Sandbox pods often race ahead of CNPG cluster Ready —
 * agent-runner blocks on this and waits for the DB.
 */
export async function initContainerPg(opts: PgInitOptions = {}): Promise<pg.Pool> {
  const cfg: pg.PoolConfig = opts.config ?? {
    // Container is per-session and single-threaded — a small pool is enough.
    max: Number(process.env.PGPOOL_MAX ?? '5'),
  };
  const pool = new pg.Pool(cfg);
  const maxRetries = opts.maxConnectRetries ?? 60;
  for (let i = 0; i < maxRetries; i++) {
    try {
      const c = await pool.connect();
      try {
        await c.query('SELECT 1');
      } finally {
        c.release();
      }
      _pool = pool;
      return pool;
    } catch (err) {
      if (i === maxRetries - 1) throw err;
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
  throw new Error('unreachable');
}

/**
 * Subscribe to inbound wake notifications for this session. The
 * channel name matches the trigger in deploy/postgres/20-triggers.sql
 * (`ncl_session_<session_id_underscored>`).
 *
 * `onNotify` fires on every inbound row insert; the caller drives the
 * poll loop from these events plus a 60s fallback timer for
 * delayed/recurrence messages.
 *
 * The LISTEN connection is dedicated (a single pool client kept alive
 * for the container's lifetime) — sharing it with query traffic would
 * lose notifications during long-running statements.
 */
export async function listenForWakes(onNotify: (payload: string) => void): Promise<void> {
  const pool = getPgPool();
  const client = await pool.connect();
  _listenClient = client;
  client.on('notification', (msg) => {
    if (msg.payload !== undefined) onNotify(msg.payload);
  });
  client.on('error', (err) => {
    // Connection lost — null out so a future reconnect can swap it in.
    // The poll loop's 60s fallback covers the gap until reconnect.
    console.error('LISTEN client error', err);
    _listenClient = null;
  });
  const ch = sessionChannel(getSessionId());
  await client.query(`LISTEN ${ch}`);
}

export function sessionChannel(sessionId: string): string {
  // Match the trigger's identifier construction in 20-triggers.sql:
  // ncl_session_<session_id with dashes → underscores>
  return 'ncl_session_' + sessionId.replace(/-/g, '_');
}

/**
 * Touch the heartbeat row — replaces the file mtime touch in
 * connection.ts. Called every poll iteration.
 */
export async function touchHeartbeat(): Promise<void> {
  await getPgPool().query(
    `INSERT INTO heartbeats (session_id, last_beat) VALUES ($1, now())
     ON CONFLICT (session_id) DO UPDATE SET last_beat = excluded.last_beat`,
    [getSessionId()],
  );
}

/**
 * Set / clear the current tool's in-flight state on the session. Used
 * by the host sweep to extend stuck-tolerance for long-running tools
 * with declared timeouts.
 */
export async function setContainerToolInFlight(tool: string, declaredTimeoutMs: number | null): Promise<void> {
  await getPgPool().query(
    `INSERT INTO container_state
       (session_id, current_tool, tool_declared_timeout_ms, tool_started_at, updated_at)
     VALUES ($1, $2, $3, now(), now())
     ON CONFLICT (session_id) DO UPDATE SET
       current_tool = excluded.current_tool,
       tool_declared_timeout_ms = excluded.tool_declared_timeout_ms,
       tool_started_at = excluded.tool_started_at,
       updated_at = excluded.updated_at`,
    [getSessionId(), tool, declaredTimeoutMs],
  );
}

export async function clearContainerToolInFlight(): Promise<void> {
  await getPgPool().query(
    `INSERT INTO container_state
       (session_id, current_tool, tool_declared_timeout_ms, tool_started_at, updated_at)
     VALUES ($1, NULL, NULL, NULL, now())
     ON CONFLICT (session_id) DO UPDATE SET
       current_tool = NULL,
       tool_declared_timeout_ms = NULL,
       tool_started_at = NULL,
       updated_at = excluded.updated_at`,
    [getSessionId()],
  );
}

/**
 * On container startup, clear stale 'processing' rows from a previous
 * (crashed) run so this fresh container reprocesses those messages.
 */
export async function clearStaleProcessingAcks(): Promise<void> {
  await getPgPool().query(
    "DELETE FROM processing_acks WHERE session_id = $1 AND status = 'processing'",
    [getSessionId()],
  );
}

/**
 * Graceful shutdown: release the LISTEN client and end the pool.
 */
export async function closeContainerPg(): Promise<void> {
  if (_listenClient) {
    _listenClient.release();
    _listenClient = null;
  }
  if (_pool) {
    await _pool.end();
    _pool = null;
  }
}
