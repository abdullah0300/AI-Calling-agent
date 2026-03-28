import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { z } from 'zod'

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

const agentSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional().nullable(),
  system_prompt: z.string().min(1),
  greeting_message: z.string().default(''),
  not_interested_message: z.string().default(''),
  max_call_duration_seconds: z.number().int().min(30).max(600).default(180),
  active_llm: z.enum(['anthropic', 'openai']).default('anthropic'),
  active_llm_model: z.string().default('claude-haiku-4-5'),
  active_tts: z.enum(['elevenlabs', 'deepgram', 'google', 'cartesia']).default('deepgram'),
  active_stt: z.enum(['deepgram', 'google']).default('deepgram'),
  active_telephony: z.enum(['telnyx', 'twilio']).default('telnyx'),
})

export async function GET() {
  const { data, error } = await supabase
    .from('agents')
    .select('*')
    .order('created_at', { ascending: false })

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ agents: data })
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json()
    const parsed = agentSchema.safeParse(body)
    if (!parsed.success) {
      return NextResponse.json({ error: 'Invalid request', details: parsed.error.flatten() }, { status: 400 })
    }

    const { data, error } = await supabase
      .from('agents')
      .insert(parsed.data)
      .select()
      .single()

    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    return NextResponse.json({ agent: data }, { status: 201 })
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
}
