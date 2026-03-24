import Anthropic from '@anthropic-ai/sdk'
import OpenAI from 'openai'

export interface LLMConfig {
  provider: 'anthropic' | 'openai'
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

// 2026 rates (source: platform.claude.com/docs/en/about-claude/pricing)
const ANTHROPIC_INPUT_PER_TOKEN  = 1.00 / 1_000_000   // $1.00 / 1M input tokens  (Haiku 4.5)
const ANTHROPIC_OUTPUT_PER_TOKEN = 5.00 / 1_000_000   // $5.00 / 1M output tokens (Haiku 4.5)

// 2026 rates (source: platform.openai.com/docs/pricing — GPT-4o-mini)
const OPENAI_INPUT_PER_TOKEN  = 0.15 / 1_000_000   // $0.15 / 1M input tokens
const OPENAI_OUTPUT_PER_TOKEN = 0.60 / 1_000_000   // $0.60 / 1M output tokens

export interface LLMStreamConfig extends LLMConfig {
  // Called with each complete sentence as the LLM streams.
  // Must be awaited sequentially so TTS audio plays in order.
  onSentence: (sentence: string) => Promise<void>
}

// Splits buffered text into complete sentences (ending with . ! ?) and a remainder.
function extractSentences(buffer: string): { sentences: string[]; remainder: string } {
  const sentences: string[] = []
  let start = 0
  for (let i = 0; i < buffer.length; i++) {
    const ch = buffer[i]
    if (ch === '.' || ch === '!' || ch === '?') {
      const next = buffer[i + 1]
      if (next === undefined || next === ' ' || next === '\n') {
        const sentence = buffer.slice(start, i + 1).trim()
        if (sentence.length > 3) sentences.push(sentence)
        start = i + (next === ' ' || next === '\n' ? 2 : 1)
        i = start - 1
      }
    }
  }
  return { sentences, remainder: buffer.slice(start) }
}

// Streams LLM tokens, fires onSentence for each complete sentence so TTS can start
// immediately without waiting for the full response. Returns full text + cost.
export async function streamAgentResponse(config: LLMStreamConfig): Promise<LLMResult> {
  if (config.provider === 'anthropic') {
    const client = new Anthropic({ apiKey: config.apiKey })
    const stream = client.messages.stream({
      model: config.model,
      max_tokens: 150,
      system: config.systemPrompt,
      messages: [
        ...config.conversationHistory,
        { role: 'user', content: config.userMessage }
      ],
    })

    let buffer = ''
    let fullText = ''

    for await (const event of stream) {
      if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
        buffer += event.delta.text
        const { sentences, remainder } = extractSentences(buffer)
        buffer = remainder
        for (const sentence of sentences) {
          fullText += (fullText ? ' ' : '') + sentence
          await config.onSentence(sentence)
        }
      }
    }
    // Flush any trailing text that didn't end with punctuation
    if (buffer.trim()) {
      const trailing = buffer.trim()
      fullText += (fullText ? ' ' : '') + trailing
      await config.onSentence(trailing)
    }

    const msg = await stream.finalMessage()
    const inputTokens  = msg.usage?.input_tokens  || 0
    const outputTokens = msg.usage?.output_tokens || 0
    const costUsd = (inputTokens * ANTHROPIC_INPUT_PER_TOKEN) + (outputTokens * ANTHROPIC_OUTPUT_PER_TOKEN)
    return { text: fullText, costUsd }
  }

  // OpenAI streaming
  const client = new OpenAI({ apiKey: config.apiKey })
  const stream = await client.chat.completions.create({
    model: config.model,
    max_tokens: 150,
    stream: true,
    stream_options: { include_usage: true },
    messages: [
      { role: 'system', content: config.systemPrompt },
      ...config.conversationHistory,
      { role: 'user', content: config.userMessage }
    ],
  })

  let buffer = ''
  let fullText = ''
  let inputTokens = 0
  let outputTokens = 0

  for await (const chunk of stream) {
    const delta = chunk.choices[0]?.delta?.content
    if (delta) {
      buffer += delta
      const { sentences, remainder } = extractSentences(buffer)
      buffer = remainder
      for (const sentence of sentences) {
        fullText += (fullText ? ' ' : '') + sentence
        await config.onSentence(sentence)
      }
    }
    if (chunk.usage) {
      inputTokens  = chunk.usage.prompt_tokens     || 0
      outputTokens = chunk.usage.completion_tokens || 0
    }
  }
  if (buffer.trim()) {
    const trailing = buffer.trim()
    fullText += (fullText ? ' ' : '') + trailing
    await config.onSentence(trailing)
  }

  const costUsd = (inputTokens * OPENAI_INPUT_PER_TOKEN) + (outputTokens * OPENAI_OUTPUT_PER_TOKEN)
  return { text: fullText, costUsd }
}

export async function generateAgentResponse(config: LLMConfig): Promise<LLMResult> {
  if (config.provider === 'anthropic') {
    const client = new Anthropic({ apiKey: config.apiKey })
    const response = await client.messages.create({
      model: config.model,
      max_tokens: 150,
      system: config.systemPrompt,
      messages: [
        ...config.conversationHistory,
        { role: 'user', content: config.userMessage }
      ],
    })
    const block = response.content[0]
    const text = block.type === 'text' ? block.text : ''
    const inputTokens  = response.usage?.input_tokens  || 0
    const outputTokens = response.usage?.output_tokens || 0
    const costUsd = (inputTokens * ANTHROPIC_INPUT_PER_TOKEN) + (outputTokens * ANTHROPIC_OUTPUT_PER_TOKEN)
    return { text, costUsd }
  }

  const client = new OpenAI({ apiKey: config.apiKey })
  const response = await client.chat.completions.create({
    model: config.model,
    max_tokens: 150,
    messages: [
      { role: 'system', content: config.systemPrompt },
      ...config.conversationHistory,
      { role: 'user', content: config.userMessage }
    ],
  })
  const text = response.choices[0]?.message?.content || ''
  const inputTokens  = response.usage?.prompt_tokens     || 0
  const outputTokens = response.usage?.completion_tokens || 0
  const costUsd = (inputTokens * OPENAI_INPUT_PER_TOKEN) + (outputTokens * OPENAI_OUTPUT_PER_TOKEN)
  return { text, costUsd }
}
