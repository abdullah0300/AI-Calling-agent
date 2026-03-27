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
import { startRecording, stopRecording } from '../providers/recording'
import { logger } from '../utils/logger'
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
// After RNNoise denoising, audio reaching this VAD is already cleaned.
// Threshold raised from 600 → 2000: on a denoised signal, real speech from the
// prospect sits at 1500-5000 RMS while residual noise stays below 1000.
// Min duration raised from 150ms → 500ms: matches LiveKit/BytePlus industry
// standard — filters coughs, door slams, and short background bursts that a
// denoiser can't fully eliminate.
const BARGE_IN_ENERGY_THRESHOLD = 2000  // RMS of decoded linear16 — above this = likely speech
const BARGE_IN_MIN_SPEECH_MS    = 500   // ms of sustained speech before triggering barge-in

// ─── Backchannel detection ────────────────────────────────────────────────────
// Backchannel utterances ("yeah", "uh-huh", "okay") are acknowledgment sounds
// the prospect makes WHILE the agent is speaking. They are NOT interruptions and
// should NOT trigger a full LLM response. This list covers the most common ones.
const BACKCHANNEL_WORDS = new Set([
  'yeah', 'yes', 'yep', 'yup', 'ya',
  'uh-huh', 'mm-hmm', 'mhm', 'mm', 'hmm', 'hm',
  'ok', 'okay',
  'alright', 'alright.', 'right',
  'sure', 'got it',
  'i see', 'oh', 'ah',
  'uh', 'um',
  'cool', 'great', 'fine',
])

// Returns true when every word in text is a backchannel acknowledgment.
// Used to ignore filler responses that don't warrant an agent reply.
function isBackchannelOnly(text: string): boolean {
  const words = text.toLowerCase().replace(/[.,!?]/g, '').trim().split(/\s+/).filter(Boolean)
  if (words.length === 0 || words.length > 4) return false  // >4 words = real speech
  return words.every(w => BACKCHANNEL_WORDS.has(w))
}

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
  // False interruption recovery (Item 3):
  // Stores the text the agent was speaking when barge-in fired so we can resume
  // if no real transcript arrives within the recovery window.
  currentSpeakingText: string | null
  // Timer ID for the false barge-in recovery window (2.5s).
  // Cancelled immediately when a real transcript arrives in handleProspectSpeech.
  // Fires speakToProspect with currentSpeakingText if the window expires without a transcript.
  falseBargeInTimer: NodeJS.Timeout | null
  // Barge-in event logging (Item 6):
  // DB row ID of the most recent barge-in event that hasn't been resolved yet.
  // Set asynchronously after fireBargeIn inserts the row; cleared when the
  // outcome is determined (real or false) and the row is updated.
  pendingBargeInEventId: string | null
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
    currentSpeakingText: null, falseBargeInTimer: null, pendingBargeInEventId: null,
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
// Starts a 2.5s false-barge-in recovery timer: if no real transcript arrives within
// that window (meaning the barge-in was triggered by noise, not actual speech),
// the agent resumes speaking from where it left off.
// Every firing inserts a row into barge_in_events; the outcome is resolved later.
function fireBargeIn(callControlId: string, source: 'vad' | 'stt'): void {
  const d = activeSessions.get(callControlId)
  if (!d || !d.isSpeaking) return
  console.log(`[Pipeline] Barge-in detected (${source}) — aborting TTS ${callControlId}`)

  // Snapshot what the agent was saying so we can recover if it was a false barge-in
  const textToRecover = d.currentSpeakingText

  d.bargedIn = true
  d.currentTtsAbort?.abort()
  d.currentTtsAbort = null
  d.isSpeaking = false
  d.pendingMarkIds.clear()
  d.vadSpeechMs = 0
  d.isProcessing = false  // allow new speech turn to start immediately
  d.pendingBargeInEventId = null  // reset — will be set once insert resolves

  if (d.ws && d.ws.readyState === d.ws.OPEN) {
    d.ws.send(JSON.stringify({ event: 'clear', stream_id: d.telnyxStreamId }))
    console.log(`[Pipeline] Telnyx audio buffer cleared (barge-in)`)
  }

  // Log the barge-in event to DB — fire-and-forget, non-blocking.
  // The outcome starts as 'pending' and is resolved to 'real' or 'false' below.
  void Promise.resolve(
    supabase.from('barge_in_events').insert({
      call_id:    d.session.callId,
      fired_at:   new Date().toISOString(),
      agent_text: textToRecover,
      trigger:    source,
      outcome:    'pending',
    }).select('id').single()
  ).then(({ data, error }) => {
    if (error) { console.error('[BargeIn] DB log insert failed:', error.message); return }
    const current = activeSessions.get(callControlId)
    if (current && data) current.pendingBargeInEventId = data.id
  }, err => console.error('[BargeIn] DB log insert error:', err))

  // False barge-in recovery: if no transcript arrives within 2.5s, the interruption
  // was caused by noise (not real speech) — resume agent audio from the saved text.
  if (textToRecover) {
    if (d.falseBargeInTimer) clearTimeout(d.falseBargeInTimer)
    d.falseBargeInTimer = setTimeout(async () => {
      d.falseBargeInTimer = null
      const current = activeSessions.get(callControlId)
      // Only recover if the session still exists, nothing new is processing or speaking,
      // and the agent hasn't already started a new turn via a real transcript.
      if (!current || current.isProcessing || current.isSpeaking) return
      console.log(`[Pipeline] False barge-in recovery — no transcript in 2.5s, resuming: "${textToRecover}"`)
      current.bargedIn = false

      // Resolve the barge-in event as 'false' — noise triggered it, not real speech
      if (current.pendingBargeInEventId) {
        const eventId = current.pendingBargeInEventId
        current.pendingBargeInEventId = null
        void Promise.resolve(
          supabase.from('barge_in_events').update({ outcome: 'false', resolved_at: new Date().toISOString() }).eq('id', eventId)
        ).then(null, err => console.error('[BargeIn] DB false-outcome update failed:', err))
      }

      await speakToProspect(callControlId, textToRecover)
    }, 2500)
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

  // Start call recording if enabled — fire-and-forget, non-blocking.
  // The recording URL is delivered later via the call.recording.saved webhook.
  if (platformSettings.recording_enabled && platformSettings.telnyx_api_key) {
    startRecording(callControlId, platformSettings.telnyx_api_key)
      .then(() => {
        console.log(`[Recording] Started dual-channel recording for ${callControlId}`)
        return supabase.from('calls')
          .update({ recording_status: 'in_progress' })
          .eq('id', session.callId)
      })
      .catch(err => logger.error('recording', `Failed to start recording: ${String(err)}`, { callId: session.callId }))
  }

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
    onError: (error) => logger.error('stt', `STT error: ${error.message}`, { callId: data.session.callId }),
    // STT-based barge-in: Deepgram fires SpeechStarted (Nova-2) or StartOfTurn (Flux)
    // when it detects the prospect starting to speak. We also run a parallel local VAD
    // in handleAudioChunk for faster (~80ms) detection independent of the STT model.
    onSpeechStarted: () => fireBargeIn(callControlId, 'stt'),
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
        fireBargeIn(callControlId, 'vad')
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

  // Backchannel filter: "yeah", "uh-huh", "okay" etc. while agent is speaking
  // are acknowledgments, not real turns. Skip LLM entirely — no response needed.
  if (isBackchannelOnly(transcript)) {
    console.log(`[Pipeline] Backchannel ignored: "${transcript}"`)
    return
  }

  // Real transcript arrived — cancel any pending false barge-in recovery timer.
  // The barge-in was genuine; the agent should not resume its previous speech.
  if (data.falseBargeInTimer) {
    clearTimeout(data.falseBargeInTimer)
    data.falseBargeInTimer = null
  }

  // Resolve the pending barge-in event as 'real' — a genuine transcript confirms
  // the barge-in was not a false positive. Store the transcript for later analysis.
  if (data.pendingBargeInEventId) {
    const eventId = data.pendingBargeInEventId
    data.pendingBargeInEventId = null
    void Promise.resolve(
      supabase.from('barge_in_events').update({ outcome: 'real', transcript, resolved_at: new Date().toISOString() }).eq('id', eventId)
    ).then(null, err => console.error('[BargeIn] DB real-outcome update failed:', err))
  }

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

              // Track per-sentence so false barge-in recovery re-speaks the interrupted sentence.
              current.currentSpeakingText = sentence

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
                  // Fallback: if ElevenLabs returns 402/429/5xx, automatically
                  // serve this sentence (and the rest of the call) via Deepgram Aura.
                  fallbackApiKey: ttsProvider === 'elevenlabs' ? platformSettings.deepgram_api_key : undefined,
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
                  logger.error('tts', `TTS stream error: ${ttsErr}`, { callId: data?.session?.callId })
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
          logger.error('pipeline', `LLM error: ${llmError}`, { callId: session.callId })
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
    logger.error('pipeline', `Speech handling error: ${error}`, { callId: activeSessions.get(callControlId)?.session?.callId })
  } finally {
    data.isProcessing = false
  }
}

async function speakToProspect(callControlId: string, text: string, onFirstChunk?: () => void) {
  const data = activeSessions.get(callControlId)
  if (!data) return

  const { session, ws, platformSettings } = data
  if (!platformSettings) return

  // Track what the agent is saying so fireBargeIn can recover if it was a false interrupt.
  data.currentSpeakingText = text

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
      // Fallback: if ElevenLabs returns 402/429/5xx, automatically serve via Deepgram Aura.
      fallbackApiKey: ttsProvider === 'elevenlabs' ? platformSettings.deepgram_api_key : undefined,
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
    logger.error('tts', `TTS failed — ending call: ${msg}`, { callId: data.session?.callId })
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

  // Stop recording (fire-and-forget) — Telnyx finalises the file and sends
  // call.recording.saved webhook with the download URL. 422/404 are safe to ignore.
  if (data.platformSettings?.recording_enabled && data.platformSettings.telnyx_api_key) {
    stopRecording(callControlId, data.platformSettings.telnyx_api_key)
      .catch(err => logger.error('recording', `stopRecording error: ${String(err)}`, { callId: data.session?.callId }))
  }

  if (maxDurationTimer) clearTimeout(maxDurationTimer)
  if (data.falseBargeInTimer) clearTimeout(data.falseBargeInTimer)
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

  // Batch dialer retry: if this call was part of a campaign and the outcome is
  // retry-eligible (e.g. no_answer), reset the lead to 'pending' with a
  // scheduled_after timestamp so the dialer picks it up again after the delay.
  if (session.campaignId) {
    await scheduleRetryIfNeeded(session.leadId, session.campaignId, outcome)
      .catch(err => console.error('[Dialer] Retry scheduling error:', err))
  }

  console.log(`[Pipeline] Session cleaned up: ${callControlId}`)
}

// ─── Batch dialer retry scheduling ───────────────────────────────────────────
// Called after every campaign call ends. If the outcome matches the campaign's
// retry_outcomes list AND retries remain, reset the lead to 'pending' with
// scheduled_after set to now + retry_delay_minutes.
// The dialer loop skips leads where scheduled_after > now, so the retry
// happens automatically at the right time without any polling overhead.
async function scheduleRetryIfNeeded(leadId: string, campaignId: string, outcome: string): Promise<void> {
  const [{ data: campaign }, { data: lead }] = await Promise.all([
    supabase.from('campaigns')
      .select('retry_attempts, retry_delay_minutes, retry_outcomes')
      .eq('id', campaignId)
      .maybeSingle(),
    supabase.from('leads')
      .select('retry_count')
      .eq('id', leadId)
      .maybeSingle(),
  ])

  if (!campaign || !lead) return

  const retryOutcomes: string[] = campaign.retry_outcomes ?? ['no_answer']
  if (!retryOutcomes.includes(outcome)) return              // terminal outcome — no retry
  if ((lead.retry_count ?? 0) >= campaign.retry_attempts) return  // retries exhausted

  const newRetryCount  = (lead.retry_count ?? 0) + 1
  const scheduledAfter = new Date(Date.now() + campaign.retry_delay_minutes * 60_000)

  await supabase.from('leads').update({
    status:          'pending',
    retry_count:     newRetryCount,
    scheduled_after: scheduledAfter.toISOString(),
  }).eq('id', leadId)

  console.log(`[Dialer] Retry ${newRetryCount}/${campaign.retry_attempts} scheduled for lead ${leadId} at ${scheduledAfter.toISOString()} (outcome: ${outcome})`)
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
      d.currentSpeakingText = null  // audio fully played — no recovery needed anymore
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
