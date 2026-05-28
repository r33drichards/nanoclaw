-- NanoClaw Postgres roles
--
-- Two writer roles enforce the single-writer-per-table invariant at the
-- database level. The host writes inbound and delivery state; the agent
-- writes outbound and processing state. Wrong-side writes fail with
-- permission errors, not silent corruption.
--
-- This file is idempotent; running it multiple times is safe.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nanoclaw_host') THEN
    CREATE ROLE nanoclaw_host LOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nanoclaw_agent') THEN
    CREATE ROLE nanoclaw_agent LOGIN;
  END IF;
END$$;

-- Grant connect on the application database. The chart wires the actual
-- password via a Secret; CNPG manages credential rotation.
GRANT CONNECT ON DATABASE nanoclaw TO nanoclaw_host;
GRANT CONNECT ON DATABASE nanoclaw TO nanoclaw_agent;

GRANT USAGE ON SCHEMA public TO nanoclaw_host;
GRANT USAGE ON SCHEMA public TO nanoclaw_agent;
