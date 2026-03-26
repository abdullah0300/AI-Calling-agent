import { createSTTStream } from '../providers/stt'
import { streamTextToSpeech } from '../providers/tts'
import { streamAgentResponse } from '../providers/llm'
import { detectScenario, buildSystemPrompt } from './scenarios'
import { supabase } from '../db/client'
import { loadSettings } from '../db/settings'
import type { PlatformSettings } from '../db/settings'
import type { CallSession, TranscriptEntry } from '@voiceflow/shared'
import type WebSocket from 'ws'

// Deepgram Nova-3 streaming rate (2026): $0.0077 / min
// (source: deepgram.com/pricing)
const DEEPGRAM_STT_PER_BYTE = 0.0077 / 60 / 8000  // $0.0077/min ÷ 60s ÷ 8000 bytes/s (mulaw 8kHz)

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
}

export const activeSessions = new Map<string, ActiveSession>()

export function registerSession(callControlId: string, session: CallSession) {
  activeSessions.set(callControlId, {
    session, ws: null, sttStream: null,
    conversationHistory: [], isProcessing: false, isStarted: false, maxDurationTimer: null,
    costLlm: 0, costTts: 0, sttAudioBytes: 0, latencyMeasurements: [], platformSettings: null,
    isSpeaking: false, currentTtsAbort: null, bargedIn: false,
  })
  console.log(`[Pipeline] Session registered: ${callControlId}`)
}

export function attachWebSocket(callControlId: string, ws: WebSocket) {
  const data = activeSessions.get(callControlId)
  if (data) {
    data.ws = ws
    console.log(`[Pipeline] WebSocket attached: ${callControlId}`)
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

  data.sttStream = createSTTStream({
    provider: sttProvider,
    apiKey: platformSettings.deepgram_api_key,
    model: platformSettings.active_stt_model,
    onTranscript: async (text, isFinal) => {
      if (isFinal && text.length > 3) await handleProspectSpeech(callControlId, text)
    },
    onError: (error) => console.error(`[Pipeline] STT error ${callControlId}:`, error),
    onSpeechStarted: () => {
      const d = activeSessions.get(callControlId)
      if (!d || !d.isSpeaking) return
      console.log(`[Pipeline] Barge-in detected — aborting TTS ${callControlId}`)
      d.bargedIn = true
      d.currentTtsAbort?.abort()
      d.currentTtsAbort = null
      d.isSpeaking = false
      d.isProcessing = false  // allow new speech turn to start immediately
    },
  })

  await speakToProspect(callControlId, session.agent.greeting_message)
  console.log(`[Pipeline] Session started: ${callControlId}`)
}

export async function handleAudioChunk(callControlId: string, audioBuffer: Buffer) {
  const data = activeSessions.get(callControlId)
  if (!data?.sttStream) return
  // Track bytes for STT cost calculation (mulaw 8kHz = 8000 bytes/sec)
  data.sttAudioBytes += audioBuffer.length
  data.sttStream.sendAudio(audioBuffer)
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
              } catch (ttsErr) {
                console.error(`[Pipeline] TTS stream error for sentence — ${ttsErr}`)
              } finally {
                if (current.currentTtsAbort === sentenceAbort) {
                  current.currentTtsAbort = null
                  current.isSpeaking = false
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
  } catch (ttsError) {
    if (ttsError instanceof Error && ttsError.name === 'AbortError') {
      console.log(`[Pipeline] TTS aborted (barge-in) ${callControlId}`)
      return  // barge-in — don't end the call
    }
    const msg = ttsError instanceof Error ? ttsError.message : String(ttsError)
    console.error(`[Pipeline] TTS failed — ending call ${callControlId}: ${msg}`)
    // End the call immediately — the prospect would hear silence otherwise
    endSession(callControlId, 'error')
  } finally {
    if (data.currentTtsAbort === abortController) {
      data.currentTtsAbort = null
      data.isSpeaking = false
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
