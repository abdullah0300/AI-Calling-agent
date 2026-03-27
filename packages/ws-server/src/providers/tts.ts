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
  // Fallback: Deepgram API key to use if the primary provider fails with a
  // retriable error (402 out-of-credits, 429 rate-limit, 5xx server error).
  // When set and the circuit breaker trips, this request and all subsequent
  // requests in the same process window are served by Deepgram Aura instead.
  fallbackApiKey?: string
}

// ─── ElevenLabs circuit breaker ──────────────────────────────────────────────
// Shared across all sessions in this process. When ElevenLabs returns a
// retriable error, we open the circuit for a fixed window so subsequent
// sentences don't retry a broken provider mid-conversation.
//
//  402 out-of-credits   → 5 minutes  (credits won't appear in seconds)
//  429 rate-limit       → 60 seconds (back-off, then try again)
//  5xx server error     → 2 minutes  (service likely recovering)
//
// The circuit auto-resets after the window expires — no manual intervention.
let elevenlabsCircuitOpenUntil: number | null = null

function isElevenLabsCircuitOpen(): boolean {
  if (elevenlabsCircuitOpenUntil === null) return false
  if (Date.now() < elevenlabsCircuitOpenUntil) return true
  elevenlabsCircuitOpenUntil = null  // window expired — reset circuit
  console.log('[TTS] ElevenLabs circuit reset — will retry primary provider')
  return false
}

function tripElevenLabsCircuit(statusCode: number): void {
  const windowMs =
    statusCode === 429         ?  60_000 :   // rate limit: back off 1 min
    statusCode === 402         ? 300_000 :   // out of credits: 5 min
    /* 500/502/503/504 */        120_000      // server error: 2 min
  elevenlabsCircuitOpenUntil = Date.now() + windowMs
  console.warn(`[TTS] ElevenLabs circuit opened (status ${statusCode}) — fallback active until ${new Date(elevenlabsCircuitOpenUntil).toISOString()}`)
}

// Status codes that warrant a fallback — not permanent auth failures.
// 401 = bad key (fallback won't fix config); 422 = bad payload (same).
function isFallbackEligibleStatus(status: number): boolean {
  return status === 402 || status === 429 || status === 500 || status === 502 || status === 503 || status === 504
}

// Custom error so the circuit breaker can inspect the HTTP status code.
class TTSProviderError extends Error {
  constructor(message: string, public readonly statusCode: number) {
    super(message)
    this.name = 'TTSProviderError'
  }
}

// ─── Public API ───────────────────────────────────────────────────────────────

// Streams TTS audio chunks as they arrive, calling onChunk for each.
// Returns costUsd. Throws on unrecoverable provider error.
// When provider='elevenlabs' and fallbackApiKey is set, automatically falls
// back to Deepgram Aura on retriable failures.
export async function streamTextToSpeech(config: TTSStreamConfig): Promise<number> {
  switch (config.provider) {
    case 'elevenlabs': {
      // If the circuit is already open (previous failure in this process window),
      // skip ElevenLabs entirely and serve Deepgram immediately.
      if (isElevenLabsCircuitOpen() && config.fallbackApiKey) {
        console.log('[TTS] ElevenLabs circuit open — using Deepgram Aura fallback')
        return deepgramStreamingTTS({ ...config, apiKey: config.fallbackApiKey, voiceId: 'aura-asteria-en' })
      }
      try {
        return await elevenLabsStreamingTTS(config)
      } catch (err) {
        // Only fall back if the error carries an eligible HTTP status AND
        // a fallback key is available AND no audio chunks have been sent yet
        // (i.e., the error fired before streaming started — mid-stream abort
        // errors are AbortErrors handled inside elevenLabsStreamingTTS itself).
        if (
          err instanceof TTSProviderError &&
          isFallbackEligibleStatus(err.statusCode) &&
          config.fallbackApiKey
        ) {
          tripElevenLabsCircuit(err.statusCode)
          console.warn(`[TTS] ElevenLabs ${err.statusCode} — falling back to Deepgram Aura for: "${config.text.slice(0, 60)}…"`)
          return deepgramStreamingTTS({ ...config, apiKey: config.fallbackApiKey, voiceId: 'aura-asteria-en' })
        }
        throw err  // non-retriable (401 bad key, 422 bad payload, AbortError, etc.)
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
        method: 'POST',
        headers: { 'xi-api-key': config.apiKey, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          text: config.text,
          model_id: 'eleven_flash_v2_5',
          voice_settings: { stability: 0.4, similarity_boost: 0.8, style: 0.15, use_speaker_boost: true },
          // mp3_22050_32: phone-grade quality (Telnyx resamples to 8kHz anyway), ~4x smaller
          // than mp3_44100_128 — less data to transfer and less transcoding overhead for Telnyx
          output_format: 'mp3_22050_32',
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
      response.status === 402 ? 'ElevenLabs account has insufficient credits or the plan does not support this voice.' :
      response.status === 422 ? `ElevenLabs rejected the request — ${detail}` :
      response.status === 429 ? 'ElevenLabs rate limit reached.' :
      `ElevenLabs HTTP ${response.status} — ${detail}`
    // Use TTSProviderError so the circuit breaker in streamTextToSpeech can read the status code
    throw new TTSProviderError(reason, response.status)
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

// ─── Deepgram Aura streaming ──────────────────────────────────────────────────

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

// ─── Non-streaming (batch) TTS ────────────────────────────────────────────────

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
      headers: { 'xi-api-key': config.apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text: config.text,
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
      response.status === 402 ? 'ElevenLabs account has insufficient credits or the plan does not support this voice.' :
      response.status === 422 ? `ElevenLabs rejected the request — ${detail}` :
      response.status === 429 ? 'ElevenLabs rate limit reached.' :
      `ElevenLabs HTTP ${response.status} — ${detail}`
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
