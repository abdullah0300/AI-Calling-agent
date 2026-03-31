// ─── LLM response generation ──────────────────────────────────────────────────
// Supports Anthropic (Claude) and OpenAI (GPT) with streaming.
//
// KEY CHANGE from previous version:
//   streamAgentResponse now accepts an AbortSignal.
//   When barge-in fires, pipeline.ts calls llmAbortController.abort() which
//   immediately cancels the in-flight HTTP stream — the LLM stops generating.
//   Previously the LLM kept running after barge-in, causing stale sentences
//   to appear after bargedIn was reset to false in the next turn.
//
// Sentence extraction: streams tokens → fires onSentence on each complete
// sentence so TTS can start immediately without waiting for the full response.
//   Hard boundary: . ! ?
//   Soft boundary: comma or em-dash after ≥6 words (fires ~150ms earlier)

import Anthropic from '@anthropic-ai/sdk'
import OpenAI from 'openai'

export interface LLMConfig {
  provider: 'anthropic' | 'openai' | 'deepseek'
  apiKey: string
  model: string
  systemPrompt: string
  conversationHistory: Array<{ role: 'user' | 'assistant'; content: string }>
  userMessage: string
}

export interface LLMResult {
  text: string
  costUsd: number
}

// 2026 rates
const ANTHROPIC_INPUT_PER_TOKEN  = 1.00 / 1_000_000   // $1.00 / 1M input  (Haiku 4.5)
const ANTHROPIC_OUTPUT_PER_TOKEN = 5.00 / 1_000_000   // $5.00 / 1M output (Haiku 4.5)
const OPENAI_INPUT_PER_TOKEN     = 0.15 / 1_000_000   // $0.15 / 1M input  (GPT-4o-mini)
const OPENAI_OUTPUT_PER_TOKEN    = 0.60 / 1_000_000   // $0.60 / 1M output (GPT-4o-mini)
const DEEPSEEK_INPUT_PER_TOKEN   = 0.14 / 1_000_000   // $0.14 / 1M input  (DeepSeek V3)
const DEEPSEEK_OUTPUT_PER_TOKEN  = 0.28 / 1_000_000   // $0.28 / 1M output (DeepSeek V3)

export interface LLMStreamConfig extends LLMConfig {
  // Called with each complete sentence as the LLM streams.
  // Awaited sequentially so TTS audio plays in order.
  onSentence: (sentence: string) => Promise<void>
  // AbortSignal from pipeline's llmAbortController.
  // When barge-in fires, abort() is called and the HTTP stream stops immediately.
  // This is the key mechanism that prevents stale LLM responses from leaking
  // into subsequent turns.
  abortSignal?: AbortSignal
}

// ─── Sentence extraction ──────────────────────────────────────────────────────
// Splits the token buffer into speakable chunks.
//   Hard split:  . ! ? followed by space/newline/end
//   Soft split:  , or — after ≥6 words (fires TTS ~150ms earlier per clause)
function extractSentences(buffer: string): { sentences: string[]; remainder: string } {
  const sentences: string[] = []
  let start = 0

  for (let i = 0; i < buffer.length; i++) {
    const ch   = buffer[i]
    const next = buffer[i + 1]

    if ((ch === '.' || ch === '!' || ch === '?') &&
        (next === undefined || next === ' ' || next === '\n')) {
      const chunk = buffer.slice(start, i + 1).trim()
      if (chunk.length > 3) sentences.push(chunk)
      start = i + (next === ' ' || next === '\n' ? 2 : 1)
      i = start - 1
      continue
    }

    if (ch === ',' || ch === '—' || (ch === '-' && next === ' ')) {
      const candidate = buffer.slice(start, i + 1).trim()
      if (candidate.split(/\s+/).length >= 6) {
        sentences.push(candidate)
        start = i + 2
        i = start - 1
      }
    }
  }

  return { sentences, remainder: buffer.slice(start) }
}

// ─── Streaming response (primary path) ───────────────────────────────────────
export async function streamAgentResponse(config: LLMStreamConfig): Promise<LLMResult> {
  if (config.provider === 'anthropic') {
    const client = new Anthropic({ apiKey: config.apiKey })
    const stream = client.messages.stream(
      {
        model:      config.model,
        max_tokens: 160,   // raised from 110 — gives space for natural sentence completion
        system:     config.systemPrompt,
        messages:   [
          ...config.conversationHistory,
          { role: 'user', content: config.userMessage },
        ],
      },
      // AbortSignal passed as request option — cancels the HTTP stream immediately
      config.abortSignal ? { signal: config.abortSignal } : undefined,
    )

    let buffer   = ''
    let fullText = ''

    try {
      for await (const event of stream) {
        // Respect abort — stop processing tokens if barge-in fired
        if (config.abortSignal?.aborted) break

        if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
          buffer += event.delta.text
          const { sentences, remainder } = extractSentences(buffer)
          buffer = remainder
          for (const sentence of sentences) {
            if (config.abortSignal?.aborted) break
            fullText += (fullText ? ' ' : '') + sentence
            await config.onSentence(sentence)
          }
        }
      }
    } catch (err: any) {
      // AbortError is expected on barge-in — not an error condition
      if (err?.name !== 'AbortError') throw err
    }

    // Flush trailing text (no trailing punctuation) — only if not aborted
    if (buffer.trim() && !config.abortSignal?.aborted) {
      const trailing = buffer.trim()
      fullText += (fullText ? ' ' : '') + trailing
      await config.onSentence(trailing)
    }

    // Cost calculation — uses actual token counts from Anthropic
    let costUsd = 0
    try {
      if (!config.abortSignal?.aborted) {
        const msg          = await stream.finalMessage()
        const inputTokens  = msg.usage?.input_tokens  || 0
        const outputTokens = msg.usage?.output_tokens || 0
        costUsd = (inputTokens * ANTHROPIC_INPUT_PER_TOKEN) + (outputTokens * ANTHROPIC_OUTPUT_PER_TOKEN)
      }
    } catch { /* stream was aborted — skip cost */ }

    return { text: fullText, costUsd }
  }

  // ── OpenAI & DeepSeek streaming ─────────────────────────────────────────────
  const isDeepSeek = config.provider === 'deepseek'
  const client = new OpenAI({ 
    apiKey: config.apiKey,
    baseURL: isDeepSeek ? 'https://api.deepseek.com' : undefined
  })
  const stream = await client.chat.completions.create(
    {
      model:          config.model,
      max_tokens:     160,
      stream:         true,
      stream_options: { include_usage: true },
      messages:       [
        { role: 'system', content: config.systemPrompt },
        ...config.conversationHistory,
        { role: 'user', content: config.userMessage },
      ],
    },
    // AbortSignal cancels the HTTP stream on barge-in
    config.abortSignal ? { signal: config.abortSignal } : undefined,
  )

  let buffer       = ''
  let fullText     = ''
  let inputTokens  = 0
  let outputTokens = 0

  try {
    for await (const chunk of stream) {
      if (config.abortSignal?.aborted) break

      const delta = chunk.choices[0]?.delta?.content
      if (delta) {
        buffer += delta
        const { sentences, remainder } = extractSentences(buffer)
        buffer = remainder
        for (const sentence of sentences) {
          if (config.abortSignal?.aborted) break
          fullText += (fullText ? ' ' : '') + sentence
          await config.onSentence(sentence)
        }
      }
      if (chunk.usage) {
        inputTokens  = chunk.usage.prompt_tokens     || 0
        outputTokens = chunk.usage.completion_tokens || 0
      }
    }
  } catch (err: any) {
    if (err?.name !== 'AbortError') throw err
  }

  if (buffer.trim() && !config.abortSignal?.aborted) {
    const trailing = buffer.trim()
    fullText += (fullText ? ' ' : '') + trailing
    await config.onSentence(trailing)
  }

  const costUsd = isDeepSeek 
    ? (inputTokens * DEEPSEEK_INPUT_PER_TOKEN) + (outputTokens * DEEPSEEK_OUTPUT_PER_TOKEN)
    : (inputTokens * OPENAI_INPUT_PER_TOKEN) + (outputTokens * OPENAI_OUTPUT_PER_TOKEN)
  return { text: fullText, costUsd }
}

// ─── Non-streaming (batch) response ──────────────────────────────────────────
// Used for one-shot responses where streaming is not needed.
export async function generateAgentResponse(config: LLMConfig): Promise<LLMResult> {
  if (config.provider === 'anthropic') {
    const client   = new Anthropic({ apiKey: config.apiKey })
    const response = await client.messages.create({
      model:      config.model,
      max_tokens: 160,
      system:     config.systemPrompt,
      messages:   [
        ...config.conversationHistory,
        { role: 'user', content: config.userMessage },
      ],
    })
    const block        = response.content[0]
    const text         = block.type === 'text' ? block.text : ''
    const inputTokens  = response.usage?.input_tokens  || 0
    const outputTokens = response.usage?.output_tokens || 0
    return { text, costUsd: (inputTokens * ANTHROPIC_INPUT_PER_TOKEN) + (outputTokens * ANTHROPIC_OUTPUT_PER_TOKEN) }
  }

  const isDeepSeek = config.provider === 'deepseek'
  const client     = new OpenAI({ 
    apiKey: config.apiKey,
    baseURL: isDeepSeek ? 'https://api.deepseek.com' : undefined
  })
  const response = await client.chat.completions.create({
    model:      config.model,
    max_tokens: 160,
    messages:   [
      { role: 'system', content: config.systemPrompt },
      ...config.conversationHistory,
      { role: 'user', content: config.userMessage },
    ],
  })
  const text         = response.choices[0]?.message?.content || ''
  const inputTokens  = response.usage?.prompt_tokens     || 0
  const outputTokens = response.usage?.completion_tokens || 0
  const costUsd      = isDeepSeek
    ? (inputTokens * DEEPSEEK_INPUT_PER_TOKEN) + (outputTokens * DEEPSEEK_OUTPUT_PER_TOKEN)
    : (inputTokens * OPENAI_INPUT_PER_TOKEN) + (outputTokens * OPENAI_OUTPUT_PER_TOKEN)
  return { text, costUsd }
}
