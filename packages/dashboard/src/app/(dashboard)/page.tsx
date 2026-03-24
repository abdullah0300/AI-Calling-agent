import { createAdminClient } from '@/lib/supabase/server'
import { StatsCards } from '@/components/dashboard/StatsCards'
import { CallsTable } from '@/components/dashboard/CallsTable'
import { Phone, Activity, ArrowRight } from 'lucide-react'
import Link from 'next/link'

export const dynamic = 'force-dynamic'

export default async function OverviewPage() {
  const supabase = createAdminClient()

  const today = new Date()
  today.setHours(0, 0, 0, 0)

  const [{ data: todayCalls }, { data: recentCalls }] = await Promise.all([
    supabase
      .from('calls')
      .select('*')
      .gte('created_at', today.toISOString()),
    supabase
      .from('calls')
      .select('*, leads(business_name, phone_number), agents(name)')
      .order('created_at', { ascending: false })
      .limit(20),
  ])

  const calls = todayCalls || []
  const totalCallsToday = calls.length
  const interestedToday = calls.filter(c => c.outcome === 'interested').length
  const meetingsBooked = calls.filter(c => c.meeting_booked).length
  const successRate =
    totalCallsToday > 0 ? (interestedToday / totalCallsToday) * 100 : 0

  const now = new Date()
  const hour = now.getHours()
  const greeting =
    hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening'
  const dateStr = now.toLocaleDateString('en-GB', {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  })

  return (
    <div className="space-y-8 max-w-7xl">
      {/* ── Page header ── */}
      <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-4">
        <div>
          <div className="flex items-center gap-2 mb-2">
            <Activity className="h-4 w-4 text-blue-600" />
            <span className="text-xs font-semibold text-blue-600 uppercase tracking-widest">
              Live Dashboard
            </span>
          </div>
          <h1 className="text-3xl font-bold text-slate-900">
            {greeting} 👋
          </h1>
          <p className="text-slate-500 mt-1 text-sm">
            {dateStr} &middot; Here&apos;s how your agents are performing today
          </p>
        </div>

        <div className="flex items-center gap-2 text-sm bg-white border border-slate-200 rounded-xl px-4 py-3 shadow-sm self-start">
          <Phone className="h-4 w-4 text-blue-600 shrink-0" />
          <div>
            <span className="font-semibold text-slate-800">{totalCallsToday}</span>
            <span className="text-slate-500"> calls made today</span>
          </div>
        </div>
      </div>

      {/* ── Stat cards ── */}
      <StatsCards
        totalCallsToday={totalCallsToday}
        interestedToday={interestedToday}
        meetingsBooked={meetingsBooked}
        successRate={successRate}
      />

      {/* ── Quick tips (shown when no calls yet) ── */}
      {totalCallsToday === 0 && (
        <div className="bg-blue-50 border border-blue-100 rounded-xl p-5">
          <p className="text-sm font-semibold text-blue-800 mb-3">
            🚀 Getting started
          </p>
          <ol className="space-y-2 text-sm text-blue-700">
            {[
              { step: '1', text: 'Add your API keys in ', link: '/settings', linkText: 'Settings' },
              { step: '2', text: 'Create or review your AI agent in ', link: '/agents', linkText: 'Agents' },
              { step: '3', text: 'Use the Call button on an agent card to make your first outbound call.' },
            ].map(({ step, text, link, linkText }) => (
              <li key={step} className="flex items-start gap-2">
                <span className="w-5 h-5 bg-blue-600 text-white rounded-full text-[11px] font-bold flex items-center justify-center shrink-0 mt-0.5">
                  {step}
                </span>
                <span>
                  {text}
                  {link && (
                    <Link
                      href={link}
                      className="font-semibold underline underline-offset-2 hover:text-blue-900 inline-flex items-center gap-0.5"
                    >
                      {linkText}
                      <ArrowRight className="h-3 w-3" />
                    </Link>
                  )}
                </span>
              </li>
            ))}
          </ol>
        </div>
      )}

      {/* ── Recent calls ── */}
      <div>
        <div className="flex items-center justify-between mb-4">
          <div>
            <h2 className="text-lg font-semibold text-slate-900">Recent Calls</h2>
            <p className="text-sm text-slate-500">
              Latest 20 outbound calls across all agents
            </p>
          </div>
          <Link
            href="/calls"
            className="text-sm text-blue-600 hover:text-blue-700 font-medium flex items-center gap-1"
          >
            View all <ArrowRight className="h-3.5 w-3.5" />
          </Link>
        </div>
        <CallsTable calls={recentCalls || []} />
      </div>
    </div>
  )
}
