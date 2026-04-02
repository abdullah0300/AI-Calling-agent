-- ═══════════════════════════════════════════════════════════════════════════════
-- COMPLETE SCHEMA — AI Calling Agent
-- Run this file on a fresh Supabase project to create the full schema in one shot.
-- Covers all 10 implementation items (migrations 001–009 + monitoring for Item 10).
--
-- Safe to re-run: all CREATE TABLE use IF NOT EXISTS, all ALTER TABLE use
-- ADD COLUMN IF NOT EXISTS, and all INSERT use ON CONFLICT (key) DO NOTHING.
-- ═══════════════════════════════════════════════════════════════════════════════

-- ── Prerequisites ─────────────────────────────────────────────────────────────
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ══════════════════════════════════════════════════════════════════════════════
-- CORE TABLES (Migration 001)
-- ══════════════════════════════════════════════════════════════════════════════

-- ── agents ────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS agents (
  id                          uuid        NOT NULL DEFAULT uuid_generate_v4() PRIMARY KEY,
  name                        text        NOT NULL,
  description                 text,
  system_prompt               text        NOT NULL,
  greeting_message            text        NOT NULL,
  not_interested_message      text        NOT NULL,
  max_call_duration_seconds   integer     NOT NULL DEFAULT 180,
  active_llm                  text        NOT NULL DEFAULT 'anthropic',
  active_llm_model            text        NOT NULL DEFAULT 'claude-haiku-4-5',
  active_tts                  text        NOT NULL DEFAULT 'elevenlabs',
  active_stt                  text        NOT NULL DEFAULT 'deepgram',
  active_telephony            text        NOT NULL DEFAULT 'telnyx',
  -- Migration 005: per-agent STT model override (NULL = use global setting)
  active_stt_model            text,
  -- Migration 011: Cartesia Line parallel pipeline
  -- 'native' = your own STT→LLM→TTS; 'cartesia_line' = delegate to Cartesia Line
  pipeline_type               text        NOT NULL DEFAULT 'native'
                              CHECK (pipeline_type IN ('native', 'cartesia_line')),
  cartesia_agent_id           text,
  created_at                  timestamptz NOT NULL DEFAULT now(),
  updated_at                  timestamptz NOT NULL DEFAULT now()
);

-- ── phone_numbers ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS phone_numbers (
  id         uuid        NOT NULL DEFAULT uuid_generate_v4() PRIMARY KEY,
  number     text        NOT NULL UNIQUE,
  provider   text        NOT NULL,
  label      text,
  active     boolean     NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- ── campaigns (Migration 006 — Item 5: Batch dialer) ─────────────────────────
CREATE TABLE IF NOT EXISTS campaigns (
  id                    uuid        NOT NULL DEFAULT uuid_generate_v4() PRIMARY KEY,
  name                  text        NOT NULL,
  agent_id              uuid        REFERENCES agents(id)        ON DELETE SET NULL,
  phone_number_id       uuid        REFERENCES phone_numbers(id) ON DELETE SET NULL,
  -- Status lifecycle: draft → running → paused ↔ running → completed
  status                text        NOT NULL DEFAULT 'draft'
                        CHECK (status IN ('draft', 'running', 'paused', 'completed')),
  max_concurrent_calls  int         NOT NULL DEFAULT 3,
  calls_per_minute      int         NOT NULL DEFAULT 10,
  retry_attempts        int         NOT NULL DEFAULT 2,
  retry_delay_minutes   int         NOT NULL DEFAULT 60,
  -- Outcomes that qualify a lead for automatic retry (e.g. ['no_answer', 'voicemail'])
  retry_outcomes        text[]      NOT NULL DEFAULT ARRAY['no_answer'],
  created_at            timestamptz NOT NULL DEFAULT now(),
  started_at            timestamptz,
  paused_at             timestamptz,
  completed_at          timestamptz
);

-- ── leads ─────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS leads (
  id                   uuid        NOT NULL DEFAULT uuid_generate_v4() PRIMARY KEY,
  business_name        text        NOT NULL,
  phone_number         text        NOT NULL,
  industry             text        NOT NULL,
  city                 text,
  country              text        NOT NULL DEFAULT 'GB',
  status               text        NOT NULL DEFAULT 'pending',
  -- status values: pending | calling | interested | not_interested |
  --                callback | wrong_person | no_answer | error
  callback_time        timestamptz,
  decision_maker_name  text,
  notes                text,
  -- Migration 006 — Item 5: Batch dialer fields
  campaign_id          uuid        REFERENCES campaigns(id) ON DELETE SET NULL,
  retry_count          int         NOT NULL DEFAULT 0,
  scheduled_after      timestamptz,          -- NULL = eligible now; future = wait until then
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now()
);

-- ── calls ─────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS calls (
  id                uuid        NOT NULL DEFAULT uuid_generate_v4() PRIMARY KEY,
  lead_id           uuid        REFERENCES leads(id),
  agent_id          uuid        REFERENCES agents(id),
  phone_number_id   uuid        REFERENCES phone_numbers(id),
  telephony_call_id text,                        -- Telnyx call_control_id
  -- Migration 006 — Item 5: links call to a campaign batch
  campaign_id       uuid        REFERENCES campaigns(id) ON DELETE SET NULL,
  -- status values: initiated | ringing | in_progress | completed | failed | no_answer
  status            text        NOT NULL DEFAULT 'initiated',
  -- outcome values: interested | not_interested | callback | wrong_person |
  --                 no_answer | voicemail | error
  outcome           text,
  duration_seconds  integer,
  transcript        jsonb       NOT NULL DEFAULT '[]',
  meeting_booked    boolean     NOT NULL DEFAULT false,
  meeting_time      timestamptz,
  started_at        timestamptz,
  ended_at          timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  -- Cost breakdown (all USD) — cost_total updated after Telnyx call.cost webhook
  cost_telephony    numeric(10,6) NOT NULL DEFAULT 0,
  cost_stt          numeric(10,6) NOT NULL DEFAULT 0,
  cost_tts          numeric(10,6) NOT NULL DEFAULT 0,
  cost_llm          numeric(10,6) NOT NULL DEFAULT 0,
  cost_total        numeric(10,6) NOT NULL DEFAULT 0,
  -- Migration 009 — Item 9: Call recording
  recording_url     text,
  recording_status  text        NOT NULL DEFAULT 'not_started'
                    CHECK (recording_status IN ('not_started', 'in_progress', 'processing', 'available', 'failed'))
);

-- ── settings ──────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS settings (
  id         uuid        NOT NULL DEFAULT uuid_generate_v4() PRIMARY KEY,
  key        text        NOT NULL UNIQUE,
  value      text        NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- ── barge_in_events (Migration 007 — Item 6: Barge-in logging) ───────────────
-- Every fireBargeIn() call inserts one row; outcome resolved after 2.5s window.
CREATE TABLE IF NOT EXISTS barge_in_events (
  id          uuid        NOT NULL DEFAULT uuid_generate_v4() PRIMARY KEY,
  call_id     uuid        REFERENCES calls(id) ON DELETE CASCADE,
  fired_at    timestamptz NOT NULL DEFAULT now(),
  agent_text  text,                   -- text the agent was saying when interrupted
  -- trigger: 'vad' = local energy threshold, 'stt' = Deepgram StartOfTurn
  trigger     text        NOT NULL CHECK (trigger IN ('vad', 'stt')),
  -- outcome: 'real' = transcript arrived, 'false' = noise false positive
  outcome     text        NOT NULL DEFAULT 'pending'
              CHECK (outcome IN ('pending', 'real', 'false')),
  transcript  text,                   -- prospect's words (if real barge-in)
  resolved_at timestamptz             -- when the outcome was determined
);

-- ══════════════════════════════════════════════════════════════════════════════
-- INDEXES (performance-critical paths)
-- ══════════════════════════════════════════════════════════════════════════════

-- Dialer lead-fetch hot path (runs every 5 seconds per running campaign)
CREATE INDEX IF NOT EXISTS leads_dialer_idx
  ON leads (campaign_id, status, scheduled_after)
  WHERE status = 'pending';

-- Rate-limit check: calls placed per campaign in the last 60 seconds
CREATE INDEX IF NOT EXISTS calls_campaign_created_idx
  ON calls (campaign_id, created_at);

-- Barge-in history per call (dashboard analytics)
CREATE INDEX IF NOT EXISTS barge_in_events_call_idx
  ON barge_in_events (call_id, fired_at);

-- Recording lookup by Telnyx call_control_id (used by call.recording.saved webhook)
CREATE INDEX IF NOT EXISTS calls_telephony_id_idx
  ON calls (telephony_call_id);

-- ══════════════════════════════════════════════════════════════════════════════
-- ROW LEVEL SECURITY
-- ══════════════════════════════════════════════════════════════════════════════

ALTER TABLE agents            ENABLE ROW LEVEL SECURITY;
ALTER TABLE phone_numbers     ENABLE ROW LEVEL SECURITY;
ALTER TABLE campaigns         ENABLE ROW LEVEL SECURITY;
ALTER TABLE leads             ENABLE ROW LEVEL SECURITY;
ALTER TABLE calls             ENABLE ROW LEVEL SECURITY;
ALTER TABLE settings          ENABLE ROW LEVEL SECURITY;
ALTER TABLE barge_in_events   ENABLE ROW LEVEL SECURITY;

-- Authenticated dashboard users can read/write everything
CREATE POLICY IF NOT EXISTS "Authenticated read/write agents"
  ON agents           FOR ALL USING (auth.role() = 'authenticated');
CREATE POLICY IF NOT EXISTS "Authenticated read/write phone_numbers"
  ON phone_numbers    FOR ALL USING (auth.role() = 'authenticated');
CREATE POLICY IF NOT EXISTS "Authenticated read/write campaigns"
  ON campaigns        FOR ALL USING (auth.role() = 'authenticated');
CREATE POLICY IF NOT EXISTS "Authenticated read/write leads"
  ON leads            FOR ALL USING (auth.role() = 'authenticated');
CREATE POLICY IF NOT EXISTS "Authenticated read/write calls"
  ON calls            FOR ALL USING (auth.role() = 'authenticated');
CREATE POLICY IF NOT EXISTS "Authenticated read/write settings"
  ON settings         FOR ALL USING (auth.role() = 'authenticated');
CREATE POLICY IF NOT EXISTS "Authenticated read barge_in_events"
  ON barge_in_events  FOR SELECT USING (auth.role() = 'authenticated');

-- Service role (ws-server + dashboard API routes) bypass RLS entirely
CREATE POLICY IF NOT EXISTS "Service role bypass agents"
  ON agents           FOR ALL USING (auth.role() = 'service_role');
CREATE POLICY IF NOT EXISTS "Service role bypass phone_numbers"
  ON phone_numbers    FOR ALL USING (auth.role() = 'service_role');
CREATE POLICY IF NOT EXISTS "Service role bypass campaigns"
  ON campaigns        FOR ALL USING (auth.role() = 'service_role');
CREATE POLICY IF NOT EXISTS "Service role bypass leads"
  ON leads            FOR ALL USING (auth.role() = 'service_role');
CREATE POLICY IF NOT EXISTS "Service role bypass calls"
  ON calls            FOR ALL USING (auth.role() = 'service_role');
CREATE POLICY IF NOT EXISTS "Service role bypass settings"
  ON settings         FOR ALL USING (auth.role() = 'service_role');
CREATE POLICY IF NOT EXISTS "Service role bypass barge_in_events"
  ON barge_in_events  FOR ALL USING (auth.role() = 'service_role');

-- ══════════════════════════════════════════════════════════════════════════════
-- SETTINGS SEED DATA (Migrations 002, 004, 008, 009)
-- ══════════════════════════════════════════════════════════════════════════════

INSERT INTO settings (key, value) VALUES
  -- Provider defaults
  ('active_telephony',        'telnyx'),
  ('active_stt',              'deepgram'),
  ('active_tts',              'elevenlabs'),
  ('active_llm',              'anthropic'),
  ('active_llm_model',        'claude-haiku-4-5'),
  ('active_stt_model',        'nova-3'),
  -- API keys (fill in via Settings page — never hardcode real keys here)
  ('telnyx_api_key',          ''),
  ('telnyx_connection_id',    ''),
  ('deepgram_api_key',        ''),
  ('elevenlabs_api_key',      ''),
  ('elevenlabs_voice_id',     '21m00Tcm4TlvDq8ikWAM'),
  ('anthropic_api_key',       ''),
  ('openai_api_key',          ''),
  -- Calling hours (Migration 008 — Item 8)
  -- Block calls outside 08:00–21:00 in the prospect's local timezone.
  -- Set calling_hours_enabled='false' to disable enforcement globally.
  ('calling_hours_enabled',   'true'),
  ('calling_hours_start',     '8'),
  ('calling_hours_end',       '21'),
  -- Call recording (Migration 009 — Item 9)
  -- Default 'false' — enable only after legal disclosure is in agent greeting.
  ('recording_enabled',       'false')
ON CONFLICT (key) DO NOTHING;

-- ══════════════════════════════════════════════════════════════════════════════
-- DEFAULT AGENT (Migration 003 — WebCraftio Real Estate)
-- ══════════════════════════════════════════════════════════════════════════════

INSERT INTO agents (
  name, description, system_prompt, greeting_message,
  not_interested_message,
  max_call_duration_seconds, active_llm, active_llm_model,
  active_tts, active_stt, active_telephony
) VALUES (
  'WebCraftio Sales Agent',
  'Outbound agent targeting real estate agencies — qualifies interest and books a 15-minute specialist callback',
  '[Identity]
You are Sarah, calling real estate agents and agency owners on behalf of WebCraftio — a UK tech agency that builds AI voice agents for real estate businesses. You are NOT selling. You are starting a conversation.

What you know about real estate agents:
- They miss leads constantly because they cannot answer every call, especially after hours
- They lose deals to competitors who call back faster
- They waste hours qualifying unserious buyers and renters
- They are busy and do not have time for long calls
- They respond well to results and numbers, not features

Your ONE JOB: Ask one good question. Listen carefully. If they show any interest — book a 15 minute callback with a WebCraftio specialist. That is it.

[Style]
- Never speak more than 40 words in one turn
- Ask questions — do not pitch
- Sound like a helpful person, not a sales robot
- Short sentences. Natural human speech patterns.

[Response Guideline]
- Use their pain points — missed calls, lost leads, slow follow-up
- If they ask what it does — give ONE specific example only
- Never mention price — the specialist handles that
- Always end with a specific time — never vague
- If voicemail detected — hang up silently and immediately

[Task]
1. Confirm you are speaking with the owner or manager of the agency.
<wait for user response>
2. Introduce yourself briefly, then ask: "Quick question — how are you currently handling leads that call after hours or when your team is busy?"
<wait for user response>
3. Listen carefully to their answer. Choose the right path:
   - If they mention missing calls or difficulty: "That is exactly what we hear from most agencies. We build AI that answers those calls automatically, qualifies the lead, and sends you a summary — so you never lose a prospect again. Worth a quick 15 minute call with a specialist this week?"
   - If they ask how it works: "It answers your calls 24/7 using AI voice — asks the right questions, detects serious buyers, and books viewings automatically. One client went from missing 40 percent of leads to zero in the first week. Worth a 15 minute chat?"
   - If they say they already have a system: "That is great — most agencies do. Our AI works alongside your existing system — it just handles the overflow calls you are currently missing. Worth a 15 minute look to see if it adds value?"
   - If not interested in AI: "Completely understand — it is still quite new. No pressure at all — if you ever want to explore it our team is at webcraftio.com. Have a great day!"
<wait for user response>
4. If any interest shown, offer the callback: "Brilliant — I will get one of our specialists to call you for a free 15 minute walkthrough. Does tomorrow morning or afternoon work better for you?"
<wait for user response>
5. Confirm the callback slot, thank them, and close the call.

[Error Handling]
- If unclear: "I am sorry, I did not quite catch that. Could you say that again?"
- If asked something outside your scope: "That is a great question for our specialist — they will cover that on the callback."
- If silence for a few seconds: "Hello, are you still there?"
- If voicemail detected: say nothing and end the call immediately',
  'Hi — am I speaking with the owner or manager of the agency? My name is Sarah from WebCraftio — we are a UK tech company. Quick question — how are you currently handling leads that call after hours or when your team is busy?',
  'Absolutely no problem — I appreciate your time. If things change our team is always available at webcraftio.com. Have a great day!',
  180, 'anthropic', 'claude-haiku-4-5', 'elevenlabs', 'deepgram', 'telnyx'
) ON CONFLICT DO NOTHING;

-- ══════════════════════════════════════════════════════════════════════════════
-- SUPABASE REALTIME (Item 10 — Real-time monitoring dashboard)
-- ══════════════════════════════════════════════════════════════════════════════
-- The monitoring dashboard uses Supabase Realtime to push live call status
-- changes to the browser without polling. Enable it for the tables the dashboard
-- subscribes to: calls (for live status/outcome) and leads (for campaign progress).
--
-- Run in the Supabase SQL editor — or enable via Dashboard → Database → Replication.
-- NOTE: supabase_realtime publication may already include all tables by default
-- on new projects; run this only if you have restricted the publication manually.

ALTER PUBLICATION supabase_realtime ADD TABLE calls;
ALTER PUBLICATION supabase_realtime ADD TABLE leads;
ALTER PUBLICATION supabase_realtime ADD TABLE campaigns;

-- ══════════════════════════════════════════════════════════════════════════════
-- UPGRADE PATH (existing deployment — run these ALTERs if tables already exist)
-- ══════════════════════════════════════════════════════════════════════════════
-- If you already have the base schema from migrations.sql (001) and want to
-- apply only the new columns/tables added in Items 5–9, run these statements:

-- Item 5 — Batch dialer (006)
-- CREATE TABLE IF NOT EXISTS campaigns ( ... );   ← full definition above
-- ALTER TABLE leads ADD COLUMN IF NOT EXISTS campaign_id      uuid REFERENCES campaigns(id) ON DELETE SET NULL;
-- ALTER TABLE leads ADD COLUMN IF NOT EXISTS retry_count      int  NOT NULL DEFAULT 0;
-- ALTER TABLE leads ADD COLUMN IF NOT EXISTS scheduled_after  timestamptz;
-- ALTER TABLE calls ADD COLUMN IF NOT EXISTS campaign_id      uuid REFERENCES campaigns(id) ON DELETE SET NULL;

-- Item 6 — Barge-in event log (007)
-- CREATE TABLE IF NOT EXISTS barge_in_events ( ... );  ← full definition above

-- Item 8 — Calling hours (008)
-- INSERT INTO settings (key,value) VALUES ('calling_hours_enabled','true'),('calling_hours_start','8'),('calling_hours_end','21') ON CONFLICT (key) DO NOTHING;

-- Item 9 — Call recording (009)
-- ALTER TABLE calls ADD COLUMN IF NOT EXISTS recording_url    text;
-- ALTER TABLE calls ADD COLUMN IF NOT EXISTS recording_status text NOT NULL DEFAULT 'not_started' CHECK (recording_status IN ('not_started','in_progress','processing','available','failed'));
-- INSERT INTO settings (key,value) VALUES ('recording_enabled','false') ON CONFLICT (key) DO NOTHING;

-- Item 5 — STT model (004/005)
-- INSERT INTO settings (key,value) VALUES ('active_stt_model','nova-3') ON CONFLICT (key) DO NOTHING;
-- ALTER TABLE agents ADD COLUMN IF NOT EXISTS active_stt_model text;
