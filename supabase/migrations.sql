-- Run these in order in the Supabase SQL Editor

-- 1. UUID extension
create extension if not exists "uuid-ossp";

-- 2. Agents table
create table public.agents (
  id uuid primary key default uuid_generate_v4(),
  name text not null,
  description text,
  system_prompt text not null,
  greeting_message text not null,
  interest_detected_message text not null,
  not_interested_message text not null,
  wrong_person_message text not null,
  callback_message text not null,
  max_call_duration_seconds integer not null default 180,
  active_llm text not null default 'anthropic',
  active_llm_model text not null default 'claude-haiku-4-5',
  active_tts text not null default 'elevenlabs',
  active_stt text not null default 'deepgram',
  active_telephony text not null default 'telnyx',
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

-- 3. Phone numbers table
create table public.phone_numbers (
  id uuid primary key default uuid_generate_v4(),
  number text not null unique,
  provider text not null,
  label text,
  active boolean default true,
  created_at timestamptz default now()
);

-- 4. Leads table
create table public.leads (
  id uuid primary key default uuid_generate_v4(),
  business_name text not null,
  phone_number text not null,
  industry text not null,
  city text,
  country text default 'GB',
  status text not null default 'pending',
  callback_time timestamptz,
  decision_maker_name text,
  notes text,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);
-- status: pending | calling | interested | not_interested | callback | wrong_person | no_answer | error

-- 5. Calls table
create table public.calls (
  id uuid primary key default uuid_generate_v4(),
  lead_id uuid references public.leads(id),
  agent_id uuid references public.agents(id),
  phone_number_id uuid references public.phone_numbers(id),
  telephony_call_id text,
  status text not null default 'initiated',
  outcome text,
  duration_seconds integer,
  transcript jsonb default '[]',
  meeting_booked boolean default false,
  meeting_time timestamptz,
  started_at timestamptz,
  ended_at timestamptz,
  created_at timestamptz default now(),
  cost_telephony numeric(10,6) default 0,
  cost_stt numeric(10,6) default 0,
  cost_tts numeric(10,6) default 0,
  cost_llm numeric(10,6) default 0,
  cost_total numeric(10,6) default 0
);
-- status: initiated | ringing | in_progress | completed | failed | no_answer
-- outcome: interested | not_interested | callback | wrong_person | no_answer | voicemail | error
-- cost columns (all in USD):
--   cost_telephony: exact amount from Telnyx call.cost webhook
--   cost_stt: Deepgram Nova-3 streaming @ $0.0077/min
--   cost_tts: ElevenLabs Flash v2.5 @ $0.30/1K chars, Deepgram Aura @ $0.030/1K chars
--   cost_llm: Claude Haiku 4.5 @ $1.00/M input + $5.00/M output tokens
--   cost_total: sum of all above (updated after Telnyx call.cost arrives)
-- Migration: run the following ALTER statements if table already exists:
-- ALTER TABLE public.calls ADD COLUMN IF NOT EXISTS cost_telephony numeric(10,6) default 0;
-- ALTER TABLE public.calls ADD COLUMN IF NOT EXISTS cost_stt numeric(10,6) default 0;
-- ALTER TABLE public.calls ADD COLUMN IF NOT EXISTS cost_tts numeric(10,6) default 0;
-- ALTER TABLE public.calls ADD COLUMN IF NOT EXISTS cost_llm numeric(10,6) default 0;
-- ALTER TABLE public.calls ADD COLUMN IF NOT EXISTS cost_total numeric(10,6) default 0;

-- 6. Settings table
create table public.settings (
  id uuid primary key default uuid_generate_v4(),
  key text not null unique,
  value text not null,
  updated_at timestamptz default now()
);

insert into public.settings (key, value) values
  ('active_telephony', 'telnyx'),
  ('active_stt', 'deepgram'),
  ('active_tts', 'elevenlabs'),
  ('active_llm', 'anthropic'),
  ('active_llm_model', 'claude-haiku-4-5');

-- 7. Row Level Security
alter table public.agents enable row level security;
alter table public.leads enable row level security;
alter table public.calls enable row level security;
alter table public.phone_numbers enable row level security;
alter table public.settings enable row level security;

create policy "Allow authenticated" on public.agents for all using (auth.role() = 'authenticated');
create policy "Allow authenticated" on public.leads for all using (auth.role() = 'authenticated');
create policy "Allow authenticated" on public.calls for all using (auth.role() = 'authenticated');
create policy "Allow authenticated" on public.phone_numbers for all using (auth.role() = 'authenticated');
create policy "Allow authenticated" on public.settings for all using (auth.role() = 'authenticated');
create policy "Service role bypass calls" on public.calls for all using (auth.role() = 'service_role');
create policy "Service role bypass leads" on public.leads for all using (auth.role() = 'service_role');
create policy "Service role bypass agents" on public.agents for all using (auth.role() = 'service_role');

-- 8. Default WebCraftio Real Estate Agent
-- System prompt uses Vapi industry-standard [Section] format.
-- Each section is editable separately in the dashboard agent form.
insert into public.agents (
  name, description, system_prompt, greeting_message,
  interest_detected_message, not_interested_message,
  wrong_person_message, callback_message,
  max_call_duration_seconds, active_llm, active_llm_model,
  active_tts, active_stt, active_telephony
) values (
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
  'Brilliant — I will get one of our specialists to call you for a free 15 minute walkthrough. Does tomorrow morning or afternoon work better for you?',
  'Absolutely no problem — I appreciate your time. If things change our team is always available at webcraftio.com. Have a great day!',
  'No problem at all — thanks for letting me know. Could I ask who handles technology decisions for the agency? And what is the best time to reach them?',
  'Of course — sounds like now is not ideal. Would tomorrow morning work better? I can have a specialist call you at a time that suits you completely.',
  180, 'anthropic', 'claude-haiku-4-5', 'elevenlabs', 'deepgram', 'telnyx'
);
