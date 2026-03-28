// ─── Speech-to-Text providers ─────────────────────────────────────────────────
// Supports Deepgram Flux (v2 WebSocket) and Deepgram Nova-2/3 (v1 SDK).
//
// INPUT: LINEAR16 8kHz PCM (Int16LE Buffer)
// Format conversion happens once at the pipeline entry point (pipeline.ts).
// This module never receives or produces mulaw — PCM is the standard throughout.
//
// Flux is strongly preferred for new deployments:
//   - StartOfTurn / EndOfTurn come from the same model as the transcript.
//     No race conditions between separate VAD and transcription systems.
//   - EagerEndOfTurn allows speculative LLM generation 150–250ms earlier.
//   - Backchannel detection window prevents "yeah"/"uh-huh" from triggering barge-in.
//
// Nova-2/3 is kept as a working fallback for users already on that setting.
//   - SpeechStarted now has the same 250ms backchannel window as Flux.
//   - Accepts linear16 directly (encoding changed from mulaw to linear16).
//
// Both paths auto-reconnect up to 3× on unexpected drops (1s / 2s / 4s backoff).

import { createClient, LiveTranscriptionEvents } from '@deepgram/sdk'
import WebSocket from 'ws'

export interface STTStreamConfig {
  provider: 'deepgram' | 'google'
  apiKey: string
  // 'flux' for Deepgram Flux (recommended), or a Nova model name ('nova-2', 'nova-3', etc.)
  model?: string
  // Called with the final transcript when a turn ends.
  onTranscript: (text: string, isFinal: boolean) => void
  // Called when the prospect starts speaking — triggers barge-in in pipeline.
  // Delayed by 250ms backchannel window on both Flux and Nova paths.
  onSpeechStarted?: () => void
  // Called when Flux fires EagerEndOfTurn (moderate confidence turn is ending).
  // Pipeline can start speculative LLM generation here to reduce latency.
  // Paired with onTurnResumed — cancel the speculative call if user keeps talking.
  onEagerEndOfTurn?: (transcript: string) => void
  // Called when Flux fires TurnResumed — user continued speaking after EagerEndOfTurn.
  // Pipeline must cancel any speculative LLM generation started in onEagerEndOfTurn.
  onTurnResumed?: () => void
  // Surface fatal STT errors (auth failure, exhausted retries) to the pipeline.
  onError?: (error: Error) => void
}

export function createSTTStream(config: STTStreamConfig) {
  if (config.provider !== 'deepgram') throw new Error(`STT provider ${config.provider} not supported`)
  if (config.model === 'flux') return createFluxStream(config)
  return createNovaStream(config)
}

// ─── Shared backchannel helpers ───────────────────────────────────────────────
// Backchannel words are acknowledgment sounds the prospect makes WHILE the
// agent is speaking ("yeah", "uh-huh", "okay"). They are not interruptions.
// Both Flux and Nova use a 250ms confirmation window: StartOfTurn / SpeechStarted
// fires the timer; if the first partial within the window is only backchannel
// words, the barge-in is cancelled before pipeline.fireBargeIn is called.

const BACKCHANNEL = new Set([
  'yeah', 'yes', 'yep', 'yup', 'ya',
  'uh-huh', 'mm-hmm', 'mhm', 'mm', 'hmm', 'hm',
  'ok', 'okay', 'alright', 'right',
  'sure', 'oh', 'ah', 'uh', 'um',
  'cool', 'great', 'fine', 'got it', 'i see',
])

function isBackchannel(text: string): boolean {
  const words = text.toLowerCase().replace(/[.,!?]/g, '').trim().split(/\s+/).filter(Boolean)
  return words.length > 0 && words.length <= 4 && words.every(w => BACKCHANNEL.has(w))
}

// ─── Deepgram Flux ────────────────────────────────────────────────────────────
// Uses Deepgram's v2/listen WebSocket directly (SDK v3 does not expose this).
// Event flow:
//   StartOfTurn   → 250ms backchannel window → onSpeechStarted (barge-in)
//   Update        → partial transcript (within window: cancels barge-in if backchannel)
//   EagerEndOfTurn→ onEagerEndOfTurn (start speculative LLM)
//   TurnResumed   → onTurnResumed (cancel speculative LLM)
//   EndOfTurn     → onTranscript (commit response)
function createFluxStream(config: STTStreamConfig) {
  if (!config.apiKey) {
    config.onError?.(new Error('Deepgram API key not set'))
    return { sendAudio: () => {}, close: () => {} }
  }

  const params = new URLSearchParams({
    model:             'flux-general-en',
    encoding:          'linear16',
    sample_rate:       '8000',
    eot_timeout_ms:    '1000',    // reduced from 1500 → tighter turn-end for sales conversations
    eot_threshold:     '0.7',     // default confidence — well-calibrated per Deepgram docs
    eager_eot_threshold: '0.4',   // fires EagerEndOfTurn at 40% confidence → 150–250ms earlier LLM start
  })
  const url        = `wss://api.deepgram.com/v2/listen?${params}`
  const keyPreview = config.apiKey.slice(0, 8) + '…'

  let isClosed      = false
  let attemptCount  = 0
  let currentWs: WebSocket | null = null
  let keepAlive: ReturnType<typeof setInterval> | null = null
  // Backchannel confirmation timer — lives outside connect() so reconnects
  // don't reset it mid-turn.
  let bargeInTimer: ReturnType<typeof setTimeout> | null = null

  function connect() {
    if (isClosed) return
    console.log(`[STT/Flux] Connecting — key: ${keyPreview}${attemptCount > 0 ? ` (retry ${attemptCount}/3)` : ''}`)

    const ws = new WebSocket(url, { headers: { Authorization: `Token ${config.apiKey}` } })
    currentWs = ws

    ws.on('open', () => {
      console.log('[STT/Flux] Connected')
      attemptCount = 0
    })

    ws.on('message', (raw: Buffer) => {
      let msg: any
      try { msg = JSON.parse(raw.toString()) } catch { return }
      if (msg.type !== 'TurnInfo') return

      const event      = msg.event as string
      const transcript = (msg.transcript as string | undefined)?.trim() ?? ''

      switch (event) {

        case 'StartOfTurn':
          // Open a 250ms window to check if this is just a backchannel word.
          // If the window expires without a cancellation → fire barge-in.
          if (bargeInTimer) return  // already pending
          bargeInTimer = setTimeout(() => {
            bargeInTimer = null
            config.onSpeechStarted?.()
          }, 250)
          break

        case 'Update':
          // Partial transcript arrived during the confirmation window.
          // Cancel the barge-in if it is only backchannel words.
          if (bargeInTimer && transcript && isBackchannel(transcript)) {
            clearTimeout(bargeInTimer)
            bargeInTimer = null
            console.log(`[STT/Flux] Backchannel suppressed: "${transcript}"`)
          }
          break

        case 'EagerEndOfTurn':
          // Model is ~40–60% confident the turn ended — start LLM speculatively.
          // Paired with TurnResumed: cancel the speculation if user keeps talking.
          if (transcript && transcript.length > 2) {
            if (bargeInTimer) { clearTimeout(bargeInTimer); bargeInTimer = null }
            config.onEagerEndOfTurn?.(transcript)
          }
          break

        case 'TurnResumed':
          // User continued speaking after EagerEndOfTurn — cancel speculation.
          config.onTurnResumed?.()
          break

        case 'EndOfTurn':
          // High-confidence turn end — commit the response.
          if (bargeInTimer) { clearTimeout(bargeInTimer); bargeInTimer = null }
          if (transcript && transcript.length > 2) {
            config.onTranscript(transcript, true)
          }
          break
      }
    })

    ws.on('error', (err: Error) => {
      console.error('[STT/Flux] WebSocket error:', err.message)
    })

    ws.on('close', (code: number, reason: Buffer) => {
      if (keepAlive) { clearInterval(keepAlive); keepAlive = null }
      const r = reason?.toString() || ''

      if (code === 1000) {
        console.log('[STT/Flux] Closed cleanly (1000)')
      } else if (code === 1008 || r.toLowerCase().includes('auth') || r.toLowerCase().includes('key')) {
        console.error(`[STT/Flux] Auth rejected (code ${code}): ${r}`)
        config.onError?.(new Error(`Deepgram Flux auth failed (${code}): ${r}`))
      } else if (!isClosed && attemptCount < 3) {
        attemptCount++
        const delay = Math.pow(2, attemptCount - 1) * 1000
        console.warn(`[STT/Flux] Unexpected close (${code}) — reconnecting in ${delay}ms (${attemptCount}/3)`)
        setTimeout(connect, delay)
      } else if (!isClosed) {
        console.error(`[STT/Flux] Reconnect attempts exhausted (code ${code})`)
        config.onError?.(new Error(`Deepgram Flux lost after 3 retries (code ${code})`))
      }
    })

    keepAlive = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) ws.ping()
    }, 10_000)
  }

  connect()

  return {
    // Accepts linear16 8kHz PCM (Int16LE Buffer) — send directly to Flux
    sendAudio: (pcm: Buffer) => {
      if (currentWs?.readyState === WebSocket.OPEN) currentWs.send(pcm)
    },
    close: () => {
      isClosed = true
      if (keepAlive)   { clearInterval(keepAlive);  keepAlive  = null }
      if (bargeInTimer){ clearTimeout(bargeInTimer); bargeInTimer = null }
      if (currentWs?.readyState === WebSocket.OPEN) currentWs.close(1000, 'session ended')
    },
  }
}

// ─── Deepgram Nova-2 / Nova-3 ─────────────────────────────────────────────────
// Uses the v1 SDK. Kept as a working fallback for users on Nova settings.
// Now accepts linear16 8kHz input (encoding changed from mulaw to linear16).
// SpeechStarted now has the same 250ms backchannel confirmation window as Flux
// — previously it fired immediately on any audio energy with no filter.
function createNovaStream(config: STTStreamConfig) {
  if (!config.apiKey) {
    console.error('[STT/Nova] Deepgram API key is empty')
    config.onError?.(new Error('Deepgram API key not set'))
    return { sendAudio: () => {}, close: () => {} }
  }

  const model      = config.model || 'nova-3'
  const keyPreview = config.apiKey.slice(0, 8) + '…'

  // Quick auth check before attempting WebSocket
  fetch('https://api.deepgram.com/v1/projects', {
    headers: { Authorization: `Token ${config.apiKey}` },
  }).then((r: Response) => {
    if (!r.ok) {
      console.error(`[STT/Nova] Key check failed — HTTP ${r.status}.${r.status === 401 ? ' Invalid key.' : r.status === 402 ? ' No credits.' : ''}`)
    }
  }).catch(() => { /* ignore — WS handles network errors */ })

  let isClosed     = false
  let attemptCount = 0
  let currentConnection: ReturnType<ReturnType<typeof createClient>['listen']['live']> | null = null
  let keepAliveInterval: ReturnType<typeof setInterval> | null = null
  // 250ms backchannel confirmation window — same design as Flux
  let bargeInTimer: ReturnType<typeof setTimeout> | null = null

  function connect() {
    if (isClosed) return
    console.log(`[STT/Nova] Connecting — model: ${model}, key: ${keyPreview}${attemptCount > 0 ? ` (retry ${attemptCount}/3)` : ''}`)

    const deepgram  = createClient(config.apiKey)
    const connection = deepgram.listen.live({
      model:           model as any,
      language:        'en-GB',
      smart_format:    true,
      interim_results: true,
      vad_events:      true,
      endpointing:     200,   // 200ms silence → speech_final (down from 300ms default)
      // Now using linear16 — same PCM format the pipeline sends for Flux.
      // Previously used mulaw which forced pipeline to re-encode after denoising.
      encoding:        'linear16',
      sample_rate:     8000,
      channels:        1,
    })
    currentConnection = connection

    connection.on(LiveTranscriptionEvents.Open, () => {
      console.log('[STT/Nova] Connected')
      attemptCount = 0
    })

    // SpeechStarted now has a 250ms backchannel window — same as Flux.
    // Previously this fired immediately on any audio, triggering barge-in
    // from background noise, coughs, and the prospect clearing their throat.
    connection.on(LiveTranscriptionEvents.SpeechStarted, () => {
      if (bargeInTimer) return
      bargeInTimer = setTimeout(() => {
        bargeInTimer = null
        config.onSpeechStarted?.()
      }, 250)
    })

    connection.on(LiveTranscriptionEvents.Transcript, (data: any) => {
      const transcript  = data?.channel?.alternatives?.[0]?.transcript?.trim()
      const speechFinal = data?.speech_final
      const isFinal     = data?.is_final

      // Cancel backchannel barge-in if first partial is only filler words
      if (bargeInTimer && transcript && isBackchannel(transcript)) {
        clearTimeout(bargeInTimer)
        bargeInTimer = null
        console.log(`[STT/Nova] Backchannel suppressed: "${transcript}"`)
        return
      }

      if (transcript && transcript.length > 2 && (speechFinal || isFinal)) {
        if (bargeInTimer) { clearTimeout(bargeInTimer); bargeInTimer = null }
        config.onTranscript(transcript, true)
      }
    })

    connection.on(LiveTranscriptionEvents.Error, (error: any) => {
      const msg = error?.message || error?.reason || String(error)
      console.error(`[STT/Nova] Error: ${msg}`)
    })

    connection.on(LiveTranscriptionEvents.Close, (event: any) => {
      if (keepAliveInterval) { clearInterval(keepAliveInterval); keepAliveInterval = null }
      const code   = event?.code
      const reason = event?.reason || ''
      if (!code || code === 1000) {
        console.log('[STT/Nova] Closed cleanly')
      } else if (code === 1008 || reason.toLowerCase().includes('auth')) {
        console.error(`[STT/Nova] Auth rejected (code ${code}): ${reason}`)
        config.onError?.(new Error(`Deepgram Nova auth failed (${code}): ${reason}`))
      } else if (!isClosed && attemptCount < 3) {
        attemptCount++
        const delay = Math.pow(2, attemptCount - 1) * 1000
        console.warn(`[STT/Nova] Unexpected close (${code}) — reconnecting in ${delay}ms (${attemptCount}/3)`)
        setTimeout(connect, delay)
      } else if (!isClosed) {
        console.error(`[STT/Nova] Reconnect attempts exhausted (code ${code})`)
        config.onError?.(new Error(`Deepgram Nova lost after 3 retries (code ${code})`))
      }
    })

    keepAliveInterval = setInterval(() => {
      try {
        if (connection.getReadyState() === 1) connection.keepAlive()
      } catch { /* ignore */ }
    }, 10_000)
  }

  connect()

  return {
    // Accepts linear16 8kHz PCM (Int16LE Buffer)
    sendAudio: (pcm: Buffer) => {
      try {
        if (currentConnection?.getReadyState() === 1) {
          currentConnection.send(pcm as unknown as ArrayBuffer)
        }
      } catch (e) {
        console.error('[STT/Nova] Failed to send audio:', e)
      }
    },
    close: () => {
      isClosed = true
      if (keepAliveInterval) { clearInterval(keepAliveInterval); keepAliveInterval = null }
      if (bargeInTimer)      { clearTimeout(bargeInTimer);       bargeInTimer       = null }
      try { currentConnection?.requestClose() } catch { /* ignore */ }
    },
  }
}

