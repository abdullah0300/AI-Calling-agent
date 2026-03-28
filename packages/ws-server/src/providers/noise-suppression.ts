// ─── Real-time noise suppression ─────────────────────────────────────────────
// Uses RNNoise (Mozilla/Xiph) compiled to WASM via @jitsi/rnnoise-wasm.
//
// INPUT / OUTPUT: LINEAR16 8kHz PCM (Int16LE Buffer)
// Format conversion (mulaw ↔ PCM) is the pipeline's responsibility — this
// module never touches mulaw. Keeping PCM throughout eliminates the double
// encode/decode cycle that degraded audio quality in the previous design.
//
// Internal pipeline per chunk:
//   linear16 8kHz  →  float32 48kHz (upsample)  →  RNNoise  →  float32 8kHz (downsample)  →  linear16 8kHz
//
// RNNoise characteristics:
//   - Handles: HVAC, traffic, keyboard, music, TV bleed
//   - Partial reduction of background speech (not full speaker isolation)
//   - Latency: ~13ms per 480-sample frame at 48kHz
//   - CPU: ~2–3% single core
//   - Falls back to original buffer if WASM is not loaded (no crash)

const INPUT_RATE   = 8000    // pipeline runs at 8kHz (phone audio)
const PROCESS_RATE = 48000   // RNNoise requires exactly 48kHz
const UPSAMPLE     = PROCESS_RATE / INPUT_RATE  // 6×
const FRAME_SIZE   = 480     // RNNoise processes 480 samples per call (10ms @ 48kHz)

// ─── WASM singleton ───────────────────────────────────────────────────────────
let wasmModule: any   = null
let initPromise: Promise<void> | null = null

// Call once at server startup and AWAIT it before accepting calls.
// Returning the same promise on repeated calls makes this idempotent.
export async function initNoiseSuppression(): Promise<void> {
  if (wasmModule)    return
  if (initPromise)   return initPromise
  initPromise = (async () => {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const createRNNoise = require('@jitsi/rnnoise-wasm')
      wasmModule = await createRNNoise()
      console.log('[NoiseSuppression] RNNoise WASM loaded — denoising active')
    } catch (err) {
      console.warn('[NoiseSuppression] RNNoise WASM unavailable — running without denoising:', err)
      wasmModule = null
    }
  })()
  return initPromise
}

// ─── Per-session state ────────────────────────────────────────────────────────
// RNNoise is recurrent — each call needs its own state handle so the model
// can track the noise profile across frames without cross-contamination.
const sessionStates = new Map<string, any>()

export function createNoiseSuppressionState(sessionId: string): void {
  if (!wasmModule) return
  try {
    sessionStates.set(sessionId, wasmModule.newState())
  } catch (err) {
    console.warn(`[NoiseSuppression] Could not create state for ${sessionId}:`, err)
  }
}

export function destroyNoiseSuppressionState(sessionId: string): void {
  const state = sessionStates.get(sessionId)
  if (state === undefined) return
  try { wasmModule?.deleteState(state) } catch { /* ignore */ }
  sessionStates.delete(sessionId)
}

// ─── Main denoising function ──────────────────────────────────────────────────
// Accepts:  linear16 8kHz Buffer (Int16LE, 2 bytes per sample)
// Returns:  denoised linear16 8kHz Buffer — same byte length, same format
// Fallback: returns original buffer unchanged if WASM not loaded or no state
export function denoiseAudioChunk(sessionId: string, pcm8k: Buffer): Buffer {
  if (!wasmModule) return pcm8k
  const state = sessionStates.get(sessionId)
  if (state === undefined) return pcm8k

  const sampleCount = pcm8k.length / 2  // 2 bytes per Int16 sample

  // 1. Read Int16LE samples into Float32 (RNNoise works in float32)
  const pcmFloat = new Float32Array(sampleCount)
  for (let i = 0; i < sampleCount; i++) {
    pcmFloat[i] = pcm8k.readInt16LE(i * 2)
  }

  // 2. Upsample 8kHz → 48kHz via linear interpolation
  const pcm48k = new Float32Array(sampleCount * UPSAMPLE)
  for (let i = 0; i < sampleCount; i++) {
    const curr = pcmFloat[i]
    const next = pcmFloat[Math.min(i + 1, sampleCount - 1)]
    for (let j = 0; j < UPSAMPLE; j++) {
      pcm48k[i * UPSAMPLE + j] = curr + (next - curr) * (j / UPSAMPLE)
    }
  }

  // 3. Process through RNNoise in 480-sample frames
  const frame = new Float32Array(FRAME_SIZE)
  const totalFrames = Math.floor(pcm48k.length / FRAME_SIZE)
  for (let f = 0; f < totalFrames; f++) {
    const offset = f * FRAME_SIZE
    frame.set(pcm48k.subarray(offset, offset + FRAME_SIZE))
    wasmModule.processFrame(state, frame)
    pcm48k.set(frame, offset)
  }
  // Tail samples (< FRAME_SIZE) are left unprocessed — negligible at phone chunk sizes

  // 4. Downsample 48kHz → 8kHz (take every 6th sample) and write back as Int16LE
  const out = Buffer.alloc(sampleCount * 2)
  for (let i = 0; i < sampleCount; i++) {
    const s = Math.max(-32768, Math.min(32767, Math.round(pcm48k[i * UPSAMPLE])))
    out.writeInt16LE(s, i * 2)
  }

  return out
}
