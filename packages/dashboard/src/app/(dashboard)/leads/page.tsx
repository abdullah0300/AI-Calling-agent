'use client'

import { useEffect, useState, useRef, useCallback } from 'react'
import type { Lead } from '@voiceflow/shared'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import {
  Users,
  Plus,
  Upload,
  Download,
  Trash2,
  AlertCircle,
  CheckCircle,
  FileText,
  RefreshCw,
} from 'lucide-react'

// ── Status config ─────────────────────────────────────────────────────────────

const STATUS: Record<string, { label: string; cls: string }> = {
  pending:        { label: 'Pending',        cls: 'bg-blue-50 text-blue-700 border border-blue-200' },
  calling:        { label: 'Calling',        cls: 'bg-amber-50 text-amber-700 border border-amber-200' },
  interested:     { label: 'Interested',     cls: 'bg-emerald-50 text-emerald-700 border border-emerald-200' },
  not_interested: { label: 'Not Interested', cls: 'bg-slate-100 text-slate-600 border border-slate-200' },
  callback:       { label: 'Callback',       cls: 'bg-purple-50 text-purple-700 border border-purple-200' },
  wrong_person:   { label: 'Wrong Person',   cls: 'bg-orange-50 text-orange-700 border border-orange-200' },
  no_answer:      { label: 'No Answer',      cls: 'bg-red-50 text-red-600 border border-red-200' },
  error:          { label: 'Error',          cls: 'bg-red-50 text-red-600 border border-red-200' },
}

const FILTER_TABS = [
  { value: 'all',            label: 'All' },
  { value: 'pending',        label: 'Pending' },
  { value: 'interested',     label: 'Interested' },
  { value: 'callback',       label: 'Callback' },
  { value: 'not_interested', label: 'Not Interested' },
  { value: 'no_answer',      label: 'No Answer' },
]

// ── CSV helpers ───────────────────────────────────────────────────────────────

function parseCsvLine(line: string): string[] {
  const out: string[] = []
  let cur = ''
  let inQ = false
  for (const ch of line) {
    if (ch === '"') { inQ = !inQ }
    else if (ch === ',' && !inQ) { out.push(cur.trim()); cur = '' }
    else { cur += ch }
  }
  out.push(cur.trim())
  return out.map(v => v.replace(/^"|"$/g, ''))
}

function parseCsv(text: string): Record<string, string>[] {
  const lines = text.trim().split(/\r?\n/).filter(Boolean)
  if (lines.length < 2) return []
  const headers = parseCsvLine(lines[0]).map(h =>
    h.toLowerCase().replace(/[\s-]+/g, '_')
  )
  return lines.slice(1).map(line => {
    const vals = parseCsvLine(line)
    return Object.fromEntries(headers.map((h, i) => [h, vals[i] ?? '']))
  })
}

function triggerDownload(content: string, filename: string, type: string) {
  const url = URL.createObjectURL(new Blob([content], { type }))
  const a = Object.assign(document.createElement('a'), { href: url, download: filename })
  a.click()
  URL.revokeObjectURL(url)
}

function exportCsv(leads: Lead[]) {
  const cols = [
    'business_name', 'phone_number', 'industry', 'city', 'country',
    'status', 'decision_maker_name', 'notes', 'created_at',
  ] as const
  const rows = leads.map(l =>
    cols.map(c => `"${String((l as any)[c] ?? '').replace(/"/g, '""')}"`).join(',')
  )
  triggerDownload(
    [cols.join(','), ...rows].join('\n'),
    `leads-${new Date().toISOString().slice(0, 10)}.csv`,
    'text/csv'
  )
}

function downloadTemplate() {
  triggerDownload(
    [
      'business_name,phone_number,industry,city,country,decision_maker_name,notes',
      'Example Estate Agency,+441234567890,Real Estate,London,GB,John Smith,Met at conference',
      'Prime Properties Ltd,+447890123456,Real Estate,Manchester,GB,,',
    ].join('\n'),
    'leads-template.csv',
    'text/csv'
  )
}

// ── Default form ──────────────────────────────────────────────────────────────

const EMPTY_FORM = {
  business_name: '',
  phone_number: '',
  industry: 'Real Estate',
  city: '',
  country: 'GB',
  decision_maker_name: '',
  notes: '',
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function LeadsPage() {
  const [leads, setLeads]               = useState<Lead[]>([])
  const [loading, setLoading]           = useState(true)
  const [filter, setFilter]             = useState('all')
  const [search, setSearch]             = useState('')
  const [addOpen, setAddOpen]           = useState(false)
  const [uploadOpen, setUploadOpen]     = useState(false)
  const [deletingId, setDeletingId]     = useState<string | null>(null)
  const [form, setForm]                 = useState(EMPTY_FORM)
  const [formError, setFormError]       = useState('')
  const [formSaving, setFormSaving]     = useState(false)
  const [csvRows, setCsvRows]           = useState<Record<string, string>[]>([])
  const [csvError, setCsvError]         = useState('')
  const [csvImporting, setCsvImporting] = useState(false)
  const [csvSuccess, setCsvSuccess]     = useState('')
  const fileRef = useRef<HTMLInputElement>(null)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const res = await fetch('/api/leads?limit=1000')
      const data = await res.json()
      setLeads(data.leads || [])
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { load() }, [load])

  // Filtered + searched leads
  const visible = leads.filter(l => {
    if (filter !== 'all' && l.status !== filter) return false
    if (search.trim()) {
      const q = search.toLowerCase()
      return (
        l.business_name.toLowerCase().includes(q) ||
        l.phone_number.includes(q) ||
        (l.decision_maker_name?.toLowerCase().includes(q) ?? false)
      )
    }
    return true
  })

  // Per-status counts for filter tabs
  const counts: Record<string, number> = { all: leads.length }
  for (const l of leads) counts[l.status] = (counts[l.status] || 0) + 1

  // Add single lead
  async function handleAddLead() {
    if (!form.business_name.trim() || !form.phone_number.trim() || !form.industry.trim()) {
      setFormError('Business name, phone number, and industry are required.')
      return
    }
    setFormSaving(true)
    setFormError('')
    try {
      const res = await fetch('/api/leads', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(form),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Failed to add lead')
      setAddOpen(false)
      setForm(EMPTY_FORM)
      load()
    } catch (e: any) {
      setFormError(e.message)
    } finally {
      setFormSaving(false)
    }
  }

  // Delete lead
  async function handleDelete(id: string) {
    setDeletingId(id)
    try {
      await fetch(`/api/leads/${id}`, { method: 'DELETE' })
      setLeads(prev => prev.filter(l => l.id !== id))
    } finally {
      setDeletingId(null)
    }
  }

  // Reset lead status back to pending (so it can be called again)
  async function handleReset(id: string) {
    await fetch(`/api/leads/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'pending' }),
    })
    setLeads(prev => prev.map(l => l.id === id ? { ...l, status: 'pending' as const } : l))
  }

  // CSV file selected
  function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return
    setCsvError('')
    setCsvSuccess('')
    const reader = new FileReader()
    reader.onload = ev => {
      try {
        const rows = parseCsv(ev.target?.result as string)
        if (rows.length === 0) {
          setCsvError('No data rows found. Check the file has a header row and at least one data row.')
          return
        }
        setCsvRows(rows)
      } catch {
        setCsvError('Could not parse the file. Make sure it is a valid CSV.')
      }
    }
    reader.readAsText(file)
  }

  // Import parsed CSV rows
  async function handleCsvImport() {
    if (csvRows.length === 0) return
    setCsvImporting(true)
    setCsvError('')
    setCsvSuccess('')
    try {
      const payload = csvRows.map(r => ({
        business_name:      r.business_name || r['business name'] || '',
        phone_number:       r.phone_number || r['phone number'] || r.phone || '',
        industry:           r.industry || 'Real Estate',
        city:               r.city || null,
        country:            r.country || 'GB',
        decision_maker_name: r.decision_maker_name || r['decision maker name'] || null,
        notes:              r.notes || null,
      }))
      const res = await fetch('/api/leads', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Import failed')
      setCsvSuccess(`${csvRows.length} lead${csvRows.length !== 1 ? 's' : ''} imported successfully.`)
      setCsvRows([])
      if (fileRef.current) fileRef.current.value = ''
      load()
    } catch (e: any) {
      setCsvError(e.message)
    } finally {
      setCsvImporting(false)
    }
  }

  function resetUploadDialog() {
    setCsvRows([])
    setCsvError('')
    setCsvSuccess('')
    if (fileRef.current) fileRef.current.value = ''
  }

  return (
    <div className="space-y-6 max-w-7xl">

      {/* ── Header ── */}
      <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-4">
        <div>
          <div className="flex items-center gap-2 mb-2">
            <Users className="h-4 w-4 text-blue-600" />
            <span className="text-xs font-semibold text-blue-600 uppercase tracking-widest">Leads</span>
          </div>
          <h1 className="text-3xl font-bold text-slate-900">Leads</h1>
          <p className="text-slate-500 mt-1 text-sm">
            {leads.length} total · {counts.pending || 0} pending · {counts.interested || 0} interested
            {(counts.callback || 0) > 0 ? ` · ${counts.callback} callback` : ''}
          </p>
        </div>
        <div className="flex flex-wrap gap-2 self-start">
          <Button
            variant="outline"
            size="sm"
            onClick={() => exportCsv(visible)}
            className="text-slate-600"
          >
            <Download className="h-3.5 w-3.5 mr-1.5" />
            Export CSV
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => { resetUploadDialog(); setUploadOpen(true) }}
            className="text-slate-600"
          >
            <Upload className="h-3.5 w-3.5 mr-1.5" />
            Upload CSV
          </Button>
          <Button
            size="sm"
            className="bg-blue-600 hover:bg-blue-700 text-white"
            onClick={() => { setForm(EMPTY_FORM); setFormError(''); setAddOpen(true) }}
          >
            <Plus className="h-3.5 w-3.5 mr-1.5" />
            Add Lead
          </Button>
        </div>
      </div>

      {/* ── Filter tabs + Search ── */}
      <div className="flex flex-col sm:flex-row gap-3">
        <div className="flex gap-1 bg-white border border-slate-200 rounded-lg p-1 overflow-x-auto shrink-0">
          {FILTER_TABS.map(tab => (
            <button
              key={tab.value}
              onClick={() => setFilter(tab.value)}
              className={`px-3 py-1.5 rounded-md text-xs font-medium whitespace-nowrap transition-colors ${
                filter === tab.value
                  ? 'bg-blue-600 text-white shadow-sm'
                  : 'text-slate-600 hover:bg-slate-100'
              }`}
            >
              {tab.label}
              {(counts[tab.value] || 0) > 0 && (
                <span className={`ml-1.5 text-[10px] px-1.5 py-0.5 rounded-full ${
                  filter === tab.value
                    ? 'bg-blue-500 text-white'
                    : 'bg-slate-100 text-slate-500'
                }`}>
                  {counts[tab.value]}
                </span>
              )}
            </button>
          ))}
        </div>

        <Input
          value={search}
          onChange={e => setSearch(e.target.value)}
          placeholder="Search name, phone, or decision maker…"
          className="bg-white text-sm"
        />

        <Button
          variant="ghost"
          size="icon"
          onClick={load}
          title="Refresh"
          className="text-slate-400 shrink-0"
        >
          <RefreshCw className="h-4 w-4" />
        </Button>
      </div>

      {/* ── Leads table ── */}
      <div className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
        {loading ? (
          <div className="py-16 text-center">
            <div className="w-8 h-8 border-2 border-blue-600 border-t-transparent rounded-full animate-spin mx-auto mb-3" />
            <p className="text-slate-500 text-sm">Loading leads…</p>
          </div>
        ) : visible.length === 0 ? (
          <div className="py-16 text-center">
            <div className="w-14 h-14 bg-slate-100 rounded-2xl flex items-center justify-center mx-auto mb-4">
              <Users className="h-7 w-7 text-slate-400" />
            </div>
            <h3 className="font-semibold text-slate-900 mb-1">
              {search || filter !== 'all' ? 'No matching leads' : 'No leads yet'}
            </h3>
            <p className="text-slate-500 text-sm max-w-xs mx-auto mb-5">
              {search || filter !== 'all'
                ? 'Try adjusting your search or changing the status filter.'
                : 'Add leads one at a time or upload a CSV to get started.'}
            </p>
            {!search && filter === 'all' && (
              <div className="flex gap-2 justify-center">
                <Button size="sm" variant="outline" onClick={() => { resetUploadDialog(); setUploadOpen(true) }}>
                  <Upload className="h-3.5 w-3.5 mr-1.5" />
                  Upload CSV
                </Button>
                <Button size="sm" className="bg-blue-600 hover:bg-blue-700 text-white" onClick={() => { setForm(EMPTY_FORM); setFormError(''); setAddOpen(true) }}>
                  <Plus className="h-3.5 w-3.5 mr-1.5" />
                  Add Lead
                </Button>
              </div>
            )}
          </div>
        ) : (
          <>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-slate-200 bg-slate-50">
                    <th className="text-left px-4 py-3 text-xs font-semibold text-slate-500 uppercase tracking-wider">Business</th>
                    <th className="text-left px-4 py-3 text-xs font-semibold text-slate-500 uppercase tracking-wider">Phone</th>
                    <th className="text-left px-4 py-3 text-xs font-semibold text-slate-500 uppercase tracking-wider">Industry</th>
                    <th className="text-left px-4 py-3 text-xs font-semibold text-slate-500 uppercase tracking-wider">Location</th>
                    <th className="text-left px-4 py-3 text-xs font-semibold text-slate-500 uppercase tracking-wider">Status</th>
                    <th className="text-left px-4 py-3 text-xs font-semibold text-slate-500 uppercase tracking-wider">Added</th>
                    <th className="px-4 py-3 w-20" />
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {visible.map(lead => (
                    <tr key={lead.id} className="hover:bg-slate-50/70 transition-colors">
                      <td className="px-4 py-3 max-w-[200px]">
                        <p className="font-medium text-slate-900 truncate leading-snug">{lead.business_name}</p>
                        {lead.decision_maker_name && (
                          <p className="text-xs text-slate-400 mt-0.5 truncate">{lead.decision_maker_name}</p>
                        )}
                      </td>
                      <td className="px-4 py-3 text-slate-600 font-mono text-xs whitespace-nowrap">{lead.phone_number}</td>
                      <td className="px-4 py-3 text-slate-600 whitespace-nowrap">{lead.industry}</td>
                      <td className="px-4 py-3 text-slate-500 text-xs whitespace-nowrap">
                        {[lead.city, lead.country].filter(Boolean).join(', ') || '—'}
                      </td>
                      <td className="px-4 py-3">
                        <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium whitespace-nowrap ${
                          STATUS[lead.status]?.cls || 'bg-slate-100 text-slate-600 border border-slate-200'
                        }`}>
                          {STATUS[lead.status]?.label || lead.status}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-slate-400 text-xs whitespace-nowrap">
                        {new Date(lead.created_at).toLocaleDateString('en-GB', {
                          day: 'numeric', month: 'short', year: '2-digit',
                        })}
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex items-center justify-end gap-1">
                          {lead.status !== 'pending' && (
                            <button
                              onClick={() => handleReset(lead.id)}
                              title="Reset to pending so it can be called again"
                              className="p-1.5 rounded-md text-slate-400 hover:text-blue-600 hover:bg-blue-50 transition-colors"
                            >
                              <RefreshCw className="h-3.5 w-3.5" />
                            </button>
                          )}
                          <button
                            onClick={() => handleDelete(lead.id)}
                            disabled={deletingId === lead.id}
                            title="Delete lead"
                            className="p-1.5 rounded-md text-slate-400 hover:text-red-600 hover:bg-red-50 transition-colors disabled:opacity-40"
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="px-4 py-3 border-t border-slate-100 bg-slate-50/50 flex items-center justify-between">
              <p className="text-xs text-slate-400">
                Showing {visible.length} of {leads.length} lead{leads.length !== 1 ? 's' : ''}
              </p>
              {visible.length !== leads.length && (
                <button
                  onClick={() => { setFilter('all'); setSearch('') }}
                  className="text-xs text-blue-600 hover:underline"
                >
                  Clear filters
                </button>
              )}
            </div>
          </>
        )}
      </div>

      {/* ── Add Lead Dialog ── */}
      <Dialog open={addOpen} onOpenChange={v => { setAddOpen(v); if (!v) setFormError('') }}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 bg-blue-100 rounded-xl flex items-center justify-center shrink-0">
                <Plus className="h-5 w-5 text-blue-600" />
              </div>
              <div>
                <DialogTitle>Add Lead</DialogTitle>
                <p className="text-sm text-slate-500 mt-0.5">Add a single lead manually</p>
              </div>
            </div>
          </DialogHeader>

          <div className="space-y-4 py-2">
            <div className="grid sm:grid-cols-2 gap-4">
              <div className="space-y-1.5 sm:col-span-2">
                <Label className="text-sm font-medium text-slate-700">
                  Business Name <span className="text-red-500">*</span>
                </Label>
                <Input
                  value={form.business_name}
                  onChange={e => setForm(p => ({ ...p, business_name: e.target.value }))}
                  placeholder="e.g. Prime Properties Ltd"
                  className="bg-slate-50"
                />
              </div>
              <div className="space-y-1.5">
                <Label className="text-sm font-medium text-slate-700">
                  Phone Number <span className="text-red-500">*</span>
                </Label>
                <Input
                  value={form.phone_number}
                  onChange={e => setForm(p => ({ ...p, phone_number: e.target.value }))}
                  placeholder="+441234567890"
                  className="bg-slate-50 font-mono"
                />
              </div>
              <div className="space-y-1.5">
                <Label className="text-sm font-medium text-slate-700">
                  Industry <span className="text-red-500">*</span>
                </Label>
                <Input
                  value={form.industry}
                  onChange={e => setForm(p => ({ ...p, industry: e.target.value }))}
                  placeholder="Real Estate"
                  className="bg-slate-50"
                />
              </div>
              <div className="space-y-1.5">
                <Label className="text-sm font-medium text-slate-700">City</Label>
                <Input
                  value={form.city}
                  onChange={e => setForm(p => ({ ...p, city: e.target.value }))}
                  placeholder="e.g. London"
                  className="bg-slate-50"
                />
              </div>
              <div className="space-y-1.5">
                <Label className="text-sm font-medium text-slate-700">Country</Label>
                <Input
                  value={form.country}
                  onChange={e => setForm(p => ({ ...p, country: e.target.value }))}
                  placeholder="GB"
                  className="bg-slate-50"
                />
              </div>
              <div className="space-y-1.5 sm:col-span-2">
                <Label className="text-sm font-medium text-slate-700">Decision Maker Name</Label>
                <Input
                  value={form.decision_maker_name}
                  onChange={e => setForm(p => ({ ...p, decision_maker_name: e.target.value }))}
                  placeholder="e.g. John Smith"
                  className="bg-slate-50"
                />
              </div>
              <div className="space-y-1.5 sm:col-span-2">
                <Label className="text-sm font-medium text-slate-700">Notes</Label>
                <Textarea
                  value={form.notes}
                  onChange={e => setForm(p => ({ ...p, notes: e.target.value }))}
                  placeholder="Any additional context about this lead…"
                  rows={2}
                  className="bg-slate-50 resize-none text-sm"
                />
              </div>
            </div>
            {formError && (
              <div className="flex items-center gap-2 bg-red-50 border border-red-200 rounded-lg px-3 py-2.5">
                <AlertCircle className="h-4 w-4 text-red-500 shrink-0" />
                <p className="text-sm text-red-600">{formError}</p>
              </div>
            )}
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setAddOpen(false)}>Cancel</Button>
            <Button
              onClick={handleAddLead}
              disabled={formSaving}
              className="bg-blue-600 hover:bg-blue-700 text-white"
            >
              {formSaving
                ? <><span className="mr-2 animate-spin inline-block">⟳</span>Saving…</>
                : <><Plus className="h-4 w-4 mr-2" />Add Lead</>
              }
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ── Upload CSV Dialog ── */}
      <Dialog open={uploadOpen} onOpenChange={v => { setUploadOpen(v); if (!v) resetUploadDialog() }}>
        <DialogContent className="sm:max-w-2xl">
          <DialogHeader>
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 bg-blue-100 rounded-xl flex items-center justify-center shrink-0">
                <Upload className="h-5 w-5 text-blue-600" />
              </div>
              <div>
                <DialogTitle>Upload CSV</DialogTitle>
                <p className="text-sm text-slate-500 mt-0.5">Import multiple leads at once from a spreadsheet</p>
              </div>
            </div>
          </DialogHeader>

          <div className="space-y-4 py-2">
            {/* Expected columns + template download */}
            <div className="bg-slate-50 border border-slate-200 rounded-lg px-4 py-3 flex items-start gap-3">
              <FileText className="h-4 w-4 text-slate-400 shrink-0 mt-0.5" />
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium text-slate-700">Expected columns</p>
                <p className="text-xs text-slate-400 font-mono mt-1 leading-relaxed break-all">
                  business_name · phone_number · industry · city · country · decision_maker_name · notes
                </p>
                <p className="text-xs text-slate-400 mt-1.5">
                  Tip: Export from Google Sheets or Excel as CSV. Column headers are case-insensitive.
                </p>
              </div>
              <Button variant="outline" size="sm" onClick={downloadTemplate} className="shrink-0">
                <Download className="h-3.5 w-3.5 mr-1.5" />
                Template
              </Button>
            </div>

            {/* File drop zone */}
            <div
              className="border-2 border-dashed border-slate-200 rounded-xl p-8 text-center cursor-pointer hover:border-blue-400 hover:bg-blue-50/30 transition-colors"
              onClick={() => fileRef.current?.click()}
            >
              <Upload className="h-8 w-8 text-slate-300 mx-auto mb-2" />
              <p className="text-sm font-medium text-slate-600">Click to select a CSV file</p>
              <p className="text-xs text-slate-400 mt-1">UTF-8 encoded CSV · max 5,000 rows</p>
              <input
                ref={fileRef}
                type="file"
                accept=".csv,text/csv"
                className="hidden"
                onChange={handleFileChange}
              />
            </div>

            {/* Preview table */}
            {csvRows.length > 0 && (
              <div className="space-y-2">
                <p className="text-sm font-medium text-slate-700">
                  {csvRows.length} row{csvRows.length !== 1 ? 's' : ''} parsed
                  {csvRows.length > 5 && (
                    <span className="text-slate-400 font-normal ml-1">(showing first 5)</span>
                  )}
                </p>
                <div className="overflow-x-auto rounded-lg border border-slate-200">
                  <table className="w-full text-xs">
                    <thead className="bg-slate-50">
                      <tr>
                        {['business_name', 'phone_number', 'industry', 'city', 'country'].map(col => (
                          <th key={col} className="text-left px-3 py-2 font-medium text-slate-500 whitespace-nowrap">
                            {col}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100">
                      {csvRows.slice(0, 5).map((row, i) => (
                        <tr key={i} className="hover:bg-slate-50">
                          <td className="px-3 py-2 font-medium text-slate-700 truncate max-w-[160px]">
                            {row.business_name || '—'}
                          </td>
                          <td className="px-3 py-2 font-mono text-slate-500">
                            {row.phone_number || row.phone || '—'}
                          </td>
                          <td className="px-3 py-2 text-slate-500">{row.industry || '—'}</td>
                          <td className="px-3 py-2 text-slate-500">{row.city || '—'}</td>
                          <td className="px-3 py-2 text-slate-500">{row.country || 'GB'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            {csvError && (
              <div className="flex items-center gap-2 bg-red-50 border border-red-200 rounded-lg px-3 py-2.5">
                <AlertCircle className="h-4 w-4 text-red-500 shrink-0" />
                <p className="text-sm text-red-600">{csvError}</p>
              </div>
            )}
            {csvSuccess && (
              <div className="flex items-center gap-2 bg-emerald-50 border border-emerald-200 rounded-lg px-3 py-2.5">
                <CheckCircle className="h-4 w-4 text-emerald-500 shrink-0" />
                <p className="text-sm text-emerald-700">{csvSuccess}</p>
              </div>
            )}
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setUploadOpen(false)}>Close</Button>
            {csvRows.length > 0 && (
              <Button
                onClick={handleCsvImport}
                disabled={csvImporting}
                className="bg-blue-600 hover:bg-blue-700 text-white"
              >
                {csvImporting
                  ? <><span className="mr-2 animate-spin inline-block">⟳</span>Importing…</>
                  : <><Upload className="h-4 w-4 mr-2" />Import {csvRows.length} Lead{csvRows.length !== 1 ? 's' : ''}</>
                }
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
