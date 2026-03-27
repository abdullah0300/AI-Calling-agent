import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { z } from 'zod'
import type { Agent, Lead, CallSession } from '@voiceflow/shared'

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

const initiateCallSchema = z.object({
  leadId:               z.string().uuid(),
  agentId:              z.string().uuid(),
  phoneNumberId:        z.string().uuid(),
  // Set to true to bypass the calling-hours check (use for urgent manual calls)
  overrideCallingHours: z.boolean().optional().default(false),
})

// ─── Inline calling-hours helper (mirrors ws-server/src/utils/calling-hours.ts)
// The dashboard cannot import from ws-server so the minimal logic is duplicated here.
const COUNTRY_TZ: Record<string, string> = {
  GB:'Europe/London', UK:'Europe/London', IE:'Europe/Dublin',
  DE:'Europe/Berlin', FR:'Europe/Paris',  ES:'Europe/Madrid',  IT:'Europe/Rome',
  NL:'Europe/Amsterdam', BE:'Europe/Brussels', CH:'Europe/Zurich', AT:'Europe/Vienna',
  PT:'Europe/Lisbon', SE:'Europe/Stockholm', NO:'Europe/Oslo', DK:'Europe/Copenhagen',
  FI:'Europe/Helsinki', PL:'Europe/Warsaw', CZ:'Europe/Prague', HU:'Europe/Budapest',
  RO:'Europe/Bucharest', GR:'Europe/Athens', TR:'Europe/Istanbul',
  ZA:'Africa/Johannesburg', IN:'Asia/Kolkata', SG:'Asia/Singapore',
  JP:'Asia/Tokyo', HK:'Asia/Hong_Kong', AU:'Australia/Sydney', NZ:'Pacific/Auckland',
  US:'America/New_York', CA:'America/Toronto', MX:'America/Mexico_City',
  BR:'America/Sao_Paulo', AE:'Asia/Dubai', SA:'Asia/Riyadh',
}
function prospectLocalHour(countryCode: string): number {
  const tz = COUNTRY_TZ[(countryCode || 'GB').toUpperCase()] ?? 'Europe/London'
  try {
    const h = new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: 'numeric', hour12: false }).format(new Date())
    return parseInt(h, 10) % 24
  } catch { return 12 }  // unknown timezone — assume midday (safe default)
}
function prospectLocalTimeStr(countryCode: string): string {
  const tz = COUNTRY_TZ[(countryCode || 'GB').toUpperCase()] ?? 'Europe/London'
  try {
    return new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour:'2-digit', minute:'2-digit', hour12:false, timeZoneName:'short' }).format(new Date())
  } catch { return 'unknown' }
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json()
    const parsed = initiateCallSchema.safeParse(body)
    if (!parsed.success) {
      return NextResponse.json({ error: 'Invalid request', details: parsed.error.flatten() }, { status: 400 })
    }

    const { leadId, agentId, phoneNumberId, overrideCallingHours } = parsed.data

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

    // ── Calling hours enforcement ─────────────────────────────────────────────
    if (!overrideCallingHours) {
      const { data: chSettings } = await supabase
        .from('settings')
        .select('key, value')
        .in('key', ['calling_hours_enabled', 'calling_hours_start', 'calling_hours_end'])

      const chMap = Object.fromEntries((chSettings || []).map(r => [r.key, r.value]))
      const chEnabled   = (chMap.calling_hours_enabled ?? 'true') !== 'false'
      const chStart     = parseInt(chMap.calling_hours_start ?? '8',  10)
      const chEnd       = parseInt(chMap.calling_hours_end   ?? '21', 10)

      if (chEnabled) {
        const country  = lead.country || 'GB'
        const localHour = prospectLocalHour(country)
        if (localHour < chStart || localHour >= chEnd) {
          const localTime = prospectLocalTimeStr(country)
          return NextResponse.json(
            {
              error: `Call blocked: outside calling hours for this prospect's timezone.`,
              detail: `Local time in ${country}: ${localTime}. Allowed window: ${chStart}:00–${chEnd}:00.`,
              hint:   'Pass overrideCallingHours: true to place the call anyway.',
            },
            { status: 422 }
          )
        }
      }
    }

    // Prevent duplicate active calls for same lead
    // .maybeSingle() returns null (not an error) when no row found — .single() would throw 406
    const { data: existingCall } = await supabase
      .from('calls').select('id')
      .eq('lead_id', leadId).eq('status', 'in_progress').maybeSingle()

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

    const wsServerUrl = process.env.WS_SERVER_URL
    const wsPublicUrl = process.env.WS_PUBLIC_URL

    if (!wsServerUrl || !wsPublicUrl) {
      return NextResponse.json(
        { error: 'WS_SERVER_URL and WS_PUBLIC_URL environment variables must be set.' },
        { status: 500 }
      )
    }

    // Fetch Telnyx credentials from settings table (set via the Settings page)
    // Falls back to env vars so existing setups without DB keys still work
    const { data: settingsRows } = await supabase
      .from('settings')
      .select('key, value')
      .in('key', ['telnyx_api_key', 'telnyx_connection_id'])
    const settingsMap = Object.fromEntries((settingsRows || []).map(r => [r.key, r.value]))
    const telnyxApiKey       = settingsMap.telnyx_api_key       || process.env.TELNYX_API_KEY       || ''
    const telnyxConnectionId = settingsMap.telnyx_connection_id || process.env.TELNYX_CONNECTION_ID || ''

    if (!telnyxApiKey || !telnyxConnectionId) {
      return NextResponse.json({ error: 'Telnyx API key and Connection ID are required. Add them in Settings.' }, { status: 500 })
    }

    // Initiate Telnyx outbound call
    const telnyxRes = await fetch('https://api.telnyx.com/v2/calls', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${telnyxApiKey}`,
      },
      body: JSON.stringify({
        connection_id: telnyxConnectionId,
        to: lead.phone_number,
        from: phoneNumber.number,
        client_state: Buffer.from(JSON.stringify({ callId: callRecord.id })).toString('base64'),
        // Webhook goes to ws-server (same ngrok tunnel as WebSocket)
        webhook_url: `${wsPublicUrl}/api/webhook/telnyx`,
        webhook_url_method: 'POST',
        // WSS URL must be publicly reachable by Telnyx — use ngrok public URL
        stream_url: `${wsPublicUrl.replace('https://', 'wss://')}/audio`,
        stream_track: 'inbound_track',
        // Required for sending TTS audio back to caller via WebSocket
        stream_bidirectional_mode: 'mp3',
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
