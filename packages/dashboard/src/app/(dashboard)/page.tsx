import { createAdminClient } from '@/lib/supabase/server'
import { StatsCards } from '@/components/dashboard/StatsCards'
import { CallsTable } from '@/components/dashboard/CallsTable'

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
      .select(`
        *,
        leads(business_name, phone_number),
        agents(name)
      `)
      .order('created_at', { ascending: false })
      .limit(20),
  ])

  const calls = todayCalls || []
  const totalCallsToday = calls.length
  const interestedToday = calls.filter(c => c.outcome === 'interested').length
  const meetingsBooked = calls.filter(c => c.meeting_booked).length
  const successRate = totalCallsToday > 0 ? (interestedToday / totalCallsToday) * 100 : 0

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Overview</h1>
        <p className="text-muted-foreground">Today&apos;s calling performance</p>
      </div>

      <StatsCards
        totalCallsToday={totalCallsToday}
        interestedToday={interestedToday}
        meetingsBooked={meetingsBooked}
        successRate={successRate}
      />

      <div>
        <h2 className="text-lg font-semibold mb-4">Recent Calls</h2>
        <CallsTable calls={recentCalls || []} />
      </div>
    </div>
  )
}
