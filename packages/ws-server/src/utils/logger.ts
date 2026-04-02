// ─── Structured logger for ws-server ─────────────────────────────────────────
// Writes to both console (visible in Cloud Run logs) and Supabase server_logs
// table (visible on the dashboard /logs page).
//
// All DB writes are fire-and-forget — a logging failure never affects the
// call pipeline. Only 'warn' and 'error' levels are persisted to DB by default
// to avoid flooding the table with routine info messages.

import { supabase } from '../db/client'

export type LogLevel = 'info' | 'warn' | 'error'
export type LogSource =
  | 'pipeline' | 'dialer' | 'stt' | 'tts'
  | 'recording' | 'webhook' | 'server' | 'noise' | 'cartesia-line'

interface LogContext {
  callId?:    string
  leadId?:    string
  campaignId?: string
  [key: string]: unknown
}

function persist(
  level: LogLevel,
  source: LogSource,
  message: string,
  context?: LogContext,
): void {
  // Only persist warn + error to DB — info is console-only
  if (level === 'info') return

  const { callId, ...rest } = context ?? {}
  const contextPayload = Object.keys(rest).length > 0 ? rest : undefined

  // Fire-and-forget — never awaited
  void Promise.resolve(
    supabase.from('server_logs').insert({
      level,
      source,
      message: message.slice(0, 2000),  // cap length
      context: contextPayload ?? null,
      call_id: callId ?? null,
    })
  ).then(null, () => { /* swallow — logging must never crash the server */ })
}

export const logger = {
  info(source: LogSource, message: string, context?: LogContext): void {
    console.log(`[${source.toUpperCase()}] ${message}`, context ?? '')
    persist('info', source, message, context)
  },

  warn(source: LogSource, message: string, context?: LogContext): void {
    console.warn(`[${source.toUpperCase()}] WARN: ${message}`, context ?? '')
    persist('warn', source, message, context)
  },

  error(source: LogSource, message: string, context?: LogContext): void {
    console.error(`[${source.toUpperCase()}] ERROR: ${message}`, context ?? '')
    persist('error', source, message, context)
  },
}
