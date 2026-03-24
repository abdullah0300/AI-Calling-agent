'use client'

import { Phone, TrendingUp, Calendar, Target } from 'lucide-react'

interface StatsCardsProps {
  totalCallsToday: number
  interestedToday: number
  meetingsBooked: number
  successRate: number
}

const statsConfig = [
  {
    key: 'totalCalls',
    title: 'Total Calls Today',
    description: 'Outbound calls made today',
    icon: Phone,
    iconBg: 'bg-blue-100',
    iconColor: 'text-blue-600',
    valueSuffix: '',
  },
  {
    key: 'interested',
    title: 'Interested Leads',
    description: 'Prospects showing genuine interest',
    icon: TrendingUp,
    iconBg: 'bg-emerald-100',
    iconColor: 'text-emerald-600',
    valueSuffix: '',
  },
  {
    key: 'meetings',
    title: 'Meetings Booked',
    description: 'Total callback meetings scheduled',
    icon: Calendar,
    iconBg: 'bg-violet-100',
    iconColor: 'text-violet-600',
    valueSuffix: '',
  },
  {
    key: 'rate',
    title: 'Success Rate',
    description: 'Interested ÷ total calls',
    icon: Target,
    iconBg: 'bg-amber-100',
    iconColor: 'text-amber-600',
    valueSuffix: '%',
  },
]

export function StatsCards({
  totalCallsToday,
  interestedToday,
  meetingsBooked,
  successRate,
}: StatsCardsProps) {
  const values = [
    totalCallsToday,
    interestedToday,
    meetingsBooked,
    successRate,
  ]

  return (
    <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
      {statsConfig.map((stat, i) => {
        const Icon = stat.icon
        const raw = values[i]
        const display =
          stat.valueSuffix === '%'
            ? `${(raw as number).toFixed(1)}%`
            : String(raw)

        return (
          <div
            key={stat.key}
            className="bg-white rounded-xl border border-slate-200 shadow-sm p-5 flex flex-col gap-4 hover:shadow-md transition-shadow duration-200"
          >
            <div className="flex items-start justify-between">
              <div
                className={`w-10 h-10 rounded-xl ${stat.iconBg} flex items-center justify-center`}
              >
                <Icon className={`h-5 w-5 ${stat.iconColor}`} />
              </div>
              <span className="text-[11px] font-medium text-slate-400 uppercase tracking-wide">
                Today
              </span>
            </div>
            <div>
              <div className="text-3xl font-bold text-slate-900 leading-none mb-1">
                {display}
              </div>
              <div className="text-sm font-medium text-slate-700">{stat.title}</div>
              <div className="text-xs text-slate-400 mt-0.5">{stat.description}</div>
            </div>
          </div>
        )
      })}
    </div>
  )
}
