// ─── Call Session Pipeline ────────────────────────────────────────────────────
// Orchestrates the full lifecycle of a single outbound call:
//   Audio in → Denoise → STT → Turn detection → LLM → TTS → Audio out
//
// ARCHITECTURE — layered, each component has one job:
//   1. Audio ingestion:  mulaw → linear16 PCM (once, at entry — never re-encoded)
//   2. Noise suppression: PCM in / PCM out (no codec inside)
//   3. STT (Deepgram Flux): transcript + StartOfTurn + EagerEndOfTurn + EndOfTurn
//   4. Barge-in manager:  generation counter + single signal (STT only, no energy VAD)
//   5. LLM stream:        AbortSignal — actually cancels on barge-in
//   6. TTS stream:        generation check on every chunk — stale audio dropped
//
// THE KEY MECHANISM — generation counter:
//   Every response cycle starts with `myGeneration = data.generation`.
//   fireBargeIn() does `data.generation++`.
//   Every async callback (onSentence, onChunk, marks) checks:
//     if (current.generation !== myGeneration) return  // stale — drop silently
//   This single pattern eliminates the race condition where an old LLM stream
//   speaks sentences into the new turn after bargedIn was reset to false.

import { createSTTStream }          from '../providers/stt'
import { streamTextToSpeech }       from '../providers/tts'
import { streamAgentResponse }      from '../providers/llm'
import { detectScenario, buildSystemPrompt } from './scenarios'
import { createCartesiaLineSession } from '../providers/cartesia-line'
import type { CartesiaLineSession }  from '../providers/cartesia-line'
import { supabase }                 from '../db/client'
import { loadSettings }             from '../db/settings'
import {
  initNoiseSuppression,
  createNoiseSuppressionState,
  destroyNoiseSuppressionState,
  denoiseAudioChunk,
} from '../providers/noise-suppression'
import { startRecording, stopRecording } from '../providers/recording'
import { logger }                   from '../utils/logger'
import type { PlatformSettings }    from '../db/settings'
import type { CallSession, TranscriptEntry } from '@voiceflow/shared'
import WebSocket                    from 'ws'

// Await WASM load at module startup — first call won't run without denoising
// (previously this was fire-and-forget which meant early calls had no denoising)
initNoiseSuppression()

// STT cost: Deepgram Nova-3 / Flux rate 2026 — $0.0077/min at mulaw 8kHz
const DEEPGRAM_STT_PER_BYTE = 0.0077 / 60 / 8000

// ─── mulaw → linear16 decoder ────────────────────────────────────────────────
// Converts Telnyx inbound audio (mulaw 8kHz) to linear16 PCM (Int16LE).
// Called ONCE per chunk in handleAudioChunk — all downstream modules (noise
// suppression, STT) receive PCM and never see mulaw again.
function mulawToLinear16(mulaw: Buffer): Buffer {
  const out = Buffer.alloc(mulaw.length * 2)
  for (let i = 0; i < mulaw.length; i++) {
    let b         = (~mulaw[i]) & 0xFF
    const sign    = b & 0x80
    const exp     = (b >> 4) & 0x07
    const mant    = b & 0x0F
    let s         = ((mant << 3) | 0x84) << exp
    s            -= 0x84
    if (sign) s   = -s
    s             = Math.max(-32768, Math.min(32767, s))
    out.writeInt16LE(s, i * 2)
  }
  return out
}

// ─── Backchannel detection ────────────────────────────────────────────────────
// Short acknowledgment sounds the prospect makes while the agent speaks.
// These are NOT interruptions — they must not trigger a full LLM response.
const BACKCHANNEL_WORDS = new Set([
  'yeah', 'yes', 'yep', 'yup', 'ya',
  'uh-huh', 'mm-hmm', 'mhm', 'mm', 'hmm', 'hm',
  'ok', 'okay', 'alright', 'right',
  'sure', 'got it', 'i see',
  'oh', 'ah', 'uh', 'um',
  'cool', 'great', 'fine',
])

function isBackchannelOnly(text: string): boolean {
  const words = text.toLowerCase().replace(/[.,!?]/g, '').trim().split(/\s+/).filter(Boolean)
  if (words.length === 0 || words.length > 4) return false
  return words.every(w => BACKCHANNEL_WORDS.has(w))
}

// ─── Text-layer AEC (Acoustic Echo Cancellation) ─────────────────────────────
// When the agent is speaking, the prospect's phone speaker plays the agent's
// voice. If the prospect is on speakerphone or has a poor handset, that audio
// is picked up by their mic and echoed back to us via Telnyx. RNNoise does not
// suppress this (it handles steady-state noise, not speech-frequency echo).
//
// Solution: compare the incoming STT transcript against the agent's current
// speech text. If >50% of the incoming words exist in the agent's text, treat
// it as echo and suppress. This requires no signal processing — pure text match.
function isEchoTranscript(incoming: string, agentText: string | null): boolean {
  if (!agentText) return false
  const inWords  = incoming.toLowerCase().replace(/[^a-z\s]/g, '').split(/\s+/).filter(Boolean)
  const agWords  = new Set(agentText.toLowerCase().replace(/[^a-z\s]/g, '').split(/\s+/).filter(Boolean))
  if (inWords.length === 0 || agWords.size === 0) return false
  const matchCount = inWords.filter(w => agWords.has(w)).length
  // >50% of incoming words found in agent text → echo
  return matchCount / inWords.length > 0.5
}

// ─── Session state ────────────────────────────────────────────────────────────
interface ActiveSession {
  session:             CallSession
  ws:                  WebSocket | null
  sttStream:           ReturnType<typeof createSTTStream> | null
  conversationHistory: Array<{ role: 'user' | 'assistant'; content: string }>
  platformSettings:    PlatformSettings | null

  // ── Generation counter — THE KEY MECHANISM ───────────────────────────────
  // Starts at 0. Incremented by fireBargeIn() on every interruption.
  // Every async operation captures `myGeneration = data.generation` at the
  // moment it starts, then checks `current.generation !== myGeneration` before
  // acting. A mismatch means a barge-in happened — silently drop and exit.
  // This prevents old LLM streams / TTS chunks from leaking into the new turn.
  generation: number

  // ── Active operation handles ─────────────────────────────────────────────
  // Both abort controllers are called together in fireBargeIn.
  // Keeping them separate lets each provider (LLM, TTS) clean up independently.
  llmAbortController: AbortController | null
  ttsAbortController: AbortController | null

  // ── Playback state ───────────────────────────────────────────────────────
  isSpeaking:        boolean           // true while Telnyx is playing agent audio
  pendingMarkIds:    Set<string>       // marks sent but not yet echoed by Telnyx
  telnyxStreamId:    string | null     // needed for the 'clear' command on barge-in
  currentSpeakingText: string | null   // text agent was saying — for false-barge-in recovery

  // ── False barge-in recovery ──────────────────────────────────────────────
  // If no transcript arrives within 2s after barge-in, it was noise.
  // Timer fires → agent resumes from currentSpeakingText (same generation).
  falseBargeInTimer: NodeJS.Timeout | null
  // ── AEC echo gate ────────────────────────────────────────────────────────
  // Set to true by onSpeechStarted when isSpeaking — instead of firing
  // fireBargeIn immediately we wait for the transcript and run isEchoTranscript.
  // Cleared in onTranscript: suppressed if echo, fires delayed barge-in if real.
  pendingEchoBargeIn: boolean

  // ── Turn state ───────────────────────────────────────────────────────────
  isProcessing:    boolean              // true while LLM+TTS pipeline is running
  isStarted:       boolean              // guard against double-start
  maxDurationTimer: NodeJS.Timeout | null
  // If a transcript arrives while isProcessing is true, save it here.
  // handleProspectSpeech picks it up in its finally block and processes it
  // after the current turn completes. Only the most recent transcript is kept —
  // if two arrive while processing, the older one is irrelevant.
  pendingTranscript: string | null

  // ── Speculative generation (EagerEndOfTurn) ──────────────────────────────
  // When Flux fires EagerEndOfTurn, we start the LLM speculatively.
  // If TurnResumed fires (user kept talking), abort the speculation.
  // If EndOfTurn confirms, we use the in-progress result.
  speculativeAbort: AbortController | null
  speculativeTranscript: string | null

  // ── Cost & telemetry ─────────────────────────────────────────────────────
  costLlm:              number
  costTts:              number
  sttAudioBytes:        number       // mulaw bytes sent to STT — for cost calculation
  latencyMeasurements:  number[]     // ms from STT final → first audio chunk per turn

  // ── Noise suppression ────────────────────────────────────────────────────
  denoisingSessionId: string         // per-call RNNoise state handle

  // ── Cartesia Line (pipeline_type === 'cartesia_line' only) ───────────────
  // Non-null when the agent delegates STT+LLM+TTS to Cartesia Line.
  // When set, handleAudioChunk routes audio here instead of the STT stream.
  cartesiaLineSession: CartesiaLineSession | null
}

export const activeSessions = new Map<string, ActiveSession>()

// ─── Session registration ─────────────────────────────────────────────────────
// Called by the dialer (engine.ts) before placing the Telnyx call.
// Creates the RNNoise state so it is ready before the first audio chunk arrives.
export function registerSession(callControlId: string, session: CallSession) {
  const denoisingSessionId = `ns_${callControlId}`
  createNoiseSuppressionState(denoisingSessionId)

  activeSessions.set(callControlId, {
    session,
    ws:                   null,
    sttStream:            null,
    conversationHistory:  [],
    platformSettings:     null,
    generation:           0,           // starts at 0 — first turn is generation 0
    llmAbortController:   null,
    ttsAbortController:   null,
    isSpeaking:           false,
    pendingMarkIds:       new Set(),
    telnyxStreamId:       null,
    currentSpeakingText:  null,
    falseBargeInTimer:    null,
    pendingEchoBargeIn:   false,
    isProcessing:         false,
    isStarted:            false,
    maxDurationTimer:     null,
    pendingTranscript:    null,
    speculativeAbort:     null,
    speculativeTranscript: null,
    cartesiaLineSession:  null,
    costLlm:              0,
    costTts:              0,
    sttAudioBytes:        0,
    latencyMeasurements:  [],
    denoisingSessionId,
  })
  console.log(`[Pipeline] Session registered: ${callControlId}`)
}

export function attachWebSocket(callControlId: string, ws: WebSocket, streamId?: string) {
  const d = activeSessions.get(callControlId)
  if (d) {
    d.ws             = ws
    d.telnyxStreamId = streamId || null
    console.log(`[Pipeline] WebSocket attached: ${callControlId} (stream_id: ${streamId ?? 'n/a'})`)
  }
}

// ─── Barge-in handler ─────────────────────────────────────────────────────────
// Single entry point — called ONLY by STT's onSpeechStarted (Flux StartOfTurn
// after the 250ms backchannel window). Energy VAD removed entirely.
//
// The generation counter is the core action here:
//   d.generation++  →  every in-flight LLM callback and TTS chunk checks this
//                       number and drops silently if it no longer matches.
// This replaces the old `bargedIn` boolean flag which had a race condition:
// `bargedIn` was reset to false at the start of the next turn, allowing old
// LLM streams to speak again after the reset.
function fireBargeIn(callControlId: string): void {
  const d = activeSessions.get(callControlId)
  // Fire on isSpeaking (audio playing) OR isProcessing (LLM generating).
  // Previously only guarded on isSpeaking — interruptions during LLM generation
  // were silently dropped, so the agent would speak over the prospect.
  if (!d || (!d.isSpeaking && !d.isProcessing)) return

  const prevGen = d.generation
  d.generation++   // ← THE KEY LINE — invalidates all in-flight operations
  console.log(`[Pipeline] Barge-in — generation ${prevGen} → ${d.generation} | ${callControlId}`)

  const textToRecover = d.currentSpeakingText

  // Cancel in-flight LLM stream (stops token generation immediately)
  d.llmAbortController?.abort()
  d.llmAbortController = null

  // Cancel in-flight TTS stream (stops audio fetch immediately)
  d.ttsAbortController?.abort()
  d.ttsAbortController = null

  // Cancel any speculative generation from EagerEndOfTurn
  d.speculativeAbort?.abort()
  d.speculativeAbort     = null
  d.speculativeTranscript = null

  // Reset playback and turn state
  d.isSpeaking   = false
  d.pendingMarkIds.clear()
  d.isProcessing = false

  // Clear Telnyx audio buffer — stops any buffered audio from playing
  if (d.ws?.readyState === WebSocket.OPEN) {
    d.ws!.send(JSON.stringify({ event: 'clear', stream_id: d.telnyxStreamId }))
    console.log('[Pipeline] Telnyx buffer cleared')
  }

  // ── False barge-in recovery ──────────────────────────────────────────────
  // If no transcript arrives within 2s, the interruption was noise (not speech).
  // Resume agent audio — but only if we are still in the same generation
  // (i.e., no further barge-in happened during the recovery window).
  if (textToRecover) {
    if (d.falseBargeInTimer) clearTimeout(d.falseBargeInTimer)
    const recoveryGeneration = d.generation  // capture — must still match when timer fires
    d.falseBargeInTimer = setTimeout(async () => {
      d.falseBargeInTimer = null
      const current = activeSessions.get(callControlId)
      if (!current)                                       return  // session ended
      if (current.generation !== recoveryGeneration)     return  // new barge-in happened
      if (current.isProcessing || current.isSpeaking)   return  // new turn already running
      console.log(`[Pipeline] False barge-in recovery — resuming: "${textToRecover}"`)
      await speakText(callControlId, textToRecover, recoveryGeneration)
    }, 2000)
  }
}

// ─── Session start ────────────────────────────────────────────────────────────
// Called from index.ts when Telnyx WebSocket fires the 'start' event.
// WebSocket is already attached at this point — greeting audio can be sent immediately.
export async function startSession(callControlId: string) {
  const data = activeSessions.get(callControlId)
  if (!data)          return console.error(`[Pipeline] No session for ${callControlId}`)
  if (data.isStarted) return console.warn(`[Pipeline] Already started: ${callControlId}`)
  data.isStarted = true

  const { session } = data

  // Load API keys and provider settings from DB
  const platformSettings = await loadSettings()
  data.platformSettings  = platformSettings

  // Start recording (fire-and-forget — URL arrives via call.recording.saved webhook)
  if (platformSettings.recording_enabled && platformSettings.telnyx_api_key) {
    startRecording(callControlId, platformSettings.telnyx_api_key)
      .then(() => supabase.from('calls').update({ recording_status: 'in_progress' }).eq('id', session.callId))
      .catch(err => logger.error('recording', `Failed to start recording: ${String(err)}`, { callId: session.callId }))
  }

  const { error: callUpdateErr } = await supabase.from('calls')
    .update({ status: 'in_progress', started_at: new Date().toISOString() })
    .eq('id', session.callId)
  if (callUpdateErr) logger.error('pipeline', `Supabase: failed to set call in_progress — ${callUpdateErr.message}`, { callId: session.callId })

  const { error: leadUpdateErr } = await supabase.from('leads')
    .update({ status: 'calling' })
    .eq('id', session.leadId)
  if (leadUpdateErr) logger.error('pipeline', `Supabase: failed to set lead calling — ${leadUpdateErr.message}`, { callId: session.callId })

  // Safety timer — force end after max duration to prevent runaway cost
  data.maxDurationTimer = setTimeout(
    () => endSession(callControlId, 'timeout'),
    session.maxDuration * 1000,
  )

  // Ensure WASM denoiser is loaded before the first audio chunk arrives.
  // initNoiseSuppression() is idempotent — resolves immediately if already done.
  // createNoiseSuppressionState is also idempotent — creates the per-call RNNoise
  // state now if WASM wasn't ready during registerSession (race at startup).
  await initNoiseSuppression()
  createNoiseSuppressionState(data.denoisingSessionId)

  // ── Cartesia Line branch ─────────────────────────────────────────────────
  // When pipeline_type === 'cartesia_line', delegate STT+LLM+TTS to Cartesia.
  // Audio routing in handleAudioChunk detects cartesiaLineSession and skips
  // the native STT path entirely. Everything else (endSession, DB writes,
  // cost webhooks, dialer) is untouched.
  if (session.agent.pipeline_type === 'cartesia_line') {
    console.log(`[Pipeline] Cartesia Line pipeline — callId: ${session.callId} | agentId: ${session.agent.cartesia_agent_id ?? 'NOT SET'}`)

    if (!session.agent.cartesia_agent_id) {
      logger.error('pipeline', 'Cartesia Line selected but cartesia_agent_id is not set on this agent — set it in the Agent settings page', { callId: session.callId })
      await endSession(callControlId, 'error')
      return
    }
    if (!platformSettings.cartesia_api_key) {
      logger.error('pipeline', 'Cartesia Line selected but cartesia_api_key is not configured — add it in Settings → API Keys', { callId: session.callId })
      await endSession(callControlId, 'error')
      return
    }

    data.cartesiaLineSession = createCartesiaLineSession({
      apiKey:   platformSettings.cartesia_api_key,
      agentId:  session.agent.cartesia_agent_id,
      callId:   session.callId,

      // Forward Cartesia's mulaw_8000 audio output directly to Telnyx
      onAudioChunk: (base64Audio) => {
        const current = activeSessions.get(callControlId)
        if (!current?.ws || current.ws.readyState !== WebSocket.OPEN) {
          logger.warn('pipeline', `[CartesiaLine] onAudioChunk — Telnyx WS not open | callId: ${session.callId}`)
          return
        }
        current.ws.send(JSON.stringify({ event: 'media', media: { payload: base64Audio } }))
      },

      // Agent was interrupted — clear Telnyx's audio buffer
      onClear: () => {
        const current = activeSessions.get(callControlId)
        if (!current?.ws || current.ws.readyState !== WebSocket.OPEN) return
        current.ws.send(JSON.stringify({ event: 'clear', stream_id: current.telnyxStreamId }))
        console.log(`[Pipeline] [CartesiaLine] Telnyx buffer cleared | callId: ${session.callId}`)
      },

      // Cartesia closed the connection (code 1000) — end the call cleanly
      onCallEnded: () => {
        console.log(`[Pipeline] [CartesiaLine] onCallEnded fired — ending session | callId: ${session.callId}`)
        endSession(callControlId, 'completed')
          .catch(err => logger.error('pipeline', `CartesiaLine onCallEnded error: ${err}`, { callId: session.callId }))
      },
    })

    console.log(`[Pipeline] Cartesia Line session started — callControlId: ${callControlId} | callId: ${session.callId}`)
    return  // ← native STT/LLM/TTS path is skipped entirely
  }

  // Provider selection: agent-level setting overrides global platform setting
  const sttProvider = (session.agent.active_stt || platformSettings.active_stt) as 'deepgram' | 'google'
  const sttModel    = session.agent.active_stt_model || platformSettings.active_stt_model

  data.sttStream = createSTTStream({
    provider: sttProvider,
    apiKey:   platformSettings.deepgram_api_key,
    model:    sttModel,

    // Final transcript — commit LLM response
    onTranscript: async (text, isFinal) => {
      if (!isFinal || text.length <= 3) return

      // Cancel any pending false barge-in recovery — real speech confirmed
      if (data.falseBargeInTimer) {
        clearTimeout(data.falseBargeInTimer)
        data.falseBargeInTimer = null
      }

      // AEC resolution: onSpeechStarted set pendingEchoBargeIn instead of firing
      // immediately. Now that we have the transcript, check if it is echo.
      if (data.pendingEchoBargeIn) {
        data.pendingEchoBargeIn = false
        if (isEchoTranscript(text, data.currentSpeakingText)) {
          console.log(`[Pipeline] AEC — echo suppressed: "${text}"`)
          return  // agent's own voice reflected back — discard entirely
        }
        // Real speech confirmed — fire delayed barge-in if agent is still active
        if (data.isSpeaking || data.isProcessing) {
          fireBargeIn(callControlId)
        }
      }

      await handleProspectSpeech(callControlId, text)
    },

    // Barge-in signal — single source of truth (STT only, no parallel energy VAD).
    // When the agent IS speaking we do NOT fire immediately: the prospect's phone
    // may echo the agent's own audio back (speakerphone, poor handset). Instead
    // we set pendingEchoBargeIn and resolve it in onTranscript above once we
    // have enough text to distinguish real speech from echo.
    onSpeechStarted: () => {
      if (data.isSpeaking) {
        data.pendingEchoBargeIn = true
        return
      }
      fireBargeIn(callControlId)
    },

    // EagerEndOfTurn — start LLM speculatively to reduce response latency
    onEagerEndOfTurn: (transcript) => {
      const d = activeSessions.get(callControlId)
      if (!d || d.isProcessing || d.isSpeaking) return
      // Only speculate if no current speculation is already running
      if (d.speculativeAbort) return
      console.log(`[Pipeline] EagerEndOfTurn — starting speculative LLM for: "${transcript}"`)
      d.speculativeTranscript = transcript
      d.speculativeAbort      = new AbortController()
      // Fire-and-forget speculation — handleProspectSpeech will use it if EndOfTurn confirms
      runSpeculativeLLM(callControlId, transcript, d.speculativeAbort.signal, d.generation)
        .catch(err => { if (err?.name !== 'AbortError') console.error('[Pipeline] Speculative LLM error:', err) })
    },

    // TurnResumed — user kept talking, cancel the speculative LLM
    onTurnResumed: () => {
      const d = activeSessions.get(callControlId)
      if (!d) return
      console.log('[Pipeline] TurnResumed — cancelling speculative LLM')
      d.speculativeAbort?.abort()
      d.speculativeAbort      = null
      d.speculativeTranscript = null
    },

    onError: (error) => logger.error('stt', `STT error: ${error.message}`, { callId: data.session.callId }),
  })

  // Brief 300ms pause before greeting — gives the prospect's initial "Hello?"
  // time to finish before the agent speaks. Without this, the greeting overlaps
  // the prospect's opening utterance and triggers an immediate false barge-in.
  await new Promise(resolve => setTimeout(resolve, 300))

  await speakText(callControlId, session.agent.greeting_message, data.generation)
  console.log(`[Pipeline] Session started: ${callControlId}`)
}

// ─── Audio ingestion ──────────────────────────────────────────────────────────
// Entry point for all inbound audio from Telnyx (mulaw 8kHz).
// FORMAT CONVERSION HAPPENS HERE — once, at the boundary.
// All downstream modules receive linear16 PCM and never touch mulaw.
export async function handleAudioChunk(callControlId: string, audioBuffer: Buffer) {
  const data = activeSessions.get(callControlId)
  if (!data) return

  // ── Cartesia Line path: forward raw mulaw directly — no conversion needed ──
  // Cartesia accepts mulaw_8000 natively (declared in the `start` event).
  if (data.cartesiaLineSession) {
    data.cartesiaLineSession.sendAudio(audioBuffer)
    return
  }

  if (!data.sttStream) return

  // 1. Convert mulaw → linear16 PCM (single conversion for the entire pipeline)
  const pcm = mulawToLinear16(audioBuffer)

  // 2. Denoise: PCM in → PCM out (no mulaw re-encoding inside noise suppression)
  const cleanPcm = denoiseAudioChunk(data.denoisingSessionId, pcm)

  // 3. Track STT cost (based on original mulaw bytes = audio duration)
  data.sttAudioBytes += audioBuffer.length

  // 4. Send clean PCM to STT — Deepgram Flux and Nova both accept linear16
  data.sttStream.sendAudio(cleanPcm)

  // NOTE: Energy VAD removed entirely.
  // Barge-in is now handled exclusively by STT's onSpeechStarted callback
  // (Flux StartOfTurn after 250ms backchannel window).
  // Reason: energy-based VAD has a 50% true positive rate at 5% false positive rate
  // (Picovoice 2025 benchmark). Running it in parallel with STT caused double-
  // triggering and unstable state. A single, well-filtered STT signal is more reliable.
}

// ─── Speculative LLM (EagerEndOfTurn) ────────────────────────────────────────
// Starts generating the LLM response before EndOfTurn confirms the turn end.
// Results are stored and reused by handleProspectSpeech if EndOfTurn arrives
// with the same transcript. If TurnResumed fires first, the abort signal kills it.
// This saves 150–250ms of LLM TTFT per turn.
const speculativeResults = new Map<string, { text: string; sentences: string[]; costUsd: number }>()

async function runSpeculativeLLM(
  callControlId: string,
  transcript: string,
  signal: AbortSignal,
  generation: number,
): Promise<void> {
  const data = activeSessions.get(callControlId)
  if (!data?.platformSettings) return

  const { session, conversationHistory, platformSettings } = data
  const llmProvider = (session.agent.active_llm || platformSettings.active_llm) as 'anthropic' | 'openai' | 'deepseek'
  const llmApiKey   = llmProvider === 'openai' ? platformSettings.openai_api_key : (llmProvider === 'deepseek' ? platformSettings.deepseek_api_key : platformSettings.anthropic_api_key)
  let llmModel      = session.agent.active_llm_model || platformSettings.active_llm_model

  // Auto-correct mismatched default models if provider is changed
  if (llmProvider === 'deepseek' && !llmModel.includes('deepseek')) llmModel = 'deepseek-chat'
  if (llmProvider === 'anthropic' && !llmModel.includes('claude'))  llmModel = 'claude-haiku-4-5'
  if (llmProvider === 'openai' && !llmModel.includes('gpt'))        llmModel = 'gpt-4o-mini'

  const sentences: string[] = []
  let fullText = ''

  const result = await streamAgentResponse({
    provider: llmProvider,
    apiKey:   llmApiKey,
    model:    llmModel,
    systemPrompt: buildSystemPrompt(session.agent.system_prompt, {
      businessName: session.lead.business_name,
      industry:     session.lead.industry,
      city:         session.lead.city || undefined,
    }),
    conversationHistory,
    userMessage:  transcript,
    abortSignal:  signal,
    onSentence: async (sentence) => {
      if (signal.aborted) return
      sentences.push(sentence)
      fullText += (fullText ? ' ' : '') + sentence
    },
  })

  if (!signal.aborted) {
    // Store costUsd with the result so handleProspectSpeech can add it to costLlm
    // when consuming the speculative result (previously cost was never tracked here)
    speculativeResults.set(`${callControlId}:${generation}`, { text: fullText, sentences, costUsd: result.costUsd })
    console.log(`[Pipeline] Speculative LLM complete — ${sentences.length} sentences ready`)
  }
}

// ─── Prospect speech handler ──────────────────────────────────────────────────
// Called by STT's onTranscript when EndOfTurn fires.
// Captures the current generation at entry — every async operation below checks
// this number before acting. If generation changed (barge-in happened), the
// operation drops silently and the function exits cleanly.
async function handleProspectSpeech(callControlId: string, transcript: string) {
  const data = activeSessions.get(callControlId)
  if (!data) return

  // Backchannel filter removed — the LLM knows the conversation history and
  // handles short responses ("yes", "okay", "uh-huh") correctly in context.
  // Filtering here caused "Yes." to be dropped when the prospect answered a
  // direct yes/no question, killing the qualifying turn entirely.
  // The STT-level backchannel filter in stt.ts remains — that one only prevents
  // false barge-in signals, which is a different concern.

  // If we're already processing a turn, queue this transcript.
  // The finally block will pick it up once the current turn completes.
  // Only the most recent transcript is kept — older ones are irrelevant.
  if (data.isProcessing) {
    data.pendingTranscript = transcript
    console.log(`[Pipeline] Queued transcript (processing): "${transcript}"`)
    return
  }

  // Clear any stale queued transcript — we are processing a fresh one
  data.pendingTranscript = null
  data.isProcessing  = true
  const myGeneration = data.generation   // ← captured here, checked everywhere below
  const turnStart    = Date.now()
  let firstChunkSent = false

  const onFirstChunk = () => {
    if (firstChunkSent) return
    firstChunkSent = true
    const latency = Date.now() - turnStart
    data.latencyMeasurements.push(latency)
    console.log(`[Latency] ${latency}ms (gen ${myGeneration})`)
  }

  try {
    const { session, conversationHistory, platformSettings } = data
    if (!platformSettings) return

    session.transcript.push({ role: 'prospect', text: transcript, timestamp: new Date().toISOString() })
    console.log(`[Pipeline] Prospect (gen ${myGeneration}): "${transcript}"`)

    const scenario   = detectScenario(transcript)
    let responseText = ''

    // Hard exit: voicemail — never speak to a machine
    if (scenario === 'voicemail') {
      await endSession(callControlId, 'voicemail')
      return
    }

    // Hard exit: legal/compliance — must not be argued with
    if (scenario === 'not_interested') {
      responseText = session.agent.not_interested_message
      await speakText(callControlId, responseText, myGeneration, onFirstChunk)
      setTimeout(() => endSession(callControlId, 'not_interested'), 4000)
      return
    }

    // Everything else → LLM.
    // Wrong person, callback requests, objections, questions, interest signals —
    // all handled by the LLM. Keyword matching cannot understand context and
    // was the root cause of the agent ignoring what the prospect actually said.
    {
      const llmProvider = (session.agent.active_llm || platformSettings.active_llm) as 'anthropic' | 'openai' | 'deepseek'
      let llmModel      = session.agent.active_llm_model || platformSettings.active_llm_model
      const llmApiKey   = llmProvider === 'openai' ? platformSettings.openai_api_key : (llmProvider === 'deepseek' ? platformSettings.deepseek_api_key : platformSettings.anthropic_api_key)

      if (llmProvider === 'deepseek' && !llmModel.includes('deepseek')) llmModel = 'deepseek-chat'
      if (llmProvider === 'anthropic' && !llmModel.includes('claude'))  llmModel = 'claude-haiku-4-5'
      if (llmProvider === 'openai' && !llmModel.includes('gpt'))        llmModel = 'gpt-4o-mini'

      // Check if a speculative result is ready from EagerEndOfTurn
      const speculativeKey    = `${callControlId}:${myGeneration}`
      const speculativeResult = speculativeResults.get(speculativeKey)
      speculativeResults.delete(speculativeKey)

      // Clean up any still-running speculative LLM for this turn
      if (data.speculativeAbort && data.speculativeTranscript === transcript) {
        // Let it finish — we'll use the result
      } else if (data.speculativeAbort) {
        // Different transcript from speculation — abort it
        data.speculativeAbort.abort()
        data.speculativeAbort      = null
        data.speculativeTranscript = null
      }

      try {
        if (speculativeResult) {
          // ── Fast path: speculative result ready — speak sentences immediately ──
          console.log(`[Pipeline] Using speculative result (${speculativeResult.sentences.length} sentences)`)
          for (const sentence of speculativeResult.sentences) {
            const current = activeSessions.get(callControlId)
            if (!current || current.generation !== myGeneration) break
            await speakText(callControlId, sentence, myGeneration, onFirstChunk)
          }
          responseText   = speculativeResult.text
          data.costLlm  += speculativeResult.costUsd

          data.speculativeAbort      = null
          data.speculativeTranscript = null

        } else {
          // ── Normal path: stream LLM tokens → TTS sentence by sentence ──────
          const llmAbort          = new AbortController()
          data.llmAbortController = llmAbort

          const result = await streamAgentResponse({
            provider:    llmProvider,
            apiKey:      llmApiKey,
            model:       llmModel,
            systemPrompt: buildSystemPrompt(session.agent.system_prompt, {
              businessName: session.lead.business_name,
              industry:     session.lead.industry,
              city:         session.lead.city || undefined,
            }),
            conversationHistory,
            userMessage: transcript,
            abortSignal: llmAbort.signal,

            onSentence: async (sentence) => {
              const current = activeSessions.get(callControlId)
              if (!current || current.generation !== myGeneration) return
              await speakText(callControlId, sentence, myGeneration, onFirstChunk)
            },
          })

          if (data.generation === myGeneration) {
            responseText            = result.text
            data.costLlm           += result.costUsd
            data.llmAbortController = null
          }
        }

      } catch (llmErr: any) {
        if (llmErr?.name === 'AbortError') return  // barge-in — clean exit
        logger.error('pipeline', `LLM error: ${llmErr}`, { callId: session.callId })
        if (data.generation === myGeneration) {
          responseText = "Could you repeat that? I did not quite catch it."
          await speakText(callControlId, responseText, myGeneration)
        }
      }
    }

    // Update conversation history — only if still the current generation
    if (data.generation === myGeneration && responseText) {
      conversationHistory.push({ role: 'user',      content: transcript    })
      conversationHistory.push({ role: 'assistant', content: responseText  })
      if (conversationHistory.length > 20) {
        data.conversationHistory = conversationHistory.slice(-20)
      }
      session.transcript.push({ role: 'agent', text: responseText, timestamp: new Date().toISOString() })
      console.log(`[Pipeline] Agent (gen ${myGeneration}): "${responseText}"`)
    }

  } catch (err) {
    logger.error('pipeline', `Speech handling error: ${err}`, { callId: data.session?.callId })
  } finally {
    // Only release isProcessing if we're still the current generation.
    // If a barge-in happened, fireBargeIn already cleared isProcessing.
    const current = activeSessions.get(callControlId)
    if (current && current.generation === myGeneration) {
      current.isProcessing = false

      // Drain the transcript queue — if a message arrived while we were busy,
      // process it now. Generation check inside handleProspectSpeech keeps it safe.
      if (current.pendingTranscript) {
        const queued = current.pendingTranscript
        current.pendingTranscript = null
        console.log(`[Pipeline] Processing queued transcript: "${queued}"`)
        // Call without await so the finally block completes first
        setImmediate(() => handleProspectSpeech(callControlId, queued))
      }
    }
  }
}

// ─── Audio output ─────────────────────────────────────────────────────────────
// Streams TTS audio to Telnyx for a single text block.
// Generation is checked:
//   1. Before starting (don't begin stale speech)
//   2. On every audio chunk (drop stale chunks mid-stream)
//   3. Before sending the mark (don't track playback for stale audio)
async function speakText(
  callControlId: string,
  text: string,
  myGeneration: number,
  onFirstChunk?: () => void,
): Promise<void> {
  const data = activeSessions.get(callControlId)
  if (!data) return

  // Drop immediately if a barge-in already superseded this generation
  if (data.generation !== myGeneration) return

  const { platformSettings, ws } = data
  if (!platformSettings || !ws || ws.readyState !== WebSocket.OPEN) return

  // Track what the agent is saying — used by false barge-in recovery
  data.currentSpeakingText = text

  const ttsProvider = (data.session.agent.active_tts || platformSettings.active_tts) as 'elevenlabs' | 'deepgram' | 'cartesia'
  const ttsApiKey   = ttsProvider === 'elevenlabs' ? platformSettings.elevenlabs_api_key
                    : ttsProvider === 'cartesia'   ? platformSettings.cartesia_api_key
                    : platformSettings.deepgram_api_key
  const ttsVoiceId  = ttsProvider === 'elevenlabs' ? platformSettings.elevenlabs_voice_id
                    : ttsProvider === 'cartesia'   ? platformSettings.cartesia_voice_id
                    : undefined

  const ttsAbort  = new AbortController()
  data.ttsAbortController = ttsAbort

  const markId = `tts_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`
  data.pendingMarkIds.add(markId)
  data.isSpeaking = true

  try {
    const cost = await streamTextToSpeech({
      provider:      ttsProvider,
      apiKey:        ttsApiKey,
      voiceId:       ttsVoiceId,
      text,
      abortSignal:   ttsAbort.signal,
      fallbackApiKey: ttsProvider === 'elevenlabs' ? platformSettings.deepgram_api_key : undefined,

      onChunk: (base64Audio) => {
        // Generation check on every single chunk — stale audio is never sent
        const current = activeSessions.get(callControlId)
        if (!current || current.generation !== myGeneration) return

        onFirstChunk?.()
        if (current.ws?.readyState === WebSocket.OPEN) {
          current.ws!.send(JSON.stringify({ event: 'media', media: { payload: base64Audio } }))
        }
      },
    })

    // Only record cost and send mark if still current generation
    const current = activeSessions.get(callControlId)
    if (current && current.generation === myGeneration) {
      current.costTts += cost
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ event: 'mark', stream_id: data.telnyxStreamId, mark: { name: markId } }))
      }
    } else {
      // Stale — remove mark so isSpeaking can clear correctly
      data.pendingMarkIds.delete(markId)
      if (data.pendingMarkIds.size === 0) data.isSpeaking = false
    }

  } catch (err: any) {
    if (err?.name === 'AbortError') return  // barge-in — clean exit, no error

    const msg = err instanceof Error ? err.message : String(err)
    logger.error('tts', `TTS failed: ${msg}`, { callId: data.session?.callId })
    data.pendingMarkIds.delete(markId)
    if (data.pendingMarkIds.size === 0) data.isSpeaking = false
    endSession(callControlId, 'error')

  } finally {
    if (data.ttsAbortController === ttsAbort) data.ttsAbortController = null
  }
}

// ─── Telnyx mark handler ──────────────────────────────────────────────────────
// Telnyx echoes a mark back when all audio before it has finished playing.
// This is the only reliable signal that the prospect can now hear silence.
// isSpeaking stays true until the last pending mark returns.
export function onTelnyxMark(callControlId: string, markName: string) {
  const d = activeSessions.get(callControlId)
  if (!d) return

  if (d.pendingMarkIds.has(markName)) {
    d.pendingMarkIds.delete(markName)
    if (d.pendingMarkIds.size === 0) {
      d.isSpeaking         = false
      d.currentSpeakingText = null   // fully played — no recovery needed
      console.log(`[Pipeline] Playback complete — last mark: ${markName}`)
    }
  }
}

// ─── Session teardown ─────────────────────────────────────────────────────────
// Handles all cleanup: STT, noise suppression, timers, DB updates, retry scheduling.
// Exported for use by index.ts webhook handlers and the max-duration timer.
export async function endSession(callControlId: string, outcome: string) {
  const data = activeSessions.get(callControlId)
  if (!data) return

  // Remove first — prevents concurrent endSession calls (hangup + WS close + stop)
  activeSessions.delete(callControlId)
  console.log(`[Pipeline] Ending ${callControlId} — outcome: ${outcome}`)

  const { session, sttStream, maxDurationTimer } = data

  // Abort any in-flight operations
  data.llmAbortController?.abort()
  data.ttsAbortController?.abort()
  data.speculativeAbort?.abort()

  // Remove any unused speculative results for this session.
  // These accumulate when EndOfTurn fires a non-default scenario (voicemail,
  // not_interested, etc.) and the default LLM path never runs to consume them.
  for (const key of speculativeResults.keys()) {
    if (key.startsWith(`${callControlId}:`)) speculativeResults.delete(key)
  }

  // Stop recording (fire-and-forget — Telnyx finalises and sends webhook)
  if (data.platformSettings?.recording_enabled && data.platformSettings.telnyx_api_key) {
    stopRecording(callControlId, data.platformSettings.telnyx_api_key)
      .catch(err => logger.error('recording', `stopRecording error: ${String(err)}`, { callId: session?.callId }))
  }

  if (maxDurationTimer)          clearTimeout(maxDurationTimer)
  if (data.falseBargeInTimer)    clearTimeout(data.falseBargeInTimer)
  if (sttStream)                 sttStream.close()
  if (data.cartesiaLineSession)  data.cartesiaLineSession.close()
  destroyNoiseSuppressionState(data.denoisingSessionId)

  const durationSeconds = Math.floor(
    (Date.now() - new Date(session.startTime).getTime()) / 1000,
  )

  const costStt   = data.sttAudioBytes * DEEPGRAM_STT_PER_BYTE
  const costTotal = data.costLlm + data.costTts + costStt

  console.log(
    `[Cost] ${callControlId} — LLM: $${data.costLlm.toFixed(6)} | TTS: $${data.costTts.toFixed(6)} | STT: $${costStt.toFixed(6)} | Total: $${costTotal.toFixed(6)}`,
  )

  if (data.latencyMeasurements.length > 0) {
    const avg = Math.round(data.latencyMeasurements.reduce((a, b) => a + b, 0) / data.latencyMeasurements.length)
    const min = Math.min(...data.latencyMeasurements)
    const max = Math.max(...data.latencyMeasurements)
    console.log(`[Latency] avg: ${avg}ms | min: ${min}ms | max: ${max}ms | turns: ${data.latencyMeasurements.length}`)
  }

  const leadStatus =
    outcome === 'interested'       ? 'interested'     :
    outcome === 'not_interested'   ? 'not_interested'  :
    outcome === 'callback_request' ? 'callback'        :
    outcome === 'wrong_person'     ? 'wrong_person'    :
    outcome === 'voicemail'        ? 'voicemail'       : 'no_answer'

  const [callFinalRes, leadFinalRes] = await Promise.all([
    supabase.from('calls').update({
      status:           'completed',
      outcome,
      duration_seconds: durationSeconds,
      transcript:       session.transcript,
      ended_at:         new Date().toISOString(),
      cost_llm:         data.costLlm,
      cost_tts:         data.costTts,
      cost_stt:         costStt,
      cost_total:       costTotal,
    }).eq('id', session.callId),

    supabase.from('leads')
      .update({ status: leadStatus })
      .eq('id', session.leadId),
  ])

  if (callFinalRes.error) logger.error('pipeline', `Supabase: failed to finalise call record — ${callFinalRes.error.message}`, { callId: session.callId })
  if (leadFinalRes.error) logger.error('pipeline', `Supabase: failed to finalise lead status — ${leadFinalRes.error.message}`, { callId: session.callId })

  if (session.campaignId) {
    await scheduleRetryIfNeeded(session.leadId, session.campaignId, outcome)
      .catch(err => console.error('[Dialer] Retry scheduling error:', err))
  }

  console.log(`[Pipeline] Cleaned up: ${callControlId}`)
}

// ─── Telephony cost update ────────────────────────────────────────────────────
// Called from index.ts when Telnyx sends the call.cost webhook.
export async function updateTelephonyCost(callControlId: string, costTelephony: number) {
  const { data: call, error } = await supabase
    .from('calls')
    .select('cost_llm, cost_stt, cost_tts')
    .eq('telephony_call_id', callControlId)
    .single()

  if (error || !call) {
    console.error(`[Cost] Lookup failed for ${callControlId}:`, error?.message ?? 'no row')
    return
  }

  const costTotal = costTelephony + (call.cost_llm || 0) + (call.cost_stt || 0) + (call.cost_tts || 0)
  await supabase.from('calls')
    .update({ cost_telephony: costTelephony, cost_total: costTotal })
    .eq('telephony_call_id', callControlId)

  console.log(`[Cost] Telephony: $${costTelephony.toFixed(6)} — Final total: $${costTotal.toFixed(6)}`)
}

// ─── Campaign retry scheduling ────────────────────────────────────────────────
// After a call ends: if the outcome matches the campaign's retry list AND
// retries remain, reset the lead to 'pending' with scheduled_after in the future.
// The dialer picks it up automatically when the window opens.
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
  if (!retryOutcomes.includes(outcome))                    return
  if ((lead.retry_count ?? 0) >= campaign.retry_attempts) return

  const newRetryCount  = (lead.retry_count ?? 0) + 1
  const scheduledAfter = new Date(Date.now() + campaign.retry_delay_minutes * 60_000)

  await supabase.from('leads').update({
    status:          'pending',
    retry_count:     newRetryCount,
    scheduled_after: scheduledAfter.toISOString(),
  }).eq('id', leadId)

  console.log(`[Dialer] Retry ${newRetryCount}/${campaign.retry_attempts} scheduled for lead ${leadId} at ${scheduledAfter.toISOString()}`)
}
