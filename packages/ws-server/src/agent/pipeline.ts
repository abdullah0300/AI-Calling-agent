import { createSTTStream } from '../providers/stt'
import { textToSpeech } from '../providers/tts'
import { generateAgentResponse } from '../providers/llm'
import { detectScenario, buildSystemPrompt } from './scenarios'
import { supabase } from '../db/client'
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
}

export const activeSessions = new Map<string, ActiveSession>()

export function registerSession(callControlId: string, session: CallSession) {
  activeSessions.set(callControlId, {
    session, ws: null, sttStream: null,
    conversationHistory: [], isProcessing: false, isStarted: false, maxDurationTimer: null,
    costLlm: 0, costTts: 0, sttAudioBytes: 0,
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

  data.sttStream = createSTTStream({
    provider: session.agent.active_stt,
    onTranscript: async (text, isFinal) => {
      if (isFinal && text.length > 3) await handleProspectSpeech(callControlId, text)
    },
    onError: (error) => console.error(`[Pipeline] STT error ${callControlId}:`, error)
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

  try {
    const { session, conversationHistory } = data

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
        await speakToProspect(callControlId, responseText)
        setTimeout(() => endSession(callControlId, 'not_interested'), 4000)
        return

      case 'interested':
        responseText = session.agent.interest_detected_message
        await speakToProspect(callControlId, responseText)
        setTimeout(() => endSession(callControlId, 'interested'), 6000)
        return

      case 'wrong_person':
        responseText = session.agent.wrong_person_message
        await speakToProspect(callControlId, responseText)
        break

      case 'callback_request':
        responseText = session.agent.callback_message
        await speakToProspect(callControlId, responseText)
        break

      default:
        try {
          const result = await generateAgentResponse({
            provider: session.agent.active_llm,
            model: session.agent.active_llm_model,
            systemPrompt: buildSystemPrompt(session.agent.system_prompt),
            conversationHistory,
            userMessage: transcript,
          })
          responseText = result.text
          data.costLlm += result.costUsd
          console.log(`[Cost] LLM +$${result.costUsd.toFixed(6)} (total LLM: $${data.costLlm.toFixed(6)})`)
        } catch (llmError) {
          console.error(`[Pipeline] LLM error ${callControlId}:`, llmError)
          responseText = "Could you repeat that? I did not quite catch it."
        }
        await speakToProspect(callControlId, responseText)
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

async function speakToProspect(callControlId: string, text: string) {
  const data = activeSessions.get(callControlId)
  if (!data) return

  const { session, ws } = data

  session.transcript.push({
    role: 'agent', text, timestamp: new Date().toISOString()
  })

  try {
    console.log(`[Pipeline] Agent: "${text}"`)

    let ttsResult: { audio: string; costUsd: number }
    try {
      ttsResult = await textToSpeech({
        provider: session.agent.active_tts, text,
      })
      data.costTts += ttsResult.costUsd
      console.log(`[Cost] TTS +$${ttsResult.costUsd.toFixed(6)} (total TTS: $${data.costTts.toFixed(6)})`)
    } catch (ttsError) {
      console.error(`[Pipeline] TTS error ${callControlId}:`, ttsError)
      return
    }

    // Send TTS audio back to caller via WebSocket (bidirectional mode: mp3)
    // Telnyx spec: { event: 'media', media: { payload: <base64 mp3> } }
    if (ws && ws.readyState === ws.OPEN) {
      ws.send(JSON.stringify({
        event: 'media',
        media: { payload: ttsResult.audio }
      }))
    } else {
      console.warn(`[Pipeline] WebSocket not ready: ${callControlId}`)
    }
  } catch (error) {
    console.error(`[Pipeline] speakToProspect error ${callControlId}:`, error)
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
  const { data: call } = await supabase
    .from('calls')
    .select('cost_llm, cost_stt, cost_tts')
    .eq('telephony_call_id', callControlId)
    .single()

  if (!call) return

  const costTotal = costTelephony + (call.cost_llm || 0) + (call.cost_stt || 0) + (call.cost_tts || 0)
  await supabase.from('calls')
    .update({ cost_telephony: costTelephony, cost_total: costTotal })
    .eq('telephony_call_id', callControlId)

  console.log(`[Cost] Telnyx telephony: $${costTelephony.toFixed(6)} — Final total: $${costTotal.toFixed(6)}`)
}
