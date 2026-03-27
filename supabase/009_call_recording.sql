-- Migration 009: call recording columns + recording_enabled setting
-- Adds recording_url and recording_status to the calls table.
-- The ws-server updates recording_status='in_progress' when record_start is called,
-- then the call.recording.saved Telnyx webhook sets status='available' + stores the URL.

ALTER TABLE calls
  ADD COLUMN IF NOT EXISTS recording_url    text,
  ADD COLUMN IF NOT EXISTS recording_status text NOT NULL DEFAULT 'not_started'
    CHECK (recording_status IN ('not_started', 'in_progress', 'processing', 'available', 'failed'));

-- Seed the recording_enabled setting.
-- Default is 'false' — must be explicitly enabled after confirming legal disclosure
-- is present in the agent's greeting / system prompt (GDPR / Ofcom requirements).
INSERT INTO settings (key, value)
VALUES ('recording_enabled', 'false')
ON CONFLICT (key) DO NOTHING;
