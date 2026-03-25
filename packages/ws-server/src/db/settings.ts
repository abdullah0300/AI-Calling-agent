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
  telnyx_api_key: string
  telnyx_connection_id: string
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
    telnyx_api_key:       map.telnyx_api_key       || process.env.TELNYX_API_KEY       || '',
    telnyx_connection_id: map.telnyx_connection_id || process.env.TELNYX_CONNECTION_ID || '',
  }
}
