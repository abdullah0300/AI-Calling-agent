'use client'

import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Phone, TrendingUp, Calendar, Target } from 'lucide-react'

interface StatsCardsProps {
  totalCallsToday: number
  interestedToday: number
  meetingsBooked: number
  successRate: number
}

export function StatsCards({ totalCallsToday, interestedToday, meetingsBooked, successRate }: StatsCardsProps) {
  const stats = [
    {
      title: 'Total Calls Today',
      value: totalCallsToday,
      icon: Phone,
      description: 'Outbound calls made today',
    },
    {
      title: 'Interested Leads',
      value: interestedToday,
      icon: TrendingUp,
      description: 'Leads showing interest today',
    },
    {
      title: 'Meetings Booked',
      value: meetingsBooked,
      icon: Calendar,
      description: 'Total meetings booked',
    },
    {
      title: 'Success Rate',
      value: `${successRate.toFixed(1)}%`,
      icon: Target,
      description: 'Interested / Total calls',
    },
  ]

  return (
    <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
      {stats.map((stat) => (
        <Card key={stat.title}>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">{stat.title}</CardTitle>
            <stat.icon className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{stat.value}</div>
            <p className="text-xs text-muted-foreground">{stat.description}</p>
          </CardContent>
        </Card>
      ))}
    </div>
  )
}
