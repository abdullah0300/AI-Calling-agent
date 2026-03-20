import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { z } from 'zod'

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

const leadSchema = z.object({
  business_name: z.string().min(1),
  phone_number: z.string().min(1),
  industry: z.string().min(1),
  city: z.string().optional().nullable(),
  country: z.string().default('GB'),
  decision_maker_name: z.string().optional().nullable(),
  notes: z.string().optional().nullable(),
})

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url)
  const status = searchParams.get('status')
  const limit = parseInt(searchParams.get('limit') || '100', 10)

  let query = supabase
    .from('leads')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(limit)

  if (status) query = query.eq('status', status)

  const { data, error } = await query
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ leads: data })
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json()

    // Support bulk import (array) or single lead
    if (Array.isArray(body)) {
      const leads = body.map(item => {
        const parsed = leadSchema.safeParse(item)
        if (!parsed.success) throw new Error(`Invalid lead: ${JSON.stringify(parsed.error.flatten())}`)
        return parsed.data
      })
      const { data, error } = await supabase.from('leads').insert(leads).select()
      if (error) return NextResponse.json({ error: error.message }, { status: 500 })
      return NextResponse.json({ leads: data }, { status: 201 })
    }

    const parsed = leadSchema.safeParse(body)
    if (!parsed.success) {
      return NextResponse.json({ error: 'Invalid request', details: parsed.error.flatten() }, { status: 400 })
    }

    const { data, error } = await supabase.from('leads').insert(parsed.data).select().single()
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    return NextResponse.json({ lead: data }, { status: 201 })
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
}
