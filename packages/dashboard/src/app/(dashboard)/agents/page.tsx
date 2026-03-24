import { createAdminClient } from '@/lib/supabase/server'
import { AgentCard } from '@/components/dashboard/AgentCard'
import { Button } from '@/components/ui/button'
import Link from 'next/link'
import { Plus, Bot, Sparkles, Phone, Users } from 'lucide-react'

export const dynamic = 'force-dynamic'

export default async function AgentsPage() {
  const supabase = createAdminClient()

  const [{ data: agents }, { data: leads }, { data: phoneNumbers }] =
    await Promise.all([
      supabase
        .from('agents')
        .select('*')
        .order('created_at', { ascending: false }),
      supabase
        .from('leads')
        .select('*')
        .eq('status', 'pending')
        .order('created_at', { ascending: false }),
      supabase.from('phone_numbers').select('*').eq('active', true),
    ])

  const agentCount = agents?.length ?? 0
  const leadCount = leads?.length ?? 0
  const phoneCount = phoneNumbers?.length ?? 0

  return (
    <div className="space-y-8 max-w-7xl">
      {/* ── Header ── */}
      <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-4">
        <div>
          <div className="flex items-center gap-2 mb-2">
            <Bot className="h-4 w-4 text-blue-600" />
            <span className="text-xs font-semibold text-blue-600 uppercase tracking-widest">
              AI Agents
            </span>
          </div>
          <h1 className="text-3xl font-bold text-slate-900">Agents</h1>
          <p className="text-slate-500 mt-1 text-sm">
            Configure and deploy your AI calling agents
          </p>
        </div>
        <Button
          asChild
          className="bg-blue-600 hover:bg-blue-700 text-white w-full sm:w-auto self-start"
        >
          <Link href="/agents/new">
            <Plus className="h-4 w-4 mr-2" />
            New Agent
          </Link>
        </Button>
      </div>

      {/* ── Summary chips ── */}
      <div className="flex flex-wrap gap-3">
        {[
          { icon: Bot,   label: `${agentCount} agent${agentCount !== 1 ? 's' : ''} configured` },
          { icon: Users, label: `${leadCount} pending lead${leadCount !== 1 ? 's' : ''}` },
          { icon: Phone, label: `${phoneCount} active number${phoneCount !== 1 ? 's' : ''}` },
        ].map(({ icon: Icon, label }) => (
          <div
            key={label}
            className="flex items-center gap-2 bg-white border border-slate-200 rounded-full px-4 py-2 text-sm text-slate-600 shadow-sm"
          >
            <Icon className="h-3.5 w-3.5 text-slate-400" />
            {label}
          </div>
        ))}
      </div>

      {/* ── Empty state ── */}
      {agentCount === 0 ? (
        <div className="bg-white rounded-xl border-2 border-dashed border-slate-200 p-12 text-center">
          <div className="w-16 h-16 bg-blue-100 rounded-2xl flex items-center justify-center mx-auto mb-5">
            <Bot className="h-8 w-8 text-blue-600" />
          </div>
          <h2 className="text-xl font-semibold text-slate-900 mb-2">
            No agents yet
          </h2>
          <p className="text-slate-500 max-w-sm mx-auto mb-6 text-sm leading-relaxed">
            Create your first AI calling agent. Each agent has its own
            personality, conversation scripts, and technology stack.
          </p>
          <Button
            asChild
            className="bg-blue-600 hover:bg-blue-700 text-white"
          >
            <Link href="/agents/new">
              <Sparkles className="h-4 w-4 mr-2" />
              Create First Agent
            </Link>
          </Button>
        </div>
      ) : (
        <>
          {/* ── Hint banner ── */}
          <div className="bg-blue-50 border border-blue-100 rounded-xl px-4 py-3 flex items-start gap-3">
            <Sparkles className="h-4 w-4 text-blue-600 shrink-0 mt-0.5" />
            <p className="text-sm text-blue-700 leading-relaxed">
              <strong>Tip:</strong> Click <strong>Edit</strong> to update an
              agent&apos;s scripts, system prompt, or providers. Click{' '}
              <strong>Call</strong> to initiate an outbound call using that
              agent and a pending lead.
            </p>
          </div>

          {/* ── Agent grid ── */}
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {agents!.map(agent => (
              <AgentCard
                key={agent.id}
                agent={agent}
                leads={leads || []}
                phoneNumbers={phoneNumbers || []}
              />
            ))}
          </div>
        </>
      )}
    </div>
  )
}
