import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { z } from 'zod'
import type { Agent, Lead, CallSession } from '@voiceflow/shared'

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

const initiateCallSchema = z.object({
  leadId: z.string().uuid(),
  agentId: z.string().uuid(),
  phoneNumberId: z.string().uuid(),
})

export async function POST(req: NextRequest) {
  try {
    const body = await req.json()
    const parsed = initiateCallSchema.safeParse(body)
    if (!parsed.success) {
      return NextResponse.json({ error: 'Invalid request', details: parsed.error.flatten() }, { status: 400 })
    }

    const { leadId, agentId, phoneNumberId } = parsed.data

    const [leadRes, agentRes, phoneRes] = await Promise.all([
      supabase.from('leads').select('*').eq('id', leadId).single(),
      supabase.from('agents').select('*').eq('id', agentId).single(),
      supabase.from('phone_numbers').select('*').eq('id', phoneNumberId).single(),
    ])

    if (leadRes.error || agentRes.error || phoneRes.error) {
      return NextResponse.json({ error: 'Could not fetch data' }, { status: 404 })
    }

    const lead = leadRes.data as Lead
    const agent = agentRes.data as Agent
    const phoneNumber = phoneRes.data

    // Prevent duplicate active calls for same lead
    const { data: existingCall } = await supabase
      .from('calls').select('id')
      .eq('lead_id', leadId).eq('status', 'in_progress').single()

    if (existingCall) {
      return NextResponse.json({ error: 'Lead already has active call' }, { status: 409 })
    }

    const { data: callRecord, error: callError } = await supabase
      .from('calls')
      .insert({ lead_id: leadId, agent_id: agentId, phone_number_id: phoneNumberId, status: 'initiated' })
      .select().single()

    if (callError || !callRecord) {
      return NextResponse.json({ error: 'Could not create call record' }, { status: 500 })
    }

    const appUrl = process.env.NEXT_PUBLIC_APP_URL!
    const wsServerUrl = process.env.WS_SERVER_URL!

    // Initiate Telnyx outbound call
    const telnyxRes = await fetch('https://api.telnyx.com/v2/calls', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.TELNYX_API_KEY!}`,
      },
      body: JSON.stringify({
        connection_id: process.env.TELNYX_CONNECTION_ID,
        to: lead.phone_number,
        from: phoneNumber.number,
        client_state: Buffer.from(JSON.stringify({ callId: callRecord.id })).toString('base64'),
        webhook_url: `${appUrl}/api/webhook/telnyx`,
        webhook_url_method: 'POST',
        // Stream audio directly to Google Cloud Run WebSocket server
        stream_url: `${wsServerUrl.replace('https', 'wss')}/audio`,
        stream_track: 'inbound_track',
      }),
    })

    if (!telnyxRes.ok) {
      const err = await telnyxRes.text()
      await supabase.from('calls').update({ status: 'failed' }).eq('id', callRecord.id)
      return NextResponse.json({ error: `Telnyx: ${err}` }, { status: 500 })
    }

    const telnyxData = await telnyxRes.json()
    const callControlId = telnyxData.data.call_control_id

    await supabase.from('calls').update({ telephony_call_id: callControlId }).eq('id', callRecord.id)

    // Register session with WebSocket server BEFORE the call is answered
    const session: CallSession = {
      callId: callRecord.id, leadId, agentId, agent, lead,
      transcript: [], startTime: new Date(),
      maxDuration: agent.max_call_duration_seconds, callControlId,
    }

    await fetch(`${wsServerUrl}/session/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(session),
    })

    return NextResponse.json({ success: true, callId: callRecord.id })

  } catch (error: any) {
    console.error('[API] Call error:', error)
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
}

export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url)
    const limit = parseInt(searchParams.get('limit') || '50', 10)
    const outcome = searchParams.get('outcome')
    const date = searchParams.get('date')

    let query = supabase
      .from('calls')
      .select(`
        *,
        leads(business_name, phone_number),
        agents(name)
      `)
      .order('created_at', { ascending: false })
      .limit(limit)

    if (outcome) query = query.eq('outcome', outcome)
    if (date) {
      const start = new Date(date)
      start.setHours(0, 0, 0, 0)
      const end = new Date(date)
      end.setHours(23, 59, 59, 999)
      query = query.gte('created_at', start.toISOString()).lte('created_at', end.toISOString())
    }

    const { data, error } = await query
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })

    return NextResponse.json({ calls: data })
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
}
