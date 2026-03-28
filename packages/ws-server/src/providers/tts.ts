// ─── Text-to-Speech providers ─────────────────────────────────────────────────
// Supports ElevenLabs Flash v2.5 (primary) and Deepgram Aura (fallback).
//
// Changes from previous version:
//   - Removed `optimize_streaming_latency` — deprecated, silently ignored by
//     the current ElevenLabs API. eleven_flash_v2_5 handles its own latency.
//   - Output format upgraded from mp3_22050_32 → mp3_44100_128.
//     mp3_22050_32 was the lowest-quality MP3 option (22kHz, 32kbps) and the
//     worst choice for telephony. mp3_44100_128 gives significantly cleaner audio
//     before Telnyx resamples it down to 8kHz for the call.
//     NOTE: When Telnyx stream_bidirectional_mode is updated to support mulaw/pcm,
//     switch output_format to 'ulaw_8000' — that would eliminate the MP3 decode
//     and resample step at Telnyx entirely (confirmed supported by ElevenLabs docs).
//   - use_speaker_boost set to false — increases computational load without
//     meaningful quality gain at phone-grade 8kHz end quality.
//   - ElevenLabs circuit breaker unchanged — still auto-falls back to Deepgram Aura
//     on 402 / 429 / 5xx errors.

export interface TTSConfig {
  provider: 'elevenlabs' | 'deepgram' | 'google'
  apiKey: string
  voiceId?: string
  text: string
}

export interface TTSResult {
  audio: string    // base64 MP3
  costUsd: number
}

// 2026 rates
const ELEVENLABS_PER_CHAR  = 0.30  / 1_000   // $0.30 / 1K chars (Creator plan)
const DEEPGRAM_TTS_PER_CHAR = 0.030 / 1_000  // $0.030 / 1K chars

export interface TTSStreamConfig extends TTSConfig {
  onChunk: (base64Audio: string) => void
  abortSignal?: AbortSignal
  // Deepgram API key for automatic fallback when ElevenLabs circuit is open
  fallbackApiKey?: string
}

// ─── ElevenLabs circuit breaker ───────────────────────────────────────────────
// Opens on retriable errors to avoid hammering a broken provider mid-conversation.
//   402 out-of-credits  → 5 minutes
//   429 rate-limit      → 60 seconds
//   5xx server error    → 2 minutes
let elevenlabsCircuitOpenUntil: number | null = null

function isElevenLabsCircuitOpen(): boolean {
  if (elevenlabsCircuitOpenUntil === null) return false
  if (Date.now() < elevenlabsCircuitOpenUntil) return true
  elevenlabsCircuitOpenUntil = null
  console.log('[TTS] ElevenLabs circuit reset — retrying primary provider')
  return false
}

function tripElevenLabsCircuit(statusCode: number): void {
  const windowMs =
    statusCode === 429 ?  60_000 :
    statusCode === 402 ? 300_000 :
    /* 5xx */            120_000
  elevenlabsCircuitOpenUntil = Date.now() + windowMs
  console.warn(`[TTS] ElevenLabs circuit opened (status ${statusCode}) until ${new Date(elevenlabsCircuitOpenUntil).toISOString()}`)
}

function isFallbackEligible(status: number): boolean {
  return status === 402 || status === 429 || status === 500 || status === 502 || status === 503 || status === 504
}

class TTSProviderError extends Error {
  constructor(message: string, public readonly statusCode: number) {
    super(message)
    this.name = 'TTSProviderError'
  }
}

// ─── Public streaming API ─────────────────────────────────────────────────────
export async function streamTextToSpeech(config: TTSStreamConfig): Promise<number> {
  switch (config.provider) {
    case 'elevenlabs': {
      if (isElevenLabsCircuitOpen() && config.fallbackApiKey) {
        console.log('[TTS] ElevenLabs circuit open — using Deepgram Aura fallback')
        return deepgramStreamingTTS({ ...config, apiKey: config.fallbackApiKey, voiceId: 'aura-asteria-en' })
      }
      try {
        return await elevenLabsStreamingTTS(config)
      } catch (err) {
        if (err instanceof TTSProviderError && isFallbackEligible(err.statusCode) && config.fallbackApiKey) {
          tripElevenLabsCircuit(err.statusCode)
          console.warn(`[TTS] ElevenLabs ${err.statusCode} — falling back to Deepgram Aura`)
          return deepgramStreamingTTS({ ...config, apiKey: config.fallbackApiKey, voiceId: 'aura-asteria-en' })
        }
        throw err
      }
    }
    case 'deepgram': return deepgramStreamingTTS(config)
    default: throw new Error(`Streaming TTS not implemented for provider: ${config.provider}`)
  }
}

// ─── ElevenLabs streaming ─────────────────────────────────────────────────────
async function elevenLabsStreamingTTS(config: TTSStreamConfig): Promise<number> {
  const voiceId = config.voiceId || '21m00Tcm4TlvDq8ikWAM'

  let response: Response
  try {
    response = await fetch(
      `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}/stream`,
      {
        method:  'POST',
        headers: { 'xi-api-key': config.apiKey, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          text:       config.text,
          model_id:   'eleven_flash_v2_5',
          voice_settings: {
            stability:        0.45,
            similarity_boost: 0.80,
            style:            0.10,
            use_speaker_boost: false,  // removed — adds compute overhead for no gain at 8kHz
          },
          // Upgraded from mp3_22050_32 (lowest quality, 22kHz 32kbps) to mp3_44100_128.
          // Phone networks resample to 8kHz regardless, but sending better source audio
          // to Telnyx means the resampling has higher-quality input to work with.
          // TODO: When Telnyx bidirectional mode supports mulaw, switch to 'ulaw_8000' —
          // that eliminates the MP3 decode + resample step at Telnyx entirely.
          output_format: 'mp3_44100_128',
          // optimize_streaming_latency removed — deprecated in current ElevenLabs API,
          // was silently ignored. eleven_flash_v2_5 handles its own latency optimization.
        }),
        signal: config.abortSignal,
      }
    )
  } catch (err: any) {
    if (err?.name === 'AbortError') return 0
    throw err
  }

  if (!response.ok) {
    const body = await response.text()
    let detail = body
    try { const p = JSON.parse(body); detail = p?.detail?.message || p?.detail || body } catch {}
    const reason =
      response.status === 401 ? 'Invalid or missing ElevenLabs API key.' :
      response.status === 402 ? 'ElevenLabs account has insufficient credits.' :
      response.status === 422 ? `ElevenLabs rejected the request — ${detail}` :
      response.status === 429 ? 'ElevenLabs rate limit reached.' :
      `ElevenLabs HTTP ${response.status} — ${detail}`
    throw new TTSProviderError(reason, response.status)
  }

  if (!response.body) throw new Error('ElevenLabs streaming TTS: no response body')

  const reader = response.body.getReader()
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      if (config.abortSignal?.aborted) break
      if (value?.length > 0) config.onChunk(Buffer.from(value).toString('base64'))
    }
  } catch (err: any) {
    if (err?.name !== 'AbortError') throw err
  }

  return config.text.length * ELEVENLABS_PER_CHAR
}

// ─── Deepgram Aura streaming ──────────────────────────────────────────────────
async function deepgramStreamingTTS(config: TTSStreamConfig): Promise<number> {
  const voice = config.voiceId || 'aura-asteria-en'
  let response: Response
  try {
    response = await fetch(
      `https://api.deepgram.com/v1/speak?model=${voice}&encoding=mp3`,
      {
        method:  'POST',
        headers: { Authorization: `Token ${config.apiKey}`, 'Content-Type': 'application/json' },
        body:    JSON.stringify({ text: config.text }),
        signal:  config.abortSignal,
      }
    )
  } catch (err: any) {
    if (err?.name === 'AbortError') return 0
    throw err
  }
  if (!response.ok) throw new Error(`Deepgram TTS failed: ${response.status} ${await response.text()}`)
  if (!response.body) throw new Error('Deepgram TTS: no response body')

  const reader = response.body.getReader()
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      if (config.abortSignal?.aborted) break
      if (value?.length > 0) config.onChunk(Buffer.from(value).toString('base64'))
    }
  } catch (err: any) {
    if (err?.name !== 'AbortError') throw err
  }

  return config.text.length * DEEPGRAM_TTS_PER_CHAR
}

// ─── Non-streaming (batch) TTS ────────────────────────────────────────────────
export async function textToSpeech(config: TTSConfig): Promise<TTSResult> {
  switch (config.provider) {
    case 'elevenlabs': return elevenLabsBatchTTS(config)
    case 'deepgram':   return deepgramBatchTTS(config)
    default: throw new Error(`TTS provider ${config.provider} not implemented`)
  }
}

async function elevenLabsBatchTTS(config: TTSConfig): Promise<TTSResult> {
  const voiceId  = config.voiceId || '21m00Tcm4TlvDq8ikWAM'
  const response = await fetch(
    `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`,
    {
      method:  'POST',
      headers: { 'xi-api-key': config.apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text:       config.text,
        model_id:   'eleven_flash_v2_5',
        voice_settings: { stability: 0.45, similarity_boost: 0.80, style: 0.10, use_speaker_boost: false },
        output_format: 'mp3_44100_128',
      }),
    }
  )
  if (!response.ok) {
    const body = await response.text()
    throw new Error(`ElevenLabs HTTP ${response.status}: ${body}`)
  }
  const audio  = Buffer.from(await response.arrayBuffer()).toString('base64')
  return { audio, costUsd: config.text.length * ELEVENLABS_PER_CHAR }
}

async function deepgramBatchTTS(config: TTSConfig): Promise<TTSResult> {
  const voice    = config.voiceId || 'aura-asteria-en'
  const response = await fetch(
    `https://api.deepgram.com/v1/speak?model=${voice}&encoding=mp3`,
    {
      method:  'POST',
      headers: { Authorization: `Token ${config.apiKey}`, 'Content-Type': 'application/json' },
      body:    JSON.stringify({ text: config.text }),
    }
  )
  if (!response.ok) throw new Error(`Deepgram TTS failed: ${response.status} ${await response.text()}`)
  const audio = Buffer.from(await response.arrayBuffer()).toString('base64')
  return { audio, costUsd: config.text.length * DEEPGRAM_TTS_PER_CHAR }
}
