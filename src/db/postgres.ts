/**
 * Host-side Postgres connection layer.
 *
 * Used in declarative mode (NANOCLAW_DB_BACKEND=postgres) instead of
 * the SQLite path in `connection.ts`. The two layers coexist — the
 * SQLite path remains the default for Docker installs.
 *
 * Connection parameters follow the standard libpq env contract:
 * PGHOST, PGPORT, PGDATABASE, PGUSER, PGPASSWORD, PGSSLMODE. The
 * Helm chart wires these via the CNPG-managed app Secret.
 *
 * Boot sequence:
 *   1. `initPg()` — open the pool, wait for connectivity (with retry).
 *   2. `runPgMigrations()` — execute deploy/postgres/{00..30}.sql against
 *      a fresh database. Idempotent; safe to re-run.
 *   3. Accessor functions in `src/db/*-pg.ts` use `getPgPool()`.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import pg from 'pg';

import { log } from '../log.js';

// Override pg's default JSONB parser so callers see raw JSON strings
// instead of parsed JS values. This matches the SQLite path's contract
// (TEXT columns containing JSON strings) and lets accessor TS types
// stay unchanged (`payload: string`, `options_json: string`).
//
// Consumers that want parsed objects use JSON.parse at the call site,
// exactly as they did under SQLite.
//
// 3802 = OID for jsonb, 114 = OID for json.
pg.types.setTypeParser(3802, (v: string) => v);
pg.types.setTypeParser(114, (v: string) => v);

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let _pool: pg.Pool | null = null;

export interface PgInitOptions {
  /** Override pg.PoolConfig. Defaults to libpq env. */
  config?: pg.PoolConfig;
  /** Retry connect up to N times (default 30) with 1s backoff. */
  maxConnectRetries?: number;
}

export function getPgPool(): pg.Pool {
  if (!_pool) throw new Error('Postgres not initialized. Call initPg() first.');
  return _pool;
}

export async function initPg(opts: PgInitOptions = {}): Promise<pg.Pool> {
  const cfg: pg.PoolConfig = opts.config ?? {
    // pg reads PGHOST/PGPORT/PGUSER/PGPASSWORD/PGDATABASE from process.env
    // when these are omitted. Setting an explicit max keeps the pool
    // bounded under sweep + delivery contention.
    max: Number(process.env.PGPOOL_MAX ?? '10'),
  };
  const pool = new pg.Pool(cfg);
  const maxRetries = opts.maxConnectRetries ?? 30;
  for (let i = 0; i < maxRetries; i++) {
    try {
      const client = await pool.connect();
      try {
        await client.query('SELECT 1');
      } finally {
        client.release();
      }
      _pool = pool;
      log.info('Postgres connected', {
        host: cfg.host ?? process.env.PGHOST,
        database: cfg.database ?? process.env.PGDATABASE,
      });
      return pool;
    } catch (err) {
      if (i === maxRetries - 1) throw err;
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
  throw new Error('unreachable');
}

export async function closePg(): Promise<void> {
  if (_pool) {
    await _pool.end();
    _pool = null;
  }
}

/**
 * Run the deploy/postgres/*.sql files in order. Each statement is wrapped
 * in `IF NOT EXISTS` / `DO $$ ... $$` so re-execution is safe.
 *
 * On a fresh DB this populates the entire schema. On an existing DB it
 * is essentially a no-op (CREATE TABLE IF NOT EXISTS, etc.).
 *
 * Looks for SQL files in (priority order):
 *   1. process.env.NANOCLAW_PG_SCHEMA_DIR (override)
 *   2. <repo>/deploy/postgres/        (dev / local builds)
 *   3. /etc/nanoclaw/postgres-schema/ (Helm chart projects ConfigMap here)
 */
export async function runPgMigrations(): Promise<void> {
  const pool = getPgPool();
  const dir = resolveSchemaDir();
  const files = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .sort();
  if (files.length === 0) {
    throw new Error(`no SQL files found in ${dir}`);
  }
  for (const f of files) {
    const sql = fs.readFileSync(path.join(dir, f), 'utf8');
    log.info('Running pg migration', { file: f });
    await pool.query(sql);
  }
}

function resolveSchemaDir(): string {
  const override = process.env.NANOCLAW_PG_SCHEMA_DIR;
  if (override) return override;
  // The compiled dist/ is one level under repo root; SQL lives at repo
  // root sibling-of-src. Walk up until we find deploy/postgres/.
  let dir = __dirname;
  for (let i = 0; i < 5; i++) {
    const candidate = path.join(dir, 'deploy', 'postgres');
    if (fs.existsSync(candidate)) return candidate;
    dir = path.dirname(dir);
  }
  const fallback = '/etc/nanoclaw/postgres-schema';
  if (fs.existsSync(fallback)) return fallback;
  throw new Error('cannot locate Postgres schema directory; set NANOCLAW_PG_SCHEMA_DIR');
}

/**
 * Parameter-style helper: pg uses $1, $2, … by index. This thin wrapper
 * makes call sites read more like better-sqlite3's `.run(...args)` while
 * still using pg's correct positional binding. Use sparingly — direct
 * `pool.query(sql, [args])` is fine for normal cases.
 */
export async function pgRun(sql: string, ...args: unknown[]): Promise<pg.QueryResult> {
  return getPgPool().query(sql, args);
}
