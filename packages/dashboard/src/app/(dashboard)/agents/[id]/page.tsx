'use client'

import { useEffect, useState } from 'react'
import { useParams, useRouter } from 'next/navigation'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import type { Agent } from '@voiceflow/shared'
import { ArrowLeft, Save } from 'lucide-react'

const DEFAULT_AGENT: Partial<Agent> = {
  name: '',
  description: '',
  system_prompt: '',
  greeting_message: '',
  interest_detected_message: '',
  not_interested_message: '',
  wrong_person_message: '',
  callback_message: '',
  max_call_duration_seconds: 180,
  active_llm: 'anthropic',
  active_llm_model: 'claude-haiku-4-5',
  active_tts: 'elevenlabs',
  active_stt: 'deepgram',
  active_telephony: 'telnyx',
}

export default function AgentEditPage() {
  const params = useParams()
  const router = useRouter()
  const id = params.id as string
  const isNew = id === 'new'

  const [agent, setAgent] = useState<Partial<Agent>>(DEFAULT_AGENT)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [success, setSuccess] = useState(false)

  useEffect(() => {
    if (!isNew) {
      fetch(`/api/agents/${id}`)
        .then(r => r.json())
        .then(data => { if (data.agent) setAgent(data.agent) })
        .catch(console.error)
    }
  }, [id, isNew])

  function handleChange(field: keyof Agent, value: string | number) {
    setAgent(prev => ({ ...prev, [field]: value }))
  }

  async function handleSave() {
    setSaving(true)
    setError('')
    setSuccess(false)
    try {
      const url = isNew ? '/api/agents' : `/api/agents/${id}`
      const method = isNew ? 'POST' : 'PUT'
      const res = await fetch(url, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(agent),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Save failed')
      setSuccess(true)
      if (isNew && data.agent?.id) {
        router.push(`/agents/${data.agent.id}`)
      }
    } catch (err: any) {
      setError(err.message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="space-y-6 max-w-3xl">
      <div className="flex items-center gap-4">
        <Button variant="ghost" size="icon" onClick={() => router.push('/agents')}>
          <ArrowLeft className="h-4 w-4" />
        </Button>
        <div>
          <h1 className="text-2xl font-bold">{isNew ? 'New Agent' : 'Edit Agent'}</h1>
          <p className="text-muted-foreground">Configure your AI calling agent</p>
        </div>
      </div>

      <Card>
        <CardHeader><CardTitle>Basic Info</CardTitle></CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <Label>Name *</Label>
            <Input value={agent.name || ''} onChange={e => handleChange('name', e.target.value)} placeholder="WebCraftio Sales Agent" />
          </div>
          <div className="space-y-2">
            <Label>Description</Label>
            <Input value={agent.description || ''} onChange={e => handleChange('description', e.target.value)} placeholder="Brief description of this agent" />
          </div>
          <div className="space-y-2">
            <Label>System Prompt *</Label>
            <Textarea
              value={agent.system_prompt || ''}
              onChange={e => handleChange('system_prompt', e.target.value)}
              placeholder="You are a friendly outbound representative for..."
              rows={6}
            />
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle>Conversation Messages</CardTitle></CardHeader>
        <CardContent className="space-y-4">
          {[
            { field: 'greeting_message', label: 'Greeting Message' },
            { field: 'interest_detected_message', label: 'Interest Detected Message' },
            { field: 'not_interested_message', label: 'Not Interested Message' },
            { field: 'wrong_person_message', label: 'Wrong Person Message' },
            { field: 'callback_message', label: 'Callback Message' },
          ].map(({ field, label }) => (
            <div key={field} className="space-y-2">
              <Label>{label} *</Label>
              <Textarea
                value={(agent as any)[field] || ''}
                onChange={e => handleChange(field as keyof Agent, e.target.value)}
                rows={2}
              />
            </div>
          ))}
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle>Provider Settings</CardTitle></CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label>LLM Provider</Label>
              <Select value={agent.active_llm || 'anthropic'} onValueChange={v => handleChange('active_llm', v)}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="anthropic">Anthropic (Claude)</SelectItem>
                  <SelectItem value="openai">OpenAI (GPT)</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label>LLM Model</Label>
              <Input value={agent.active_llm_model || ''} onChange={e => handleChange('active_llm_model', e.target.value)} placeholder="claude-haiku-4-5" />
            </div>
            <div className="space-y-2">
              <Label>TTS Provider</Label>
              <Select value={agent.active_tts || 'elevenlabs'} onValueChange={v => handleChange('active_tts', v)}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="elevenlabs">ElevenLabs</SelectItem>
                  <SelectItem value="deepgram">Deepgram</SelectItem>
                  <SelectItem value="google">Google</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label>STT Provider</Label>
              <Select value={agent.active_stt || 'deepgram'} onValueChange={v => handleChange('active_stt', v)}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="deepgram">Deepgram</SelectItem>
                  <SelectItem value="google">Google</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label>Telephony</Label>
              <Select value={agent.active_telephony || 'telnyx'} onValueChange={v => handleChange('active_telephony', v)}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="telnyx">Telnyx</SelectItem>
                  <SelectItem value="twilio">Twilio</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label>Max Call Duration (seconds)</Label>
              <Input
                type="number"
                min={30}
                max={600}
                value={agent.max_call_duration_seconds || 180}
                onChange={e => handleChange('max_call_duration_seconds', parseInt(e.target.value, 10))}
              />
            </div>
          </div>
        </CardContent>
      </Card>

      {error && <p className="text-sm text-destructive">{error}</p>}
      {success && <p className="text-sm text-green-600">Saved successfully!</p>}

      <div className="flex gap-2">
        <Button onClick={handleSave} disabled={saving}>
          <Save className="h-4 w-4 mr-2" />
          {saving ? 'Saving...' : 'Save Agent'}
        </Button>
        <Button variant="outline" onClick={() => router.push('/agents')}>Cancel</Button>
      </div>
    </div>
  )
}
