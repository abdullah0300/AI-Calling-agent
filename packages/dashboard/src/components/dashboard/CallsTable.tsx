'use client'

import { useState } from 'react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import type { Call, TranscriptEntry } from '@voiceflow/shared'
import { formatDistanceToNow } from 'date-fns'
import { Phone, Clock, MessageSquare, DollarSign, Bot } from 'lucide-react'

interface CallWithRelations extends Call {
  leads?: { business_name: string; phone_number: string } | null
  agents?: { name: string } | null
}

/* ── Badge helpers ── */
type BadgeVariant = 'success' | 'info' | 'destructive' | 'secondary' | 'warning' | 'outline'

const statusMap: Record<string, { variant: BadgeVariant; label: string }> = {
  completed:   { variant: 'success',     label: 'Completed' },
  in_progress: { variant: 'info',        label: 'In Progress' },
  failed:      { variant: 'destructive', label: 'Failed' },
  initiated:   { variant: 'secondary',   label: 'Initiated' },
  ringing:     { variant: 'warning',     label: 'Ringing' },
  no_answer:   { variant: 'secondary',   label: 'No Answer' },
}

const outcomeMap: Record<string, { variant: BadgeVariant; label: string; emoji: string }> = {
  interested:    { variant: 'success',     label: 'Interested',    emoji: '🎯' },
  not_interested:{ variant: 'destructive', label: 'Not Interested',emoji: '👎' },
  callback:      { variant: 'warning',     label: 'Callback',      emoji: '📅' },
  wrong_person:  { variant: 'secondary',   label: 'Wrong Person',  emoji: '🔄' },
  no_answer:     { variant: 'outline',     label: 'No Answer',     emoji: '📵' },
  voicemail:     { variant: 'outline',     label: 'Voicemail',     emoji: '📬' },
  error:         { variant: 'destructive', label: 'Error',         emoji: '⚠️' },
}

/* ── Formatters ── */
function fmtDuration(seconds: number | null) {
  if (!seconds) return '—'
  const m = Math.floor(seconds / 60)
  const s = seconds % 60
  return `${m}m ${s.toString().padStart(2, '0')}s`
}

function fmtCost(usd: number | null | undefined) {
  if (usd == null || usd === 0) return '—'
  return `$${usd.toFixed(4)}`
}

/* ── Component ── */
export function CallsTable({ calls }: { calls: CallWithRelations[] }) {
  const [selectedCall, setSelectedCall] = useState<CallWithRelations | null>(null)

  /* Empty state */
  if (calls.length === 0) {
    return (
      <div className="bg-white rounded-xl border border-slate-200 shadow-sm p-16 text-center">
        <div className="w-12 h-12 bg-slate-100 rounded-2xl flex items-center justify-center mx-auto mb-4">
          <Phone className="h-6 w-6 text-slate-400" />
        </div>
        <p className="font-semibold text-slate-700 mb-1">No calls found</p>
        <p className="text-sm text-slate-400">
          Calls will appear here once your agents start making them.
        </p>
      </div>
    )
  }

  return (
    <>
      <div className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-slate-50 border-b border-slate-200">
                {[
                  'Business', 'Agent', 'Status', 'Outcome',
                  'Duration', 'Cost', 'Time', '',
                ].map(col => (
                  <th
                    key={col}
                    className="px-4 py-3 text-left text-[11px] font-semibold text-slate-500 uppercase tracking-wider whitespace-nowrap"
                  >
                    {col}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {calls.map(call => {
                const status      = statusMap[call.status] ?? { variant: 'secondary' as const, label: call.status }
                const outcome     = call.outcome ? outcomeMap[call.outcome] : null
                const hasTranscript = Array.isArray(call.transcript) && call.transcript.length > 0
                const hasCost     = (call.cost_total ?? 0) > 0

                return (
                  <tr key={call.id} className="hover:bg-slate-50/60 transition-colors">
                    {/* Business */}
                    <td className="px-4 py-3">
                      <div className="font-medium text-slate-900 whitespace-nowrap">
                        {call.leads?.business_name || '—'}
                      </div>
                      <div className="text-xs text-slate-400 mt-0.5">
                        {call.leads?.phone_number || ''}
                      </div>
                    </td>

                    {/* Agent */}
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-1.5 text-slate-600 whitespace-nowrap">
                        <Bot className="h-3.5 w-3.5 text-slate-400 shrink-0" />
                        <span className="text-sm">{call.agents?.name || '—'}</span>
                      </div>
                    </td>

                    {/* Status */}
                    <td className="px-4 py-3 whitespace-nowrap">
                      <Badge variant={status.variant}>{status.label}</Badge>
                    </td>

                    {/* Outcome */}
                    <td className="px-4 py-3 whitespace-nowrap">
                      {outcome ? (
                        <div className="flex items-center gap-1.5">
                          <span>{outcome.emoji}</span>
                          <Badge variant={outcome.variant}>{outcome.label}</Badge>
                        </div>
                      ) : (
                        <span className="text-slate-300 text-xs">—</span>
                      )}
                    </td>

                    {/* Duration */}
                    <td className="px-4 py-3 whitespace-nowrap">
                      <div className="flex items-center gap-1.5 text-slate-600">
                        <Clock className="h-3.5 w-3.5 text-slate-400" />
                        <span className="font-mono text-xs">
                          {fmtDuration(call.duration_seconds)}
                        </span>
                      </div>
                    </td>

                    {/* Cost */}
                    <td className="px-4 py-3">
                      {hasCost ? (
                        <div className="font-mono text-xs">
                          <div className="font-semibold text-slate-900">
                            ${(call.cost_total ?? 0).toFixed(4)}
                          </div>
                          <div className="text-[10px] text-slate-400 mt-0.5 space-x-1">
                            {(call.cost_telephony ?? 0) > 0 && (
                              <span>Tel ${call.cost_telephony!.toFixed(4)}</span>
                            )}
                            {(call.cost_stt ?? 0) > 0 && (
                              <span>STT ${call.cost_stt!.toFixed(4)}</span>
                            )}
                            {(call.cost_tts ?? 0) > 0 && (
                              <span>TTS ${call.cost_tts!.toFixed(4)}</span>
                            )}
                            {(call.cost_llm ?? 0) > 0 && (
                              <span>LLM ${call.cost_llm!.toFixed(4)}</span>
                            )}
                          </div>
                        </div>
                      ) : (
                        <span className="text-slate-300 text-xs">—</span>
                      )}
                    </td>

                    {/* Time */}
                    <td className="px-4 py-3 text-xs text-slate-400 whitespace-nowrap">
                      {formatDistanceToNow(new Date(call.created_at), { addSuffix: true })}
                    </td>

                    {/* Transcript button */}
                    <td className="px-4 py-3 whitespace-nowrap">
                      {hasTranscript && (
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => setSelectedCall(call)}
                          className="text-xs gap-1.5 text-blue-600 hover:text-blue-700 hover:bg-blue-50"
                        >
                          <MessageSquare className="h-3.5 w-3.5" />
                          Transcript
                        </Button>
                      )}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      </div>

      {/* ── Transcript dialog ── */}
      <Dialog open={!!selectedCall} onOpenChange={() => setSelectedCall(null)}>
        <DialogContent className="max-w-2xl max-h-[85vh] flex flex-col gap-0 p-0 overflow-hidden">
          {/* Dialog header */}
          <div className="px-6 py-5 border-b border-slate-200 shrink-0">
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2 text-base">
                <MessageSquare className="h-5 w-5 text-blue-600" />
                Call Transcript
              </DialogTitle>
            </DialogHeader>
            <p className="text-sm text-slate-500 mt-1">
              <strong>{selectedCall?.leads?.business_name}</strong>
              {selectedCall?.agents?.name && (
                <> &middot; Agent: {selectedCall.agents.name}</>
              )}
              {selectedCall && (
                <> &middot;{' '}
                  {formatDistanceToNow(new Date(selectedCall.created_at), {
                    addSuffix: true,
                  })}
                </>
              )}
            </p>
          </div>

          {/* Scrollable body */}
          <div className="flex-1 overflow-y-auto px-6 py-5 space-y-5">
            {/* Cost breakdown */}
            {selectedCall && (selectedCall.cost_total ?? 0) > 0 && (
              <div className="bg-slate-50 rounded-xl border border-slate-200 p-4">
                <div className="flex items-center gap-2 mb-3">
                  <DollarSign className="h-4 w-4 text-slate-500" />
                  <span className="text-sm font-semibold text-slate-700">
                    Cost Breakdown
                  </span>
                </div>
                <div className="grid grid-cols-[1fr_auto] gap-x-6 gap-y-1.5 text-xs font-mono">
                  {[
                    ['Telephony (Telnyx)',           selectedCall.cost_telephony],
                    ['Speech-to-Text (Deepgram)',    selectedCall.cost_stt],
                    ['Text-to-Speech',               selectedCall.cost_tts],
                    ['LLM (Claude / GPT)',           selectedCall.cost_llm],
                  ].map(([label, cost]) => (
                    <div key={label as string} className="contents">
                      <span className="text-slate-500">{label}</span>
                      <span className="text-slate-700 text-right">
                        {fmtCost(cost as number | null)}
                      </span>
                    </div>
                  ))}
                  <div className="col-span-2 border-t border-slate-200 mt-1 pt-2 flex justify-between">
                    <span className="font-semibold text-slate-700">Total</span>
                    <span className="font-semibold text-slate-900">
                      {fmtCost(selectedCall.cost_total)}
                    </span>
                  </div>
                </div>
              </div>
            )}

            {/* Chat bubbles */}
            <div className="space-y-3">
              {selectedCall &&
                (selectedCall.transcript as TranscriptEntry[]).map((entry, i) => (
                  <div
                    key={i}
                    className={`flex ${entry.role === 'agent' ? 'justify-start' : 'justify-end'}`}
                  >
                    <div
                      className={`rounded-2xl px-4 py-3 max-w-[80%] ${
                        entry.role === 'agent'
                          ? 'bg-blue-600 text-white rounded-tl-sm'
                          : 'bg-slate-100 text-slate-800 rounded-tr-sm'
                      }`}
                    >
                      <div
                        className={`text-[10px] font-semibold uppercase tracking-wide mb-1 ${
                          entry.role === 'agent' ? 'text-blue-200' : 'text-slate-400'
                        }`}
                      >
                        {entry.role === 'agent' ? 'AI Agent' : 'Prospect'}
                      </div>
                      <p className="text-sm leading-relaxed">{entry.text}</p>
                      <div
                        className={`text-[10px] mt-1.5 ${
                          entry.role === 'agent' ? 'text-blue-200' : 'text-slate-400'
                        }`}
                      >
                        {new Date(entry.timestamp).toLocaleTimeString()}
                      </div>
                    </div>
                  </div>
                ))}
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </>
  )
}
