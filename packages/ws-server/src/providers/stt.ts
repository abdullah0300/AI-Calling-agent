import { createClient, LiveTranscriptionEvents } from '@deepgram/sdk'

export interface STTStreamConfig {
  provider: 'deepgram' | 'google'
  apiKey: string
  model?: string  // e.g. 'nova-2', 'nova-3' — defaults to 'nova-2'
  onTranscript: (text: string, isFinal: boolean) => void
  onError: (error: Error) => void
}

export function createSTTStream(config: STTStreamConfig) {
  if (config.provider === 'deepgram') return createDeepgramStream(config)
  throw new Error(`STT provider ${config.provider} not yet implemented`)
}

function createDeepgramStream(config: STTStreamConfig) {
  if (!config.apiKey) {
    console.error('[STT] Deepgram API key is empty — check Settings → Deepgram API Key')
    config.onError(new Error('Deepgram API key is not set'))
    return { sendAudio: () => {}, close: () => {} }
  }

  const keyPreview = config.apiKey.slice(0, 8) + '…'
  const model = config.model || 'nova-2'
  console.log(`[STT] Connecting to Deepgram — model: ${model}, key: ${keyPreview}`)

  // Quick auth check — surfaces exact HTTP status before attempting WebSocket
  fetch('https://api.deepgram.com/v1/projects', {
    headers: { Authorization: `Token ${config.apiKey}` },
  }).then(r => {
    if (r.ok) {
      console.log('[STT] Deepgram key valid — HTTP 200 OK')
    } else {
      console.error(`[STT] Deepgram key check failed — HTTP ${r.status}. ${
        r.status === 401 ? 'Invalid or expired API key.' :
        r.status === 402 ? 'Account has no credits / payment required.' :
        r.status === 403 ? 'Key lacks permission for live streaming.' : ''
      } Go to console.deepgram.com to fix.`)
    }
  }).catch(() => { /* ignore — network errors handled by WS below */ })

  const deepgram = createClient(config.apiKey)

  const connection = deepgram.listen.live({
    model: model as any,
    language: 'en-GB',
    smart_format: true,
    interim_results: true,
    utterance_end_ms: 500,
    vad_events: true,
    endpointing: 300,
    // CRITICAL: Telnyx streams mulaw 8000Hz mono audio
    // Wrong encoding = garbage transcriptions
    encoding: 'mulaw',
    sample_rate: 8000,
    channels: 1,
  })

  connection.on(LiveTranscriptionEvents.Open, () => {
    console.log('[STT] Deepgram opened')
  })

  connection.on(LiveTranscriptionEvents.Transcript, (data: any) => {
    const transcript = data?.channel?.alternatives?.[0]?.transcript
    const isFinal = data?.is_final
    if (transcript && transcript.trim().length > 2) {
      config.onTranscript(transcript.trim(), isFinal)
    }
  })

  connection.on(LiveTranscriptionEvents.Error, (error: any) => {
    const msg = error?.message || error?.reason || error?.code || JSON.stringify(error) || String(error)
    config.onError(new Error(`Deepgram WS error: ${msg}`))
  })

  // Close event carries the HTTP status code — useful for diagnosing 401/402/403
  connection.on(LiveTranscriptionEvents.Close, (event: any) => {
    const code = event?.code
    const reason = event?.reason || ''
    if (code && code !== 1000) {
      if (code === 1008 || reason.toLowerCase().includes('auth') || reason.toLowerCase().includes('key')) {
        console.error(`[STT] Deepgram rejected connection — invalid API key (code ${code}): ${reason}`)
      } else {
        console.warn(`[STT] Deepgram connection closed — code ${code}: ${reason}`)
      }
    }
  })

  // CRITICAL: Send keepalive every 10 seconds
  // Deepgram closes idle connections after 12 seconds
  // During silence on call this prevents disconnection
  const keepAliveInterval = setInterval(() => {
    try {
      if (connection.getReadyState() === 1) connection.keepAlive()
    } catch (e) { /* ignore */ }
  }, 10000)

  return {
    sendAudio: (chunk: Buffer) => {
      try {
        if (connection.getReadyState() === 1) connection.send(chunk as unknown as ArrayBuffer)
      } catch (e) {
        console.error('[STT] Failed to send audio chunk:', e)
      }
    },
    close: () => {
      clearInterval(keepAliveInterval)
      try { connection.requestClose() } catch (e) { /* ignore */ }
    }
  }
}
