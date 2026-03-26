-- Add per-agent STT model override.
-- NULL means "use the global active_stt_model from the settings table".
-- Non-null value overrides the global setting for that specific agent.
ALTER TABLE public.agents
  ADD COLUMN IF NOT EXISTS active_stt_model text;
