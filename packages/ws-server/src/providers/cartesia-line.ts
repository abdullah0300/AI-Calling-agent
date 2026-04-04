// ─── Cartesia Line pipeline bridge ────────────────────────────────────────────
// Bridges a Telnyx audio stream to a Cartesia Line agent.
//
// How it works:
//   1. Opens a WebSocket to wss://api.cartesia.ai/agents/stream/{agentId}
//   2. Sends a `start` event declaring mulaw_8000 input (Telnyx native format —
//      no audio conversion needed at all)
//   3. Forwards each Telnyx mulaw chunk as a `media_input` event (base64)
//   4. Receives `media_output` events from Cartesia and fires onAudioChunk()
//      so pipeline.ts can forward the base64 audio to Telnyx
//   5. Handles `clear` (agent interrupted — stop playing buffered audio)
//   6. Transcripts are NOT streamed in real-time by Cartesia; they are fetched
//      post-call via REST if needed
//
// Audio format:
//   Input to Cartesia:  mulaw_8000 (matches Telnyx native format, no conversion)
//   Output from Cartesia: mulaw_8000 (mirrors input format — base64 in media_output)
//   Telnyx bidirectional: must be set to mode='rtp' + codec='PCMU' at call placement
//
// The agent's system prompt, voice, and intro are configured on the Cartesia
// platform — nothing needs to be sent here except the agent ID.

import WebSocket from 'ws'
import { logger } from '../utils/logger'

export interface CartesiaLineConfig {
  apiKey:       string
  agentId:      string   // UUID from Cartesia dashboard
  callId:       string   // your internal call UUID — for logging and stream_id
  onAudioChunk: (base64Audio: string) => void   // forward to Telnyx
  onClear:      () => void                      // agent interrupted — clear Telnyx buffer
  onCallEnded:  () => void                      // agent ended the call
}

export interface CartesiaLineSession {
  // Send raw mulaw 8kHz buffer from Telnyx — no conversion needed
  sendAudio: (mulawBuffer: Buffer) => void
  close:     () => void
}

export function createCartesiaLineSession(config: CartesiaLineConfig): CartesiaLineSession {
  const { apiKey, agentId, callId, onAudioChunk, onClear, onCallEnded } = config

  const wsUrl = `wss://api.cartesia.ai/agents/stream/${agentId}`

  let ws:       WebSocket | null = null
  let streamId: string | null    = null
  let ready     = false
  let closed    = false

  // Mulaw chunks that arrive before the socket is open — flushed on ack
  const audioQueue: Buffer[] = []

  console.log(`[CartesiaLine] Connecting — agent: ${agentId} | call: ${callId} | url: ${wsUrl}`)

  ws = new WebSocket(wsUrl, {
    headers: {
      'Authorization':    `Bearer ${apiKey}`,
      'Cartesia-Version': '2025-04-16',
    },
  })

  ws.on('open', () => {
    console.log(`[CartesiaLine] WebSocket open — agent: ${agentId} | call: ${callId}`)

    // First message MUST be `start` with the input audio format.
    // mulaw_8000 matches Telnyx's native RTP/PCMU format — no conversion needed.
    // stream_id uses callId for correlation across logs.
    // The agent's system prompt, voice, and greeting are already configured on
    // the Cartesia platform — no overrides needed here.
    const startMsg = {
      event:     'start',
      stream_id: callId,
      config:    { input_format: 'mulaw_8000' },
    }
    console.log(`[CartesiaLine] Sending start event — stream_id: ${callId} | input_format: mulaw_8000`)
    ws!.send(JSON.stringify(startMsg))
  })

  ws.on('message', (raw: WebSocket.RawData) => {
    let msg: Record<string, any>
    try {
      msg = JSON.parse(raw.toString())
    } catch {
      return  // not JSON — ignore
    }

    switch (msg.event) {
      case 'ack': {
        // Server confirmed stream start — use server-assigned stream_id
        streamId = msg.stream_id ?? callId
        ready    = true
        console.log(`[CartesiaLine] Stream ready — stream_id: ${streamId} | call: ${callId} | queued chunks: ${audioQueue.length}`)

        // Flush any audio that arrived before ack
        if (audioQueue.length > 0) {
          console.log(`[CartesiaLine] Flushing ${audioQueue.length} queued audio chunks`)
          for (const chunk of audioQueue) {
            sendMulawChunk(chunk)
          }
          audioQueue.length = 0
        }
        break
      }

      case 'media_output': {
        // Agent speaking — forward base64 mulaw_8000 audio to Telnyx
        const payload = msg.media?.payload
        if (payload) {
          onAudioChunk(payload)
        } else {
          logger.warn('cartesia-line', `media_output event missing media.payload | call: ${callId}`)
        }
        break
      }

      case 'clear': {
        // Agent was interrupted — tell Telnyx to clear buffered audio
        console.log(`[CartesiaLine] Clear event — agent interrupted | call: ${callId}`)
        onClear()
        break
      }

      case 'transfer_call': {
        // Agent requested a transfer — telephony transfer not implemented
        const target = msg.transfer?.target_phone_number ?? 'unknown'
        logger.warn('cartesia-line', `Agent requested transfer to ${target} — not implemented | call: ${callId}`, { callId })
        break
      }

      case 'error': {
        const errMsg = msg.message ?? msg.error ?? JSON.stringify(msg)
        logger.error('cartesia-line', `Cartesia error event: ${errMsg} | call: ${callId}`, { callId, agentId })
        break
      }

      default:
        // session_started, input_accepted, etc. — informational only
        console.log(`[CartesiaLine] Event: ${msg.event} | call: ${callId}`)
        break
    }
  })

  ws.on('error', (err) => {
    // Network-level errors: connection refused, DNS failure, TLS error, etc.
    logger.error('cartesia-line', `WebSocket error: ${err.message} | agent: ${agentId} | call: ${callId}`, { callId, agentId })
  })

  ws.on('close', (code, reason) => {
    const reasonStr = reason?.toString() ?? ''
    console.log(`[CartesiaLine] WebSocket closed — code: ${code} | reason: "${reasonStr}" | call: ${callId}`)

    // Capture closed state BEFORE setting it — so we can distinguish a natural
    // Cartesia-initiated close (closed=false) from our own close() call (closed=true).
    const wasClosedByUs = closed
    ready  = false
    closed = true

    if (code === 1000 && !wasClosedByUs) {
      // Normal closure initiated by Cartesia: "call ended by agent"
      console.log(`[CartesiaLine] Agent ended the call naturally — triggering endSession | call: ${callId}`)
      onCallEnded()
    } else if (code !== 1000 && !wasClosedByUs) {
      // Abnormal closure — Cartesia dropped the connection unexpectedly
      logger.error('cartesia-line', `Unexpected WebSocket close — code: ${code} | reason: "${reasonStr}" | call: ${callId}`, { callId, agentId })
      // Still end the session so the call doesn't hang open
      onCallEnded()
    }
    // If wasClosedByUs: close() was called from endSession — no action needed
  })

  // Keepalive — Cartesia's inactivity timeout is 180s; ping every 60s.
  const pingInterval = setInterval(() => {
    if (ws?.readyState === WebSocket.OPEN) {
      ws.ping()
    }
  }, 60_000)

  // ── Internal helper ──────────────────────────────────────────────────────────
  function sendMulawChunk(mulawBuffer: Buffer): void {
    if (!ws || ws.readyState !== WebSocket.OPEN) return
    ws.send(JSON.stringify({
      event:     'media_input',
      stream_id: streamId,
      media:     { payload: mulawBuffer.toString('base64') },
    }))
  }

  // ── Public interface ─────────────────────────────────────────────────────────

  function sendAudio(mulawBuffer: Buffer): void {
    if (closed) return
    if (!ready) {
      audioQueue.push(mulawBuffer)
      return
    }
    sendMulawChunk(mulawBuffer)
  }

  function close(): void {
    if (closed) return
    closed = true
    ready  = false
    clearInterval(pingInterval)
    console.log(`[CartesiaLine] Closing session — call: ${callId}`)
    try {
      if (ws?.readyState === WebSocket.OPEN || ws?.readyState === WebSocket.CONNECTING) {
        ws.close(1000, 'call ended')
      }
    } catch {
      // ignore
    }
    ws = null
  }

  return { sendAudio, close }
}
