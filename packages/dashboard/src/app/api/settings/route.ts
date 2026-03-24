import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/server'

// Use admin client (service role) so RLS doesn't block settings reads/writes
function getAdmin() {
  return createAdminClient()
}

export async function GET() {
  const { data, error } = await getAdmin().from('settings').select('key, value')
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ settings: data })
}

export async function PATCH(req: NextRequest) {
  const { key, value } = await req.json()
  if (!key || value === undefined) {
    return NextResponse.json({ error: 'key and value are required' }, { status: 400 })
  }
  const { error } = await getAdmin()
    .from('settings')
    .upsert({ key, value, updated_at: new Date().toISOString() }, { onConflict: 'key' })
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ success: true })
}
