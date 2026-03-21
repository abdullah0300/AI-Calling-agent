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
  interest_detected_message: string
  not_interested_message: string
  wrong_person_message: string
  callback_message: string
  max_call_duration_seconds: number
  active_llm: LLMProvider
  active_llm_model: string
  active_tts: TTSProvider
  active_stt: STTProvider
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
  created_at: string
  updated_at: string
}

export type LeadStatus =
  | 'pending' | 'calling' | 'interested' | 'not_interested'
  | 'callback' | 'wrong_person' | 'no_answer' | 'error'

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
}
