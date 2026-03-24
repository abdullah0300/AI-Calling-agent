import { createClient, LiveTranscriptionEvents } from '@deepgram/sdk'

export interface STTStreamConfig {
  provider: 'deepgram' | 'google'
  apiKey: string
  onTranscript: (text: string, isFinal: boolean) => void
  onError: (error: Error) => void
}

export function createSTTStream(config: STTStreamConfig) {
  if (config.provider === 'deepgram') return createDeepgramStream(config)
  throw new Error(`STT provider ${config.provider} not yet implemented`)
}

function createDeepgramStream(config: STTStreamConfig) {
  const deepgram = createClient(config.apiKey)

  const connection = deepgram.listen.live({
    model: 'nova-3',
    language: 'en-GB',
    smart_format: true,
    interim_results: true,
    utterance_end_ms: 1000,
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
    config.onError(new Error(String(error)))
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
