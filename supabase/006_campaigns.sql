-- Migration 006: campaigns table + lead retry/scheduling columns
-- Enables the batch dialer (Item 5): group leads into campaigns, control
-- concurrency, rate-limit calls/minute, auto-retry no_answer leads.

CREATE TABLE IF NOT EXISTS campaigns (
  id                    uuid        NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  name                  text        NOT NULL,
  agent_id              uuid        REFERENCES agents(id)        ON DELETE SET NULL,
  phone_number_id       uuid        REFERENCES phone_numbers(id) ON DELETE SET NULL,
  -- draft → running → paused ↔ running → completed
  status                text        NOT NULL DEFAULT 'draft'
                        CHECK (status IN ('draft', 'running', 'paused', 'completed')),
  -- Maximum parallel calls the dialer will maintain for this campaign
  max_concurrent_calls  int         NOT NULL DEFAULT 3,
  -- Hard cap on calls initiated per 60-second window
  calls_per_minute      int         NOT NULL DEFAULT 10,
  -- How many times to retry a lead that ended with a retry-eligible outcome
  retry_attempts        int         NOT NULL DEFAULT 2,
  -- Minutes to wait before the retry is eligible to dial again
  retry_delay_minutes   int         NOT NULL DEFAULT 60,
  -- Call outcomes that qualify a lead for retry (e.g. ['no_answer', 'voicemail'])
  retry_outcomes        text[]      NOT NULL DEFAULT ARRAY['no_answer'],
  created_at            timestamptz NOT NULL DEFAULT now(),
  started_at            timestamptz,
  paused_at             timestamptz,
  completed_at          timestamptz
);

-- Attach leads to campaigns and track retry state
ALTER TABLE leads ADD COLUMN IF NOT EXISTS campaign_id      uuid        REFERENCES campaigns(id) ON DELETE SET NULL;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS retry_count      int         NOT NULL DEFAULT 0;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS scheduled_after  timestamptz;

-- Track which campaign each call was part of
ALTER TABLE calls ADD COLUMN IF NOT EXISTS campaign_id uuid REFERENCES campaigns(id) ON DELETE SET NULL;

-- Index for the dialer's lead-fetch query (hot path, runs every 5 seconds)
CREATE INDEX IF NOT EXISTS leads_dialer_idx
  ON leads (campaign_id, status, scheduled_after)
  WHERE status = 'pending';

-- Index for the rate-limit check (calls placed per campaign in last 60s)
CREATE INDEX IF NOT EXISTS calls_campaign_created_idx
  ON calls (campaign_id, created_at);

-- Row-Level Security
ALTER TABLE campaigns ENABLE ROW LEVEL SECURITY;
CREATE POLICY IF NOT EXISTS "Authenticated can view campaigns"   ON campaigns FOR SELECT USING (auth.role() = 'authenticated');
CREATE POLICY IF NOT EXISTS "Authenticated can insert campaigns" ON campaigns FOR INSERT WITH CHECK (auth.role() = 'authenticated');
CREATE POLICY IF NOT EXISTS "Authenticated can update campaigns" ON campaigns FOR UPDATE USING (auth.role() = 'authenticated');
CREATE POLICY IF NOT EXISTS "Authenticated can delete campaigns" ON campaigns FOR DELETE USING (auth.role() = 'authenticated');
CREATE POLICY IF NOT EXISTS "Service role bypass for campaigns"  ON campaigns FOR ALL   USING (auth.role() = 'service_role');
