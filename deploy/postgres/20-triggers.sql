-- NOTIFY triggers — push wake signals to container LISTENers.
--
-- Replaces the 1s active poll the agent-runner does today. When the host
-- INSERTs a wake-eligible inbound message, this trigger fires
-- pg_notify('ncl_session:<session_id>', payload). The agent-runner holds
-- a LISTEN on its own channel and processes the notification immediately.
--
-- Wake-eligibility mirrors the existing logic in
-- container/agent-runner/src/db/messages-in.ts:
--   - trigger = 1
--   - status = 'pending'
--   - (process_after IS NULL OR process_after <= now())
--
-- on_wake messages are excluded (they're delivered only on the first poll
-- after a fresh container start; LISTEN doesn't apply).

CREATE OR REPLACE FUNCTION notify_inbound_wake() RETURNS trigger AS $$
DECLARE
  channel TEXT;
  payload TEXT;
BEGIN
  IF NEW.trigger = 1
     AND NEW.status = 'pending'
     AND (NEW.process_after IS NULL OR NEW.process_after <= now())
     AND NEW.on_wake = 0 THEN
    channel := 'ncl_session_' || replace(NEW.session_id, '-', '_');
    payload := json_build_object(
      'session_id', NEW.session_id,
      'message_id', NEW.id,
      'seq', NEW.seq,
      'kind', NEW.kind
    )::text;
    PERFORM pg_notify(channel, payload);
  END IF;
  RETURN NEW;
END$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_notify_inbound_wake ON messages_in;
CREATE TRIGGER trg_notify_inbound_wake
  AFTER INSERT ON messages_in
  FOR EACH ROW
  EXECUTE FUNCTION notify_inbound_wake();

-- Host-side notify on outbound writes — wakes the delivery worker
-- without waiting for the 1s active poll tick.
CREATE OR REPLACE FUNCTION notify_outbound_deliver() RETURNS trigger AS $$
DECLARE
  payload TEXT;
BEGIN
  -- Only signal on rows that are ready right now. Delayed rows
  -- (deliver_after > now) get picked up by the 60s sweep.
  IF NEW.deliver_after IS NULL OR NEW.deliver_after <= now() THEN
    payload := json_build_object(
      'session_id', NEW.session_id,
      'message_id', NEW.id,
      'seq', NEW.seq,
      'kind', NEW.kind
    )::text;
    PERFORM pg_notify('ncl_outbound', payload);
  END IF;
  RETURN NEW;
END$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_notify_outbound_deliver ON messages_out;
CREATE TRIGGER trg_notify_outbound_deliver
  AFTER INSERT ON messages_out
  FOR EACH ROW
  EXECUTE FUNCTION notify_outbound_deliver();
