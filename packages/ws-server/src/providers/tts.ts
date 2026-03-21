export interface TTSConfig {
  provider: 'elevenlabs' | 'deepgram' | 'google'
  text: string
  voiceId?: string
}

export async function textToSpeech(config: TTSConfig): Promise<string> {
  switch (config.provider) {
    case 'elevenlabs': return elevenLabsTTS(config)
    case 'deepgram': return deepgramTTS(config)
    default: throw new Error(`TTS provider ${config.provider} not implemented`)
  }
}

async function elevenLabsTTS(config: TTSConfig): Promise<string> {
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

  if (!response.ok) throw new Error(`ElevenLabs failed: ${response.status} ${await response.text()}`)
  return Buffer.from(await response.arrayBuffer()).toString('base64')
}

async function deepgramTTS(config: TTSConfig): Promise<string> {
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
  return Buffer.from(await response.arrayBuffer()).toString('base64')
}
