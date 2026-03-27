-- Migration 008: calling hours default settings
-- These rows seed the settings table with sensible defaults.
-- They can be overridden at any time via the Settings page (PATCH /api/settings).
--
-- calling_hours_enabled: 'true'  — set to 'false' to disable enforcement globally
-- calling_hours_start:   '8'     — 8:00 AM prospect local time (Ofcom guideline minimum)
-- calling_hours_end:     '21'    — 9:00 PM prospect local time (Ofcom guideline maximum)
--
-- Timezone is determined per-lead from the lead's country field.

INSERT INTO settings (key, value) VALUES
  ('calling_hours_enabled', 'true'),
  ('calling_hours_start',   '8'),
  ('calling_hours_end',     '21')
ON CONFLICT (key) DO NOTHING;
