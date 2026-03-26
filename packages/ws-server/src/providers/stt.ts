import { createClient, LiveTranscriptionEvents } from '@deepgram/sdk'
import WebSocket from 'ws'

export interface STTStreamConfig {
  provider: 'deepgram' | 'google'
  apiKey: string
  model?: string  // e.g. 'nova-2', 'nova-3', 'nova-2-phonecall', 'flux' — defaults to 'nova-3'
  onTranscript: (text: string, isFinal: boolean) => void
  onError: (error: Error) => void
  onSpeechStarted?: () => void  // fires when Deepgram detects the prospect starting to speak (used for barge-in)
}

export function createSTTStream(config: STTStreamConfig) {
  if (config.provider !== 'deepgram') throw new Error(`STT provider ${config.provider} not yet implemented`)
  // Flux uses Deepgram's v2 WebSocket API — completely separate from the v1 SDK path
  if (config.model === 'flux') return createFluxStream(config)
  return createDeepgramStream(config)
}

// ─── G.711 μ-law → linear16 PCM converter ───────────────────────────────────
// Telnyx streams mulaw 8kHz. Deepgram Flux only accepts linear16.
// Each mulaw byte expands to one 16-bit LE PCM sample.
function mulawToLinear16(mulaw: Buffer): Buffer {
  const out = Buffer.alloc(mulaw.length * 2)
  for (let i = 0; i < mulaw.length; i++) {
    let b = (~mulaw[i]) & 0xFF
    const sign      = b & 0x80
    const exponent  = (b >> 4) & 0x07
    const mantissa  = b & 0x0F
    let sample      = ((mantissa << 3) | 0x84) << exponent
    sample         -= 0x84
    if (sign) sample = -sample
    sample = Math.max(-32768, Math.min(32767, sample))
    out.writeInt16LE(sample, i * 2)
  }
  return out
}

// ─── Deepgram Flux (v2/listen) ───────────────────────────────────────────────
// Uses raw WebSocket because SDK v3 only supports v1/listen.
// Flux replaces our manual VAD/endpointing with model-native turn detection:
//   EndOfTurn  → onTranscript(text, true)   — equivalent to speech_final
//   StartOfTurn → onSpeechStarted()         — equivalent to SpeechStarted (barge-in)
function createFluxStream(config: STTStreamConfig) {
  if (!config.apiKey) {
    config.onError(new Error('Deepgram API key is not set'))
    return { sendAudio: () => {}, close: () => {} }
  }

  const params = new URLSearchParams({
    model:          'flux-general-en',
    encoding:       'linear16',
    sample_rate:    '8000',
    eot_timeout_ms: '1500',   // fallback silence timeout — 1.5s is good for voice agents
    eot_threshold:  '0.7',    // default confidence required to fire EndOfTurn
  })
  const url = `wss://api.deepgram.com/v2/listen?${params}`
  const keyPreview = config.apiKey.slice(0, 8) + '…'
  console.log(`[STT/Flux] Connecting — key: ${keyPreview}`)

  const ws = new WebSocket(url, { headers: { Authorization: `Token ${config.apiKey}` } })

  ws.on('open', () => {
    console.log('[STT/Flux] Connected to Deepgram v2/listen')
  })

  ws.on('message', (raw: Buffer) => {
    let msg: any
    try { msg = JSON.parse(raw.toString()) } catch { return }

    if (msg.type !== 'TurnInfo') return  // ignore Connected/Metadata/etc.

    const event = msg.event as string
    const transcript = (msg.transcript as string | undefined)?.trim()

    if (event === 'EndOfTurn' && transcript && transcript.length > 2) {
      // Final transcript — send to LLM pipeline
      config.onTranscript(transcript, true)
    } else if (event === 'StartOfTurn') {
      // Prospect started speaking — trigger barge-in if agent is speaking
      config.onSpeechStarted?.()
    }
    // Update events (interim) and EagerEndOfTurn are ignored for now
  })

  ws.on('error', (err: Error) => {
    console.error('[STT/Flux] WebSocket error:', err.message)
    config.onError(new Error(`Deepgram Flux WS error: ${err.message}`))
  })

  ws.on('close', (code: number, reason: Buffer) => {
    const r = reason?.toString() || ''
    if (code !== 1000) {
      if (code === 1008 || r.toLowerCase().includes('auth') || r.toLowerCase().includes('key')) {
        console.error(`[STT/Flux] Rejected — invalid API key (code ${code}): ${r}`)
      } else {
        console.warn(`[STT/Flux] Closed — code ${code}: ${r}`)
      }
    }
  })

  // Ping every 10 seconds to keep the connection alive during prospect silence
  const keepAlive = setInterval(() => {
    if (ws.readyState === WebSocket.OPEN) ws.ping()
  }, 10000)

  return {
    sendAudio: (chunk: Buffer) => {
      if (ws.readyState !== WebSocket.OPEN) return
      // Flux requires linear16 — convert from mulaw before sending
      const linear16 = mulawToLinear16(chunk)
      ws.send(linear16)
    },
    close: () => {
      clearInterval(keepAlive)
      if (ws.readyState === WebSocket.OPEN) ws.close(1000, 'session ended')
    },
  }
}

function createDeepgramStream(config: STTStreamConfig) {
  if (!config.apiKey) {
    console.error('[STT] Deepgram API key is empty — check Settings → Deepgram API Key')
    config.onError(new Error('Deepgram API key is not set'))
    return { sendAudio: () => {}, close: () => {} }
  }

  const keyPreview = config.apiKey.slice(0, 8) + '…'
  const model = config.model || 'nova-2'
  console.log(`[STT] Connecting to Deepgram — model: ${model}, key: ${keyPreview}`)

  // Quick auth check — surfaces exact HTTP status before attempting WebSocket
  fetch('https://api.deepgram.com/v1/projects', {
    headers: { Authorization: `Token ${config.apiKey}` },
  }).then(r => {
    if (r.ok) {
      console.log('[STT] Deepgram key valid — HTTP 200 OK')
    } else {
      console.error(`[STT] Deepgram key check failed — HTTP ${r.status}. ${
        r.status === 401 ? 'Invalid or expired API key.' :
        r.status === 402 ? 'Account has no credits / payment required.' :
        r.status === 403 ? 'Key lacks permission for live streaming.' : ''
      } Go to console.deepgram.com to fix.`)
    }
  }).catch(() => { /* ignore — network errors handled by WS below */ })

  const deepgram = createClient(config.apiKey)

  const connection = deepgram.listen.live({
    model: model as any,
    language: 'en-GB',
    smart_format: true,
    interim_results: true,
    vad_events: true,
    endpointing: 300,
    // CRITICAL: Telnyx streams mulaw 8000Hz mono audio
    // Wrong encoding = garbage transcriptions
    encoding: 'mulaw',
    sample_rate: 8000,
    channels: 1,
  })

  connection.on(LiveTranscriptionEvents.Open, () => {
    console.log('[STT] Deepgram opened')
  })

  connection.on(LiveTranscriptionEvents.SpeechStarted, () => {
    config.onSpeechStarted?.()
  })

  connection.on(LiveTranscriptionEvents.Transcript, (data: any) => {
    const transcript = data?.channel?.alternatives?.[0]?.transcript
    const isFinal = data?.is_final
    if (transcript && transcript.trim().length > 2) {
      config.onTranscript(transcript.trim(), isFinal)
    }
  })

  connection.on(LiveTranscriptionEvents.Error, (error: any) => {
    const msg = error?.message || error?.reason || error?.code || JSON.stringify(error) || String(error)
    config.onError(new Error(`Deepgram WS error: ${msg}`))
  })

  // Close event carries the HTTP status code — useful for diagnosing 401/402/403
  connection.on(LiveTranscriptionEvents.Close, (event: any) => {
    const code = event?.code
    const reason = event?.reason || ''
    if (code && code !== 1000) {
      if (code === 1008 || reason.toLowerCase().includes('auth') || reason.toLowerCase().includes('key')) {
        console.error(`[STT] Deepgram rejected connection — invalid API key (code ${code}): ${reason}`)
      } else {
        console.warn(`[STT] Deepgram connection closed — code ${code}: ${reason}`)
      }
    }
  })

  // CRITICAL: Send keepalive every 10 seconds
  // Deepgram closes idle connections after 12 seconds
  // During silence on call this prevents disconnection
  const keepAliveInterval = setInterval(() => {
    try {
      if (connection.getReadyState() === 1) connection.keepAlive()
    } catch (e) { /* ignore */ }
  }, 10000)

  return {
    sendAudio: (chunk: Buffer) => {
      try {
        if (connection.getReadyState() === 1) connection.send(chunk as unknown as ArrayBuffer)
      } catch (e) {
        console.error('[STT] Failed to send audio chunk:', e)
      }
    },
    close: () => {
      clearInterval(keepAliveInterval)
      try { connection.requestClose() } catch (e) { /* ignore */ }
    }
  }
}
