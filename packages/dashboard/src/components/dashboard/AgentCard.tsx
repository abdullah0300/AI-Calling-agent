'use client'

import { useState } from 'react'
import { Card, CardContent, CardHeader, CardTitle, CardDescription, CardFooter } from '@/components/ui/card'
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
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import type { Agent, Lead, PhoneNumber } from '@voiceflow/shared'
import { useRouter } from 'next/navigation'

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
        body: JSON.stringify({ leadId: selectedLeadId, agentId: agent.id, phoneNumberId: selectedPhoneId }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Failed to initiate call')
      setCallDialogOpen(false)
      router.refresh()
    } catch (err: any) {
      setError(err.message)
    } finally {
      setInitiating(false)
    }
  }

  return (
    <>
      <Card>
        <CardHeader>
          <CardTitle>{agent.name}</CardTitle>
          <CardDescription>{agent.description || 'No description'}</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex flex-wrap gap-2">
            <Badge variant="info">{agent.active_llm}/{agent.active_llm_model}</Badge>
            <Badge variant="secondary">TTS: {agent.active_tts}</Badge>
            <Badge variant="secondary">STT: {agent.active_stt}</Badge>
            <Badge variant="outline">{agent.active_telephony}</Badge>
            <Badge variant="outline">{agent.max_call_duration_seconds}s max</Badge>
          </div>
        </CardContent>
        <CardFooter className="gap-2">
          <Button variant="outline" size="sm" onClick={() => router.push(`/agents/${agent.id}`)}>
            Edit
          </Button>
          <Button size="sm" onClick={() => setCallDialogOpen(true)}>
            Make a Call
          </Button>
        </CardFooter>
      </Card>

      <Dialog open={callDialogOpen} onOpenChange={setCallDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Initiate Call — {agent.name}</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <Label>Select Lead</Label>
              <Select value={selectedLeadId} onValueChange={setSelectedLeadId}>
                <SelectTrigger>
                  <SelectValue placeholder="Choose a pending lead..." />
                </SelectTrigger>
                <SelectContent>
                  {pendingLeads.map(lead => (
                    <SelectItem key={lead.id} value={lead.id}>
                      {lead.business_name} — {lead.phone_number}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label>Phone Number (From)</Label>
              <Select value={selectedPhoneId} onValueChange={setSelectedPhoneId}>
                <SelectTrigger>
                  <SelectValue placeholder="Choose a phone number..." />
                </SelectTrigger>
                <SelectContent>
                  {activePhoneNumbers.map(phone => (
                    <SelectItem key={phone.id} value={phone.id}>
                      {phone.number} {phone.label ? `(${phone.label})` : ''}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            {error && <p className="text-sm text-destructive">{error}</p>}
          </div>
          <DialogFooterUI>
            <Button variant="outline" onClick={() => setCallDialogOpen(false)}>Cancel</Button>
            <Button
              onClick={handleInitiateCall}
              disabled={!selectedLeadId || !selectedPhoneId || initiating}
            >
              {initiating ? 'Initiating...' : 'Start Call'}
            </Button>
          </DialogFooterUI>
        </DialogContent>
      </Dialog>
    </>
  )
}
