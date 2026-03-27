'use client'

import { useEffect, useState, useCallback } from 'react'
import { Activity, Phone, TrendingUp, DollarSign, Clock, Mic, MicOff, Loader2, RefreshCw, AlertTriangle } from 'lucide-react'
import { cn } from '@/lib/utils'

// ─── Types ─────────────────────────────────────────────────────────────────

interface LiveSession {
  callControlId:  string
  callId:         string
  leadName:       string
  phoneNumber:    string
  agentName:      string
  campaignId:     string | null
  isSpeaking:     boolean
  isProcessing:   boolean
  turnCount:      number
  elapsedSeconds: number
  costLlm:        number
  costTts:        number
  costStt:        number
  avgLatencyMs:   number | null
}

interface TodayStats {
  total:        number
  completed:    number
  interested:   number
  noAnswer:     number
  totalCostUsd: number
  avgDurationS: number
}

interface CampaignStat {
  id:            string
  name:          string
  maxConcurrent: number
  leadsPending:  number
  leadsCalling:  number
  leadsDone:     number
  leadsTotal:    number
  progressPct:   number
}

interface BargeInAnalytics {
  total:            number
  false:            number
  falsePositiveRate: number
}

interface MonitoringData {
  live:             { activeCalls: number; sessions: LiveSession[] }
  todayStats:       TodayStats
  campaigns:        CampaignStat[]
  bargeInAnalytics: BargeInAnalytics
  fetchedAt:        string
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function fmtDuration(seconds: number): string {
  const m = Math.floor(seconds / 60)
  const s = seconds % 60
  return `${m}:${String(s).padStart(2, '0')}`
}

function fmtCost(usd: number): string {
  return `$${usd.toFixed(4)}`
}

function fmtUsd(usd: number): string {
  return usd >= 1 ? `$${usd.toFixed(2)}` : `$${usd.toFixed(4)}`
}

// ─── Sub-components ─────────────────────────────────────────────────────────

function StatCard({ label, value, sub, icon: Icon, accent }: {
  label: string
  value: string | number
  sub?: string
  icon: React.ElementType
  accent?: string
}) {
  return (
    <div className="bg-white rounded-xl border border-slate-200 p-4 flex items-start gap-3">
      <div className={cn('w-10 h-10 rounded-lg flex items-center justify-center shrink-0', accent ?? 'bg-blue-50')}>
        <Icon className={cn('h-5 w-5', accent ? 'text-white' : 'text-blue-600')} />
      </div>
      <div className="min-w-0">
        <p className="text-xs text-slate-500 font-medium">{label}</p>
        <p className="text-2xl font-bold text-slate-900 leading-tight">{value}</p>
        {sub && <p className="text-xs text-slate-400 mt-0.5">{sub}</p>}
      </div>
    </div>
  )
}

function LiveCallRow({ s }: { s: LiveSession }) {
  const statusColor = s.isSpeaking
    ? 'bg-green-100 text-green-700'
    : s.isProcessing
    ? 'bg-amber-100 text-amber-700'
    : 'bg-slate-100 text-slate-600'

  const statusLabel = s.isSpeaking ? 'Speaking' : s.isProcessing ? 'Thinking' : 'Listening'
  const totalCost   = s.costLlm + s.costTts + s.costStt

  return (
    <tr className="border-b border-slate-100 hover:bg-slate-50 transition-colors">
      <td className="px-4 py-3">
        <div className="font-medium text-slate-800 text-sm">{s.leadName}</div>
        <div className="text-xs text-slate-400">{s.phoneNumber}</div>
      </td>
      <td className="px-4 py-3 text-sm text-slate-600">{s.agentName}</td>
      <td className="px-4 py-3">
        <span className={cn('inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-xs font-medium', statusColor)}>
          {s.isSpeaking ? <Mic className="h-3 w-3" /> : s.isProcessing ? <Loader2 className="h-3 w-3 animate-spin" /> : <MicOff className="h-3 w-3" />}
          {statusLabel}
        </span>
      </td>
      <td className="px-4 py-3 text-sm tabular-nums text-slate-700">{fmtDuration(s.elapsedSeconds)}</td>
      <td className="px-4 py-3 text-sm tabular-nums text-slate-600">{s.turnCount}</td>
      <td className="px-4 py-3 text-sm tabular-nums text-slate-600">
        {s.avgLatencyMs != null ? `${s.avgLatencyMs}ms` : '—'}
      </td>
      <td className="px-4 py-3 text-sm tabular-nums text-slate-600">{fmtCost(totalCost)}</td>
    </tr>
  )
}

function CampaignRow({ c }: { c: CampaignStat }) {
  return (
    <div className="bg-white rounded-xl border border-slate-200 p-4">
      <div className="flex items-center justify-between mb-2">
        <div>
          <p className="font-semibold text-slate-800 text-sm">{c.name}</p>
          <p className="text-xs text-slate-400 mt-0.5">
            {c.leadsCalling} active · {c.leadsPending} pending · {c.leadsDone} done
          </p>
        </div>
        <span className="text-sm font-bold text-blue-600">{c.progressPct}%</span>
      </div>
      <div className="h-2 bg-slate-100 rounded-full overflow-hidden">
        <div
          className="h-full bg-blue-500 rounded-full transition-all duration-500"
          style={{ width: `${c.progressPct}%` }}
        />
      </div>
      <p className="text-xs text-slate-400 mt-1.5">{c.leadsDone} / {c.leadsTotal} leads completed</p>
    </div>
  )
}

// ─── Page ────────────────────────────────────────────────────────────────────

export default function MonitoringPage() {
  const [data, setData]       = useState<MonitoringData | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError]     = useState<string | null>(null)
  const [lastRefresh, setLastRefresh] = useState<Date | null>(null)

  const fetchData = useCallback(async () => {
    try {
      const res = await fetch('/api/monitoring')
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const json = await res.json()
      setData(json)
      setError(null)
      setLastRefresh(new Date())
    } catch (e: any) {
      setError(e.message ?? 'Failed to fetch monitoring data')
    } finally {
      setLoading(false)
    }
  }, [])

  // Initial fetch + 5-second auto-refresh
  useEffect(() => {
    fetchData()
    const interval = setInterval(fetchData, 5000)
    return () => clearInterval(interval)
  }, [fetchData])

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64 gap-2 text-slate-500">
        <Loader2 className="h-5 w-5 animate-spin" />
        <span className="text-sm">Loading monitoring data…</span>
      </div>
    )
  }

  if (error && !data) {
    return (
      <div className="flex flex-col items-center justify-center h-64 gap-3 text-slate-500">
        <AlertTriangle className="h-8 w-8 text-amber-400" />
        <p className="text-sm font-medium">Could not load monitoring data</p>
        <p className="text-xs text-slate-400">{error}</p>
        <button
          onClick={fetchData}
          className="mt-2 flex items-center gap-1.5 text-xs bg-slate-100 hover:bg-slate-200 px-3 py-1.5 rounded-lg transition-colors"
        >
          <RefreshCw className="h-3.5 w-3.5" /> Retry
        </button>
      </div>
    )
  }

  const { live, todayStats, campaigns, bargeInAnalytics } = data!

  return (
    <div className="space-y-6">

      {/* ── Header ── */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold text-slate-900">Live Monitoring</h1>
          <p className="text-sm text-slate-400 mt-0.5">Auto-refreshes every 5 seconds</p>
        </div>
        <div className="flex items-center gap-2">
          {error && (
            <span className="text-xs text-amber-600 bg-amber-50 border border-amber-200 rounded-lg px-2.5 py-1">
              Stale data — ws-server unreachable
            </span>
          )}
          {lastRefresh && (
            <span className="text-xs text-slate-400">
              Updated {lastRefresh.toLocaleTimeString()}
            </span>
          )}
          <button
            onClick={fetchData}
            className="p-2 rounded-lg hover:bg-slate-100 text-slate-500 transition-colors"
            title="Refresh now"
          >
            <RefreshCw className="h-4 w-4" />
          </button>
        </div>
      </div>

      {/* ── Stats cards ── */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
        <StatCard
          label="Active Calls"
          value={live.activeCalls}
          icon={Activity}
          accent="bg-green-500"
        />
        <StatCard
          label="Today's Calls"
          value={todayStats.total}
          sub={`${todayStats.completed} completed`}
          icon={Phone}
        />
        <StatCard
          label="Interested"
          value={todayStats.interested}
          sub={todayStats.total > 0 ? `${Math.round((todayStats.interested / todayStats.total) * 100)}% rate` : '—'}
          icon={TrendingUp}
        />
        <StatCard
          label="No Answer"
          value={todayStats.noAnswer}
          icon={MicOff}
        />
        <StatCard
          label="Today's Cost"
          value={fmtUsd(todayStats.totalCostUsd)}
          icon={DollarSign}
        />
        <StatCard
          label="Avg Duration"
          value={fmtDuration(todayStats.avgDurationS)}
          icon={Clock}
        />
      </div>

      {/* ── Live calls table ── */}
      <div className="bg-white rounded-xl border border-slate-200 overflow-hidden">
        <div className="px-4 py-3 border-b border-slate-100 flex items-center gap-2">
          <div className={cn('w-2 h-2 rounded-full', live.activeCalls > 0 ? 'bg-green-500 animate-pulse' : 'bg-slate-300')} />
          <h2 className="text-sm font-semibold text-slate-800">
            Active Calls
            <span className="ml-2 text-xs font-normal text-slate-400">({live.activeCalls})</span>
          </h2>
        </div>

        {live.sessions.length === 0 ? (
          <div className="text-center py-12 text-slate-400 text-sm">
            No active calls right now
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="text-xs text-slate-400 uppercase tracking-wide border-b border-slate-100">
                  <th className="px-4 py-2.5 text-left font-medium">Lead</th>
                  <th className="px-4 py-2.5 text-left font-medium">Agent</th>
                  <th className="px-4 py-2.5 text-left font-medium">Status</th>
                  <th className="px-4 py-2.5 text-left font-medium">Duration</th>
                  <th className="px-4 py-2.5 text-left font-medium">Turns</th>
                  <th className="px-4 py-2.5 text-left font-medium">Latency</th>
                  <th className="px-4 py-2.5 text-left font-medium">Cost</th>
                </tr>
              </thead>
              <tbody>
                {live.sessions.map(s => <LiveCallRow key={s.callControlId} s={s} />)}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* ── Running campaigns ── */}
      {campaigns.length > 0 && (
        <div>
          <h2 className="text-sm font-semibold text-slate-800 mb-3">Running Campaigns</h2>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
            {campaigns.map(c => <CampaignRow key={c.id} c={c} />)}
          </div>
        </div>
      )}

      {/* ── Barge-in analytics ── */}
      <div className="bg-white rounded-xl border border-slate-200 p-4">
        <h2 className="text-sm font-semibold text-slate-800 mb-3">Today's Barge-in Analytics</h2>
        <div className="grid grid-cols-3 gap-4 text-center">
          <div>
            <p className="text-2xl font-bold text-slate-900">{bargeInAnalytics.total}</p>
            <p className="text-xs text-slate-400 mt-0.5">Total barge-ins</p>
          </div>
          <div>
            <p className="text-2xl font-bold text-slate-900">{bargeInAnalytics.false}</p>
            <p className="text-xs text-slate-400 mt-0.5">False positives</p>
          </div>
          <div>
            <p className={cn('text-2xl font-bold', bargeInAnalytics.falsePositiveRate > 20 ? 'text-amber-500' : 'text-green-600')}>
              {bargeInAnalytics.falsePositiveRate}%
            </p>
            <p className="text-xs text-slate-400 mt-0.5">False-positive rate</p>
          </div>
        </div>
        {bargeInAnalytics.falsePositiveRate > 20 && (
          <div className="mt-3 flex items-start gap-2 text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
            <AlertTriangle className="h-3.5 w-3.5 mt-0.5 shrink-0" />
            High false-positive rate detected. Consider raising the VAD energy threshold or minimum speech duration.
          </div>
        )}
      </div>
    </div>
  )
}
