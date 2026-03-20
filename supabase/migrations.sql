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
  created_at timestamptz default now()
);
-- status: initiated | ringing | in_progress | completed | failed | no_answer
-- outcome: interested | not_interested | callback | wrong_person | no_answer | voicemail | error

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

-- 8. Default WebCraftio Sales Agent
insert into public.agents (
  name, description, system_prompt, greeting_message,
  interest_detected_message, not_interested_message,
  wrong_person_message, callback_message,
  max_call_duration_seconds, active_llm, active_llm_model,
  active_tts, active_stt, active_telephony
) values (
  'WebCraftio Sales Agent',
  'Outbound agent for WebCraftio AI services',
  'You are a friendly outbound representative for WebCraftio, a UK-based web development and AI agency. You call business owners to introduce AI voice agents and chatbot services that automate customer calls. Services cost £500-£2000/month. Your ONLY goal is to detect interest and arrange a specialist callback. Never sell.',
  'Hello, is this the business? Hi, my name is Sarah from WebCraftio. We help businesses automate customer calls using AI agents. Quick question — have you looked into AI automation for your business at all?',
  'That is great to hear! I will have one of our specialists call you back for a quick 10-minute demo. Morning or afternoon works better for you?',
  'Absolutely no problem. Thanks so much for your time. Have a great day!',
  'Sorry about that! Who would be the right person to speak to about technology in the business? And the best time to reach them?',
  'Of course, completely understand. What time works better — morning or afternoon? And is there a specific person I should ask for?',
  180, 'anthropic', 'claude-haiku-4-5', 'elevenlabs', 'deepgram', 'telnyx'
);
