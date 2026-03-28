// ─── Campaign types ───────────────────────────────────────────────────────────
export type CampaignStatus = 'draft' | 'running' | 'paused' | 'completed'

export interface Campaign {
  id: string
  name: string
  agent_id: string | null
  phone_number_id: string | null
  status: CampaignStatus
  max_concurrent_calls: number
  calls_per_minute: number
  retry_attempts: number
  retry_delay_minutes: number
  retry_outcomes: string[]
  created_at: string
  started_at: string | null
  paused_at: string | null
  completed_at: string | null
}

export type TelephonyProvider = 'telnyx' | 'twilio'
export type STTProvider = 'deepgram' | 'google'
export type TTSProvider = 'elevenlabs' | 'deepgram' | 'google'
export type LLMProvider = 'anthropic' | 'openai'

export interface Agent {
  id: string
  name: string
  description: string | null
  system_prompt: string
  greeting_message: string
  not_interested_message: string
  max_call_duration_seconds: number
  active_llm: LLMProvider
  active_llm_model: string
  active_tts: TTSProvider
  active_stt: STTProvider
  active_stt_model: string | null  // null = use global setting from settings table
  active_telephony: TelephonyProvider
  created_at: string
  updated_at: string
}

export interface Lead {
  id: string
  business_name: string
  phone_number: string
  industry: string
  city: string | null
  country: string
  status: LeadStatus
  callback_time: string | null
  decision_maker_name: string | null
  notes: string | null
  // Batch dialer fields (added in migration 006)
  campaign_id: string | null
  retry_count: number
  scheduled_after: string | null
  created_at: string
  updated_at: string
}

export type LeadStatus =
  | 'pending' | 'calling' | 'interested' | 'not_interested'
  | 'callback' | 'wrong_person' | 'no_answer' | 'error'

export interface CallCostBreakdown {
  telephony: number  // Telnyx exact cost from call.cost webhook
  stt: number        // Deepgram Nova-3 @ $0.0077/min streaming
  tts: number        // ElevenLabs Flash v2.5 @ $0.30/1K chars OR Deepgram Aura @ $0.030/1K chars
  llm: number        // Claude Haiku 4.5 @ $1.00/M input + $5.00/M output tokens
  total: number      // sum of all above
}

export interface Call {
  id: string
  lead_id: string | null
  agent_id: string | null
  phone_number_id: string | null
  telephony_call_id: string | null
  status: CallStatus
  outcome: CallOutcome | null
  duration_seconds: number | null
  transcript: TranscriptEntry[]
  meeting_booked: boolean
  meeting_time: string | null
  started_at: string | null
  ended_at: string | null
  created_at: string
  cost_telephony: number | null
  cost_stt: number | null
  cost_tts: number | null
  cost_llm: number | null
  cost_total: number | null
  campaign_id: string | null
}

export type CallStatus =
  | 'initiated' | 'ringing' | 'in_progress' | 'completed' | 'failed' | 'no_answer'

export type CallOutcome =
  | 'interested' | 'not_interested' | 'callback' | 'wrong_person'
  | 'no_answer' | 'voicemail' | 'error'

export interface TranscriptEntry {
  role: 'agent' | 'prospect'
  text: string
  timestamp: string
}

export interface PhoneNumber {
  id: string
  number: string
  provider: TelephonyProvider
  label: string | null
  active: boolean
  created_at: string
}

export interface CallSession {
  callId: string
  leadId: string
  agentId: string
  agent: Agent
  lead: Lead
  transcript: TranscriptEntry[]
  startTime: Date
  maxDuration: number
  callControlId: string
  // Set by the batch dialer — undefined for manually initiated calls
  campaignId?: string
}
