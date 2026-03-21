'use client'

import { useEffect, useState } from 'react'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Label } from '@/components/ui/label'
import { createClient } from '@/lib/supabase/client'

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
  active_llm_model: 'Default LLM Model',
}

const providerDescriptions: Record<string, string> = {
  active_telephony: 'Provider used for making outbound calls',
  active_stt: 'Provider used for transcribing prospect speech',
  active_tts: 'Provider used for converting agent text to speech',
  active_llm: 'AI model provider for generating agent responses',
  active_llm_model: 'Specific model used for generating responses',
}

export default function SettingsPage() {
  const [settings, setSettings] = useState<Setting[]>([])
  const [saving, setSaving] = useState<string | null>(null)
  const supabase = createClient()

  useEffect(() => {
    supabase.from('settings').select('*').then(({ data }) => {
      if (data) setSettings(data)
    })
  }, [])

  function getSetting(key: string) {
    return settings.find(s => s.key === key)?.value || ''
  }

  async function updateSetting(key: string, value: string) {
    setSaving(key)
    await supabase
      .from('settings')
      .update({ value, updated_at: new Date().toISOString() })
      .eq('key', key)
    setSettings(prev => prev.map(s => s.key === key ? { ...s, value } : s))
    setSaving(null)
  }

  const providerKeys = ['active_telephony', 'active_stt', 'active_tts', 'active_llm']

  return (
    <div className="space-y-6 max-w-2xl">
      <div>
        <h1 className="text-2xl font-bold">Settings</h1>
        <p className="text-muted-foreground">Configure active providers for the platform</p>
      </div>

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
                    onValueChange={v => updateSetting(key, v)}
                    disabled={saving === key}
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
                {saving === key && (
                  <Button disabled size="sm" variant="outline">Saving...</Button>
                )}
              </div>
            </CardContent>
          </Card>
        )
      })}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Environment Variables</CardTitle>
          <CardDescription>
            API keys are configured via environment variables. See .env.example for the full list.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="space-y-2 text-sm font-mono text-muted-foreground">
            {[
              'TELNYX_API_KEY', 'DEEPGRAM_API_KEY', 'ELEVENLABS_API_KEY',
              'ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'SUPABASE_SERVICE_ROLE_KEY'
            ].map(key => (
              <div key={key} className="flex items-center gap-2">
                <Badge variant="secondary" className="font-mono text-xs">{key}</Badge>
                <span className="text-xs">••••••••••••</span>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>
    </div>
  )
}
