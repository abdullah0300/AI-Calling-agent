-- Migration 010: server_logs table
-- Captures application-level errors and warnings from ws-server in real-time.
-- Written fire-and-forget by the logger utility — never blocks the call pipeline.
-- Retention: rows older than 30 days can be pruned via a Supabase cron job.

CREATE TABLE IF NOT EXISTS public.server_logs (
  id         uuid        NOT NULL DEFAULT uuid_generate_v4() PRIMARY KEY,
  level      text        NOT NULL CHECK (level IN ('info', 'warn', 'error')),
  source     text        NOT NULL,  -- 'pipeline', 'dialer', 'stt', 'tts', 'recording', 'webhook'
  message    text        NOT NULL,
  context    jsonb,                  -- optional structured data (call_id, lead_id, status codes, etc.)
  call_id    uuid        REFERENCES public.calls(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS server_logs_created_idx ON public.server_logs (created_at DESC);
CREATE INDEX IF NOT EXISTS server_logs_level_idx   ON public.server_logs (level, created_at DESC);
CREATE INDEX IF NOT EXISTS server_logs_source_idx  ON public.server_logs (source, created_at DESC);
CREATE INDEX IF NOT EXISTS server_logs_call_idx    ON public.server_logs (call_id) WHERE call_id IS NOT NULL;
