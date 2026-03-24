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
