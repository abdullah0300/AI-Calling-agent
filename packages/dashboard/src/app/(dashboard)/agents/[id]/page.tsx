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

// ── Vapi-style prompt sections ───────────────────────────────────────────────

interface PromptSections {
  identity: string
  style: string
  responseGuideline: string
  task: string
  errorHandling: string
}

const EMPTY_SECTIONS: PromptSections = {
  identity: '',
  style: '',
  responseGuideline: '',
  task: '',
  errorHandling: '',
}

/** Parse a stored system_prompt string back into its five Vapi sections. */
function parsePromptSections(prompt: string): PromptSections {
  if (!prompt?.trim()) return { ...EMPTY_SECTIONS }

  const headerRegex = /^\[(Identity|Style|Response Guideline|Task|Error Handling|Context)\]\s*$/im
  const keyMap: Record<string, keyof PromptSections> = {
    identity: 'identity',
    style: 'style',
    'response guideline': 'responseGuideline',
    task: 'task',
    'error handling': 'errorHandling',
  }

  const lines = prompt.split('\n')
  const result = { ...EMPTY_SECTIONS }
  let current: keyof PromptSections | null = null
  const buffer: string[] = []

  function flush() {
    if (current) {
      result[current] = buffer.join('\n').trim()
      buffer.length = 0
    }
  }

  for (const line of lines) {
    const match = line.match(/^\[(.+?)\]\s*$/)
    if (match) {
      const key = match[1].toLowerCase()
      if (keyMap[key]) {
        flush()
        current = keyMap[key]
        continue
      }
      // [Context] and unknown headers — skip header line, stop capturing
      flush()
      current = null
      continue
    }
    if (current) buffer.push(line)
  }
  flush()

  // Legacy flat prompt (no sections found) — put entire text in identity
  const hasAnySections = Object.values(result).some(v => v.trim())
  if (!hasAnySections) result.identity = prompt.trim()

  return result
}

/** Assemble five sections into the stored system_prompt string. */
function assembleSystemPrompt(s: PromptSections): string {
  const parts: string[] = []
  if (s.identity.trim())          parts.push(`[Identity]\n${s.identity.trim()}`)
  if (s.style.trim())             parts.push(`[Style]\n${s.style.trim()}`)
  if (s.responseGuideline.trim()) parts.push(`[Response Guideline]\n${s.responseGuideline.trim()}`)
  if (s.task.trim())              parts.push(`[Task]\n${s.task.trim()}`)
  if (s.errorHandling.trim())     parts.push(`[Error Handling]\n${s.errorHandling.trim()}`)
  return parts.join('\n\n')
}

// ── Section definitions ──────────────────────────────────────────────────────

const PROMPT_SECTIONS = [
  {
    key: 'identity' as keyof PromptSections,
    label: '[Identity]',
    subtitle: 'Who the agent is — name, company, role, and goal',
    rows: 4,
    placeholder:
      'You are Sarah, a friendly outbound representative for WebCraftio, a UK-based AI agency. You call business owners to introduce AI voice agents that automate customer calls. Your ONLY goal is to detect interest and arrange a specialist callback.',
    hint: 'Define the agent\'s name, company, and purpose. This is the first thing the LLM reads — be specific about who they are and what success looks like.',
  },
  {
    key: 'style' as keyof PromptSections,
    label: '[Style]',
    subtitle: 'Tone, pacing, and speaking rules',
    rows: 4,
    placeholder:
      '- Warm, confident, and professional. Never pushy or salesy.\n- Keep every response under 30 words. You are speaking aloud, not writing.\n- Short sentences. Natural human speech patterns.\n- No bullet points or markdown when speaking.',
    hint: 'Controls how the agent sounds. Voice agents need different rules than text — keep responses short, no lists, no markdown.',
  },
  {
    key: 'responseGuideline' as keyof PromptSections,
    label: '[Response Guideline]',
    subtitle: 'Rules the agent must always follow',
    rows: 4,
    placeholder:
      '- Ask only one question at a time — never stack two questions.\n- Spell numbers in words (say "five hundred" not "500").\n- Never quote prices or try to close a sale.\n- Never hang up without getting at least a name, callback time, or email.',
    hint: 'Hard constraints the agent must never break. Use clear, direct language — "never", "always", "only".',
  },
  {
    key: 'task' as keyof PromptSections,
    label: '[Task]',
    subtitle: 'Numbered call flow with <wait for user response> between steps',
    rows: 8,
    placeholder:
      '1. Greet the prospect and introduce yourself and the company.\n<wait for user response>\n2. Ask: "Have you looked into AI automation for your business at all?"\n<wait for user response>\n3. If curious, briefly describe what you offer in one sentence.\n<wait for user response>\n4. Offer a callback: "I can have one of our specialists call you — morning or afternoon works better?"\n<wait for user response>\n5. Confirm the slot, thank them, and close the call.',
    hint: 'The step-by-step script. The <wait for user response> tag is critical — without it the agent rushes through steps like a monologue.',
  },
  {
    key: 'errorHandling' as keyof PromptSections,
    label: '[Error Handling]',
    subtitle: 'What to say when the conversation goes off-script',
    rows: 3,
    placeholder:
      '- If unclear: "I am sorry, I did not quite catch that. Could you say that again?"\n- If asked something outside your scope: "That is a great question for our specialist on the callback."\n- If silence for a few seconds: "Hello, are you still there?"',
    hint: 'Fallback instructions keep the agent from getting stuck or hallucinating when the prospect says something unexpected.',
  },
]

// ── Conversation scripts ─────────────────────────────────────────────────────

const MESSAGE_FIELDS = [
  {
    field: 'greeting_message',
    label: 'Opening Greeting',
    emoji: '👋',
    trigger: 'Spoken first — no LLM delay',
    placeholder:
      'Hello, is this the business? Hi, my name is Sarah from WebCraftio…',
    hint: 'The very first thing the agent says when someone answers. Sent directly to TTS — no LLM call, instant playback. Keep it natural and brief.',
  },
  {
    field: 'not_interested_message',
    label: 'Not Interested / DNC',
    emoji: '👍',
    trigger: 'On "not interested" keywords',
    placeholder:
      'Absolutely no problem at all. Thanks so much for your time. Have a great day!',
    hint: 'Fires instantly when the prospect says a DNC phrase ("not interested", "remove me", "do not call", etc.). Bypasses the LLM entirely — immediate polite exit. All other objections (wrong person, callback, hesitation) are handled by the LLM via [Task] in the system prompt above.',
  },
]

// ── Default state ─────────────────────────────────────────────────────────────

const DEFAULT_AGENT: Partial<Agent> = {
  name: '',
  description: '',
  system_prompt: '',
  greeting_message: '',
  not_interested_message: '',
  max_call_duration_seconds: 180,
  active_llm: 'anthropic',
  active_llm_model: 'claude-haiku-4-5',
  active_tts: 'elevenlabs',
  active_stt: 'deepgram',
  active_stt_model: null,  // null = inherit from global Settings
  active_telephony: 'telnyx',
}

// ── Page component ────────────────────────────────────────────────────────────

export default function AgentEditPage() {
  const params = useParams()
  const router = useRouter()
  const id = params.id as string
  const isNew = id === 'new'

  const [agent, setAgent] = useState<Partial<Agent>>(DEFAULT_AGENT)
  const [sections, setSections] = useState<PromptSections>({ ...EMPTY_SECTIONS })
  const [saving, setSaving] = useState(false)
  const [loading, setLoading] = useState(!isNew)
  const [error, setError] = useState('')
  const [success, setSuccess] = useState(false)

  useEffect(() => {
    if (!isNew) {
      fetch(`/api/agents/${id}`)
        .then(r => r.json())
        .then(data => {
          if (data.agent) {
            setAgent(data.agent)
            setSections(parsePromptSections(data.agent.system_prompt || ''))
          }
        })
        .catch(console.error)
        .finally(() => setLoading(false))
    }
  }, [id, isNew])

  function handleChange(field: keyof Agent, value: string | number) {
    setAgent(prev => ({ ...prev, [field]: value }))
    setSuccess(false)
  }

  function handleSectionChange(key: keyof PromptSections, value: string) {
    const next = { ...sections, [key]: value }
    setSections(next)
    setAgent(prev => ({ ...prev, system_prompt: assembleSystemPrompt(next) }))
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
          subtitle="Name and description for this agent"
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
        </Section>

        {/* ── Section 2: System Prompt (Vapi Structure) ── */}
        <Section
          number={2}
          title="System Prompt"
          subtitle="Industry-standard Vapi prompt structure — fill in each section to build the agent's behaviour"
          icon={<Bot className="h-4 w-4 text-blue-600" />}
        >
          {/* Info banner */}
          <div className="bg-blue-50 border border-blue-100 rounded-xl p-4 flex gap-3">
            <Info className="h-4 w-4 text-blue-500 shrink-0 mt-0.5" />
            <div className="text-xs text-blue-700 space-y-1">
              <p className="font-semibold">Industry-standard Vapi prompt format</p>
              <p className="text-blue-600 leading-relaxed">
                Each section tells the AI a different thing. <strong>[Identity]</strong> defines who it is.{' '}
                <strong>[Style]</strong> controls how it speaks. <strong>[Task]</strong> is the actual call script —
                use <code className="bg-blue-100 px-1 rounded">{'<wait for user response>'}</code> between steps
                so the agent doesn&apos;t rush through like a monologue.
              </p>
            </div>
          </div>

          {PROMPT_SECTIONS.map(({ key, label, subtitle, rows, placeholder, hint }) => (
            <div key={key} className="space-y-1.5">
              <div className="flex flex-wrap items-baseline gap-2">
                <Label className="font-semibold text-slate-800 text-sm font-mono">{label}</Label>
                <span className="text-xs text-slate-400">{subtitle}</span>
                <span className="ml-auto text-xs text-slate-400">
                  {(sections[key] || '').length} chars
                </span>
              </div>
              <Textarea
                value={sections[key] || ''}
                onChange={e => handleSectionChange(key, e.target.value)}
                placeholder={placeholder}
                rows={rows}
                className="bg-slate-50 resize-none text-sm font-mono"
              />
              <p className="text-xs text-slate-400 leading-relaxed">{hint}</p>
            </div>
          ))}
        </Section>

        {/* ── Section 3: Conversation Scripts ── */}
        <Section
          number={3}
          title="Instant Scripts"
          subtitle="Two hard-coded messages that bypass the LLM entirely — spoken with zero latency"
          icon={<MessageSquare className="h-4 w-4 text-blue-600" />}
        >
          <div className="bg-amber-50 border border-amber-100 rounded-xl p-4 flex gap-3">
            <Info className="h-4 w-4 text-amber-500 shrink-0 mt-0.5" />
            <div className="text-xs text-amber-700 space-y-1">
              <p className="font-semibold">No AI generation — instant playback</p>
              <p className="leading-relaxed">
                These two messages go straight to text-to-speech — the LLM is never called.
                Everything else (wrong person, callback requests, hesitation, objections) is handled
                by the LLM using the <strong>[Task]</strong> section in your system prompt above.
              </p>
            </div>
          </div>

          {MESSAGE_FIELDS.map(({ field, label, emoji, trigger, placeholder, hint }) => (
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
                onChange={e => handleChange(field as keyof Agent, e.target.value)}
                placeholder={placeholder}
                rows={2}
                className="bg-slate-50 resize-none text-sm"
              />
              <p className="text-xs text-slate-400">{hint}</p>
            </div>
          ))}
        </Section>

        {/* ── Section 4: Technology Stack ── */}
        <Section
          number={4}
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
                  <SelectItem value="deepgram">Deepgram Aura — Fast &amp; cheap</SelectItem>
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
                  <SelectItem value="deepgram">Deepgram</SelectItem>
                  <SelectItem value="google">Google STT</SelectItem>
                </SelectContent>
              </Select>
            </FieldGroup>

            <FieldGroup
              label="Deepgram STT Model"
              hint="Override the global model for this agent only. Leave as 'Use global setting' to follow Settings page."
              icon={<Mic className="h-3.5 w-3.5 text-slate-400" />}
            >
              <Select
                value={agent.active_stt_model || ''}
                onValueChange={v => handleChange('active_stt_model', v === '__global__' ? '' : v)}
              >
                <SelectTrigger className="bg-slate-50">
                  <SelectValue placeholder="Use global setting" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="__global__">Use global setting (Settings page)</SelectItem>
                  <SelectItem value="flux">Flux — Voice-agent optimised (newest)</SelectItem>
                  <SelectItem value="nova-3">Nova 3 — Best accuracy</SelectItem>
                  <SelectItem value="nova-2-phonecall">Nova 2 Phonecall — Phone-optimised</SelectItem>
                  <SelectItem value="nova-2">Nova 2 — Stable fallback</SelectItem>
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
            <p className="text-sm text-emerald-700">Agent saved successfully!</p>
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

// ── Sub-components ────────────────────────────────────────────────────────────

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
  icon,
  children,
}: {
  label: string
  required?: boolean
  hint: string
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
      </div>
      {children}
      {hint && <p className="text-xs text-slate-400 leading-relaxed">{hint}</p>}
    </div>
  )
}
