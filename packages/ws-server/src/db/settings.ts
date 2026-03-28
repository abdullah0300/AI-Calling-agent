import { supabase } from './client'

export interface PlatformSettings {
  // Global provider defaults (overridden per-agent in agents table)
  active_llm: string
  active_llm_model: string
  active_stt: string
  active_stt_model: string
  active_tts: string
  active_telephony: string
  // API keys — stored in settings table, managed via the Settings page
  anthropic_api_key: string
  openai_api_key: string
  deepgram_api_key: string
  elevenlabs_api_key: string
  elevenlabs_voice_id: string
  cartesia_api_key: string
  cartesia_voice_id: string
  telnyx_api_key: string
  telnyx_connection_id: string
  // Calling hours enforcement (Item 8)
  // Outbound calls are blocked outside startHour–endHour in the prospect's local timezone.
  calling_hours_enabled: boolean
  calling_hours_start: number    // 0–23, inclusive (default: 8  = 8:00 AM)
  calling_hours_end: number      // 0–23, exclusive (default: 21 = 9:00 PM)
  // Call recording (Item 9)
  // When true, dual-channel MP3 recording is started at session open.
  // Disabled by default — enable only after confirming legal disclosure is in place.
  recording_enabled: boolean
}

export async function loadSettings(): Promise<PlatformSettings> {
  const { data, error } = await supabase.from('settings').select('key, value')
  if (error) throw new Error(`Failed to load platform settings: ${error.message}`)

  const map: Record<string, string> = {}
  for (const row of data || []) map[row.key] = row.value

  // Fall back to env vars so existing setups without DB keys still work
  return {
    active_llm:           map.active_llm           || 'anthropic',
    active_llm_model:     map.active_llm_model     || 'claude-haiku-4-5',
    active_stt:           map.active_stt           || 'deepgram',
    active_stt_model:     map.active_stt_model     || 'nova-3',
    active_tts:           map.active_tts           || 'elevenlabs',
    active_telephony:     map.active_telephony     || 'telnyx',
    anthropic_api_key:    map.anthropic_api_key    || process.env.ANTHROPIC_API_KEY    || '',
    openai_api_key:       map.openai_api_key       || process.env.OPENAI_API_KEY       || '',
    deepgram_api_key:     map.deepgram_api_key     || process.env.DEEPGRAM_API_KEY     || '',
    elevenlabs_api_key:   map.elevenlabs_api_key   || process.env.ELEVENLABS_API_KEY   || '',
    elevenlabs_voice_id:  map.elevenlabs_voice_id  || process.env.ELEVENLABS_VOICE_ID  || '21m00Tcm4TlvDq8ikWAM',
    cartesia_api_key:     map.cartesia_api_key     || process.env.CARTESIA_API_KEY     || '',
    cartesia_voice_id:    map.cartesia_voice_id    || process.env.CARTESIA_VOICE_ID    || 'a0e99841-438c-4a64-b679-ae501e7d6091',
    telnyx_api_key:       map.telnyx_api_key       || process.env.TELNYX_API_KEY       || '',
    telnyx_connection_id: map.telnyx_connection_id || process.env.TELNYX_CONNECTION_ID || '',
    calling_hours_enabled: (map.calling_hours_enabled ?? 'true') !== 'false',
    calling_hours_start:   parseInt(map.calling_hours_start   ?? '8',  10),
    calling_hours_end:     parseInt(map.calling_hours_end     ?? '21', 10),
    recording_enabled:     (map.recording_enabled ?? 'false') === 'true',
  }
}
