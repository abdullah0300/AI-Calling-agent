// ─── Real-time noise suppression for inbound call audio ──────────────────────
// Uses RNNoise (Mozilla/Xiph) compiled to WebAssembly via @jitsi/rnnoise-wasm.
// Sits in front of VAD and STT — processes every audio chunk before it reaches
// either the local energy VAD or Deepgram, reducing false barge-in triggers.
//
// Pipeline per chunk:
//   mulaw 8kHz  →  linear16 8kHz  →  linear16 48kHz  →  RNNoise  →  linear16 8kHz  →  mulaw 8kHz
//
// NOTE: This is designed as a drop-in upgrade path to Krisp VIVA SDK.
// When the Krisp binary is available (sdk.krisp.ai), replace the RNNoise
// processing block with Krisp's krisp-viva-tel model call — the input/output
// interface (mulaw 8kHz Buffer in → mulaw 8kHz Buffer out) stays identical.
//
// RNNoise characteristics:
//   - Handles: HVAC, traffic, keyboard, music, TV audio
//   - Partial reduction of: background human speech (not full isolation)
//   - Latency: ~13ms (480 samples at 48kHz per frame)
//   - CPU: low (~2–3% single core)

// eslint-disable-next-line @typescript-eslint/no-require-imports
const createRNNoise = require('@jitsi/rnnoise-wasm')

const INPUT_RATE    = 8000   // Telnyx sends mulaw at 8kHz
const PROCESS_RATE  = 48000  // RNNoise requires 48kHz
const UPSAMPLE      = PROCESS_RATE / INPUT_RATE  // 6x
const FRAME_SIZE    = 480    // RNNoise processes exactly 480 samples (10ms at 48kHz)

// ─── WASM module singleton ────────────────────────────────────────────────────
let wasmModule: any = null
let initPromise: Promise<void> | null = null

// Call once at server startup. Safe to call multiple times.
export async function initNoiseSuppression(): Promise<void> {
  if (wasmModule) return
  if (initPromise) return initPromise
  initPromise = (async () => {
    try {
      wasmModule = await createRNNoise()
      console.log('[NoiseSuppression] RNNoise WASM loaded — noise suppression active')
    } catch (err) {
      console.warn('[NoiseSuppression] Failed to load RNNoise WASM — running without noise suppression:', err)
      wasmModule = null
    }
  })()
  return initPromise
}

// ─── Per-session state ────────────────────────────────────────────────────────
// RNNoise is stateful — each audio stream needs its own state handle so the
// recurrent network can track noise profile across frames.
const sessionStates = new Map<string, any>()

export function createNoiseSuppressionState(sessionId: string): void {
  if (!wasmModule) return
  try {
    const state = wasmModule.newState()
    sessionStates.set(sessionId, state)
  } catch (err) {
    console.warn(`[NoiseSuppression] Could not create state for ${sessionId}:`, err)
  }
}

export function destroyNoiseSuppressionState(sessionId: string): void {
  if (!wasmModule) return
  const state = sessionStates.get(sessionId)
  if (state !== undefined) {
    try { wasmModule.deleteState(state) } catch { /* ignore */ }
    sessionStates.delete(sessionId)
  }
}

// ─── μ-law codec ─────────────────────────────────────────────────────────────
function mulawDecode(byte: number): number {
  const b    = (~byte) & 0xFF
  const sign = b & 0x80
  const exp  = (b >> 4) & 0x07
  const mant = b & 0x0F
  let s = ((mant << 3) | 0x84) << exp
  s -= 0x84
  return sign ? -s : s
}

function mulawEncode(sample: number): number {
  const BIAS = 0x84
  const CLIP = 32635
  let sign = 0
  if (sample < 0) { sample = -sample; sign = 0x80 }
  if (sample > CLIP) sample = CLIP
  sample += BIAS
  let exp = 7
  for (let mask = 0x4000; (sample & mask) === 0 && exp > 0; exp--, mask >>= 1) {}
  const mantis = (sample >> (exp + 3)) & 0x0F
  return (~(sign | (exp << 4) | mantis)) & 0xFF
}

// ─── Main denoising function ──────────────────────────────────────────────────
// Takes a mulaw 8kHz buffer, returns a denoised mulaw 8kHz buffer of equal length.
// Falls back to returning the original buffer if WASM is not loaded or no state exists.
export function denoiseAudioChunk(sessionId: string, mulaw8k: Buffer): Buffer {
  if (!wasmModule) return mulaw8k
  const state = sessionStates.get(sessionId)
  if (state === undefined) return mulaw8k

  const n = mulaw8k.length

  // 1. Decode mulaw → Int16 PCM at 8kHz
  const pcm8k = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    pcm8k[i] = mulawDecode(mulaw8k[i])
  }

  // 2. Upsample 8kHz → 48kHz via linear interpolation (6x)
  const pcm48k = new Float32Array(n * UPSAMPLE)
  for (let i = 0; i < n; i++) {
    const curr = pcm8k[i]
    const next = pcm8k[Math.min(i + 1, n - 1)]
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
  // Tail samples (< 480) are left unprocessed — at 8kHz chunks they rarely occur

  // 4. Downsample 48kHz → 8kHz (take every 6th sample)
  const out = Buffer.alloc(n)
  for (let i = 0; i < n; i++) {
    const raw = pcm48k[i * UPSAMPLE]
    const clamped = Math.max(-32768, Math.min(32767, Math.round(raw)))
    out[i] = mulawEncode(clamped)
  }

  return out
}
