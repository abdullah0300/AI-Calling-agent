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
              <th className="px-4 py-3 text-left font-medium">Time</th>
              <th className="px-4 py-3 text-left font-medium">Transcript</th>
            </tr>
          </thead>
          <tbody>
            {calls.length === 0 ? (
              <tr>
                <td colSpan={8} className="px-4 py-8 text-center text-muted-foreground">
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
