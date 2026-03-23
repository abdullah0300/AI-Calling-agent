export interface TTSConfig {
  provider: 'elevenlabs' | 'deepgram' | 'google'
  text: string
  voiceId?: string
}

export interface TTSResult {
  audio: string    // base64 MP3
  costUsd: number
}

// 2026 rates
// ElevenLabs Flash v2.5 — Creator plan overage: $0.30 / 1,000 chars
// (source: elevenlabs.io/pricing/api)
const ELEVENLABS_PER_CHAR = 0.30 / 1_000

// Deepgram Aura TTS — Pay-as-you-go: $0.030 / 1,000 chars
// (source: deepgram.com/pricing)
const DEEPGRAM_TTS_PER_CHAR = 0.030 / 1_000

export async function textToSpeech(config: TTSConfig): Promise<TTSResult> {
  switch (config.provider) {
    case 'elevenlabs': return elevenLabsTTS(config)
    case 'deepgram': return deepgramTTS(config)
    default: throw new Error(`TTS provider ${config.provider} not implemented`)
  }
}

async function elevenLabsTTS(config: TTSConfig): Promise<TTSResult> {
  const voiceId = config.voiceId || process.env.ELEVENLABS_VOICE_ID || '21m00Tcm4TlvDq8ikWAM'

  const response = await fetch(
    `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`,
    {
      method: 'POST',
      headers: {
        'xi-api-key': process.env.ELEVENLABS_API_KEY!,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        text: config.text,
        // eleven_flash_v2_5 = lowest latency ElevenLabs model at 75ms
        // Do NOT use eleven_multilingual_v2 — 400ms+ latency breaks conversations
        model_id: 'eleven_flash_v2_5',
        voice_settings: { stability: 0.5, similarity_boost: 0.8, style: 0.0, use_speaker_boost: true },
        output_format: 'mp3_44100_128',
      }),
    }
  )

  if (!response.ok) {
    const body = await response.text()
    // Free plan cannot use library voices — fall back to Deepgram automatically
    if (response.status === 402) {
      console.warn('[TTS] ElevenLabs 402: falling back to Deepgram')
      return deepgramTTS(config)
    }
    throw new Error(`ElevenLabs failed: ${response.status} ${body}`)
  }

  const audio = Buffer.from(await response.arrayBuffer()).toString('base64')
  const costUsd = config.text.length * ELEVENLABS_PER_CHAR
  return { audio, costUsd }
}

async function deepgramTTS(config: TTSConfig): Promise<TTSResult> {
  const voice = process.env.DEEPGRAM_TTS_VOICE || 'aura-asteria-en'
  const response = await fetch(
    `https://api.deepgram.com/v1/speak?model=${voice}&encoding=mp3`,
    {
      method: 'POST',
      headers: { 'Authorization': `Token ${process.env.DEEPGRAM_API_KEY!}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: config.text }),
    }
  )
  if (!response.ok) throw new Error(`Deepgram TTS failed: ${response.status} ${await response.text()}`)
  const audio = Buffer.from(await response.arrayBuffer()).toString('base64')
  const costUsd = config.text.length * DEEPGRAM_TTS_PER_CHAR
  return { audio, costUsd }
}
