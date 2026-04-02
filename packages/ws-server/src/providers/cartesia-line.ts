// ─── Cartesia Line pipeline bridge ────────────────────────────────────────────
// Replaces the native STT → LLM → TTS chain for agents that use
// pipeline_type === 'cartesia_line'.
//
// How it works:
//   1. Opens a WebSocket to the Cartesia Line Calls API for the given agent.
//   2. Streams inbound PCM audio (already decoded from mulaw in pipeline.ts)
//      to Cartesia. They handle STT, LLM, and TTS internally.
//   3. Receives outbound audio chunks from Cartesia and fires onAudioChunk()
//      so pipeline.ts can forward them to Telnyx exactly as it does today.
//   4. Receives transcript events and fires onTranscript() so pipeline.ts
//      can store them in session.transcript for the DB.
//   5. Fires onCallEnded() when Cartesia signals the conversation is over
//      (e.g. agent said goodbye and hung up).
//
// Audio formats:
//   In  — linear16 PCM, 8 kHz, mono (same as what Deepgram receives today)
//   Out — base64-encoded MP3 chunks (same format Telnyx expects today)
//
// The Cartesia Line Calls API WebSocket URL:
//   wss://api.cartesia.ai/calls/<agent_id>/ws
//   Auth header: X-API-Key: <cartesia_api_key>
//   Protocol version header: Cartesia-Version: 2025-04-16

import WebSocket from 'ws'
import { logger } from '../utils/logger'

export interface CartesiaLineConfig {
  apiKey:      string
  agentId:     string   // the agent ID from Cartesia's platform
  callId:      string   // your internal call UUID — for logging only
  onAudioChunk: (base64Mp3: string) => void
  onTranscript: (role: 'agent' | 'prospect', text: string) => void
  onCallEnded:  () => void
}

export interface CartesiaLineSession {
  sendAudio: (pcm: Buffer) => void
  close:     () => void
}

// ─── Cartesia Line WebSocket message types (inbound from Cartesia) ─────────────
interface CartesiaAudioChunkMessage {
  type: 'audio_chunk'
  data: string  // base64 MP3
}

interface CartesiaTranscriptMessage {
  type: 'transcript'
  role: 'agent' | 'user'
  text: string
}

interface CartesiaCallEndedMessage {
  type: 'call_ended'
  reason?: string
}

type CartesiaInboundMessage =
  | CartesiaAudioChunkMessage
  | CartesiaTranscriptMessage
  | CartesiaCallEndedMessage
  | { type: string }

// ─── Public factory ───────────────────────────────────────────────────────────
// Returns a CartesiaLineSession immediately. The WebSocket connects in the
// background — audio queued before it opens is flushed automatically.
export function createCartesiaLineSession(config: CartesiaLineConfig): CartesiaLineSession {
  const { apiKey, agentId, callId, onAudioChunk, onTranscript, onCallEnded } = config

  const wsUrl = `wss://api.cartesia.ai/calls/${agentId}/ws`

  let ws: WebSocket | null = null
  let closed  = false
  let ready   = false

  // Audio queued before the WebSocket opens — flushed once connected
  const audioQueue: Buffer[] = []

  ws = new WebSocket(wsUrl, {
    headers: {
      'X-API-Key':        apiKey,
      'Cartesia-Version': '2025-04-16',
    },
  })

  ws.on('open', () => {
    ready = true
    console.log(`[CartesiaLine] Connected — agent: ${agentId} | call: ${callId}`)

    // Send the input audio format so Cartesia knows what to expect
    ws!.send(JSON.stringify({
      type:         'input_audio_format',
      encoding:     'linear16',
      sample_rate:  8000,
      channels:     1,
    }))

    // Flush any audio that arrived before the socket was ready
    for (const chunk of audioQueue) {
      ws!.send(chunk)
    }
    audioQueue.length = 0
  })

  ws.on('message', (raw: Buffer) => {
    // Cartesia sends two kinds of frames:
    //   - Binary frames: raw audio bytes (base64-encode and forward)
    //   - Text frames:   JSON control messages (transcript, call_ended, etc.)
    if (typeof raw !== 'string' && !Buffer.isBuffer(raw)) return

    // Binary audio frame — encode to base64 and fire onAudioChunk
    if (Buffer.isBuffer(raw) && raw[0] !== 0x7B) {  // 0x7B = '{' (JSON start)
      onAudioChunk(raw.toString('base64'))
      return
    }

    // Text / JSON frame
    let msg: CartesiaInboundMessage
    try {
      msg = JSON.parse(raw.toString())
    } catch {
      return  // malformed — ignore
    }

    switch (msg.type) {
      case 'audio_chunk': {
        const m = msg as CartesiaAudioChunkMessage
        if (m.data) onAudioChunk(m.data)
        break
      }

      case 'transcript': {
        const m = msg as CartesiaTranscriptMessage
        // Cartesia uses 'user' for the prospect; map to our 'prospect' label
        const role: 'agent' | 'prospect' = m.role === 'agent' ? 'agent' : 'prospect'
        if (m.text?.trim()) onTranscript(role, m.text.trim())
        break
      }

      case 'call_ended': {
        const m = msg as CartesiaCallEndedMessage
        console.log(`[CartesiaLine] Call ended by agent — reason: ${m.reason ?? 'none'} | call: ${callId}`)
        if (!closed) onCallEnded()
        break
      }

      case 'error': {
        const err = (msg as any).message ?? JSON.stringify(msg)
        logger.error('cartesia-line', `Cartesia error: ${err}`, { callId })
        break
      }

      // session_started, input_accepted, etc. — informational, no action needed
      default:
        break
    }
  })

  ws.on('error', (err) => {
    logger.error('cartesia-line', `WebSocket error: ${err.message}`, { callId })
  })

  ws.on('close', (code, reason) => {
    console.log(`[CartesiaLine] WebSocket closed — code: ${code} reason: ${reason?.toString() ?? ''} | call: ${callId}`)
    ready  = false
    closed = true
  })

  // ── Public interface ─────────────────────────────────────────────────────────

  function sendAudio(pcm: Buffer): void {
    if (closed) return
    if (!ready || ws?.readyState !== WebSocket.OPEN) {
      // Buffer until open — prevents dropping audio during connection setup
      audioQueue.push(pcm)
      return
    }
    // Send raw PCM binary frame directly — Cartesia accepts binary audio
    ws.send(pcm)
  }

  function close(): void {
    if (closed) return
    closed = true
    ready  = false
    try {
      if (ws?.readyState === WebSocket.OPEN || ws?.readyState === WebSocket.CONNECTING) {
        ws.close(1000, 'call ended')
      }
    } catch {
      // ignore close errors
    }
    ws = null
  }

  return { sendAudio, close }
}
