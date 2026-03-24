'use client'

import { useState } from 'react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter as DialogFooterUI,
} from '@/components/ui/dialog'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import type { Agent, Lead, PhoneNumber } from '@voiceflow/shared'
import { useRouter } from 'next/navigation'
import {
  Bot,
  Phone,
  Edit2,
  Cpu,
  Mic,
  Volume2,
  Clock,
  PhoneCall,
  AlertCircle,
} from 'lucide-react'

interface AgentCardProps {
  agent: Agent
  leads: Lead[]
  phoneNumbers: PhoneNumber[]
}

export function AgentCard({ agent, leads, phoneNumbers }: AgentCardProps) {
  const router = useRouter()
  const [callDialogOpen, setCallDialogOpen] = useState(false)
  const [selectedLeadId, setSelectedLeadId] = useState('')
  const [selectedPhoneId, setSelectedPhoneId] = useState('')
  const [initiating, setInitiating] = useState(false)
  const [error, setError] = useState('')

  const pendingLeads = leads.filter(l => l.status === 'pending')
  const activePhoneNumbers = phoneNumbers.filter(p => p.active)

  async function handleInitiateCall() {
    if (!selectedLeadId || !selectedPhoneId) return
    setInitiating(true)
    setError('')
    try {
      const res = await fetch('/api/calls', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          leadId: selectedLeadId,
          agentId: agent.id,
          phoneNumberId: selectedPhoneId,
        }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Failed to initiate call')
      setCallDialogOpen(false)
      setSelectedLeadId('')
      setSelectedPhoneId('')
      router.refresh()
    } catch (err: any) {
      setError(err.message)
    } finally {
      setInitiating(false)
    }
  }

  const stack = [
    { icon: Cpu,     label: 'LLM', value: agent.active_llm_model },
    { icon: Mic,     label: 'STT', value: agent.active_stt },
    { icon: Volume2, label: 'TTS', value: agent.active_tts },
    { icon: Phone,   label: 'Tel', value: agent.active_telephony },
  ]

  return (
    <>
      <div className="bg-white rounded-xl border border-slate-200 shadow-sm hover:shadow-md transition-shadow duration-200 flex flex-col">
        {/* Header */}
        <div className="p-5 border-b border-slate-100">
          <div className="flex items-start gap-3">
            <div className="w-10 h-10 bg-blue-100 rounded-xl flex items-center justify-center shrink-0">
              <Bot className="h-5 w-5 text-blue-600" />
            </div>
            <div className="flex-1 min-w-0">
              <h3 className="font-semibold text-slate-900 truncate leading-snug">
                {agent.name}
              </h3>
              <p className="text-xs text-slate-400 mt-0.5 line-clamp-2 leading-relaxed">
                {agent.description || 'No description provided'}
              </p>
            </div>
          </div>
        </div>

        {/* Tech stack grid */}
        <div className="px-5 py-4 space-y-2">
          <p className="text-[10px] uppercase tracking-widest font-semibold text-slate-400">
            Technology Stack
          </p>
          <div className="grid grid-cols-2 gap-1.5">
            {stack.map(({ icon: Icon, label, value }) => (
              <div
                key={label}
                className="flex items-center gap-1.5 bg-slate-50 border border-slate-100 rounded-lg px-2.5 py-1.5"
              >
                <Icon className="h-3 w-3 text-slate-400 shrink-0" />
                <span className="text-[11px] font-medium text-slate-500 shrink-0">{label}:</span>
                <span className="text-[11px] text-slate-700 truncate font-mono">{value}</span>
              </div>
            ))}
          </div>
          <div className="flex items-center gap-1.5 bg-slate-50 border border-slate-100 rounded-lg px-2.5 py-1.5">
            <Clock className="h-3 w-3 text-slate-400 shrink-0" />
            <span className="text-[11px] font-medium text-slate-500 shrink-0">Max duration:</span>
            <span className="text-[11px] text-slate-700 font-mono">
              {agent.max_call_duration_seconds}s (
              {Math.floor(agent.max_call_duration_seconds / 60)}m)
            </span>
          </div>
        </div>

        {/* Actions */}
        <div className="px-5 pb-5 mt-auto flex gap-2">
          <Button
            variant="outline"
            size="sm"
            className="flex-1 text-slate-600"
            onClick={() => router.push(`/agents/${agent.id}`)}
          >
            <Edit2 className="h-3.5 w-3.5 mr-1.5" />
            Edit
          </Button>
          <Button
            size="sm"
            className="flex-1 bg-blue-600 hover:bg-blue-700 text-white"
            onClick={() => { setError(''); setCallDialogOpen(true) }}
          >
            <PhoneCall className="h-3.5 w-3.5 mr-1.5" />
            Call
          </Button>
        </div>
      </div>

      {/* ── Call dialog ── */}
      <Dialog open={callDialogOpen} onOpenChange={v => { setCallDialogOpen(v); if (!v) setError('') }}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 bg-blue-100 rounded-xl flex items-center justify-center">
                <PhoneCall className="h-5 w-5 text-blue-600" />
              </div>
              <div>
                <DialogTitle>Initiate Call</DialogTitle>
                <p className="text-sm text-slate-500 mt-0.5">Using: <strong>{agent.name}</strong></p>
              </div>
            </div>
          </DialogHeader>

          <div className="space-y-5 py-2">
            {/* Lead */}
            <div className="space-y-1.5">
              <Label className="text-sm font-medium text-slate-700">
                Lead to Call
              </Label>
              <Select value={selectedLeadId} onValueChange={setSelectedLeadId}>
                <SelectTrigger>
                  <SelectValue placeholder="Choose a pending lead..." />
                </SelectTrigger>
                <SelectContent>
                  {pendingLeads.length === 0 ? (
                    <div className="px-3 py-4 text-sm text-slate-400 text-center">
                      No pending leads available
                    </div>
                  ) : (
                    pendingLeads.map(lead => (
                      <SelectItem key={lead.id} value={lead.id}>
                        <span className="font-medium">{lead.business_name}</span>
                        <span className="text-xs text-slate-400 ml-2">{lead.phone_number}</span>
                      </SelectItem>
                    ))
                  )}
                </SelectContent>
              </Select>
              <p className="text-xs text-slate-400">
                {pendingLeads.length} pending lead{pendingLeads.length !== 1 ? 's' : ''} available
              </p>
            </div>

            {/* Phone number */}
            <div className="space-y-1.5">
              <Label className="text-sm font-medium text-slate-700">
                Outbound Number (Caller ID)
              </Label>
              <Select value={selectedPhoneId} onValueChange={setSelectedPhoneId}>
                <SelectTrigger>
                  <SelectValue placeholder="Choose a phone number..." />
                </SelectTrigger>
                <SelectContent>
                  {activePhoneNumbers.length === 0 ? (
                    <div className="px-3 py-4 text-sm text-slate-400 text-center">
                      No active phone numbers configured
                    </div>
                  ) : (
                    activePhoneNumbers.map(phone => (
                      <SelectItem key={phone.id} value={phone.id}>
                        {phone.number}
                        {phone.label ? (
                          <span className="text-xs text-slate-400 ml-2">· {phone.label}</span>
                        ) : null}
                      </SelectItem>
                    ))
                  )}
                </SelectContent>
              </Select>
              <p className="text-xs text-slate-400">
                The number the prospect will see on their caller ID
              </p>
            </div>

            {error && (
              <div className="flex items-center gap-2 bg-red-50 border border-red-200 rounded-lg px-3 py-2.5">
                <AlertCircle className="h-4 w-4 text-red-500 shrink-0" />
                <p className="text-sm text-red-600">{error}</p>
              </div>
            )}
          </div>

          <DialogFooterUI>
            <Button variant="outline" onClick={() => setCallDialogOpen(false)}>
              Cancel
            </Button>
            <Button
              onClick={handleInitiateCall}
              disabled={!selectedLeadId || !selectedPhoneId || initiating}
              className="bg-blue-600 hover:bg-blue-700 text-white"
            >
              {initiating ? (
                <>
                  <span className="mr-2 animate-spin inline-block">⟳</span>
                  Initiating...
                </>
              ) : (
                <>
                  <PhoneCall className="h-4 w-4 mr-2" />
                  Start Call
                </>
              )}
            </Button>
          </DialogFooterUI>
        </DialogContent>
      </Dialog>
    </>
  )
}
