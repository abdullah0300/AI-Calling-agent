import 'dotenv/config'
import express from 'express'
import { WebSocketServer, WebSocket } from 'ws'
import { createServer } from 'http'
import {
  activeSessions, registerSession, attachWebSocket,
  startSession, handleAudioChunk, endSession, updateTelephonyCost
} from './agent/pipeline'
import type { CallSession } from '@voiceflow/shared'

const app = express()
app.use(express.json())

// Health check — required by Google Cloud Run
app.get('/health', (req, res) => {
  res.json({ status: 'ok', activeCalls: activeSessions.size, timestamp: new Date().toISOString() })
})

// Called by Next.js dashboard to register session before call starts
app.post('/session/register', (req, res) => {
  const session: CallSession = req.body
  if (!session?.callControlId) {
    return res.status(400).json({ error: 'callControlId is required' })
  }
  registerSession(session.callControlId, session)
  res.json({ success: true })
})

// Telnyx webhook handler — co-located here because ngrok tunnels port 4000 (this server)
// The dashboard's calls/route.ts sets webhook_url to WS_PUBLIC_URL/api/webhook/telnyx
app.post('/api/webhook/telnyx', async (req, res) => {
  const event = req.body?.data?.event_type
  const payload = req.body?.data?.payload

  console.log('[Telnyx Webhook]', event)

  switch (event) {
    case 'call.answered':
      // Session start is triggered by WebSocket 'start' event (after WS is attached)
      // No action needed here — avoids race condition where WS isn't connected yet
      break

    case 'call.hangup':
      // Prospect or agent hung up — end session cleanly
      if (payload?.call_control_id) {
        await endSession(payload.call_control_id, payload?.hangup_cause || 'completed')
          .catch(err => console.error('[Webhook] Failed to end session on hangup:', err))
      }
      break

    case 'call.machine.detection.ended':
      // Answering machine detected — end without speaking
      if (payload?.result === 'machine' && payload?.call_control_id) {
        await endSession(payload.call_control_id, 'voicemail')
          .catch(() => {})
      }
      break

    case 'call.cost': {
      // Telnyx sends exact telephony charge after call ends
      // payload.cost is a string like "0.007000"
      console.log('[Webhook] call.cost payload:', JSON.stringify(payload))
      const ccid = payload?.call_control_id
      // cost can be a plain string "0.007000" or nested object { amount, currency }
      const rawCost = payload?.cost
      const costTelephony = typeof rawCost === 'object' && rawCost !== null
        ? parseFloat(rawCost.amount ?? rawCost.value ?? 0)
        : parseFloat(rawCost ?? 0)
      if (ccid) {
        await updateTelephonyCost(ccid, isNaN(costTelephony) ? 0 : costTelephony)
          .catch(err => console.error('[Webhook] Failed to save telephony cost:', err))
      } else {
        console.warn('[Webhook] call.cost missing call_control_id — cannot store cost')
      }
      break
    }
  }

  res.json({ received: true })
})

const server = createServer(app)
const wss = new WebSocketServer({ server, path: '/audio' })

wss.on('connection', (ws: WebSocket) => {
  console.log('[WS] New Telnyx audio stream connection')
  let callControlId: string | null = null

  // Keepalive ping every 20 seconds
  // Google Cloud Run closes idle connections — this prevents that
  const pingInterval = setInterval(() => {
    if (ws.readyState === WebSocket.OPEN) ws.ping()
  }, 20000)

  ws.on('message', async (data: Buffer) => {
    try {
      const message = JSON.parse(data.toString())

      switch (message.event) {
        case 'connected':
          console.log('[WS] Telnyx protocol connected')
          break

        case 'start':
          callControlId = message.start?.call_control_id || message.stream_id || null
          // stream_id is needed later to send Telnyx 'clear' on barge-in
          const streamId: string | undefined = message.stream_id
          console.log(`[WS] Audio stream started: ${callControlId}`)
          if (callControlId) {
            attachWebSocket(callControlId, ws, streamId)
            // Start session here — AFTER WebSocket is attached — so greeting audio
            // can be sent immediately. Starting from the webhook risks ws being null.
            await startSession(callControlId)
          }
          break

        case 'media':
          if (callControlId && message.media?.payload) {
            const audioBuffer = Buffer.from(message.media.payload, 'base64')
            await handleAudioChunk(callControlId, audioBuffer)
          }
          break

        case 'stop':
          if (callControlId && activeSessions.has(callControlId)) {
            await endSession(callControlId, 'completed')
          }
          break
      }
    } catch (e) {
      // Non-JSON binary — ignore silently
    }
  })

  ws.on('close', async () => {
    clearInterval(pingInterval)
    if (callControlId && activeSessions.has(callControlId)) {
      await endSession(callControlId, 'completed')
    }
  })

  ws.on('error', (error) => console.error('[WS] Error:', error.message))
  ws.on('pong', () => { /* connection alive */ })
})

const PORT = parseInt(process.env.PORT || '4000', 10)
server.listen(PORT, '0.0.0.0', () => {
  console.log(`[Server] Running on port ${PORT}`)
  console.log(`[Server] Health: http://localhost:${PORT}/health`)
  console.log(`[Server] WebSocket: ws://localhost:${PORT}/audio`)
})

process.on('SIGTERM', () => {
  console.log('[Server] Shutting down gracefully')
  server.close(() => process.exit(0))
})
