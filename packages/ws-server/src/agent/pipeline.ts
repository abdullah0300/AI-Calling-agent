import { createSTTStream } from '../providers/stt'
import { streamTextToSpeech } from '../providers/tts'
import { streamAgentResponse } from '../providers/llm'
import { detectScenario, buildSystemPrompt } from './scenarios'
import { supabase } from '../db/client'
import { loadSettings } from '../db/settings'
import {
  initNoiseSuppression,
  createNoiseSuppressionState,
  destroyNoiseSuppressionState,
  denoiseAudioChunk,
} from '../providers/noise-suppression'
import type { PlatformSettings } from '../db/settings'
import type { CallSession, TranscriptEntry } from '@voiceflow/shared'
import type WebSocket from 'ws'

// Initialise RNNoise WASM once at module load — all sessions share the same module.
// Sessions each get their own stateful RNNoise handle (createNoiseSuppressionState).
initNoiseSuppression()

// Deepgram Nova-3 streaming rate (2026): $0.0077 / min
// (source: deepgram.com/pricing)
const DEEPGRAM_STT_PER_BYTE = 0.0077 / 60 / 8000  // $0.0077/min ÷ 60s ÷ 8000 bytes/s (mulaw 8kHz)

// ─── Local VAD constants for fast barge-in ───────────────────────────────────
// Vapi/LiveKit detect barge-in in ~80ms using raw audio energy (VAD), not by waiting
// for the STT model to make a decision. We mirror this with a simple energy threshold.
// Telnyx sends mulaw 8kHz. When decoded to linear16: silence ~0-200 RMS, noise ~200-600,
// speech ~600-5000. We require sustained speech (150ms) above threshold to fire barge-in.
const BARGE_IN_ENERGY_THRESHOLD = 600   // RMS of decoded linear16 — above this = likely speech
const BARGE_IN_MIN_SPEECH_MS    = 150   // ms of sustained speech before triggering barge-in

// Decodes a mulaw 8kHz buffer and returns its RMS energy (linear16 scale).
// Used by local VAD to detect prospect speech during agent audio playback.
function mulawRms(buf: Buffer): number {
  let sumSq = 0
  for (let i = 0; i < buf.length; i++) {
    let b = (~buf[i]) & 0xFF
    const sign = b & 0x80
    const exp  = (b >> 4) & 0x07
    const mant = b & 0x0F
    let s = ((mant << 3) | 0x84) << exp
    s -= 0x84
    if (sign) s = -s
    sumSq += s * s
  }
  return Math.sqrt(sumSq / buf.length)
}

interface ActiveSession {
  session: CallSession
  ws: WebSocket | null
  sttStream: ReturnType<typeof createSTTStream> | null
  conversationHistory: Array<{ role: 'user' | 'assistant'; content: string }>
  isProcessing: boolean
  isStarted: boolean
  maxDurationTimer: NodeJS.Timeout | null
  // Cost accumulators (USD)
  costLlm: number
  costTts: number
  sttAudioBytes: number  // raw bytes sent to Deepgram — converted to cost at endSession
  // Latency measurements: ms from STT final transcript → first audio chunk sent, per turn
  latencyMeasurements: number[]
  // Platform settings loaded from DB at session start
  // API keys + global provider defaults, merged with per-agent overrides
  platformSettings: PlatformSettings | null
  // Barge-in state — set when the agent is currently playing audio to the prospect
  isSpeaking: boolean
  currentTtsAbort: AbortController | null
  // Set to true when barge-in fires mid-LLM-stream — onSentence skips remaining sentences
  bargedIn: boolean
  // Telnyx stream_id from the WS 'start' event — required to send the 'clear' command
  telnyxStreamId: string | null
  // SET of mark IDs sent to Telnyx that haven't been echoed back yet.
  // Each sentence adds its markId BEFORE the TTS fetch starts — this prevents the race condition
  // where sentence N's mark returns from Telnyx while sentence N+1's TTS is still fetching,
  // which used to flip isSpeaking=false even though more audio was about to play.
  // isSpeaking stays true as long as pendingMarkIds.size > 0.
  pendingMarkIds: Set<string>
  // Accumulated ms of audio above speech-energy threshold — for local VAD barge-in detection.
  // Reset to 0 when energy drops below threshold or barge-in fires.
  vadSpeechMs: number
  // RNNoise denoising state handle for this session — one stateful handle per call so
  // the recurrent network can track noise profile across frames.
  denoisingSessionId: string
}

export const activeSessions = new Map<string, ActiveSession>()

export function registerSession(callControlId: string, session: CallSession) {
  // Create a unique ID for this session's RNNoise state.
  // The state must exist before the first audio chunk arrives.
  const denoisingSessionId = `ns_${callControlId}`
  createNoiseSuppressionState(denoisingSessionId)

  activeSessions.set(callControlId, {
    session, ws: null, sttStream: null,
    conversationHistory: [], isProcessing: false, isStarted: false, maxDurationTimer: null,
    costLlm: 0, costTts: 0, sttAudioBytes: 0, latencyMeasurements: [], platformSettings: null,
    isSpeaking: false, currentTtsAbort: null, bargedIn: false, telnyxStreamId: null,
    pendingMarkIds: new Set<string>(), vadSpeechMs: 0, denoisingSessionId,
  })
  console.log(`[Pipeline] Session registered: ${callControlId}`)
}

export function attachWebSocket(callControlId: string, ws: WebSocket, streamId?: string) {
  const data = activeSessions.get(callControlId)
  if (data) {
    data.ws = ws
    data.telnyxStreamId = streamId || null
    console.log(`[Pipeline] WebSocket attached: ${callControlId} (stream_id: ${streamId ?? 'n/a'})`)
  }
}

// Central barge-in handler — called by both the STT onSpeechStarted callback AND the local VAD.
// Immediately stops TTS, clears all pending marks, and clears Telnyx's audio buffer.
function fireBargeIn(callControlId: string): void {
  const d = activeSessions.get(callControlId)
  if (!d || !d.isSpeaking) return
  console.log(`[Pipeline] Barge-in detected — aborting TTS ${callControlId}`)
  d.bargedIn = true
  d.currentTtsAbort?.abort()
  d.currentTtsAbort = null
  d.isSpeaking = false
  d.pendingMarkIds.clear()
  d.vadSpeechMs = 0
  d.isProcessing = false  // allow new speech turn to start immediately
  if (d.ws && d.ws.readyState === d.ws.OPEN) {
    d.ws.send(JSON.stringify({ event: 'clear', stream_id: d.telnyxStreamId }))
    console.log(`[Pipeline] Telnyx audio buffer cleared (barge-in)`)
  }
}

export async function startSession(callControlId: string) {
  const data = activeSessions.get(callControlId)
  if (!data) return console.error(`[Pipeline] No session: ${callControlId}`)
  // Guard against double-start (webhook + WS event could both trigger this)
  if (data.isStarted) return console.warn(`[Pipeline] Session already started: ${callControlId}`)
  data.isStarted = true

  const { session } = data

  // Load API keys + global settings from DB
  // Agent's active_llm/stt/tts override the global defaults for provider routing
  const platformSettings = await loadSettings()
  data.platformSettings = platformSettings

  await supabase.from('calls')
    .update({ status: 'in_progress', started_at: new Date().toISOString() })
    .eq('id', session.callId)

  await supabase.from('leads')
    .update({ status: 'calling' })
    .eq('id', session.leadId)

  // Safety timer — force end after max duration to prevent cost overruns
  data.maxDurationTimer = setTimeout(
    () => endSession(callControlId, 'timeout'),
    session.maxDuration * 1000
  )

  // Provider selection: agent field wins (per-agent override), falls back to global setting
  const sttProvider = (session.agent.active_stt || platformSettings.active_stt) as 'deepgram' | 'google'

  // STT model: agent-level override wins, falls back to global setting
  const sttModel = session.agent.active_stt_model || platformSettings.active_stt_model

  data.sttStream = createSTTStream({
    provider: sttProvider,
    apiKey: platformSettings.deepgram_api_key,
    model: sttModel,
    onTranscript: async (text, isFinal) => {
      if (isFinal && text.length > 3) await handleProspectSpeech(callControlId, text)
    },
    onError: (error) => console.error(`[Pipeline] STT error ${callControlId}:`, error),
    // STT-based barge-in: Deepgram fires SpeechStarted (Nova-2) or StartOfTurn (Flux)
    // when it detects the prospect starting to speak. We also run a parallel local VAD
    // in handleAudioChunk for faster (~80ms) detection independent of the STT model.
    onSpeechStarted: () => fireBargeIn(callControlId),
  })

  await speakToProspect(callControlId, session.agent.greeting_message)
  console.log(`[Pipeline] Session started: ${callControlId}`)
}

export async function handleAudioChunk(callControlId: string, audioBuffer: Buffer) {
  const data = activeSessions.get(callControlId)
  if (!data?.sttStream) return

  // ── Noise suppression (RNNoise) ───────────────────────────────────────────
  // Clean the audio BEFORE it reaches VAD or STT. This is the core fix for
  // false barge-ins triggered by background noise (HVAC, traffic, TV audio).
  // denoiseAudioChunk falls back to the original buffer if WASM isn't loaded.
  const cleanBuffer = denoiseAudioChunk(data.denoisingSessionId, audioBuffer)

  // Track bytes for STT cost calculation (mulaw 8kHz = 8000 bytes/sec)
  data.sttAudioBytes += cleanBuffer.length
  // Send denoised audio to STT — Deepgram sees cleaner signal, fewer false starts
  data.sttStream.sendAudio(cleanBuffer)

  // ── Local VAD barge-in (runs on denoised audio while agent is speaking) ───
  // Energy VAD now operates on cleaned audio — background noise has already been
  // attenuated, so only real speech energy from the prospect crosses the threshold.
  if (data.isSpeaking) {
    const chunkMs = cleanBuffer.length / 8  // 8000 bytes/s → 8 bytes per ms
    if (mulawRms(cleanBuffer) > BARGE_IN_ENERGY_THRESHOLD) {
      data.vadSpeechMs += chunkMs
      if (data.vadSpeechMs >= BARGE_IN_MIN_SPEECH_MS) {
        data.vadSpeechMs = 0
        fireBargeIn(callControlId)
      }
    } else {
      data.vadSpeechMs = 0
    }
  } else {
    data.vadSpeechMs = 0
  }
}

async function handleProspectSpeech(callControlId: string, transcript: string) {
  const data = activeSessions.get(callControlId)
  if (!data || data.isProcessing) return

  data.isProcessing = true
  data.bargedIn = false  // reset — new turn starting
  const turnStart = Date.now()
  let firstChunkSent = false

  // Called on the first audio chunk of each turn — measures STT final → first audio out.
  const onFirstChunk = () => {
    if (firstChunkSent) return
    firstChunkSent = true
    const latency = Date.now() - turnStart
    data.latencyMeasurements.push(latency)
    console.log(`[Latency] Turn response: ${latency}ms`)
  }

  try {
    const { session, conversationHistory, platformSettings } = data

    if (!platformSettings) return

    session.transcript.push({
      role: 'prospect', text: transcript, timestamp: new Date().toISOString()
    })

    console.log(`[Pipeline] Prospect: "${transcript}"`)

    const scenario = detectScenario(transcript)
    let responseText = ''

    switch (scenario) {
      case 'voicemail':
        await endSession(callControlId, 'voicemail')
        return

      case 'not_interested':
        responseText = session.agent.not_interested_message
        await speakToProspect(callControlId, responseText, onFirstChunk)
        setTimeout(() => endSession(callControlId, 'not_interested'), 4000)
        return

      case 'interested':
        responseText = session.agent.interest_detected_message
        await speakToProspect(callControlId, responseText, onFirstChunk)
        setTimeout(() => endSession(callControlId, 'interested'), 6000)
        return

      case 'wrong_person':
        responseText = session.agent.wrong_person_message
        await speakToProspect(callControlId, responseText, onFirstChunk)
        break

      case 'callback_request':
        responseText = session.agent.callback_message
        await speakToProspect(callControlId, responseText, onFirstChunk)
        break

      default:
        try {
          // Provider selection: agent field wins, falls back to global setting
          const llmProvider = (session.agent.active_llm || platformSettings.active_llm) as 'anthropic' | 'openai'
          const llmModel    = session.agent.active_llm_model || platformSettings.active_llm_model
          const llmApiKey   = llmProvider === 'openai'
            ? platformSettings.openai_api_key
            : platformSettings.anthropic_api_key
          const ttsProvider = (session.agent.active_tts || platformSettings.active_tts) as 'elevenlabs' | 'deepgram' | 'google'
          const ttsApiKey   = ttsProvider === 'elevenlabs'
            ? platformSettings.elevenlabs_api_key
            : platformSettings.deepgram_api_key
          const ttsVoiceId  = ttsProvider === 'elevenlabs' ? platformSettings.elevenlabs_voice_id : undefined

          // Stream LLM tokens → fire TTS on each sentence → send audio chunks immediately.
          // This eliminates the full-response wait and starts audio ~150ms after first sentence.
          const result = await streamAgentResponse({
            provider: llmProvider,
            apiKey: llmApiKey,
            model: llmModel,
            systemPrompt: buildSystemPrompt(session.agent.system_prompt, {
              businessName: session.lead.business_name,
              industry: session.lead.industry,
              city: session.lead.city || undefined,
            }),
            conversationHistory,
            userMessage: transcript,
            onSentence: async (sentence) => {
              const current = activeSessions.get(callControlId)
              if (!current?.ws || current.ws.readyState !== current.ws.OPEN) return
              if (current.bargedIn) return  // prospect interrupted — skip remaining sentences

              const sentenceAbort = new AbortController()
              const sentenceMarkId = `tts_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`
              // Add markId to the pending set BEFORE the TTS fetch starts.
              // This prevents the race condition: sentence N's mark can return from Telnyx
              // while sentence N+1's TTS is still fetching — with the Set, N+1 is already
              // registered, so isSpeaking stays true until N+1's mark also returns.
              current.pendingMarkIds.add(sentenceMarkId)
              current.currentTtsAbort = sentenceAbort
              current.isSpeaking = true
              try {
                const sentenceCost = await streamTextToSpeech({
                  provider: ttsProvider,
                  apiKey: ttsApiKey,
                  voiceId: ttsVoiceId,
                  text: sentence,
                  abortSignal: sentenceAbort.signal,
                  onChunk: (base64Audio) => {
                    onFirstChunk()
                    const c = activeSessions.get(callControlId)
                    if (c?.ws && c.ws.readyState === c.ws.OPEN) {
                      c.ws.send(JSON.stringify({ event: 'media', media: { payload: base64Audio } }))
                    }
                  },
                })
                data.costTts += sentenceCost
                // Send mark to Telnyx — it will echo back when this sentence finishes playing
                const c = activeSessions.get(callControlId)
                if (c?.ws && c.ws.readyState === c.ws.OPEN) {
                  c.ws.send(JSON.stringify({ event: 'mark', stream_id: c.telnyxStreamId, mark: { name: sentenceMarkId } }))
                }
              } catch (ttsErr) {
                if (!(ttsErr instanceof Error && ttsErr.name === 'AbortError')) {
                  console.error(`[Pipeline] TTS stream error for sentence — ${ttsErr}`)
                }
                // On abort (barge-in already cleared the set) or error — remove this mark
                if (current.currentTtsAbort === sentenceAbort) {
                  current.pendingMarkIds.delete(sentenceMarkId)
                  if (current.pendingMarkIds.size === 0) current.isSpeaking = false
                }
              } finally {
                if (current.currentTtsAbort === sentenceAbort) {
                  current.currentTtsAbort = null
                  // isSpeaking cleared by onTelnyxMark when all marks return
                }
              }
            },
          })
          responseText = result.text
          data.costLlm += result.costUsd
          console.log(`[Cost] LLM +$${result.costUsd.toFixed(6)} (total LLM: $${data.costLlm.toFixed(6)})`)

          // Transcript logged here — TTS was already sent sentence by sentence above
          session.transcript.push({ role: 'agent', text: responseText, timestamp: new Date().toISOString() })
          console.log(`[Pipeline] Agent: "${responseText}"`)
        } catch (llmError) {
          console.error(`[Pipeline] LLM error ${callControlId}:`, llmError)
          responseText = "Could you repeat that? I did not quite catch it."
          await speakToProspect(callControlId, responseText)
        }
        break
    }

    conversationHistory.push({ role: 'user', content: transcript })
    conversationHistory.push({ role: 'assistant', content: responseText })
    // Keep only last 20 messages to limit token usage
    if (conversationHistory.length > 20) {
      data.conversationHistory = conversationHistory.slice(-20)
    }

  } catch (error) {
    console.error(`[Pipeline] Speech handling error ${callControlId}:`, error)
  } finally {
    data.isProcessing = false
  }
}

async function speakToProspect(callControlId: string, text: string, onFirstChunk?: () => void) {
  const data = activeSessions.get(callControlId)
  if (!data) return

  const { session, ws, platformSettings } = data
  if (!platformSettings) return

  session.transcript.push({ role: 'agent', text, timestamp: new Date().toISOString() })
  console.log(`[Pipeline] Agent: "${text}"`)

  // Provider selection: agent field wins, falls back to global setting
  const ttsProvider = (session.agent.active_tts || platformSettings.active_tts) as 'elevenlabs' | 'deepgram' | 'google'
  const ttsApiKey   = ttsProvider === 'elevenlabs'
    ? platformSettings.elevenlabs_api_key
    : platformSettings.deepgram_api_key

  const abortController = new AbortController()
  const markId = `tts_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`
  // Add markId BEFORE the TTS fetch — prevents race where Telnyx echoes an old mark
  // back while this fetch is in-flight, which would clear isSpeaking prematurely.
  data.pendingMarkIds.add(markId)
  data.currentTtsAbort = abortController
  data.isSpeaking = true

  try {
    // Stream TTS audio chunks to Telnyx as they arrive — no waiting for full MP3
    const costUsd = await streamTextToSpeech({
      provider: ttsProvider,
      apiKey: ttsApiKey,
      voiceId: ttsProvider === 'elevenlabs' ? platformSettings.elevenlabs_voice_id : undefined,
      text,
      abortSignal: abortController.signal,
      onChunk: (base64Audio) => {
        onFirstChunk?.()
        if (ws && ws.readyState === ws.OPEN) {
          ws.send(JSON.stringify({ event: 'media', media: { payload: base64Audio } }))
        }
      },
    })
    data.costTts += costUsd
    console.log(`[Cost] TTS +$${costUsd.toFixed(6)} (total TTS: $${data.costTts.toFixed(6)})`)
    // All audio bytes sent to Telnyx — but Telnyx hasn't finished playing yet.
    // Send the mark now: Telnyx echoes it back when the last audio chunk finishes playing.
    // isSpeaking stays true until onTelnyxMark() fires and the Set becomes empty.
    if (ws && ws.readyState === ws.OPEN) {
      ws.send(JSON.stringify({ event: 'mark', stream_id: data.telnyxStreamId, mark: { name: markId } }))
    }
  } catch (ttsError) {
    if (ttsError instanceof Error && ttsError.name === 'AbortError') {
      console.log(`[Pipeline] TTS aborted (barge-in) ${callControlId}`)
      return  // barge-in already cleared the Set via fireBargeIn — don't end the call
    }
    const msg = ttsError instanceof Error ? ttsError.message : String(ttsError)
    console.error(`[Pipeline] TTS failed — ending call ${callControlId}: ${msg}`)
    // Remove this mark since no audio was sent and no mark event will arrive from Telnyx
    data.pendingMarkIds.delete(markId)
    if (data.pendingMarkIds.size === 0) data.isSpeaking = false
    // End the call immediately — the prospect would hear silence otherwise
    endSession(callControlId, 'error')
  } finally {
    if (data.currentTtsAbort === abortController) {
      data.currentTtsAbort = null
      // isSpeaking intentionally NOT cleared here — onTelnyxMark() clears it when Telnyx finishes playing
    }
  }
}

export async function endSession(callControlId: string, outcome: string) {
  const data = activeSessions.get(callControlId)
  if (!data) return

  // Remove immediately — prevents concurrent calls (stop event + ws.close + hangup webhook)
  // all firing before the first async endSession completes
  activeSessions.delete(callControlId)

  console.log(`[Pipeline] Ending ${callControlId} — outcome: ${outcome}`)

  const { session, sttStream, maxDurationTimer } = data

  if (maxDurationTimer) clearTimeout(maxDurationTimer)
  if (sttStream) sttStream.close()
  // Free the RNNoise state for this session — prevents memory leak over many calls
  destroyNoiseSuppressionState(data.denoisingSessionId)

  const durationSeconds = Math.floor(
    (Date.now() - new Date(session.startTime).getTime()) / 1000
  )

  // Calculate STT cost from total audio bytes processed
  const costStt = data.sttAudioBytes * DEEPGRAM_STT_PER_BYTE
  // cost_telephony will be added later by the call.cost webhook from Telnyx
  const costTotal = data.costLlm + data.costTts + costStt

  console.log(`[Cost] Call ${callControlId} — LLM: $${data.costLlm.toFixed(6)} | TTS: $${data.costTts.toFixed(6)} | STT: $${costStt.toFixed(6)} | Total (excl. telephony): $${costTotal.toFixed(6)}`)

  if (data.latencyMeasurements.length > 0) {
    const avg = Math.round(data.latencyMeasurements.reduce((a, b) => a + b, 0) / data.latencyMeasurements.length)
    const min = Math.min(...data.latencyMeasurements)
    const max = Math.max(...data.latencyMeasurements)
    console.log(`[Latency] Call ${callControlId} — avg: ${avg}ms | min: ${min}ms | max: ${max}ms | turns measured: ${data.latencyMeasurements.length}`)
  }

  const leadStatus =
    outcome === 'interested' ? 'interested' :
    outcome === 'not_interested' ? 'not_interested' :
    outcome === 'callback_request' ? 'callback' :
    outcome === 'wrong_person' ? 'wrong_person' : 'no_answer'

  await Promise.all([
    supabase.from('calls').update({
      status: 'completed', outcome,
      duration_seconds: durationSeconds,
      transcript: session.transcript,
      ended_at: new Date().toISOString(),
      cost_llm: data.costLlm,
      cost_tts: data.costTts,
      cost_stt: costStt,
      cost_total: costTotal,
    }).eq('id', session.callId),

    supabase.from('leads').update({ status: leadStatus }).eq('id', session.leadId),
  ])

  console.log(`[Pipeline] Session cleaned up: ${callControlId}`)
}

// Called from index.ts when Telnyx echoes back a mark — signals true end of audio playback on the call.
// This is how we know the prospect can hear silence and barge-in window is actually over.
export function onTelnyxMark(callControlId: string, markName: string) {
  const d = activeSessions.get(callControlId)
  if (!d) return
  if (d.pendingMarkIds.has(markName)) {
    d.pendingMarkIds.delete(markName)
    if (d.pendingMarkIds.size === 0) {
      d.isSpeaking = false
      console.log(`[Pipeline] Telnyx playback complete — last mark: ${markName}`)
    } else {
      console.log(`[Pipeline] Telnyx mark received (${d.pendingMarkIds.size} still pending): ${markName}`)
    }
  }
}

// Called from index.ts when Telnyx call.cost webhook arrives
// Telnyx sends the exact telephony charge after the call ends
export async function updateTelephonyCost(callControlId: string, costTelephony: number) {
  const { data: call, error } = await supabase
    .from('calls')
    .select('cost_llm, cost_stt, cost_tts')
    .eq('telephony_call_id', callControlId)
    .single()

  if (error || !call) {
    console.error(`[Cost] call.cost DB lookup failed for call_control_id=${callControlId}:`, error?.message ?? 'no row found')
    return
  }

  const costTotal = costTelephony + (call.cost_llm || 0) + (call.cost_stt || 0) + (call.cost_tts || 0)
  await supabase.from('calls')
    .update({ cost_telephony: costTelephony, cost_total: costTotal })
    .eq('telephony_call_id', callControlId)

  console.log(`[Cost] Telnyx telephony: $${costTelephony.toFixed(6)} — Final total: $${costTotal.toFixed(6)}`)
}
