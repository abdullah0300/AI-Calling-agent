import 'dotenv/config'
import express from 'express'
import { WebSocketServer, WebSocket } from 'ws'
import { createServer } from 'http'
import {
  activeSessions, registerSession, attachWebSocket,
  startSession, handleAudioChunk, endSession
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

// Called by Next.js dashboard when Telnyx reports call.answered
app.post('/session/start/:callControlId', async (req, res) => {
  const { callControlId } = req.params
  await startSession(callControlId)
  res.json({ success: true })
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
          console.log(`[WS] Audio stream started: ${callControlId}`)
          if (callControlId) attachWebSocket(callControlId, ws)
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
