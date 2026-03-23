'use client'

import { useEffect, useState } from 'react'
import { CallsTable } from '@/components/dashboard/CallsTable'
import { Button } from '@/components/ui/button'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Input } from '@/components/ui/input'
import { Download, RefreshCw } from 'lucide-react'

export default function CallsPage() {
  const [calls, setCalls] = useState<any[]>([])
  const [loading, setLoading] = useState(true)
  const [outcome, setOutcome] = useState('all')
  const [date, setDate] = useState('')

  async function fetchCalls() {
    setLoading(true)
    const params = new URLSearchParams({ limit: '100' })
    if (outcome && outcome !== 'all') params.set('outcome', outcome)
    if (date) params.set('date', date)
    const res = await fetch(`/api/calls?${params}`)
    const data = await res.json()
    setCalls(data.calls || [])
    setLoading(false)
  }

  useEffect(() => { fetchCalls() }, [outcome, date])

  function exportCSV() {
    const headers = ['Business', 'Phone', 'Agent', 'Status', 'Outcome', 'Duration (s)', 'Cost Telephony ($)', 'Cost STT ($)', 'Cost TTS ($)', 'Cost LLM ($)', 'Cost Total ($)', 'Created At']
    const rows = calls.map(c => [
      c.leads?.business_name || '',
      c.leads?.phone_number || '',
      c.agents?.name || '',
      c.status,
      c.outcome || '',
      c.duration_seconds || '',
      c.cost_telephony ?? '',
      c.cost_stt ?? '',
      c.cost_tts ?? '',
      c.cost_llm ?? '',
      c.cost_total ?? '',
      c.created_at,
    ])
    const csv = [headers, ...rows].map(r => r.map(String).join(',')).join('\n')
    const blob = new Blob([csv], { type: 'text/csv' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `calls-${new Date().toISOString().split('T')[0]}.csv`
    a.click()
    URL.revokeObjectURL(url)
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Call Log</h1>
          <p className="text-muted-foreground">Full history of all calls</p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={fetchCalls}>
            <RefreshCw className="h-4 w-4 mr-2" />
            Refresh
          </Button>
          <Button variant="outline" size="sm" onClick={exportCSV}>
            <Download className="h-4 w-4 mr-2" />
            Export CSV
          </Button>
        </div>
      </div>

      <div className="flex gap-4 flex-wrap">
        <div className="w-48">
          <Select value={outcome} onValueChange={setOutcome}>
            <SelectTrigger>
              <SelectValue placeholder="Filter by outcome" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Outcomes</SelectItem>
              <SelectItem value="interested">Interested</SelectItem>
              <SelectItem value="not_interested">Not Interested</SelectItem>
              <SelectItem value="callback">Callback</SelectItem>
              <SelectItem value="wrong_person">Wrong Person</SelectItem>
              <SelectItem value="no_answer">No Answer</SelectItem>
              <SelectItem value="voicemail">Voicemail</SelectItem>
              <SelectItem value="error">Error</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <Input
          type="date"
          value={date}
          onChange={e => setDate(e.target.value)}
          className="w-48"
        />
      </div>

      {loading ? (
        <div className="text-center py-12 text-muted-foreground">Loading...</div>
      ) : (
        <CallsTable calls={calls} />
      )}
    </div>
  )
}
