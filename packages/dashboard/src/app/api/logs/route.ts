import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url)
  const level    = searchParams.get('level')    // 'error' | 'warn' | 'info' | null = all
  const source   = searchParams.get('source')   // 'pipeline' | 'dialer' | etc | null = all
  const callId   = searchParams.get('callId')
  const limit    = Math.min(parseInt(searchParams.get('limit') ?? '200', 10), 500)

  let query = supabase
    .from('server_logs')
    .select('id, level, source, message, context, call_id, created_at')
    .order('created_at', { ascending: false })
    .limit(limit)

  if (level)  query = query.eq('level', level)
  if (source) query = query.eq('source', source)
  if (callId) query = query.eq('call_id', callId)

  const { data, error } = await query

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ logs: data ?? [], total: data?.length ?? 0 })
}

export async function DELETE() {
  // Clear all logs older than 7 days
  const cutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString()
  const { error } = await supabase.from('server_logs').delete().lt('created_at', cutoff)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ success: true })
}
