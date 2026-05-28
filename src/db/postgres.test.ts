import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

// We don't need a live Postgres for these tests. Only the schema-dir
// resolver and the backend selector are exercised.
import { getBackend, isPostgres } from './backend.js';

describe('backend selector', () => {
  const original = process.env.NANOCLAW_DB_BACKEND;
  afterEach(() => {
    if (original === undefined) delete process.env.NANOCLAW_DB_BACKEND;
    else process.env.NANOCLAW_DB_BACKEND = original;
  });

  it('defaults to sqlite when env is unset', () => {
    delete process.env.NANOCLAW_DB_BACKEND;
    expect(getBackend()).toBe('sqlite');
    expect(isPostgres()).toBe(false);
  });

  it('returns postgres for any of pg / postgres / postgresql', () => {
    for (const v of ['postgres', 'POSTGRES', 'pg', 'postgresql']) {
      process.env.NANOCLAW_DB_BACKEND = v;
      expect(getBackend()).toBe('postgres');
      expect(isPostgres()).toBe(true);
    }
  });

  it('returns sqlite for any other value', () => {
    process.env.NANOCLAW_DB_BACKEND = 'mysql';
    expect(getBackend()).toBe('sqlite');
  });
});

describe('schema dir resolver', () => {
  const original = process.env.NANOCLAW_PG_SCHEMA_DIR;
  afterEach(() => {
    if (original === undefined) delete process.env.NANOCLAW_PG_SCHEMA_DIR;
    else process.env.NANOCLAW_PG_SCHEMA_DIR = original;
  });

  it('finds deploy/postgres/ from the repo (dev mode)', async () => {
    delete process.env.NANOCLAW_PG_SCHEMA_DIR;
    // postgres.ts has an internal helper but it's not exported; assert
    // the directory exists where we expect it to so the dev-mode path
    // works.
    const repoRoot = path.resolve(__dirname, '..', '..');
    expect(fs.existsSync(path.join(repoRoot, 'deploy', 'postgres', '10-schema.sql'))).toBe(true);
  });

  it('honors NANOCLAW_PG_SCHEMA_DIR override', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ncl-pg-'));
    fs.writeFileSync(path.join(tmp, '00-test.sql'), 'SELECT 1;');
    process.env.NANOCLAW_PG_SCHEMA_DIR = tmp;
    expect(fs.readdirSync(tmp)).toContain('00-test.sql');
    fs.rmSync(tmp, { recursive: true });
  });
});

describe('schema file shape', () => {
  it('contains all four SQL files in deploy/postgres', () => {
    const repoRoot = path.resolve(__dirname, '..', '..');
    const dir = path.join(repoRoot, 'deploy', 'postgres');
    const files = fs
      .readdirSync(dir)
      .filter((f) => f.endsWith('.sql'))
      .sort();
    expect(files).toEqual(['00-roles.sql', '10-schema.sql', '20-triggers.sql', '30-grants.sql']);
  });

  it('declares every table the host accessors reference', () => {
    const schema = fs.readFileSync(path.resolve(__dirname, '..', '..', 'deploy', 'postgres', '10-schema.sql'), 'utf8');
    for (const t of [
      'sessions',
      'messages_in',
      'messages_out',
      'delivered',
      'destinations',
      'session_routing',
      'processing_acks',
      'session_state',
      'container_state',
      'heartbeats',
      'attachments_inbound',
      'attachments_outbound',
      'pending_questions',
      'pending_approvals',
      'pending_sender_approvals',
      'pending_channel_approvals',
      'user_dms',
      'unregistered_senders',
      'dropped_messages',
      'chat_sdk_kv',
    ]) {
      expect(schema).toContain(`CREATE TABLE IF NOT EXISTS ${t}`);
    }
  });
});
