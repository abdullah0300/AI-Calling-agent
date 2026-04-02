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
// The agent's system prompt, voice, and intro are already configured on the
// Cartesia platform — nothing needs to be sent here except the agent ID.

import WebSocket from 'ws'
import { logger } from '../utils/logger'

export interface CartesiaLineConfig {
  apiKey:       string
  agentId:      string   // UUID from Cartesia dashboard
  callId:       string   // your internal call UUID — for logging only
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

  // Correct URL per Cartesia docs
  const wsUrl = `wss://api.cartesia.ai/agents/stream/${agentId}`

  let ws:       WebSocket | null = null
  let streamId: string | null    = null
  let ready     = false
  let closed    = false

  // Mulaw chunks that arrive before the socket is open — flushed on ack
  const audioQueue: Buffer[] = []

  ws = new WebSocket(wsUrl, {
    headers: {
      'Authorization':    `Bearer ${apiKey}`,
      'Cartesia-Version': '2025-04-16',
    },
  })

  ws.on('open', () => {
    console.log(`[CartesiaLine] WebSocket open — agent: ${agentId} | call: ${callId}`)

    // First message MUST be `start` with the input audio format.
    // mulaw_8000 matches Telnyx's native format — no conversion needed.
    // The agent's system prompt, voice, and greeting are already saved
    // on the Cartesia platform — no overrides needed here.
    ws!.send(JSON.stringify({
      event:  'start',
      config: { input_format: 'mulaw_8000' },
    }))
    // Ready state and queue flush happen in the `ack` handler below
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
        // Server confirmed stream start and returned the resolved stream_id
        streamId = msg.stream_id ?? null
        ready    = true
        console.log(`[CartesiaLine] Stream ready — stream_id: ${streamId} | call: ${callId}`)

        // Flush any audio that arrived before ack
        for (const chunk of audioQueue) {
          sendMulawChunk(chunk)
        }
        audioQueue.length = 0
        break
      }

      case 'media_output': {
        // Agent speaking — forward base64 audio to Telnyx
        const payload = msg.media?.payload
        if (payload) onAudioChunk(payload)
        break
      }

      case 'clear': {
        // Agent was interrupted — tell Telnyx to clear buffered audio
        console.log(`[CartesiaLine] Clear event received | call: ${callId}`)
        onClear()
        break
      }

      case 'transfer_call': {
        // Agent requested a transfer — log it (telephony transfer not implemented)
        const target = msg.transfer?.target_phone_number ?? 'unknown'
        logger.warn('cartesia-line', `Agent requested transfer to ${target} — not implemented`, { callId })
        break
      }

      case 'error': {
        const errMsg = msg.message ?? msg.error ?? JSON.stringify(msg)
        logger.error('cartesia-line', `Cartesia error: ${errMsg}`, { callId })
        break
      }

      default:
        // session_started, input_accepted, etc. — informational
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
    // Code 1000 = normal closure (agent ended the call naturally)
    if (code === 1000 && !closed) {
      onCallEnded()
    }
  })

  // Keepalive — Cloud Run closes idle connections after 60s without traffic.
  // Cartesia's inactivity timeout is 180s; ping every 60s to stay alive.
  const pingInterval = setInterval(() => {
    if (ws?.readyState === WebSocket.OPEN) ws.ping()
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
