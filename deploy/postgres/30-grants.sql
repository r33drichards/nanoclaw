-- Single-writer-per-table enforcement at the DB level.
--
-- nanoclaw_host writes:  messages_in, delivered, destinations,
--                        session_routing, sessions, pending_questions,
--                        pending_sender_approvals, user_dms,
--                        unregistered_senders, dropped_messages,
--                        chat_sdk_*, attachments_inbound.
-- nanoclaw_host reads:   everything (sweep + delivery need visibility into
--                        agent-owned tables).
--
-- nanoclaw_agent writes: messages_out, processing_acks, session_state,
--                        container_state, heartbeats, attachments_outbound.
-- nanoclaw_agent reads:  messages_in, delivered, destinations,
--                        session_routing, sessions, attachments_inbound.
--
-- Wrong-side writes fail with a Postgres permission error, surfacing the
-- bug instead of silently corrupting the cross-writer invariant.

-- Host writes
GRANT SELECT, INSERT, UPDATE, DELETE ON
  sessions,
  messages_in,
  delivered,
  destinations,
  session_routing,
  pending_questions,
  pending_sender_approvals,
  user_dms,
  unregistered_senders,
  dropped_messages,
  chat_sdk_kv,
  chat_sdk_subscriptions,
  chat_sdk_locks,
  chat_sdk_lists,
  attachments_inbound,
  schema_version
TO nanoclaw_host;

-- Host reads (agent-owned)
GRANT SELECT ON
  messages_out,
  processing_acks,
  session_state,
  container_state,
  heartbeats,
  attachments_outbound
TO nanoclaw_host;

-- Sequence (BIGSERIAL columns)
GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA public TO nanoclaw_host;

-- Agent writes
GRANT SELECT, INSERT, UPDATE, DELETE ON
  messages_out,
  processing_acks,
  session_state,
  container_state,
  heartbeats,
  attachments_outbound
TO nanoclaw_agent;

-- Agent reads (host-owned)
GRANT SELECT ON
  messages_in,
  delivered,
  destinations,
  session_routing,
  sessions,
  attachments_inbound
TO nanoclaw_agent;
