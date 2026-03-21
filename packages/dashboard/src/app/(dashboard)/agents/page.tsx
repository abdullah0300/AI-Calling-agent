import { createAdminClient } from '@/lib/supabase/server'
import { AgentCard } from '@/components/dashboard/AgentCard'
import { Button } from '@/components/ui/button'
import Link from 'next/link'
import { Plus } from 'lucide-react'

export const dynamic = 'force-dynamic'

export default async function AgentsPage() {
  const supabase = createAdminClient()

  const [{ data: agents }, { data: leads }, { data: phoneNumbers }] = await Promise.all([
    supabase.from('agents').select('*').order('created_at', { ascending: false }),
    supabase.from('leads').select('*').eq('status', 'pending').order('created_at', { ascending: false }),
    supabase.from('phone_numbers').select('*').eq('active', true),
  ])

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Agents</h1>
          <p className="text-muted-foreground">Manage your AI calling agents</p>
        </div>
        <Button asChild>
          <Link href="/agents/new">
            <Plus className="h-4 w-4 mr-2" />
            New Agent
          </Link>
        </Button>
      </div>

      {(!agents || agents.length === 0) ? (
        <div className="text-center py-12 text-muted-foreground">
          <p>No agents yet. Create your first agent to get started.</p>
        </div>
      ) : (
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          {agents.map((agent) => (
            <AgentCard
              key={agent.id}
              agent={agent}
              leads={leads || []}
              phoneNumbers={phoneNumbers || []}
            />
          ))}
        </div>
      )}
    </div>
  )
}
