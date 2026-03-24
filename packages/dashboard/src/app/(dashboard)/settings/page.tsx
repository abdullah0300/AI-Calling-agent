'use client'

import { useEffect, useState } from 'react'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Label } from '@/components/ui/label'

interface Setting {
  key: string
  value: string
}

const providerOptions = {
  active_telephony: ['telnyx', 'twilio'],
  active_stt: ['deepgram', 'google'],
  active_tts: ['elevenlabs', 'deepgram', 'google'],
  active_llm: ['anthropic', 'openai'],
}

const providerLabels: Record<string, string> = {
  active_telephony: 'Telephony Provider',
  active_stt: 'Speech-to-Text (STT)',
  active_tts: 'Text-to-Speech (TTS)',
  active_llm: 'LLM Provider',
}

const providerDescriptions: Record<string, string> = {
  active_telephony: 'Default provider for making outbound calls',
  active_stt: 'Default provider for transcribing prospect speech',
  active_tts: 'Default provider for converting agent text to speech',
  active_llm: 'Default AI model provider for generating agent responses',
}

// API keys managed in the settings table — shown masked, never revealed after save
const apiKeyFields = [
  { key: 'telnyx_api_key',       label: 'Telnyx API Key',         placeholder: 'KEY...',               hint: 'Required for outbound calls' },
  { key: 'telnyx_connection_id', label: 'Telnyx Connection ID',   placeholder: 'YOUR_CONN_ID',         hint: 'TeXML / WebRTC App connection ID' },
  { key: 'deepgram_api_key',     label: 'Deepgram API Key',       placeholder: 'YOUR_API_KEY',         hint: 'Used for STT and Deepgram TTS' },
  { key: 'elevenlabs_api_key',   label: 'ElevenLabs API Key',     placeholder: 'YOUR_API_KEY',         hint: 'Used when TTS provider is ElevenLabs' },
  { key: 'elevenlabs_voice_id',  label: 'ElevenLabs Voice ID',    placeholder: '21m00Tcm4TlvDq8ikWAM', hint: 'Voice ID from your ElevenLabs library' },
  { key: 'anthropic_api_key',    label: 'Anthropic API Key',      placeholder: 'sk-ant-...',           hint: 'Used when LLM provider is Anthropic' },
  { key: 'openai_api_key',       label: 'OpenAI API Key',         placeholder: 'sk-...',               hint: 'Used when LLM provider is OpenAI' },
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
  const [settings, setSettings] = useState<Setting[]>([])
  const [savingProvider, setSavingProvider] = useState<string | null>(null)
  // Draft values for API key inputs — separate from committed DB values
  const [keyDrafts, setKeyDrafts] = useState<Record<string, string>>({})
  const [savingKey, setSavingKey] = useState<string | null>(null)
  const [savedKey, setSavedKey] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    fetch('/api/settings')
      .then(r => r.json())
      .then(data => { if (data.settings) setSettings(data.settings) })
      .catch(() => setError('Failed to load settings'))
  }, [])

  function getSetting(key: string) {
    return settings.find(s => s.key === key)?.value || ''
  }

  async function updateProvider(key: string, value: string) {
    setSavingProvider(key)
    try {
      await saveSetting(key, value)
      setSettings(prev => prev.map(s => s.key === key ? { ...s, value } : s))
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
      setTimeout(() => setSavedKey(null), 2000)
    } catch (err: any) {
      setError(err.message)
    } finally {
      setSavingKey(null)
    }
  }

  const providerKeys = ['active_telephony', 'active_stt', 'active_tts', 'active_llm']

  return (
    <div className="space-y-8 max-w-2xl">
      <div>
        <h1 className="text-2xl font-bold">Settings</h1>
        <p className="text-muted-foreground">Configure global provider defaults and API keys</p>
      </div>

      {error && (
        <p className="text-sm text-destructive">{error}</p>
      )}

      {/* Global Provider Defaults */}
      <div className="space-y-4">
        <h2 className="text-lg font-semibold">Global Provider Defaults</h2>
        <p className="text-sm text-muted-foreground">
          These are used as defaults when creating new agents. Each agent can override them individually.
        </p>

        {providerKeys.map(key => {
          const currentValue = getSetting(key)
          const options = providerOptions[key as keyof typeof providerOptions] || []

          return (
            <Card key={key}>
              <CardHeader>
                <div className="flex items-center justify-between">
                  <CardTitle className="text-base">{providerLabels[key]}</CardTitle>
                  <Badge variant="info">{currentValue || 'not set'}</Badge>
                </div>
                <CardDescription>{providerDescriptions[key]}</CardDescription>
              </CardHeader>
              <CardContent>
                <div className="flex gap-3 items-end">
                  <div className="flex-1 space-y-2">
                    <Label>Active Provider</Label>
                    <Select
                      value={currentValue}
                      onValueChange={v => updateProvider(key, v)}
                      disabled={savingProvider === key}
                    >
                      <SelectTrigger>
                        <SelectValue placeholder="Select provider" />
                      </SelectTrigger>
                      <SelectContent>
                        {options.map(opt => (
                          <SelectItem key={opt} value={opt}>{opt}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  {savingProvider === key && (
                    <Button disabled size="sm" variant="outline">Saving...</Button>
                  )}
                </div>
              </CardContent>
            </Card>
          )
        })}
      </div>

      {/* API Keys */}
      <div className="space-y-4">
        <h2 className="text-lg font-semibold">API Keys & Integrations</h2>
        <p className="text-sm text-muted-foreground">
          Keys are stored in the database and never exposed after saving. Enter a new value to update.
        </p>

        <Card>
          <CardContent className="pt-6 space-y-5">
            {apiKeyFields.map(({ key, label, placeholder, hint }) => {
              const isSet = !!getSetting(key)
              const isSaving = savingKey === key
              const isSaved = savedKey === key
              const draft = keyDrafts[key] || ''

              return (
                <div key={key} className="space-y-1.5">
                  <div className="flex items-center gap-2">
                    <Label className="text-sm font-medium">{label}</Label>
                    <Badge variant={isSet ? 'info' : 'secondary'} className="text-xs">
                      {isSet ? 'Saved' : 'Not set'}
                    </Badge>
                  </div>
                  <p className="text-xs text-muted-foreground">{hint}</p>
                  <div className="flex gap-2">
                    <Input
                      type="password"
                      placeholder={isSet ? '••••••••••••••••' : placeholder}
                      value={draft}
                      onChange={e => setKeyDrafts(prev => ({ ...prev, [key]: e.target.value }))}
                      className="font-mono text-sm"
                      autoComplete="off"
                    />
                    <Button
                      size="sm"
                      variant={isSaved ? 'outline' : 'default'}
                      disabled={!draft.trim() || isSaving}
                      onClick={() => saveApiKey(key)}
                      className="shrink-0"
                    >
                      {isSaving ? 'Saving...' : isSaved ? 'Saved ✓' : 'Save'}
                    </Button>
                  </div>
                </div>
              )
            })}
          </CardContent>
        </Card>
      </div>
    </div>
  )
}
