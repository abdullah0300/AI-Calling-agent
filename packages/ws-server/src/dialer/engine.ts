// ─── Batch Dialer Engine ──────────────────────────────────────────────────────
// Polls the DB every TICK_INTERVAL_MS for campaigns with status='running'.
// For each running campaign, fills available call slots up to max_concurrent_calls
// and calls_per_minute limits. Co-located in ws-server so it has direct access to
// the activeSessions map (for accurate concurrency counts) and can call
// registerSession without an HTTP round-trip.
//
// Retry scheduling: when endSession saves a no_answer/voicemail outcome and the
// lead's campaign still has retries left, the lead is reset to 'pending' with
// scheduled_after = now + retry_delay_minutes. The dialer skips leads where
// scheduled_after > now, so they reappear in the queue automatically.

import { supabase } from '../db/client'
import { loadSettings } from '../db/settings'
import { activeSessions, registerSession } from '../agent/pipeline'
import type { CallSession } from '@voiceflow/shared'

const TICK_INTERVAL_MS = 5_000  // how often to check for pending calls

export function startDialerLoop(): void {
  console.log('[Dialer] Batch dialer started — polling every 5s for running campaigns')
  setInterval(dialerTick, TICK_INTERVAL_MS)
}

// ─── Main tick ───────────────────────────────────────────────────────────────

async function dialerTick(): Promise<void> {
  try {
    const { data: campaigns } = await supabase
      .from('campaigns')
      .select(`*, agents(*), phone_numbers(*)`)
      .eq('status', 'running')

    if (!campaigns?.length) return

    // Process campaigns in parallel — each is independent
    await Promise.all(campaigns.map(processCampaign))
  } catch (err) {
    console.error('[Dialer] Tick error:', err)
  }
}

// ─── Per-campaign slot management ────────────────────────────────────────────

async function processCampaign(campaign: any): Promise<void> {
  if (!campaign.agents || !campaign.phone_numbers) {
    console.warn(`[Dialer] Campaign ${campaign.id} missing agent or phone number — skipping`)
    return
  }

  // Count calls currently active (in-flight) for this campaign
  const activeCampaignCalls = [...activeSessions.values()]
    .filter(s => s.session.campaignId === campaign.id).length

  if (activeCampaignCalls >= campaign.max_concurrent_calls) return

  // Rate limit: count calls initiated for this campaign in the last 60 seconds
  const minuteAgo = new Date(Date.now() - 60_000).toISOString()
  const { count: recentCount } = await supabase
    .from('calls')
    .select('id', { count: 'exact', head: true })
    .eq('campaign_id', campaign.id)
    .gte('created_at', minuteAgo)

  if ((recentCount ?? 0) >= campaign.calls_per_minute) return

  // Slots = min(concurrency headroom, rate headroom)
  const slotsAvailable = Math.min(
    campaign.max_concurrent_calls - activeCampaignCalls,
    campaign.calls_per_minute - (recentCount ?? 0)
  )

  for (let i = 0; i < slotsAvailable; i++) {
    const result = await dispatchNextLead(campaign)
    if (result === 'no_leads') {
      await checkCampaignCompletion(campaign.id, campaign.name)
      break
    }
    // result === 'dispatched' | 'lock_failed' — continue loop or break
    if (result === 'lock_failed') break
  }
}

// ─── Lead dispatch ───────────────────────────────────────────────────────────

type DispatchResult = 'dispatched' | 'no_leads' | 'lock_failed'

async function dispatchNextLead(campaign: any): Promise<DispatchResult> {
  const now = new Date().toISOString()

  // Fetch the next lead that is pending and past its scheduled_after window
  const { data: lead } = await supabase
    .from('leads')
    .select('*')
    .eq('campaign_id', campaign.id)
    .eq('status', 'pending')
    .or(`scheduled_after.is.null,scheduled_after.lte.${now}`)
    .order('scheduled_after', { ascending: true, nullsFirst: true })
    .limit(1)
    .maybeSingle()

  if (!lead) return 'no_leads'

  // Optimistic lock: transition pending → calling atomically.
  // If two ticks somehow race (multiple ws-server instances), only one wins.
  const { error: lockError, count } = await supabase
    .from('leads')
    .update({ status: 'calling' })
    .eq('id', lead.id)
    .eq('status', 'pending')  // only update if still pending
    .select('id', { count: 'exact', head: true })

  if (lockError || (count ?? 0) === 0) {
    // Another process claimed this lead between SELECT and UPDATE
    console.warn(`[Dialer] Lead ${lead.id} already claimed — skipping`)
    return 'lock_failed'
  }

  try {
    await placeCall(campaign, lead)
    return 'dispatched'
  } catch (err) {
    console.error(`[Dialer] Call dispatch failed for lead ${lead.id}:`, err)
    // Reset lead so it can be retried on the next tick
    await supabase.from('leads').update({ status: 'pending' }).eq('id', lead.id)
    return 'lock_failed'
  }
}

// ─── Telnyx call initiation ──────────────────────────────────────────────────

async function placeCall(campaign: any, lead: any): Promise<void> {
  const settings = await loadSettings()
  const wsPublicUrl = process.env.WS_PUBLIC_URL || ''

  if (!settings.telnyx_api_key || !settings.telnyx_connection_id) {
    throw new Error('Telnyx API key or connection ID not configured in Settings')
  }
  if (!wsPublicUrl) {
    throw new Error('WS_PUBLIC_URL environment variable not set')
  }

  const agent       = campaign.agents
  const phoneNumber = campaign.phone_numbers

  // Create call record in DB — campaign_id links the call to the campaign
  const { data: callRecord, error: callError } = await supabase
    .from('calls')
    .insert({
      lead_id:         lead.id,
      agent_id:        campaign.agent_id,
      phone_number_id: campaign.phone_number_id,
      campaign_id:     campaign.id,
      status:          'initiated',
    })
    .select()
    .single()

  if (callError || !callRecord) {
    throw new Error(`DB call record creation failed: ${callError?.message}`)
  }

  // Initiate Telnyx outbound call — same payload as dashboard POST /api/calls
  const telnyxRes = await fetch('https://api.telnyx.com/v2/calls', {
    method: 'POST',
    headers: {
      'Content-Type':  'application/json',
      'Authorization': `Bearer ${settings.telnyx_api_key}`,
    },
    body: JSON.stringify({
      connection_id:             settings.telnyx_connection_id,
      to:                        lead.phone_number,
      from:                      phoneNumber.number,
      client_state:              Buffer.from(JSON.stringify({ callId: callRecord.id })).toString('base64'),
      webhook_url:               `${wsPublicUrl}/api/webhook/telnyx`,
      webhook_url_method:        'POST',
      stream_url:                `${wsPublicUrl.replace('https://', 'wss://')}/audio`,
      stream_track:              'inbound_track',
      stream_bidirectional_mode: 'mp3',
    }),
  })

  if (!telnyxRes.ok) {
    const errBody = await telnyxRes.text()
    await supabase.from('calls').update({ status: 'failed' }).eq('id', callRecord.id)
    throw new Error(`Telnyx API ${telnyxRes.status}: ${errBody}`)
  }

  const telnyxData    = await telnyxRes.json()
  const callControlId = telnyxData.data.call_control_id

  await supabase.from('calls')
    .update({ telephony_call_id: callControlId })
    .eq('id', callRecord.id)

  // Register session directly — no HTTP round-trip needed since we're in the same process
  const session: CallSession = {
    callId:      callRecord.id,
    leadId:      lead.id,
    agentId:     campaign.agent_id,
    agent,
    lead,
    transcript:  [],
    startTime:   new Date(),
    maxDuration: agent.max_call_duration_seconds,
    callControlId,
    campaignId:  campaign.id,
  }

  registerSession(callControlId, session)
  console.log(`[Dialer] Placed call — campaign: "${campaign.name}" | lead: ${lead.business_name} (${lead.phone_number}) | retry: ${lead.retry_count}`)
}

// ─── Campaign completion check ───────────────────────────────────────────────

async function checkCampaignCompletion(campaignId: string, campaignName: string): Promise<void> {
  // A campaign is complete when no leads are pending or currently being called
  const { count } = await supabase
    .from('leads')
    .select('id', { count: 'exact', head: true })
    .eq('campaign_id', campaignId)
    .in('status', ['pending', 'calling'])

  if ((count ?? 0) === 0) {
    await supabase.from('campaigns')
      .update({ status: 'completed', completed_at: new Date().toISOString() })
      .eq('id', campaignId)
    console.log(`[Dialer] Campaign "${campaignName}" (${campaignId}) completed — all leads processed`)
  }
}
