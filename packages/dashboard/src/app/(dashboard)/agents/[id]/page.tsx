'use client'

import { useEffect, useState } from 'react'
import { useParams, useRouter } from 'next/navigation'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import type { Agent } from '@voiceflow/shared'
import {
  ArrowLeft,
  Save,
  Bot,
  MessageSquare,
  Cpu,
  Info,
  Phone,
  Mic,
  Volume2,
  Clock,
  CheckCircle,
  AlertCircle,
} from 'lucide-react'

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

const messageFields = [
  {
    field: 'greeting_message',
    label: 'Opening Greeting',
    emoji: '👋',
    trigger: 'When call connects',
    placeholder:
      'Hello, is this the business? Hi, my name is Sarah from WebCraftio…',
    hint: 'The very first thing the agent says when someone answers. Keep it natural, brief, and engaging.',
  },
  {
    field: 'interest_detected_message',
    label: 'Interest Detected',
    emoji: '🎯',
    trigger: 'When prospect shows interest',
    placeholder:
      "That's great to hear! I'll have one of our specialists call you back for a quick 10-minute demo…",
    hint: 'Triggered when the AI detects genuine interest. Should immediately offer a next step (callback or demo).',
  },
  {
    field: 'not_interested_message',
    label: 'Not Interested',
    emoji: '👍',
    trigger: 'When prospect declines',
    placeholder:
      'Absolutely no problem at all. Thanks so much for your time. Have a great day!',
    hint: "Used when the prospect clearly isn't interested. Always stay polite and leave a positive impression.",
  },
  {
    field: 'wrong_person_message',
    label: 'Wrong Person',
    emoji: '🔄',
    trigger: 'When not the decision maker',
    placeholder:
      'Sorry about that! Who would be the right person to speak to about technology decisions in the business?',
    hint: "Triggered when the call reaches someone who isn't the decision maker. Politely ask for a referral.",
  },
  {
    field: 'callback_message',
    label: 'Callback Request',
    emoji: '📅',
    trigger: 'When prospect asks to be called back',
    placeholder:
      "Of course, I completely understand. What time works better — morning or afternoon? And is there a specific person I should ask for?",
    hint: "Used when the prospect asks to be reached at a better time. Capture their preferred slot and contact name.",
  },
]

export default function AgentEditPage() {
  const params = useParams()
  const router = useRouter()
  const id = params.id as string
  const isNew = id === 'new'

  const [agent, setAgent] = useState<Partial<Agent>>(DEFAULT_AGENT)
  const [saving, setSaving] = useState(false)
  const [loading, setLoading] = useState(!isNew)
  const [error, setError] = useState('')
  const [success, setSuccess] = useState(false)

  useEffect(() => {
    if (!isNew) {
      fetch(`/api/agents/${id}`)
        .then(r => r.json())
        .then(data => { if (data.agent) setAgent(data.agent) })
        .catch(console.error)
        .finally(() => setLoading(false))
    }
  }, [id, isNew])

  function handleChange(field: keyof Agent, value: string | number) {
    setAgent(prev => ({ ...prev, [field]: value }))
    setSuccess(false)
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

  const maxDuration = agent.max_call_duration_seconds || 180

  /* ── Loading skeleton ── */
  if (loading) {
    return (
      <div className="flex items-center justify-center py-24">
        <div className="text-center">
          <div className="w-12 h-12 bg-blue-100 rounded-2xl flex items-center justify-center mx-auto mb-4 animate-pulse">
            <Bot className="h-6 w-6 text-blue-600" />
          </div>
          <p className="text-slate-500 text-sm">Loading agent…</p>
        </div>
      </div>
    )
  }

  return (
    <div className="max-w-3xl pb-12">
      {/* ── Page header ── */}
      <div className="flex items-center gap-3 mb-8">
        <Button
          variant="ghost"
          size="icon"
          onClick={() => router.push('/agents')}
          className="shrink-0 text-slate-500"
        >
          <ArrowLeft className="h-4 w-4" />
        </Button>
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 bg-blue-100 rounded-xl flex items-center justify-center shrink-0">
            <Bot className="h-5 w-5 text-blue-600" />
          </div>
          <div>
            <h1 className="text-2xl font-bold text-slate-900">
              {isNew ? 'Create New Agent' : 'Edit Agent'}
            </h1>
            <p className="text-slate-500 text-sm">
              {isNew
                ? 'Configure your AI calling agent from scratch'
                : `Editing: ${agent.name}`}
            </p>
          </div>
        </div>
      </div>

      <div className="space-y-6">
        {/* ── Section 1: Identity ── */}
        <Section
          number={1}
          title="Agent Identity"
          subtitle="Name, description, and core behaviour instructions"
        >
          <FieldGroup
            label="Agent Name"
            required
            hint="Shown in dashboards, call logs, and agent selection menus."
          >
            <Input
              value={agent.name || ''}
              onChange={e => handleChange('name', e.target.value)}
              placeholder="e.g. WebCraftio Sales Agent"
              className="bg-slate-50"
            />
          </FieldGroup>

          <FieldGroup
            label="Description"
            hint="A short note to remind you what this agent is for (optional)."
          >
            <Input
              value={agent.description || ''}
              onChange={e => handleChange('description', e.target.value)}
              placeholder="e.g. Outbound agent for WebCraftio AI services – UK leads"
              className="bg-slate-50"
            />
          </FieldGroup>

          <FieldGroup
            label="System Prompt"
            required
            hint=""
            charCount={(agent.system_prompt || '').length}
          >
            <Textarea
              value={agent.system_prompt || ''}
              onChange={e => handleChange('system_prompt', e.target.value)}
              placeholder="You are a friendly outbound representative for WebCraftio, a UK-based web development and AI agency…"
              rows={7}
              className="bg-slate-50 resize-none"
            />
            <div className="bg-blue-50 border border-blue-100 rounded-xl p-4 flex gap-3">
              <Info className="h-4 w-4 text-blue-500 shrink-0 mt-0.5" />
              <div className="text-xs text-blue-700 space-y-1.5">
                <p className="font-semibold">Tips for an effective system prompt:</p>
                <ul className="space-y-1 text-blue-600 list-disc list-inside">
                  <li>Define the agent&apos;s role, company, and services clearly</li>
                  <li>Set a single, clear goal (e.g. &quot;Your ONLY goal is to detect interest&quot;)</li>
                  <li>State what the agent must NOT do (e.g. &quot;Never quote prices or try to sell directly&quot;)</li>
                  <li>Describe the tone (e.g. &quot;Friendly, concise, professional, never pushy&quot;)</li>
                </ul>
              </div>
            </div>
          </FieldGroup>
        </Section>

        {/* ── Section 2: Conversation Scripts ── */}
        <Section
          number={2}
          title="Conversation Scripts"
          subtitle="What the agent says in each call scenario — triggered automatically by the AI"
          icon={<MessageSquare className="h-4 w-4 text-blue-600" />}
        >
          {messageFields.map(({ field, label, emoji, trigger, placeholder, hint }) => (
            <div key={field} className="space-y-1.5">
              <div className="flex flex-wrap items-center gap-2 mb-1">
                <span className="text-base">{emoji}</span>
                <Label className="font-medium text-slate-800">
                  {label} <span className="text-red-500">*</span>
                </Label>
                <span className="ml-auto text-[11px] bg-slate-100 text-slate-600 rounded-full px-2.5 py-0.5 font-medium">
                  {trigger}
                </span>
              </div>
              <Textarea
                value={(agent as any)[field] || ''}
                onChange={e =>
                  handleChange(field as keyof Agent, e.target.value)
                }
                placeholder={placeholder}
                rows={2}
                className="bg-slate-50 resize-none text-sm"
              />
              <p className="text-xs text-slate-400">{hint}</p>
            </div>
          ))}
        </Section>

        {/* ── Section 3: Technology Stack ── */}
        <Section
          number={3}
          title="Technology Stack"
          subtitle="AI providers and call configuration for this agent"
          icon={<Cpu className="h-4 w-4 text-blue-600" />}
        >
          <div className="grid sm:grid-cols-2 gap-5">
            <FieldGroup
              label="LLM Provider"
              hint="AI brain that generates the agent's responses."
              icon={<Cpu className="h-3.5 w-3.5 text-slate-400" />}
            >
              <Select
                value={agent.active_llm || 'anthropic'}
                onValueChange={v => handleChange('active_llm', v)}
              >
                <SelectTrigger className="bg-slate-50">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="anthropic">Anthropic (Claude)</SelectItem>
                  <SelectItem value="openai">OpenAI (GPT)</SelectItem>
                </SelectContent>
              </Select>
            </FieldGroup>

            <FieldGroup
              label="LLM Model"
              hint="Exact model ID (e.g. claude-haiku-4-5, gpt-4o-mini)."
              icon={<Cpu className="h-3.5 w-3.5 text-slate-400" />}
            >
              <Input
                value={agent.active_llm_model || ''}
                onChange={e => handleChange('active_llm_model', e.target.value)}
                placeholder="claude-haiku-4-5"
                className="bg-slate-50 font-mono text-sm"
              />
            </FieldGroup>

            <FieldGroup
              label="Text-to-Speech (TTS)"
              hint="Converts the agent's text into spoken audio."
              icon={<Volume2 className="h-3.5 w-3.5 text-slate-400" />}
            >
              <Select
                value={agent.active_tts || 'elevenlabs'}
                onValueChange={v => handleChange('active_tts', v)}
              >
                <SelectTrigger className="bg-slate-50">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="elevenlabs">ElevenLabs — Most natural</SelectItem>
                  <SelectItem value="deepgram">Deepgram Aura — Fast & cheap</SelectItem>
                  <SelectItem value="google">Google TTS</SelectItem>
                </SelectContent>
              </Select>
            </FieldGroup>

            <FieldGroup
              label="Speech-to-Text (STT)"
              hint="Transcribes the prospect's speech in real-time."
              icon={<Mic className="h-3.5 w-3.5 text-slate-400" />}
            >
              <Select
                value={agent.active_stt || 'deepgram'}
                onValueChange={v => handleChange('active_stt', v)}
              >
                <SelectTrigger className="bg-slate-50">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="deepgram">Deepgram Nova-3 — Recommended</SelectItem>
                  <SelectItem value="google">Google STT</SelectItem>
                </SelectContent>
              </Select>
            </FieldGroup>

            <FieldGroup
              label="Telephony Provider"
              hint="SIP provider that makes the physical phone call."
              icon={<Phone className="h-3.5 w-3.5 text-slate-400" />}
            >
              <Select
                value={agent.active_telephony || 'telnyx'}
                onValueChange={v => handleChange('active_telephony', v)}
              >
                <SelectTrigger className="bg-slate-50">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="telnyx">Telnyx — Recommended</SelectItem>
                  <SelectItem value="twilio">Twilio</SelectItem>
                </SelectContent>
              </Select>
            </FieldGroup>

            <FieldGroup
              label="Max Call Duration"
              hint={`= ${Math.floor(maxDuration / 60)}m ${maxDuration % 60}s · Recommended: 180s`}
              icon={<Clock className="h-3.5 w-3.5 text-slate-400" />}
            >
              <div className="relative">
                <Input
                  type="number"
                  min={30}
                  max={600}
                  value={maxDuration}
                  onChange={e =>
                    handleChange(
                      'max_call_duration_seconds',
                      parseInt(e.target.value, 10) || 180
                    )
                  }
                  className="bg-slate-50 pr-12"
                />
                <span className="absolute right-3 top-1/2 -translate-y-1/2 text-xs text-slate-400 pointer-events-none">
                  sec
                </span>
              </div>
            </FieldGroup>
          </div>
        </Section>

        {/* ── Status messages ── */}
        {error && (
          <div className="flex items-center gap-3 bg-red-50 border border-red-200 rounded-xl px-4 py-3">
            <AlertCircle className="h-5 w-5 text-red-500 shrink-0" />
            <p className="text-sm text-red-700">{error}</p>
          </div>
        )}
        {success && (
          <div className="flex items-center gap-3 bg-emerald-50 border border-emerald-200 rounded-xl px-4 py-3">
            <CheckCircle className="h-5 w-5 text-emerald-500 shrink-0" />
            <p className="text-sm text-emerald-700">
              Agent saved successfully!
            </p>
          </div>
        )}

        {/* ── Actions ── */}
        <div className="flex flex-col sm:flex-row gap-3">
          <Button
            onClick={handleSave}
            disabled={saving || !agent.name?.trim()}
            className="flex-1 bg-blue-600 hover:bg-blue-700 text-white h-11 text-sm"
          >
            {saving ? (
              <>
                <span className="mr-2 animate-spin inline-block">⟳</span>
                Saving…
              </>
            ) : (
              <>
                <Save className="h-4 w-4 mr-2" />
                {isNew ? 'Create Agent' : 'Save Changes'}
              </>
            )}
          </Button>
          <Button
            variant="outline"
            onClick={() => router.push('/agents')}
            className="h-11 text-sm"
          >
            Cancel
          </Button>
        </div>
      </div>
    </div>
  )
}

/* ── Sub-components ── */

function Section({
  number,
  title,
  subtitle,
  icon,
  children,
}: {
  number: number
  title: string
  subtitle: string
  icon?: React.ReactNode
  children: React.ReactNode
}) {
  return (
    <div className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
      <div className="bg-slate-50 border-b border-slate-200 px-6 py-4 flex items-center gap-3">
        <div className="w-7 h-7 bg-blue-600 text-white rounded-lg flex items-center justify-center text-xs font-bold shrink-0">
          {number}
        </div>
        <div>
          <h2 className="font-semibold text-slate-900 text-sm">{title}</h2>
          <p className="text-xs text-slate-500 mt-0.5">{subtitle}</p>
        </div>
        {icon && <div className="ml-auto">{icon}</div>}
      </div>
      <div className="p-6 space-y-5">{children}</div>
    </div>
  )
}

function FieldGroup({
  label,
  required,
  hint,
  charCount,
  icon,
  children,
}: {
  label: string
  required?: boolean
  hint: string
  charCount?: number
  icon?: React.ReactNode
  children: React.ReactNode
}) {
  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-1.5">
        {icon}
        <Label className="font-medium text-slate-700 text-sm">
          {label}
          {required && <span className="text-red-500 ml-0.5">*</span>}
        </Label>
        {charCount !== undefined && (
          <span className="ml-auto text-xs text-slate-400">{charCount} chars</span>
        )}
      </div>
      {children}
      {hint && <p className="text-xs text-slate-400 leading-relaxed">{hint}</p>}
    </div>
  )
}
