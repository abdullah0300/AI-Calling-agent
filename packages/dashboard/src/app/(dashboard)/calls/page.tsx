'use client'

import { useCallback, useEffect, useState } from 'react'
import { CallsTable } from '@/components/dashboard/CallsTable'
import { Button } from '@/components/ui/button'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Input } from '@/components/ui/input'
import { Download, RefreshCw, Phone, Filter, X } from 'lucide-react'

const outcomeOptions = [
  { value: 'all',           label: 'All Outcomes' },
  { value: 'interested',    label: '🎯 Interested' },
  { value: 'not_interested',label: '👎 Not Interested' },
  { value: 'callback',      label: '📅 Callback Requested' },
  { value: 'wrong_person',  label: '🔄 Wrong Person' },
  { value: 'no_answer',     label: '📵 No Answer' },
  { value: 'voicemail',     label: '📬 Voicemail' },
  { value: 'error',         label: '⚠️ Error' },
]

export default function CallsPage() {
  const [calls, setCalls]     = useState<any[]>([])
  const [loading, setLoading] = useState(true)
  const [outcome, setOutcome] = useState('all')
  const [date, setDate]       = useState('')

  const fetchCalls = useCallback(async () => {
    setLoading(true)
    const params = new URLSearchParams({ limit: '100' })
    if (outcome !== 'all') params.set('outcome', outcome)
    if (date) params.set('date', date)
    const res = await fetch(`/api/calls?${params}`)
    const data = await res.json()
    setCalls(data.calls || [])
    setLoading(false)
  }, [outcome, date])

  useEffect(() => { fetchCalls() }, [fetchCalls])

  const hasFilters = outcome !== 'all' || date !== ''

  function clearFilters() {
    setOutcome('all')
    setDate('')
  }

  /* Quick stats from loaded data */
  const interestedCount = calls.filter(c => c.outcome === 'interested').length
  const callbackCount   = calls.filter(c => c.outcome === 'callback').length
  const totalCost       = calls.reduce((sum, c) => sum + (c.cost_total || 0), 0)
  const successRate     = calls.length > 0
    ? ((interestedCount / calls.length) * 100).toFixed(0)
    : '0'

  function exportCSV() {
    const headers = [
      'Business','Phone','Agent','Status','Outcome',
      'Duration (s)','Cost Telephony ($)','Cost STT ($)',
      'Cost TTS ($)','Cost LLM ($)','Cost Total ($)','Created At',
    ]
    const rows = calls.map(c => [
      c.leads?.business_name || '',
      c.leads?.phone_number  || '',
      c.agents?.name         || '',
      c.status,
      c.outcome              || '',
      c.duration_seconds     || '',
      c.cost_telephony       ?? '',
      c.cost_stt             ?? '',
      c.cost_tts             ?? '',
      c.cost_llm             ?? '',
      c.cost_total           ?? '',
      c.created_at,
    ])
    const csv  = [headers, ...rows].map(r => r.map(String).join(',')).join('\n')
    const blob = new Blob([csv], { type: 'text/csv' })
    const url  = URL.createObjectURL(blob)
    const a    = document.createElement('a')
    a.href     = url
    a.download = `calls-${new Date().toISOString().split('T')[0]}.csv`
    a.click()
    URL.revokeObjectURL(url)
  }

  return (
    <div className="space-y-6 max-w-7xl">
      {/* ── Header ── */}
      <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-4">
        <div>
          <div className="flex items-center gap-2 mb-2">
            <Phone className="h-4 w-4 text-blue-600" />
            <span className="text-xs font-semibold text-blue-600 uppercase tracking-widest">
              Call Log
            </span>
          </div>
          <h1 className="text-3xl font-bold text-slate-900">Calls</h1>
          <p className="text-slate-500 mt-1 text-sm">
            Full history of all outbound calls across every agent
          </p>
        </div>
        <div className="flex gap-2 self-start">
          <Button
            variant="outline"
            size="sm"
            onClick={fetchCalls}
            disabled={loading}
          >
            <RefreshCw className={`h-4 w-4 mr-2 ${loading ? 'animate-spin' : ''}`} />
            Refresh
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={exportCSV}
            disabled={calls.length === 0}
          >
            <Download className="h-4 w-4 mr-2" />
            Export CSV
          </Button>
        </div>
      </div>

      {/* ── Quick stats ── */}
      {!loading && calls.length > 0 && (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          {[
            { label: 'Calls showing', value: calls.length,         sub: hasFilters ? 'filtered results' : 'total loaded' },
            { label: 'Interested',    value: interestedCount,       sub: `${successRate}% success rate` },
            { label: 'Callbacks',     value: callbackCount,         sub: 'follow-ups needed' },
            { label: 'Total spend',   value: `$${totalCost.toFixed(4)}`, sub: 'combined call cost' },
          ].map(({ label, value, sub }) => (
            <div
              key={label}
              className="bg-white rounded-xl border border-slate-200 px-4 py-3 shadow-sm"
            >
              <div className="text-[10px] uppercase font-semibold text-slate-400 tracking-wider">
                {label}
              </div>
              <div className="text-xl font-bold text-slate-900 mt-0.5">{value}</div>
              <div className="text-xs text-slate-400">{sub}</div>
            </div>
          ))}
        </div>
      )}

      {/* ── Filters ── */}
      <div className="bg-white rounded-xl border border-slate-200 shadow-sm p-4">
        <div className="flex items-center gap-2 mb-3">
          <Filter className="h-4 w-4 text-slate-400" />
          <span className="text-sm font-semibold text-slate-700">Filters</span>
          {hasFilters && (
            <button
              onClick={clearFilters}
              className="ml-auto flex items-center gap-1 text-xs text-slate-500 hover:text-slate-700 transition-colors"
            >
              <X className="h-3.5 w-3.5" />
              Clear
            </button>
          )}
        </div>
        <div className="flex flex-wrap gap-3">
          <div className="flex-1 min-w-[180px] max-w-[240px]">
            <label className="text-xs font-medium text-slate-500 mb-1.5 block">
              Outcome
            </label>
            <Select value={outcome} onValueChange={setOutcome}>
              <SelectTrigger className="bg-slate-50 text-sm">
                <SelectValue placeholder="All Outcomes" />
              </SelectTrigger>
              <SelectContent>
                {outcomeOptions.map(opt => (
                  <SelectItem key={opt.value} value={opt.value}>
                    {opt.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div>
            <label className="text-xs font-medium text-slate-500 mb-1.5 block">
              Date
            </label>
            <Input
              type="date"
              value={date}
              onChange={e => setDate(e.target.value)}
              className="w-44 bg-slate-50 text-sm"
            />
          </div>
        </div>
      </div>

      {/* ── Table / Loading ── */}
      {loading ? (
        <div className="bg-white rounded-xl border border-slate-200 p-16 text-center">
          <div className="w-12 h-12 bg-blue-100 rounded-2xl flex items-center justify-center mx-auto mb-4 animate-pulse">
            <Phone className="h-6 w-6 text-blue-600" />
          </div>
          <p className="text-slate-500 text-sm">Loading calls…</p>
        </div>
      ) : (
        <CallsTable calls={calls} />
      )}
    </div>
  )
}
