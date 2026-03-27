import { NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

const WS_URL = process.env.WS_PUBLIC_URL || process.env.WS_INTERNAL_URL || 'http://localhost:4000'

export async function GET() {
  // Today's date range (UTC midnight boundaries)
  const todayStart = new Date()
  todayStart.setUTCHours(0, 0, 0, 0)
  const todayEnd = new Date()
  todayEnd.setUTCHours(23, 59, 59, 999)

  const [liveRes, todayCallsRes, campaignsRes, bargeInRes] = await Promise.allSettled([
    // 1. Live sessions from ws-server
    fetch(`${WS_URL}/monitoring/live`, { signal: AbortSignal.timeout(3000) })
      .then(r => r.ok ? r.json() : { activeCalls: 0, sessions: [] }),

    // 2. Today's call stats from DB
    supabase
      .from('calls')
      .select('id, outcome, duration_seconds, cost_total, cost_llm, cost_tts, cost_stt, cost_telephony, started_at')
      .gte('created_at', todayStart.toISOString())
      .lte('created_at', todayEnd.toISOString()),

    // 3. Running campaigns with lead progress
    supabase
      .from('campaigns')
      .select('id, name, max_concurrent_calls')
      .eq('status', 'running'),

    // 4. Today's barge-in events for false-positive analytics
    supabase
      .from('barge_in_events')
      .select('outcome')
      .gte('fired_at', todayStart.toISOString())
      .lte('fired_at', todayEnd.toISOString()),
  ])

  // ── Live sessions ──────────────────────────────────────────────────────────
  const live = liveRes.status === 'fulfilled' ? liveRes.value : { activeCalls: 0, sessions: [] }

  // ── Today stats ────────────────────────────────────────────────────────────
  const todayCalls = todayCallsRes.status === 'fulfilled' && !todayCallsRes.value.error
    ? todayCallsRes.value.data ?? []
    : []

  const todayStats = {
    total:        todayCalls.length,
    completed:    todayCalls.filter((c: any) => c.outcome && c.outcome !== 'error').length,
    interested:   todayCalls.filter((c: any) => c.outcome === 'interested').length,
    noAnswer:     todayCalls.filter((c: any) => c.outcome === 'no_answer' || c.outcome === 'voicemail').length,
    totalCostUsd: todayCalls.reduce((s: number, c: any) => s + (c.cost_total ?? 0), 0),
    avgDurationS: todayCalls.length
      ? Math.round(todayCalls.reduce((s: number, c: any) => s + (c.duration_seconds ?? 0), 0) / todayCalls.length)
      : 0,
  }

  // ── Running campaigns ──────────────────────────────────────────────────────
  const runningCampaigns = campaignsRes.status === 'fulfilled' && !campaignsRes.value.error
    ? campaignsRes.value.data ?? []
    : []

  // Fetch lead counts per campaign in parallel
  const campaignStats = await Promise.all(
    runningCampaigns.map(async (c: any) => {
      const [pending, calling, done] = await Promise.all([
        supabase.from('leads').select('id', { count: 'exact', head: true }).eq('campaign_id', c.id).eq('status', 'pending'),
        supabase.from('leads').select('id', { count: 'exact', head: true }).eq('campaign_id', c.id).eq('status', 'calling'),
        supabase.from('leads').select('id', { count: 'exact', head: true }).eq('campaign_id', c.id)
          .in('status', ['interested', 'not_interested', 'callback', 'wrong_person', 'no_answer', 'error']),
      ])
      const total = (pending.count ?? 0) + (calling.count ?? 0) + (done.count ?? 0)
      return {
        id:              c.id,
        name:            c.name,
        maxConcurrent:   c.max_concurrent_calls,
        leadsPending:    pending.count ?? 0,
        leadsCalling:    calling.count ?? 0,
        leadsDone:       done.count    ?? 0,
        leadsTotal:      total,
        progressPct:     total > 0 ? Math.round(((done.count ?? 0) / total) * 100) : 0,
      }
    })
  )

  // ── Barge-in analytics ─────────────────────────────────────────────────────
  const bargeIns = bargeInRes.status === 'fulfilled' && !bargeInRes.value.error
    ? bargeInRes.value.data ?? []
    : []

  const totalBargeIns = bargeIns.length
  const falseBargeIns = bargeIns.filter((b: any) => b.outcome === 'false').length
  const falsePositiveRate = totalBargeIns > 0
    ? Math.round((falseBargeIns / totalBargeIns) * 100)
    : 0

  return NextResponse.json({
    live,
    todayStats,
    campaigns: campaignStats,
    bargeInAnalytics: { total: totalBargeIns, false: falseBargeIns, falsePositiveRate },
    fetchedAt: new Date().toISOString(),
  })
}
