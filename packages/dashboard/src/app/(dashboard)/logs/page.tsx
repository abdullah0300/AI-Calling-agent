'use client'

import { useEffect, useState, useCallback } from 'react'
import { AlertTriangle, AlertCircle, Info, RefreshCw, Trash2, Loader2, Filter } from 'lucide-react'
import { cn } from '@/lib/utils'

// ─── Types ────────────────────────────────────────────────────────────────────

interface ServerLog {
  id:         string
  level:      'info' | 'warn' | 'error'
  source:     string
  message:    string
  context:    Record<string, unknown> | null
  call_id:    string | null
  created_at: string
}

const SOURCES = ['pipeline', 'dialer', 'stt', 'tts', 'recording', 'webhook', 'server', 'noise']
const LEVELS  = ['error', 'warn', 'info'] as const

// ─── Helpers ──────────────────────────────────────────────────────────────────

function levelStyle(level: string) {
  if (level === 'error') return 'bg-red-100 text-red-700 border-red-200'
  if (level === 'warn')  return 'bg-amber-100 text-amber-700 border-amber-200'
  return 'bg-blue-50 text-blue-600 border-blue-200'
}

function levelIcon(level: string) {
  if (level === 'error') return <AlertCircle className="h-3.5 w-3.5" />
  if (level === 'warn')  return <AlertTriangle className="h-3.5 w-3.5" />
  return <Info className="h-3.5 w-3.5" />
}

function rowBg(level: string) {
  if (level === 'error') return 'bg-red-50/40 hover:bg-red-50'
  if (level === 'warn')  return 'hover:bg-amber-50/40'
  return 'hover:bg-slate-50'
}

function fmtTime(iso: string) {
  const d = new Date(iso)
  return d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit' })
}

function fmtDate(iso: string) {
  return new Date(iso).toLocaleDateString('en-GB', { day: '2-digit', month: 'short' })
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function LogsPage() {
  const [logs, setLogs]           = useState<ServerLog[]>([])
  const [loading, setLoading]     = useState(true)
  const [levelFilter, setLevelFilter] = useState<string>('')
  const [sourceFilter, setSourceFilter] = useState<string>('')
  const [expanded, setExpanded]   = useState<string | null>(null)
  const [clearing, setClearing]   = useState(false)
  const [lastRefresh, setLastRefresh] = useState<Date | null>(null)

  const fetchLogs = useCallback(async () => {
    const params = new URLSearchParams({ limit: '300' })
    if (levelFilter)  params.set('level', levelFilter)
    if (sourceFilter) params.set('source', sourceFilter)
    const res = await fetch(`/api/logs?${params}`)
    if (res.ok) {
      const data = await res.json()
      setLogs(data.logs)
      setLastRefresh(new Date())
    }
    setLoading(false)
  }, [levelFilter, sourceFilter])

  useEffect(() => {
    setLoading(true)
    fetchLogs()
  }, [fetchLogs])

  // 10-second auto-refresh
  useEffect(() => {
    const t = setInterval(fetchLogs, 10_000)
    return () => clearInterval(t)
  }, [fetchLogs])

  async function clearOldLogs() {
    setClearing(true)
    await fetch('/api/logs', { method: 'DELETE' })
    await fetchLogs()
    setClearing(false)
  }

  const errorCount = logs.filter(l => l.level === 'error').length
  const warnCount  = logs.filter(l => l.level === 'warn').length

  return (
    <div className="space-y-4">

      {/* ── Header ── */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold text-slate-900">Server Logs</h1>
          <p className="text-sm text-slate-400 mt-0.5">Application errors and warnings — auto-refreshes every 10s</p>
        </div>
        <div className="flex items-center gap-2">
          {lastRefresh && (
            <span className="text-xs text-slate-400 hidden sm:block">
              Updated {lastRefresh.toLocaleTimeString()}
            </span>
          )}
          <button
            onClick={fetchLogs}
            className="p-2 rounded-lg hover:bg-slate-100 text-slate-500 transition-colors"
            title="Refresh"
          >
            <RefreshCw className="h-4 w-4" />
          </button>
          <button
            onClick={clearOldLogs}
            disabled={clearing}
            className="flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-lg border border-slate-200 hover:bg-red-50 hover:border-red-200 hover:text-red-600 text-slate-500 transition-colors"
            title="Delete logs older than 7 days"
          >
            {clearing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}
            Clear old logs
          </button>
        </div>
      </div>

      {/* ── Summary cards ── */}
      <div className="grid grid-cols-3 gap-3">
        <div className="bg-white rounded-xl border border-slate-200 p-3 flex items-center gap-3">
          <div className="w-8 h-8 bg-red-100 rounded-lg flex items-center justify-center">
            <AlertCircle className="h-4 w-4 text-red-600" />
          </div>
          <div>
            <p className="text-xl font-bold text-slate-900">{errorCount}</p>
            <p className="text-xs text-slate-400">Errors</p>
          </div>
        </div>
        <div className="bg-white rounded-xl border border-slate-200 p-3 flex items-center gap-3">
          <div className="w-8 h-8 bg-amber-100 rounded-lg flex items-center justify-center">
            <AlertTriangle className="h-4 w-4 text-amber-600" />
          </div>
          <div>
            <p className="text-xl font-bold text-slate-900">{warnCount}</p>
            <p className="text-xs text-slate-400">Warnings</p>
          </div>
        </div>
        <div className="bg-white rounded-xl border border-slate-200 p-3 flex items-center gap-3">
          <div className="w-8 h-8 bg-slate-100 rounded-lg flex items-center justify-center">
            <Info className="h-4 w-4 text-slate-500" />
          </div>
          <div>
            <p className="text-xl font-bold text-slate-900">{logs.length}</p>
            <p className="text-xs text-slate-400">Total shown</p>
          </div>
        </div>
      </div>

      {/* ── Filters ── */}
      <div className="flex items-center gap-2 flex-wrap">
        <Filter className="h-3.5 w-3.5 text-slate-400 shrink-0" />
        <select
          value={levelFilter}
          onChange={e => setLevelFilter(e.target.value)}
          className="text-xs border border-slate-200 rounded-lg px-2.5 py-1.5 bg-white text-slate-700 focus:outline-none focus:ring-2 focus:ring-blue-500"
        >
          <option value="">All levels</option>
          {LEVELS.map(l => <option key={l} value={l}>{l}</option>)}
        </select>
        <select
          value={sourceFilter}
          onChange={e => setSourceFilter(e.target.value)}
          className="text-xs border border-slate-200 rounded-lg px-2.5 py-1.5 bg-white text-slate-700 focus:outline-none focus:ring-2 focus:ring-blue-500"
        >
          <option value="">All sources</option>
          {SOURCES.map(s => <option key={s} value={s}>{s}</option>)}
        </select>
        {(levelFilter || sourceFilter) && (
          <button
            onClick={() => { setLevelFilter(''); setSourceFilter('') }}
            className="text-xs text-blue-600 hover:underline"
          >
            Clear filters
          </button>
        )}
      </div>

      {/* ── Log table ── */}
      <div className="bg-white rounded-xl border border-slate-200 overflow-hidden">
        {loading ? (
          <div className="flex items-center justify-center py-16 gap-2 text-slate-400">
            <Loader2 className="h-5 w-5 animate-spin" />
            <span className="text-sm">Loading logs…</span>
          </div>
        ) : logs.length === 0 ? (
          <div className="text-center py-16 text-slate-400 text-sm">
            No logs yet — errors and warnings from ws-server will appear here
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-xs text-slate-400 uppercase tracking-wide border-b border-slate-100">
                  <th className="px-4 py-2.5 text-left font-medium w-32">Time</th>
                  <th className="px-4 py-2.5 text-left font-medium w-20">Level</th>
                  <th className="px-4 py-2.5 text-left font-medium w-24">Source</th>
                  <th className="px-4 py-2.5 text-left font-medium">Message</th>
                </tr>
              </thead>
              <tbody>
                {logs.map(log => (
                  <>
                    <tr
                      key={log.id}
                      onClick={() => setExpanded(expanded === log.id ? null : log.id)}
                      className={cn(
                        'border-b border-slate-100 cursor-pointer transition-colors',
                        rowBg(log.level)
                      )}
                    >
                      <td className="px-4 py-2.5 text-xs text-slate-400 whitespace-nowrap font-mono">
                        <div>{fmtDate(log.created_at)}</div>
                        <div>{fmtTime(log.created_at)}</div>
                      </td>
                      <td className="px-4 py-2.5">
                        <span className={cn(
                          'inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium border',
                          levelStyle(log.level)
                        )}>
                          {levelIcon(log.level)}
                          {log.level}
                        </span>
                      </td>
                      <td className="px-4 py-2.5">
                        <span className="text-xs font-mono bg-slate-100 text-slate-600 px-1.5 py-0.5 rounded">
                          {log.source}
                        </span>
                      </td>
                      <td className="px-4 py-2.5 text-slate-700 max-w-xl">
                        <p className="truncate">{log.message}</p>
                        {log.call_id && (
                          <p className="text-xs text-slate-400 font-mono mt-0.5">call: {log.call_id.slice(0, 8)}…</p>
                        )}
                      </td>
                    </tr>
                    {expanded === log.id && (
                      <tr key={`${log.id}-detail`} className="bg-slate-50 border-b border-slate-200">
                        <td colSpan={4} className="px-4 py-3">
                          <div className="space-y-2">
                            <div>
                              <p className="text-xs font-semibold text-slate-500 mb-1">Full message</p>
                              <p className="text-sm text-slate-800 break-all">{log.message}</p>
                            </div>
                            {log.call_id && (
                              <div>
                                <p className="text-xs font-semibold text-slate-500 mb-1">Call ID</p>
                                <p className="text-xs font-mono text-slate-700">{log.call_id}</p>
                              </div>
                            )}
                            {log.context && (
                              <div>
                                <p className="text-xs font-semibold text-slate-500 mb-1">Context</p>
                                <pre className="text-xs bg-slate-900 text-green-400 rounded-lg p-3 overflow-x-auto">
                                  {JSON.stringify(log.context, null, 2)}
                                </pre>
                              </div>
                            )}
                          </div>
                        </td>
                      </tr>
                    )}
                  </>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  )
}
