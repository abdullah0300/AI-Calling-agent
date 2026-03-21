import Anthropic from '@anthropic-ai/sdk'
import OpenAI from 'openai'

let anthropicClient: Anthropic | null = null
let openaiClient: OpenAI | null = null

function getAnthropicClient() {
  if (!anthropicClient) anthropicClient = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY! })
  return anthropicClient
}

function getOpenAIClient() {
  if (!openaiClient) openaiClient = new OpenAI({ apiKey: process.env.OPENAI_API_KEY! })
  return openaiClient
}

export interface LLMConfig {
  provider: 'anthropic' | 'openai'
  model: string
  systemPrompt: string
  conversationHistory: Array<{ role: 'user' | 'assistant'; content: string }>
  userMessage: string
}

export async function generateAgentResponse(config: LLMConfig): Promise<string> {
  if (config.provider === 'anthropic') {
    const response = await getAnthropicClient().messages.create({
      model: config.model,
      max_tokens: 150,
      system: config.systemPrompt,
      messages: [
        ...config.conversationHistory,
        { role: 'user', content: config.userMessage }
      ],
    })
    const block = response.content[0]
    return block.type === 'text' ? block.text : ''
  }

  const response = await getOpenAIClient().chat.completions.create({
    model: config.model,
    max_tokens: 150,
    messages: [
      { role: 'system', content: config.systemPrompt },
      ...config.conversationHistory,
      { role: 'user', content: config.userMessage }
    ],
  })
  return response.choices[0]?.message?.content || ''
}
