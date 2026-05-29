-- NanoClaw runtime schema (Postgres)
--
-- Replaces the SQLite layout from src/db/migrations/ and the per-session
-- inbound.db / outbound.db files. All per-session tables carry a
-- `session_id` column; rows are unified across sessions, indexed by
-- (session_id, …) for fast per-session scans.
--
-- Config that lived in central SQLite tables (agent_groups, container_configs,
-- messaging_groups, messaging_group_agents, agent_destinations, users,
-- user_roles, agent_group_members) is sourced from CRDs in declarative mode
-- and is not stored here. Runtime state and async-work tracking is.
--
-- Single-writer enforcement: see 00-roles.sql for grants. The host role
-- can write only to host-owned tables; the agent role only to its own.

-- ──────────────────────────────────────────────────────────────────────
-- Session registry (one row per active conversation thread)
-- ──────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS sessions (
  id                  TEXT PRIMARY KEY,
  agent_group_id      TEXT NOT NULL,
  messaging_group_id  TEXT,
  thread_id           TEXT,
  agent_provider      TEXT,
  status              TEXT NOT NULL DEFAULT 'active',
  container_status    TEXT NOT NULL DEFAULT 'stopped',
  last_active         TIMESTAMPTZ,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_sessions_agent_group ON sessions(agent_group_id);
CREATE INDEX IF NOT EXISTS idx_sessions_lookup ON sessions(messaging_group_id, thread_id);

-- ──────────────────────────────────────────────────────────────────────
-- Host-owned: inbound messages + delivery tracking
-- ──────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS messages_in (
  session_id     TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  id             TEXT NOT NULL,
  seq            BIGINT NOT NULL,
  kind           TEXT NOT NULL,
  timestamp      TIMESTAMPTZ NOT NULL DEFAULT now(),
  status         TEXT NOT NULL DEFAULT 'pending',
  process_after  TIMESTAMPTZ,
  recurrence     TEXT,
  series_id      TEXT,
  tries          INTEGER NOT NULL DEFAULT 0,
  trigger        SMALLINT NOT NULL DEFAULT 1,
  platform_id    TEXT,
  channel_type   TEXT,
  thread_id      TEXT,
  content        JSONB NOT NULL,
  on_wake        SMALLINT NOT NULL DEFAULT 0,
  source_session_id TEXT,
  PRIMARY KEY (session_id, id),
  UNIQUE (session_id, seq)
);
CREATE INDEX IF NOT EXISTS idx_messages_in_due
  ON messages_in (session_id, status, process_after)
  WHERE status = 'pending';

CREATE TABLE IF NOT EXISTS delivered (
  session_id          TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  message_out_id      TEXT NOT NULL,
  platform_message_id TEXT,
  status              TEXT NOT NULL DEFAULT 'delivered',
  delivered_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (session_id, message_out_id)
);

CREATE TABLE IF NOT EXISTS destinations (
  session_id      TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  name            TEXT NOT NULL,
  display_name    TEXT,
  type            TEXT NOT NULL,
  channel_type    TEXT,
  platform_id     TEXT,
  agent_group_id  TEXT,
  PRIMARY KEY (session_id, name)
);

CREATE TABLE IF NOT EXISTS session_routing (
  session_id      TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
  channel_type    TEXT,
  platform_id     TEXT,
  thread_id       TEXT,
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS attachments_inbound (
  session_id   TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  message_id   TEXT NOT NULL,
  filename     TEXT NOT NULL,
  content_type TEXT,
  content      BYTEA NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (session_id, message_id, filename)
);

-- ──────────────────────────────────────────────────────────────────────
-- Agent-owned: outbound + processing + per-session agent state
-- ──────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS messages_out (
  session_id     TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  id             TEXT NOT NULL,
  seq            BIGINT NOT NULL,
  in_reply_to    TEXT,
  timestamp      TIMESTAMPTZ NOT NULL DEFAULT now(),
  deliver_after  TIMESTAMPTZ,
  recurrence     TEXT,
  kind           TEXT NOT NULL,
  platform_id    TEXT,
  channel_type   TEXT,
  thread_id      TEXT,
  content        JSONB NOT NULL,
  PRIMARY KEY (session_id, id),
  UNIQUE (session_id, seq)
);
CREATE INDEX IF NOT EXISTS idx_messages_out_due
  ON messages_out (session_id, deliver_after);

CREATE TABLE IF NOT EXISTS processing_acks (
  session_id     TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  message_id     TEXT NOT NULL,
  status         TEXT NOT NULL,
  status_changed TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (session_id, message_id)
);

CREATE TABLE IF NOT EXISTS session_state (
  session_id  TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  key         TEXT NOT NULL,
  value       JSONB NOT NULL,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (session_id, key)
);

CREATE TABLE IF NOT EXISTS container_state (
  session_id               TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
  current_tool             TEXT,
  tool_declared_timeout_ms BIGINT,
  tool_started_at          TIMESTAMPTZ,
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS heartbeats (
  session_id  TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
  last_beat   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS attachments_outbound (
  session_id   TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  message_id   TEXT NOT NULL,
  filename     TEXT NOT NULL,
  content_type TEXT,
  content      BYTEA NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (session_id, message_id, filename)
);

-- ──────────────────────────────────────────────────────────────────────
-- Host-side async-work tables (former central DB rows that don't fit CRDs)
-- ──────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS pending_questions (
  question_id    TEXT PRIMARY KEY,
  session_id     TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  message_out_id TEXT NOT NULL,
  platform_id    TEXT,
  channel_type   TEXT,
  thread_id      TEXT,
  title          TEXT NOT NULL,
  options        JSONB NOT NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_pending_questions_session
  ON pending_questions(session_id);

CREATE TABLE IF NOT EXISTS pending_sender_approvals (
  id                  TEXT PRIMARY KEY,
  messaging_group_id  TEXT NOT NULL,
  user_id             TEXT NOT NULL,
  platform_id         TEXT,
  display_name        TEXT,
  request_payload     JSONB NOT NULL,
  status              TEXT NOT NULL DEFAULT 'pending',
  title               TEXT NOT NULL DEFAULT '',
  options_json        JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  decided_at          TIMESTAMPTZ
);

-- Generic approval state. Used by install_packages, add_mcp_server,
-- OneCLI credential approvals, etc. References to sessions are FK'd;
-- references to config (agent_group_id) are plain TEXT because the
-- agent group lives in a CRD in declarative mode.
CREATE TABLE IF NOT EXISTS pending_approvals (
  approval_id         TEXT PRIMARY KEY,
  session_id          TEXT REFERENCES sessions(id) ON DELETE CASCADE,
  request_id          TEXT NOT NULL,
  action              TEXT NOT NULL,
  payload             JSONB NOT NULL,
  agent_group_id      TEXT,
  channel_type        TEXT,
  platform_id         TEXT,
  platform_message_id TEXT,
  expires_at          TIMESTAMPTZ,
  status              TEXT NOT NULL DEFAULT 'pending',
  title               TEXT NOT NULL DEFAULT '',
  options_json        JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_pending_approvals_action_status
  ON pending_approvals(action, status);

-- Unknown-channel registration: an unwired channel that received a
-- mention or DM, awaiting owner approval before being wired to an
-- agent. PRIMARY KEY on messaging_group_id is the dedup mechanism —
-- a second mention while a card is pending is silently swallowed.
CREATE TABLE IF NOT EXISTS pending_channel_approvals (
  messaging_group_id   TEXT PRIMARY KEY,
  agent_group_id       TEXT NOT NULL,
  original_message     JSONB NOT NULL,
  approver_user_id     TEXT NOT NULL,
  title                TEXT NOT NULL DEFAULT '',
  options_json         JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS user_dms (
  user_id            TEXT NOT NULL,
  channel_type       TEXT NOT NULL,
  messaging_group_id TEXT NOT NULL,
  resolved_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, channel_type)
);

CREATE TABLE IF NOT EXISTS unregistered_senders (
  id                  BIGSERIAL PRIMARY KEY,
  channel_type        TEXT NOT NULL,
  platform_id         TEXT NOT NULL,
  messaging_group_id  TEXT,
  display_name        TEXT,
  observed_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_unregistered_senders_lookup
  ON unregistered_senders(channel_type, platform_id);

CREATE TABLE IF NOT EXISTS dropped_messages (
  id            BIGSERIAL PRIMARY KEY,
  channel_type  TEXT NOT NULL,
  platform_id   TEXT NOT NULL,
  reason        TEXT NOT NULL,
  payload       JSONB,
  dropped_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ──────────────────────────────────────────────────────────────────────
-- Chat SDK bridge state (host-internal, transient platform binding cache)
-- ──────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS chat_sdk_kv (
  scope     TEXT NOT NULL,
  key       TEXT NOT NULL,
  value     JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (scope, key)
);
CREATE TABLE IF NOT EXISTS chat_sdk_subscriptions (
  id         TEXT PRIMARY KEY,
  topic      TEXT NOT NULL,
  payload    JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS chat_sdk_locks (
  resource    TEXT PRIMARY KEY,
  holder      TEXT NOT NULL,
  acquired_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at  TIMESTAMPTZ NOT NULL
);
CREATE TABLE IF NOT EXISTS chat_sdk_lists (
  scope      TEXT NOT NULL,
  list_key   TEXT NOT NULL,
  position   BIGINT NOT NULL,
  value      JSONB NOT NULL,
  PRIMARY KEY (scope, list_key, position)
);

-- ──────────────────────────────────────────────────────────────────────
-- Schema-version table (matches src/db/migrations/index.ts contract)
-- ──────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS schema_version (
  version    INTEGER PRIMARY KEY,
  name       TEXT NOT NULL,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
INSERT INTO schema_version (version, name) VALUES (1, 'declarative-initial')
  ON CONFLICT (version) DO NOTHING;
