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
//
// Auto-reconnect: if Deepgram closes with a non-1000 code mid-call (network blip,
// rate limit, server-side timeout), we reconnect up to 3 times with 1s/2s/4s backoff.
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

  const BACKCHANNEL = new Set([
    'yeah', 'yes', 'yep', 'yup', 'ya',
    'uh-huh', 'mm-hmm', 'mhm', 'mm', 'hmm', 'hm',
    'ok', 'okay', 'alright', 'right',
    'sure', 'oh', 'ah', 'uh', 'um', 'cool', 'great', 'fine',
  ])
  function isBackchannel(text: string): boolean {
    const words = text.toLowerCase().replace(/[.,!?]/g, '').trim().split(/\s+/).filter(Boolean)
    return words.length > 0 && words.length <= 4 && words.every(w => BACKCHANNEL.has(w))
  }

  // Shared state that persists across reconnects
  let isClosed = false         // set to true only by explicit .close() call — stops reconnect loop
  let attemptCount = 0         // reconnect attempts since last successful open
  let currentWs: WebSocket | null = null
  let keepAlive: ReturnType<typeof setInterval> | null = null

  // Pending barge-in timer — StartOfTurn fires a 250ms confirmation window.
  // If the first partial transcript within that window is only backchannel words
  // ("yeah", "uh-huh") we cancel and don't interrupt the agent.
  // If 250ms passes with no cancellation, the barge-in fires.
  // Lives in outer scope so it isn't reset by reconnects mid-turn.
  let bargeInTimer: ReturnType<typeof setTimeout> | null = null

  function connect() {
    if (isClosed) return
    console.log(`[STT/Flux] Connecting — key: ${keyPreview}${attemptCount > 0 ? ` (retry ${attemptCount}/3)` : ''}`)

    const ws = new WebSocket(url, { headers: { Authorization: `Token ${config.apiKey}` } })
    currentWs = ws

    ws.on('open', () => {
      console.log('[STT/Flux] Connected to Deepgram v2/listen')
      attemptCount = 0  // successful connect resets the retry counter
    })

    ws.on('message', (raw: Buffer) => {
      let msg: any
      try { msg = JSON.parse(raw.toString()) } catch { return }

      if (msg.type !== 'TurnInfo') return  // ignore Connected/Metadata/etc.

      const event = msg.event as string
      const transcript = (msg.transcript as string | undefined)?.trim()

      if (event === 'EndOfTurn' && transcript && transcript.length > 2) {
        // Cancel any pending barge-in timer — turn has ended cleanly
        if (bargeInTimer) { clearTimeout(bargeInTimer); bargeInTimer = null }
        config.onTranscript(transcript, true)

      } else if (event === 'StartOfTurn') {
        // Don't fire barge-in immediately — wait 250ms for a partial transcript.
        // If the partial shows only backchannel words, the prospect is just
        // acknowledging, not actually interrupting. Cancel and don't stop agent.
        if (bargeInTimer) return  // already pending
        bargeInTimer = setTimeout(() => {
          bargeInTimer = null
          config.onSpeechStarted?.()
        }, 250)

      } else if ((event === 'Update' || event === 'EagerEndOfTurn') && transcript && bargeInTimer) {
        // Partial transcript arrived within the 250ms window.
        // If it's only backchannel words — cancel the pending barge-in.
        if (isBackchannel(transcript)) {
          clearTimeout(bargeInTimer)
          bargeInTimer = null
          console.log(`[STT/Flux] Backchannel detected in StartOfTurn window — barge-in cancelled: "${transcript}"`)
        }
        // Non-backchannel partial → let the timer fire naturally (250ms)
      }
    })

    ws.on('error', (err: Error) => {
      console.error('[STT/Flux] WebSocket error:', err.message)
      // Don't call onError for transient errors — reconnect will handle it.
      // Only surface to pipeline if we've exhausted all retries.
    })

    ws.on('close', (code: number, reason: Buffer) => {
      if (keepAlive) { clearInterval(keepAlive); keepAlive = null }
      const r = reason?.toString() || ''
      if (code === 1000) {
        // Intentional close — do nothing (either .close() was called or Deepgram timed out a
        // session that we explicitly closed; in either case isClosed will already be true).
        console.log(`[STT/Flux] Closed cleanly (1000)`)
      } else if (code === 1008 || r.toLowerCase().includes('auth') || r.toLowerCase().includes('key')) {
        // Auth failure — retrying won't help; surface the error immediately
        console.error(`[STT/Flux] Rejected — invalid API key (code ${code}): ${r}`)
        config.onError(new Error(`Deepgram Flux auth failed (${code}): ${r}`))
      } else if (!isClosed && attemptCount < 3) {
        // Unexpected drop — reconnect with exponential backoff (1s, 2s, 4s)
        attemptCount++
        const delay = Math.pow(2, attemptCount - 1) * 1000
        console.warn(`[STT/Flux] Unexpected close (code ${code}${r ? ': ' + r : ''}) — reconnecting in ${delay}ms (attempt ${attemptCount}/3)`)
        setTimeout(connect, delay)
      } else if (!isClosed) {
        // Exhausted retries — surface error so pipeline can decide (end call or continue silently)
        console.error(`[STT/Flux] All reconnect attempts exhausted — code ${code}: ${r}`)
        config.onError(new Error(`Deepgram Flux connection lost after 3 retries (code ${code})`))
      }
    })

    // Ping every 10 seconds to keep the connection alive during prospect silence
    keepAlive = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) ws.ping()
    }, 10000)
  }

  connect()  // initial connection

  return {
    sendAudio: (chunk: Buffer) => {
      if (!currentWs || currentWs.readyState !== WebSocket.OPEN) return
      // Flux requires linear16 — convert from mulaw before sending
      const linear16 = mulawToLinear16(chunk)
      currentWs.send(linear16)
    },
    close: () => {
      isClosed = true  // prevents reconnect loop from firing
      if (keepAlive) { clearInterval(keepAlive); keepAlive = null }
      if (bargeInTimer) { clearTimeout(bargeInTimer); bargeInTimer = null }
      if (currentWs && currentWs.readyState === WebSocket.OPEN) currentWs.close(1000, 'session ended')
    },
  }
}

// ─── Deepgram Nova-2/Nova-3 (v1/listen, SDK-based) ───────────────────────────
// Auto-reconnect: on unexpected Close (non-1000) retry up to 3 times with
// 1s/2s/4s exponential backoff, then surface error to pipeline.
function createDeepgramStream(config: STTStreamConfig) {
  if (!config.apiKey) {
    console.error('[STT] Deepgram API key is empty — check Settings → Deepgram API Key')
    config.onError(new Error('Deepgram API key is not set'))
    return { sendAudio: () => {}, close: () => {} }
  }

  const keyPreview = config.apiKey.slice(0, 8) + '…'
  const model = config.model || 'nova-2'

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

  // Reconnect state
  let isClosed = false
  let attemptCount = 0
  let currentConnection: ReturnType<ReturnType<typeof createClient>['listen']['live']> | null = null
  let keepAliveInterval: ReturnType<typeof setInterval> | null = null

  function connect() {
    if (isClosed) return
    console.log(`[STT] Connecting to Deepgram — model: ${model}, key: ${keyPreview}${attemptCount > 0 ? ` (retry ${attemptCount}/3)` : ''}`)

    const deepgram = createClient(config.apiKey)
    const connection = deepgram.listen.live({
      model: model as any,
      language: 'en-GB',
      smart_format: true,
      interim_results: true,
      // utterance_end_ms removed — minimum valid value is 1000ms per Deepgram docs.
      // We use endpointing (VAD-based) + speech_final instead for lower latency.
      vad_events: true,
      endpointing: 200,  // 200ms silence → speech_final fires. 100ms faster than 300ms, safe minimum for conversational speech
      // CRITICAL: Telnyx streams mulaw 8000Hz mono audio
      // Wrong encoding = garbage transcriptions
      encoding: 'mulaw',
      sample_rate: 8000,
      channels: 1,
    })
    currentConnection = connection

    connection.on(LiveTranscriptionEvents.Open, () => {
      console.log('[STT] Deepgram opened')
      attemptCount = 0  // successful connect resets the retry counter
    })

    connection.on(LiveTranscriptionEvents.SpeechStarted, () => {
      config.onSpeechStarted?.()
    })

    connection.on(LiveTranscriptionEvents.Transcript, (data: any) => {
      const transcript = data?.channel?.alternatives?.[0]?.transcript
      const isFinal    = data?.is_final
      // speech_final fires when endpointing detects 300ms of silence (VAD-based) — fast & accurate.
      // Fallback to is_final ensures we never miss a turn even if speech_final isn't set.
      const speechFinal = data?.speech_final
      if (transcript && transcript.trim().length > 2 && (speechFinal || isFinal)) {
        config.onTranscript(transcript.trim(), true)
      }
    })

    connection.on(LiveTranscriptionEvents.Error, (error: any) => {
      const msg = error?.message || error?.reason || error?.code || JSON.stringify(error) || String(error)
      // Log but don't surface — if the connection drops it will also emit Close, where we reconnect.
      console.error(`[STT] Deepgram WS error: ${msg}`)
    })

    // Close event carries the HTTP status code — useful for diagnosing 401/402/403
    connection.on(LiveTranscriptionEvents.Close, (event: any) => {
      if (keepAliveInterval) { clearInterval(keepAliveInterval); keepAliveInterval = null }
      const code = event?.code
      const reason = event?.reason || ''
      if (!code || code === 1000) {
        console.log(`[STT] Deepgram closed cleanly`)
      } else if (code === 1008 || reason.toLowerCase().includes('auth') || reason.toLowerCase().includes('key')) {
        console.error(`[STT] Deepgram rejected connection — invalid API key (code ${code}): ${reason}`)
        config.onError(new Error(`Deepgram auth failed (${code}): ${reason}`))
      } else if (!isClosed && attemptCount < 3) {
        attemptCount++
        const delay = Math.pow(2, attemptCount - 1) * 1000
        console.warn(`[STT] Deepgram closed unexpectedly (code ${code}${reason ? ': ' + reason : ''}) — reconnecting in ${delay}ms (attempt ${attemptCount}/3)`)
        setTimeout(connect, delay)
      } else if (!isClosed) {
        console.error(`[STT] All reconnect attempts exhausted — code ${code}: ${reason}`)
        config.onError(new Error(`Deepgram connection lost after 3 retries (code ${code})`))
      }
    })

    // CRITICAL: Send keepalive every 10 seconds
    // Deepgram closes idle connections after 12 seconds
    // During silence on call this prevents disconnection
    keepAliveInterval = setInterval(() => {
      try {
        if (connection.getReadyState() === 1) connection.keepAlive()
      } catch (e) { /* ignore */ }
    }, 10000)
  }

  connect()  // initial connection

  return {
    sendAudio: (chunk: Buffer) => {
      try {
        if (currentConnection && currentConnection.getReadyState() === 1) {
          currentConnection.send(chunk as unknown as ArrayBuffer)
        }
      } catch (e) {
        console.error('[STT] Failed to send audio chunk:', e)
      }
    },
    close: () => {
      isClosed = true  // prevents reconnect loop from firing
      if (keepAliveInterval) { clearInterval(keepAliveInterval); keepAliveInterval = null }
      try { currentConnection?.requestClose() } catch (e) { /* ignore */ }
    }
  }
}
