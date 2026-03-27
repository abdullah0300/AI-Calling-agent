import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { z } from 'zod'

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

const createCampaignSchema = z.object({
  name:                 z.string().min(1),
  agent_id:             z.string().uuid(),
  phone_number_id:      z.string().uuid(),
  max_concurrent_calls: z.number().int().min(1).max(20).default(3),
  calls_per_minute:     z.number().int().min(1).max(60).default(10),
  retry_attempts:       z.number().int().min(0).max(5).default(2),
  retry_delay_minutes:  z.number().int().min(5).max(1440).default(60),
  retry_outcomes:       z.array(z.string()).default(['no_answer']),
  // Optional: lead IDs to attach to this campaign on creation
  lead_ids:             z.array(z.string().uuid()).optional(),
})

// GET /api/campaigns — list all campaigns with lead progress counts
export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url)
    const status = searchParams.get('status')

    let query = supabase
      .from('campaigns')
      .select(`
        *,
        agents(name),
        phone_numbers(number, label)
      `)
      .order('created_at', { ascending: false })

    if (status) query = query.eq('status', status)

    const { data: campaigns, error } = await query
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })

    // Attach per-campaign lead counts (pending/calling/done) for the UI progress bars
    const campaignIds = (campaigns || []).map(c => c.id)
    if (campaignIds.length === 0) return NextResponse.json({ campaigns: [] })

    const { data: leadCounts } = await supabase
      .from('leads')
      .select('campaign_id, status')
      .in('campaign_id', campaignIds)

    const countMap: Record<string, { total: number; pending: number; calling: number; done: number }> = {}
    for (const lead of leadCounts || []) {
      if (!countMap[lead.campaign_id]) {
        countMap[lead.campaign_id] = { total: 0, pending: 0, calling: 0, done: 0 }
      }
      countMap[lead.campaign_id].total++
      if (lead.status === 'pending')       countMap[lead.campaign_id].pending++
      else if (lead.status === 'calling')  countMap[lead.campaign_id].calling++
      else                                 countMap[lead.campaign_id].done++
    }

    const enriched = (campaigns || []).map(c => ({
      ...c,
      lead_counts: countMap[c.id] ?? { total: 0, pending: 0, calling: 0, done: 0 },
    }))

    return NextResponse.json({ campaigns: enriched })
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
}

// POST /api/campaigns — create a new campaign (optionally with leads attached)
export async function POST(req: NextRequest) {
  try {
    const body = await req.json()
    const parsed = createCampaignSchema.safeParse(body)
    if (!parsed.success) {
      return NextResponse.json({ error: 'Invalid request', details: parsed.error.flatten() }, { status: 400 })
    }

    const { lead_ids, ...campaignData } = parsed.data

    const { data: campaign, error } = await supabase
      .from('campaigns')
      .insert(campaignData)
      .select()
      .single()

    if (error || !campaign) {
      return NextResponse.json({ error: error?.message || 'Failed to create campaign' }, { status: 500 })
    }

    // Attach leads to the campaign if provided
    if (lead_ids && lead_ids.length > 0) {
      const { error: leadError } = await supabase
        .from('leads')
        .update({ campaign_id: campaign.id, retry_count: 0, scheduled_after: null })
        .in('id', lead_ids)

      if (leadError) {
        console.error('[API] Failed to attach leads to campaign:', leadError.message)
      }
    }

    return NextResponse.json({ campaign }, { status: 201 })
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
}
