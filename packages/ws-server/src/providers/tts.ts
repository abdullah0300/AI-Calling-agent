export interface TTSConfig {
  provider: 'elevenlabs' | 'deepgram' | 'google'
  apiKey: string
  voiceId?: string   // ElevenLabs voice ID or Deepgram voice model
  text: string
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

export interface TTSStreamConfig extends TTSConfig {
  // Called with each base64-encoded audio chunk as it arrives from the TTS provider.
  // Caller should send each chunk to the WebSocket immediately.
  onChunk: (base64Audio: string) => void
  // Optional AbortSignal — abort() cancels the in-flight TTS request (used for barge-in).
  abortSignal?: AbortSignal
}

// Streams TTS audio chunks as they arrive, calling onChunk for each.
// Returns costUsd. Throws on provider error.
export async function streamTextToSpeech(config: TTSStreamConfig): Promise<number> {
  switch (config.provider) {
    case 'elevenlabs': return elevenLabsStreamingTTS(config)
    case 'deepgram':   return deepgramStreamingTTS(config)
    default: throw new Error(`Streaming TTS not implemented for provider: ${config.provider}`)
  }
}

async function elevenLabsStreamingTTS(config: TTSStreamConfig): Promise<number> {
  const voiceId = config.voiceId || '21m00Tcm4TlvDq8ikWAM'

  let response: Response
  try {
    response = await fetch(
      `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}/stream`,
      {
        method: 'POST',
        headers: { 'xi-api-key': config.apiKey, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          text: config.text,
          model_id: 'eleven_flash_v2_5',
          voice_settings: { stability: 0.4, similarity_boost: 0.8, style: 0.15, use_speaker_boost: true },
          output_format: 'mp3_44100_128',
          optimize_streaming_latency: 4,
        }),
        signal: config.abortSignal,
      }
    )
  } catch (err: any) {
    if (err?.name === 'AbortError') return 0  // barge-in — silently stop
    throw err
  }

  if (!response.ok) {
    const body = await response.text()
    let detail = body
    try {
      const parsed = JSON.parse(body)
      detail = parsed?.detail?.message || parsed?.detail || body
    } catch {}
    const reason =
      response.status === 401 ? 'Invalid or missing ElevenLabs API key.' :
      response.status === 402 ? 'ElevenLabs account has insufficient credits or the plan does not support this voice. Please top up your account or upgrade your plan at elevenlabs.io.' :
      response.status === 422 ? `ElevenLabs rejected the request — ${detail}` :
      response.status === 429 ? 'ElevenLabs rate limit reached. Too many requests in a short period.' :
      `ElevenLabs returned an unexpected error (HTTP ${response.status}) — ${detail}`
    throw new Error(reason)
  }

  if (!response.body) throw new Error('ElevenLabs streaming TTS: no response body')

  const reader = response.body.getReader()
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      if (config.abortSignal?.aborted) break  // barge-in detected mid-stream
      if (value && value.length > 0) {
        config.onChunk(Buffer.from(value).toString('base64'))
      }
    }
  } catch (err: any) {
    if (err?.name !== 'AbortError') throw err
    // AbortError mid-stream — barge-in, stop gracefully
  }

  return config.text.length * ELEVENLABS_PER_CHAR
}

async function deepgramStreamingTTS(config: TTSStreamConfig): Promise<number> {
  const voice = config.voiceId || 'aura-asteria-en'
  let response: Response
  try {
    response = await fetch(
      `https://api.deepgram.com/v1/speak?model=${voice}&encoding=mp3`,
      {
        method: 'POST',
        headers: { 'Authorization': `Token ${config.apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: config.text }),
        signal: config.abortSignal,
      }
    )
  } catch (err: any) {
    if (err?.name === 'AbortError') return 0
    throw err
  }
  if (!response.ok) throw new Error(`Deepgram TTS failed: ${response.status} ${await response.text()}`)
  if (!response.body) throw new Error('Deepgram streaming TTS: no response body')

  const reader = response.body.getReader()
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      if (config.abortSignal?.aborted) break
      if (value && value.length > 0) {
        config.onChunk(Buffer.from(value).toString('base64'))
      }
    }
  } catch (err: any) {
    if (err?.name !== 'AbortError') throw err
  }

  return config.text.length * DEEPGRAM_TTS_PER_CHAR
}

export async function textToSpeech(config: TTSConfig): Promise<TTSResult> {
  switch (config.provider) {
    case 'elevenlabs': return elevenLabsTTS(config)
    case 'deepgram': return deepgramTTS(config)
    default: throw new Error(`TTS provider ${config.provider} not implemented`)
  }
}

async function elevenLabsTTS(config: TTSConfig): Promise<TTSResult> {
  const voiceId = config.voiceId || '21m00Tcm4TlvDq8ikWAM'

  const response = await fetch(
    `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`,
    {
      method: 'POST',
      headers: {
        'xi-api-key': config.apiKey,
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
    let detail = body
    try {
      const parsed = JSON.parse(body)
      detail = parsed?.detail?.message || parsed?.detail || body
    } catch {}
    const reason =
      response.status === 401 ? 'Invalid or missing ElevenLabs API key.' :
      response.status === 402 ? 'ElevenLabs account has insufficient credits or the plan does not support this voice. Please top up your account or upgrade your plan at elevenlabs.io.' :
      response.status === 422 ? `ElevenLabs rejected the request — ${detail}` :
      response.status === 429 ? 'ElevenLabs rate limit reached. Too many requests in a short period.' :
      `ElevenLabs returned an unexpected error (HTTP ${response.status}) — ${detail}`
    throw new Error(reason)
  }

  const audio = Buffer.from(await response.arrayBuffer()).toString('base64')
  const costUsd = config.text.length * ELEVENLABS_PER_CHAR
  return { audio, costUsd }
}

async function deepgramTTS(config: TTSConfig): Promise<TTSResult> {
  const voice = config.voiceId || 'aura-asteria-en'
  const response = await fetch(
    `https://api.deepgram.com/v1/speak?model=${voice}&encoding=mp3`,
    {
      method: 'POST',
      headers: { 'Authorization': `Token ${config.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: config.text }),
    }
  )
  if (!response.ok) throw new Error(`Deepgram TTS failed: ${response.status} ${await response.text()}`)
  const audio = Buffer.from(await response.arrayBuffer()).toString('base64')
  const costUsd = config.text.length * DEEPGRAM_TTS_PER_CHAR
  return { audio, costUsd }
}
