'use client'

import { useEffect, useState } from 'react'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Label } from '@/components/ui/label'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import {
  Settings,
  Phone,
  Mic,
  Volume2,
  Cpu,
  Key,
  CheckCircle,
  AlertCircle,
  Eye,
  EyeOff,
  Save,
} from 'lucide-react'

interface Setting {
  key: string
  value: string
}

/* ── Provider defaults config ── */
const providerConfig = [
  {
    key: 'active_telephony',
    label: 'Telephony Provider',
    icon: Phone,
    iconBg: 'bg-blue-100',
    iconColor: 'text-blue-600',
    description: 'Makes the actual outbound phone calls.',
    options: [
      { value: 'telnyx',  label: 'Telnyx',  note: 'Recommended · UK & global' },
      { value: 'twilio',  label: 'Twilio',  note: 'Widely supported' },
    ],
  },
  {
    key: 'active_stt',
    label: 'Speech-to-Text (STT)',
    icon: Mic,
    iconBg: 'bg-violet-100',
    iconColor: 'text-violet-600',
    description: "Transcribes the prospect's speech in real-time.",
    options: [
      { value: 'deepgram', label: 'Deepgram', note: 'Recommended · fast & accurate' },
      { value: 'google',   label: 'Google STT',      note: 'Alternative' },
    ],
  },
  {
    key: 'active_stt_model',
    label: 'Deepgram STT Model',
    icon: Mic,
    iconBg: 'bg-violet-100',
    iconColor: 'text-violet-600',
    description: 'nova-2 works on all plans. nova-3 is the latest but requires a paid plan.',
    options: [
      { value: 'nova-2', label: 'Nova 2', note: 'Recommended · available on all plans' },
      { value: 'nova-3', label: 'Nova 3', note: 'Latest · requires paid Deepgram plan' },
    ],
  },
  {
    key: 'active_tts',
    label: 'Text-to-Speech (TTS)',
    icon: Volume2,
    iconBg: 'bg-emerald-100',
    iconColor: 'text-emerald-600',
    description: "Converts the agent's text responses to spoken audio.",
    options: [
      { value: 'elevenlabs', label: 'ElevenLabs',    note: 'Most natural voice' },
      { value: 'deepgram',   label: 'Deepgram Aura', note: 'Fast & cost-efficient' },
      { value: 'google',     label: 'Google TTS',    note: 'Alternative' },
    ],
  },
  {
    key: 'active_llm',
    label: 'LLM Provider',
    icon: Cpu,
    iconBg: 'bg-amber-100',
    iconColor: 'text-amber-600',
    description: 'AI model that understands and generates agent responses.',
    options: [
      { value: 'anthropic', label: 'Anthropic (Claude)', note: 'Recommended · Claude Haiku 4.5' },
      { value: 'openai',    label: 'OpenAI (GPT)',       note: 'Alternative' },
    ],
  },
]

/* ── API key groups ── */
const apiKeyGroups = [
  {
    provider: 'Telnyx',
    emoji: '📞',
    borderColor: 'border-blue-200',
    headerBg: 'bg-blue-50',
    description: 'Required for making outbound calls',
    keys: [
      {
        key: 'telnyx_api_key',
        label: 'API Key',
        placeholder: 'KEY_…',
        hint: 'Found in Telnyx Portal → API Keys',
        isSecret: true,
      },
      {
        key: 'telnyx_connection_id',
        label: 'Connection ID',
        placeholder: 'YOUR_CONNECTION_ID',
        hint: 'Your TeXML App or WebRTC connection ID',
        isSecret: false,
      },
    ],
  },
  {
    provider: 'Deepgram',
    emoji: '🎤',
    borderColor: 'border-violet-200',
    headerBg: 'bg-violet-50',
    description: 'Used for STT (speech recognition) and Deepgram Aura TTS',
    keys: [
      {
        key: 'deepgram_api_key',
        label: 'API Key',
        placeholder: 'YOUR_DEEPGRAM_API_KEY',
        hint: 'Found in Deepgram Console → API Keys',
        isSecret: true,
      },
    ],
  },
  {
    provider: 'ElevenLabs',
    emoji: '🔊',
    borderColor: 'border-emerald-200',
    headerBg: 'bg-emerald-50',
    description: 'Used for ultra-realistic text-to-speech voices',
    keys: [
      {
        key: 'elevenlabs_api_key',
        label: 'API Key',
        placeholder: 'YOUR_ELEVENLABS_API_KEY',
        hint: 'Found in ElevenLabs → Profile → API Key',
        isSecret: true,
      },
      {
        key: 'elevenlabs_voice_id',
        label: 'Voice ID',
        placeholder: '21m00Tcm4TlvDq8ikWAM',
        hint: 'Voice ID from your ElevenLabs voice library (not a secret)',
        isSecret: false,
      },
    ],
  },
  {
    provider: 'Anthropic',
    emoji: '🤖',
    borderColor: 'border-amber-200',
    headerBg: 'bg-amber-50',
    description: 'Used when LLM provider is set to Anthropic (Claude)',
    keys: [
      {
        key: 'anthropic_api_key',
        label: 'API Key',
        placeholder: 'sk-ant-api03-…',
        hint: 'Found in Anthropic Console → API Keys',
        isSecret: true,
      },
    ],
  },
  {
    provider: 'OpenAI',
    emoji: '✨',
    borderColor: 'border-slate-200',
    headerBg: 'bg-slate-50',
    description: 'Used when LLM provider is set to OpenAI',
    keys: [
      {
        key: 'openai_api_key',
        label: 'API Key',
        placeholder: 'sk-…',
        hint: 'Found in OpenAI Platform → API Keys',
        isSecret: true,
      },
    ],
  },
]

async function saveSetting(key: string, value: string) {
  const res = await fetch('/api/settings', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ key, value }),
  })
  if (!res.ok) {
    const data = await res.json()
    throw new Error(data.error || 'Failed to save')
  }
}

export default function SettingsPage() {
  const [settings, setSettings]         = useState<Setting[]>([])
  const [savingProvider, setSavingProvider] = useState<string | null>(null)
  const [keyDrafts, setKeyDrafts]       = useState<Record<string, string>>({})
  const [savingKey, setSavingKey]       = useState<string | null>(null)
  const [savedKey, setSavedKey]         = useState<string | null>(null)
  const [error, setError]               = useState<string | null>(null)
  const [visibleKeys, setVisibleKeys]   = useState<Set<string>>(new Set())

  useEffect(() => {
    fetch('/api/settings')
      .then(r => r.json())
      .then(data => { if (data.settings) setSettings(data.settings) })
      .catch(() => setError('Failed to load settings — check your network connection.'))
  }, [])

  function getSetting(key: string) {
    return settings.find(s => s.key === key)?.value || ''
  }

  async function updateProvider(key: string, value: string) {
    setSavingProvider(key)
    setError(null)
    try {
      await saveSetting(key, value)
      setSettings(prev =>
        prev.map(s => s.key === key ? { ...s, value } : s)
      )
    } catch (err: any) {
      setError(err.message)
    } finally {
      setSavingProvider(null)
    }
  }

  async function saveApiKey(key: string) {
    const value = keyDrafts[key]
    if (!value?.trim()) return
    setSavingKey(key)
    setError(null)
    try {
      await saveSetting(key, value.trim())
      setSettings(prev => {
        const exists = prev.find(s => s.key === key)
        if (exists) return prev.map(s => s.key === key ? { ...s, value: value.trim() } : s)
        return [...prev, { key, value: value.trim() }]
      })
      setKeyDrafts(prev => ({ ...prev, [key]: '' }))
      setSavedKey(key)
      setTimeout(() => setSavedKey(null), 2500)
    } catch (err: any) {
      setError(err.message)
    } finally {
      setSavingKey(null)
    }
  }

  function toggleVisible(key: string) {
    setVisibleKeys(prev => {
      const next = new Set(prev)
      next.has(key) ? next.delete(key) : next.add(key)
      return next
    })
  }

  return (
    <div className="max-w-3xl space-y-10 pb-12">
      {/* ── Header ── */}
      <div>
        <div className="flex items-center gap-2 mb-2">
          <Settings className="h-4 w-4 text-blue-600" />
          <span className="text-xs font-semibold text-blue-600 uppercase tracking-widest">
            Configuration
          </span>
        </div>
        <h1 className="text-3xl font-bold text-slate-900">Settings</h1>
        <p className="text-slate-500 mt-1 text-sm">
          Configure global provider defaults and your API credentials
        </p>
      </div>

      {error && (
        <div className="flex items-center gap-3 bg-red-50 border border-red-200 rounded-xl px-4 py-3">
          <AlertCircle className="h-5 w-5 text-red-500 shrink-0" />
          <p className="text-sm text-red-700">{error}</p>
        </div>
      )}

      {/* ── Section 1: Provider Defaults ── */}
      <div className="space-y-4">
        <div>
          <h2 className="text-lg font-semibold text-slate-900">
            Global Provider Defaults
          </h2>
          <p className="text-sm text-slate-500 mt-0.5">
            Used as defaults when creating new agents. Each agent can override
            these individually in its own settings.
          </p>
        </div>

        <div className="grid sm:grid-cols-2 gap-4">
          {providerConfig.map(({ key, label, icon: Icon, iconBg, iconColor, description, options }) => {
            const current       = getSetting(key)
            const currentOption = options.find(o => o.value === current)
            const isSaving      = savingProvider === key

            return (
              <div
                key={key}
                className="bg-white rounded-xl border border-slate-200 shadow-sm p-4 flex flex-col gap-3"
              >
                {/* Card header */}
                <div className="flex items-center gap-3">
                  <div className={`w-9 h-9 ${iconBg} rounded-lg flex items-center justify-center shrink-0`}>
                    <Icon className={`h-4 w-4 ${iconColor}`} />
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="font-medium text-slate-800 text-sm truncate">
                      {label}
                    </div>
                    {currentOption && (
                      <div className="text-[11px] text-slate-400 truncate">
                        {currentOption.note}
                      </div>
                    )}
                  </div>
                  {current && (
                    <Badge variant="info" className="text-[11px] shrink-0">
                      {current}
                    </Badge>
                  )}
                </div>

                <p className="text-xs text-slate-400">{description}</p>

                <Select
                  value={current}
                  onValueChange={v => updateProvider(key, v)}
                  disabled={isSaving}
                >
                  <SelectTrigger className="bg-slate-50 text-sm">
                    <SelectValue placeholder="Select provider…" />
                  </SelectTrigger>
                  <SelectContent>
                    {options.map(opt => (
                      <SelectItem key={opt.value} value={opt.value}>
                        <span className="font-medium">{opt.label}</span>
                        <span className="text-xs text-slate-400 ml-1.5">
                          — {opt.note}
                        </span>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>

                {isSaving && (
                  <p className="text-xs text-slate-400 animate-pulse">Saving…</p>
                )}
              </div>
            )
          })}
        </div>
      </div>

      {/* ── Section 2: API Credentials ── */}
      <div className="space-y-4">
        <div>
          <div className="flex items-center gap-2">
            <Key className="h-5 w-5 text-slate-600" />
            <h2 className="text-lg font-semibold text-slate-900">
              API Credentials
            </h2>
          </div>
          <p className="text-sm text-slate-500 mt-0.5">
            Keys are stored securely in the database and masked after saving.
            Enter a new value at any time to update an existing key.
          </p>
        </div>

        <div className="space-y-4">
          {apiKeyGroups.map(({ provider, emoji, borderColor, headerBg, description, keys }) => {
            const allSet = keys.every(k => !!getSetting(k.key))

            return (
              <div
                key={provider}
                className={`rounded-xl border-2 ${borderColor} overflow-hidden`}
              >
                {/* Provider header */}
                <div
                  className={`${headerBg} px-5 py-3 flex items-center gap-3 border-b ${borderColor}`}
                >
                  <span className="text-xl">{emoji}</span>
                  <div className="flex-1 min-w-0">
                    <span className="font-semibold text-slate-800">{provider}</span>
                    <span className="text-xs text-slate-500 ml-2">{description}</span>
                  </div>
                  {allSet && (
                    <div className="flex items-center gap-1 text-emerald-600 text-xs font-medium shrink-0">
                      <CheckCircle className="h-3.5 w-3.5" />
                      Connected
                    </div>
                  )}
                </div>

                {/* Keys */}
                <div className="bg-white px-5 py-5 space-y-5">
                  {keys.map(({ key, label, placeholder, hint, isSecret }) => {
                    const isSet     = !!getSetting(key)
                    const isSaving  = savingKey === key
                    const isSaved   = savedKey === key
                    const draft     = keyDrafts[key] || ''
                    const isVisible = visibleKeys.has(key)

                    return (
                      <div key={key}>
                        <div className="flex items-center gap-2 mb-1.5">
                          <Label className="text-sm font-medium text-slate-700">
                            {label}
                          </Label>
                          <Badge
                            variant={isSet ? 'success' : 'secondary'}
                            className="text-[11px] py-0"
                          >
                            {isSet ? '● Saved' : '○ Not set'}
                          </Badge>
                        </div>
                        <p className="text-xs text-slate-400 mb-2 leading-relaxed">
                          {hint}
                        </p>
                        <div className="flex gap-2">
                          <div className="relative flex-1">
                            <Input
                              type={isSecret && !isVisible ? 'password' : 'text'}
                              placeholder={isSet ? '••••••••••••••••' : placeholder}
                              value={draft}
                              onChange={e =>
                                setKeyDrafts(prev => ({
                                  ...prev,
                                  [key]: e.target.value,
                                }))
                              }
                              className="bg-slate-50 font-mono text-sm pr-10"
                              autoComplete="off"
                              onKeyDown={e => {
                                if (e.key === 'Enter' && draft.trim()) saveApiKey(key)
                              }}
                            />
                            {isSecret && (
                              <button
                                type="button"
                                onClick={() => toggleVisible(key)}
                                className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600 transition-colors"
                                tabIndex={-1}
                              >
                                {isVisible
                                  ? <EyeOff className="h-4 w-4" />
                                  : <Eye className="h-4 w-4" />}
                              </button>
                            )}
                          </div>

                          <Button
                            size="sm"
                            variant={isSaved ? 'outline' : 'default'}
                            disabled={!draft.trim() || isSaving}
                            onClick={() => saveApiKey(key)}
                            className={
                              isSaved
                                ? 'text-emerald-600 border-emerald-300 bg-emerald-50 hover:bg-emerald-50'
                                : ''
                            }
                          >
                            {isSaving ? (
                              <>
                                <span className="animate-spin inline-block mr-1">⟳</span>
                                Saving
                              </>
                            ) : isSaved ? (
                              <>
                                <CheckCircle className="h-3.5 w-3.5 mr-1.5" />
                                Saved!
                              </>
                            ) : (
                              <>
                                <Save className="h-3.5 w-3.5 mr-1.5" />
                                Save
                              </>
                            )}
                          </Button>
                        </div>
                      </div>
                    )
                  })}
                </div>
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}
