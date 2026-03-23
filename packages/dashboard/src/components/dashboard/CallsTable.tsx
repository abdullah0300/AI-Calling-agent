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

interface CallWithRelations extends Call {
  leads?: { business_name: string; phone_number: string } | null
  agents?: { name: string } | null
}

interface CallsTableProps {
  calls: CallWithRelations[]
}

function getStatusVariant(status: string) {
  switch (status) {
    case 'completed': return 'success' as const
    case 'in_progress': return 'info' as const
    case 'failed': return 'destructive' as const
    default: return 'secondary' as const
  }
}

function getOutcomeVariant(outcome: string | null) {
  switch (outcome) {
    case 'interested': return 'success' as const
    case 'not_interested': return 'destructive' as const
    case 'callback': return 'warning' as const
    case 'wrong_person': return 'secondary' as const
    default: return 'outline' as const
  }
}

function formatDuration(seconds: number | null) {
  if (!seconds) return '—'
  const m = Math.floor(seconds / 60)
  const s = seconds % 60
  return `${m}:${s.toString().padStart(2, '0')}`
}

function formatCost(usd: number | null | undefined) {
  if (usd == null || usd === 0) return '—'
  return `$${usd.toFixed(4)}`
}

function CostBreakdown({ call }: { call: CallWithRelations }) {
  const hasAnyCost = (call.cost_total ?? 0) > 0 ||
    (call.cost_llm ?? 0) > 0 || (call.cost_tts ?? 0) > 0 ||
    (call.cost_stt ?? 0) > 0 || (call.cost_telephony ?? 0) > 0

  if (!hasAnyCost) return <span className="text-muted-foreground text-xs">—</span>

  return (
    <div className="text-xs space-y-0.5 font-mono">
      {(call.cost_telephony ?? 0) > 0 && (
        <div className="text-muted-foreground">
          Tel: <span className="text-foreground">${(call.cost_telephony!).toFixed(4)}</span>
        </div>
      )}
      {(call.cost_stt ?? 0) > 0 && (
        <div className="text-muted-foreground">
          STT: <span className="text-foreground">${(call.cost_stt!).toFixed(4)}</span>
        </div>
      )}
      {(call.cost_tts ?? 0) > 0 && (
        <div className="text-muted-foreground">
          TTS: <span className="text-foreground">${(call.cost_tts!).toFixed(4)}</span>
        </div>
      )}
      {(call.cost_llm ?? 0) > 0 && (
        <div className="text-muted-foreground">
          LLM: <span className="text-foreground">${(call.cost_llm!).toFixed(4)}</span>
        </div>
      )}
      <div className="border-t pt-0.5 font-semibold text-foreground">
        Total: ${(call.cost_total ?? 0).toFixed(4)}
      </div>
    </div>
  )
}

export function CallsTable({ calls }: CallsTableProps) {
  const [selectedCall, setSelectedCall] = useState<CallWithRelations | null>(null)

  return (
    <>
      <div className="rounded-md border overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b bg-muted/50">
              <th className="px-4 py-3 text-left font-medium">Business</th>
              <th className="px-4 py-3 text-left font-medium">Number</th>
              <th className="px-4 py-3 text-left font-medium">Agent</th>
              <th className="px-4 py-3 text-left font-medium">Status</th>
              <th className="px-4 py-3 text-left font-medium">Outcome</th>
              <th className="px-4 py-3 text-left font-medium">Duration</th>
              <th className="px-4 py-3 text-left font-medium">Cost</th>
              <th className="px-4 py-3 text-left font-medium">Time</th>
              <th className="px-4 py-3 text-left font-medium">Transcript</th>
            </tr>
          </thead>
          <tbody>
            {calls.length === 0 ? (
              <tr>
                <td colSpan={9} className="px-4 py-8 text-center text-muted-foreground">
                  No calls yet
                </td>
              </tr>
            ) : (
              calls.map((call) => (
                <tr key={call.id} className="border-b hover:bg-muted/30 transition-colors">
                  <td className="px-4 py-3 font-medium">{call.leads?.business_name || '—'}</td>
                  <td className="px-4 py-3 text-muted-foreground">{call.leads?.phone_number || '—'}</td>
                  <td className="px-4 py-3">{call.agents?.name || '—'}</td>
                  <td className="px-4 py-3">
                    <Badge variant={getStatusVariant(call.status)}>{call.status}</Badge>
                  </td>
                  <td className="px-4 py-3">
                    {call.outcome ? (
                      <Badge variant={getOutcomeVariant(call.outcome)}>{call.outcome.replace('_', ' ')}</Badge>
                    ) : '—'}
                  </td>
                  <td className="px-4 py-3">{formatDuration(call.duration_seconds)}</td>
                  <td className="px-4 py-3">
                    <CostBreakdown call={call} />
                  </td>
                  <td className="px-4 py-3 text-muted-foreground text-xs">
                    {formatDistanceToNow(new Date(call.created_at), { addSuffix: true })}
                  </td>
                  <td className="px-4 py-3">
                    {call.transcript && (call.transcript as TranscriptEntry[]).length > 0 && (
                      <Button variant="ghost" size="sm" onClick={() => setSelectedCall(call)}>
                        View
                      </Button>
                    )}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      <Dialog open={!!selectedCall} onOpenChange={() => setSelectedCall(null)}>
        <DialogContent className="max-w-2xl max-h-[80vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>
              Call Transcript — {selectedCall?.leads?.business_name}
            </DialogTitle>
          </DialogHeader>

          {/* Cost summary inside transcript dialog */}
          {selectedCall && (selectedCall.cost_total ?? 0) > 0 && (
            <div className="rounded-md border bg-muted/30 p-3 text-sm">
              <div className="font-semibold mb-2">Cost Breakdown</div>
              <div className="grid grid-cols-2 gap-x-8 gap-y-1 text-xs font-mono">
                <span className="text-muted-foreground">Telephony (Telnyx)</span>
                <span>{formatCost(selectedCall.cost_telephony)}</span>
                <span className="text-muted-foreground">Speech-to-Text (Deepgram Nova-3)</span>
                <span>{formatCost(selectedCall.cost_stt)}</span>
                <span className="text-muted-foreground">Text-to-Speech (ElevenLabs / Deepgram)</span>
                <span>{formatCost(selectedCall.cost_tts)}</span>
                <span className="text-muted-foreground">LLM (Claude Haiku 4.5)</span>
                <span>{formatCost(selectedCall.cost_llm)}</span>
                <span className="font-semibold border-t pt-1">Total</span>
                <span className="font-semibold border-t pt-1">{formatCost(selectedCall.cost_total)}</span>
              </div>
            </div>
          )}

          <div className="space-y-3 mt-4">
            {selectedCall && (selectedCall.transcript as TranscriptEntry[]).map((entry, i) => (
              <div
                key={i}
                className={`flex gap-3 ${entry.role === 'agent' ? 'justify-start' : 'justify-end'}`}
              >
                <div
                  className={`rounded-lg px-4 py-2 max-w-[80%] text-sm ${
                    entry.role === 'agent'
                      ? 'bg-primary text-primary-foreground'
                      : 'bg-muted'
                  }`}
                >
                  <div className="font-semibold text-xs mb-1 opacity-70 capitalize">{entry.role}</div>
                  <div>{entry.text}</div>
                  <div className="text-xs opacity-50 mt-1">
                    {new Date(entry.timestamp).toLocaleTimeString()}
                  </div>
                </div>
              </div>
            ))}
          </div>
        </DialogContent>
      </Dialog>
    </>
  )
}
