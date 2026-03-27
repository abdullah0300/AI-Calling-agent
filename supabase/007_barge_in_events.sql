-- Migration 007: barge-in event log
-- Every fireBargeIn() call inserts one row. The outcome is updated after 2.5s:
--   'real'  — a transcript arrived → genuine interruption
--   'false' — no transcript arrived → caused by noise, VAD false-positive, etc.
-- This table is the primary data source for tuning VAD thresholds and understanding
-- why the agent is being interrupted during calls.

CREATE TABLE IF NOT EXISTS barge_in_events (
  id           uuid        NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  call_id      uuid        REFERENCES calls(id) ON DELETE CASCADE,
  -- Wall-clock time the barge-in fired (TTS aborted, Telnyx buffer cleared)
  fired_at     timestamptz NOT NULL DEFAULT now(),
  -- Text the agent was speaking when interrupted (null if agent was silent)
  agent_text   text,
  -- Which subsystem detected speech: 'vad' (local energy) or 'stt' (Deepgram StartOfTurn)
  trigger      text        NOT NULL CHECK (trigger IN ('vad', 'stt')),
  -- Resolved outcome after the 2.5s recovery window closes
  outcome      text        NOT NULL DEFAULT 'pending'
               CHECK (outcome IN ('pending', 'real', 'false')),
  -- Transcript of what the prospect said, if it was a real barge-in
  transcript   text,
  -- When the outcome was determined (null while still pending)
  resolved_at  timestamptz
);

-- Index for per-call barge-in history (used by dashboard analytics)
CREATE INDEX IF NOT EXISTS barge_in_events_call_id_idx ON barge_in_events (call_id, fired_at);

-- RLS — same policy pattern as other tables
ALTER TABLE barge_in_events ENABLE ROW LEVEL SECURITY;
CREATE POLICY IF NOT EXISTS "Authenticated can view barge_in_events"   ON barge_in_events FOR SELECT USING (auth.role() = 'authenticated');
CREATE POLICY IF NOT EXISTS "Service role bypass for barge_in_events"  ON barge_in_events FOR ALL   USING (auth.role() = 'service_role');
