import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { z } from 'zod'

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

const patchCampaignSchema = z.object({
  name:                 z.string().min(1).optional(),
  status:               z.enum(['running', 'paused', 'completed']).optional(),
  max_concurrent_calls: z.number().int().min(1).max(20).optional(),
  calls_per_minute:     z.number().int().min(1).max(60).optional(),
  retry_attempts:       z.number().int().min(0).max(5).optional(),
  retry_delay_minutes:  z.number().int().min(5).max(1440).optional(),
  retry_outcomes:       z.array(z.string()).optional(),
}).refine(data => Object.keys(data).length > 0, { message: 'At least one field required' })

// GET /api/campaigns/[id] — campaign details + live stats
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params
    const { data: campaign, error } = await supabase
      .from('campaigns')
      .select(`*, agents(name, greeting_message), phone_numbers(number, label)`)
      .eq('id', id)
      .single()

    if (error || !campaign) {
      return NextResponse.json({ error: 'Campaign not found' }, { status: 404 })
    }

    // Lead breakdown by status for progress display
    const { data: leads } = await supabase
      .from('leads')
      .select('id, status, retry_count, scheduled_after, business_name, phone_number')
      .eq('campaign_id', id)

    const stats = {
      total:         leads?.length ?? 0,
      pending:       leads?.filter(l => l.status === 'pending').length  ?? 0,
      calling:       leads?.filter(l => l.status === 'calling').length  ?? 0,
      interested:    leads?.filter(l => l.status === 'interested').length   ?? 0,
      not_interested:leads?.filter(l => l.status === 'not_interested').length ?? 0,
      callback:      leads?.filter(l => l.status === 'callback').length ?? 0,
      no_answer:     leads?.filter(l => l.status === 'no_answer').length ?? 0,
      wrong_person:  leads?.filter(l => l.status === 'wrong_person').length ?? 0,
      error:         leads?.filter(l => l.status === 'error').length    ?? 0,
    }

    // Cost rollup across all calls in this campaign
    const { data: costRows } = await supabase
      .from('calls')
      .select('cost_total')
      .eq('campaign_id', id)
      .eq('status', 'completed')

    const totalCost = (costRows || []).reduce((sum, r) => sum + (r.cost_total ?? 0), 0)

    return NextResponse.json({ campaign, stats, total_cost: totalCost })
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
}

// PATCH /api/campaigns/[id] — update settings or transition status
// Status transitions allowed:
//   draft → running         (start)
//   running → paused        (pause)
//   paused → running        (resume)
//   running|paused → completed (force stop)
export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params
    const body = await req.json()
    const parsed = patchCampaignSchema.safeParse(body)
    if (!parsed.success) {
      return NextResponse.json({ error: 'Invalid request', details: parsed.error.flatten() }, { status: 400 })
    }

    const updates: Record<string, any> = { ...parsed.data }

    // Set timestamp fields based on status transition
    const now = new Date().toISOString()
    if (updates.status === 'running')   updates.started_at   = now
    if (updates.status === 'paused')    updates.paused_at    = now
    if (updates.status === 'completed') updates.completed_at = now

    const { data: campaign, error } = await supabase
      .from('campaigns')
      .update(updates)
      .eq('id', id)
      .select()
      .single()

    if (error || !campaign) {
      return NextResponse.json({ error: error?.message || 'Campaign not found' }, { status: 404 })
    }

    return NextResponse.json({ campaign })
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
}

// DELETE /api/campaigns/[id] — remove campaign (only if draft or completed)
export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params
    const { data: campaign } = await supabase
      .from('campaigns')
      .select('status')
      .eq('id', id)
      .single()

    if (!campaign) {
      return NextResponse.json({ error: 'Campaign not found' }, { status: 404 })
    }
    if (campaign.status === 'running' || campaign.status === 'paused') {
      return NextResponse.json(
        { error: 'Cannot delete a running or paused campaign. Stop it first.' },
        { status: 409 }
      )
    }

    // Detach leads before deleting (nullify campaign_id so leads aren't lost)
    await supabase.from('leads').update({ campaign_id: null }).eq('campaign_id', id)

    const { error } = await supabase.from('campaigns').delete().eq('id', id)
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })

    return NextResponse.json({ success: true })
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
}
