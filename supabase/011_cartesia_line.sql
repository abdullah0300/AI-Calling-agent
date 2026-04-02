-- ══════════════════════════════════════════════════════════════════════════════
-- Migration 011 — Cartesia Line parallel pipeline
--
-- Adds two columns to agents so each agent can independently choose between:
--   native        — your own STT → LLM → TTS pipeline (default, unchanged)
--   cartesia_line — delegates the full conversation to Cartesia Line
--
-- All existing agents default to 'native' automatically.
-- No other tables are touched.
-- ══════════════════════════════════════════════════════════════════════════════

ALTER TABLE agents
  ADD COLUMN IF NOT EXISTS pipeline_type     text NOT NULL DEFAULT 'native'
    CHECK (pipeline_type IN ('native', 'cartesia_line')),
  ADD COLUMN IF NOT EXISTS cartesia_agent_id text;

-- ── complete_schema.sql upgrade path note ─────────────────────────────────────
-- If running against an existing deployment, run only these two ALTER statements.
-- If running complete_schema.sql on a fresh project, add these lines there too.
