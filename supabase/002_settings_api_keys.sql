-- Migration 002: Add API key rows to settings table + service_role bypass policy
-- Run this in the Supabase SQL Editor AFTER migrations.sql has been applied
-- Date: 2026-03-24

-- Add API key rows to the settings table
-- Values are entered via the Settings page in the dashboard — never hardcode real keys here
insert into public.settings (key, value) values
  ('telnyx_api_key',       ''),
  ('telnyx_connection_id', ''),
  ('deepgram_api_key',     ''),
  ('elevenlabs_api_key',   ''),
  ('elevenlabs_voice_id',  '21m00Tcm4TlvDq8ikWAM'),
  ('anthropic_api_key',    ''),
  ('openai_api_key',       '')
on conflict (key) do nothing;

-- Allow the service role (used by ws-server and dashboard API routes) to read/write settings
-- without being blocked by the authenticated-only RLS policy
create policy "Service role bypass settings" on public.settings
  for all using (auth.role() = 'service_role');
