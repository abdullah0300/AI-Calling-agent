'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { Phone, Bot, BarChart3, Settings, Menu, X, Zap, ChevronRight, Users, Activity, ScrollText } from 'lucide-react'
import { useState } from 'react'
import { cn } from '@/lib/utils'

const navItems = [
  { href: '/',         label: 'Dashboard', icon: BarChart3, description: 'Overview & live stats' },
  { href: '/agents',  label: 'Agents',    icon: Bot,       description: 'Manage AI calling agents' },
  { href: '/leads',   label: 'Leads',     icon: Users,     description: 'Manage and import leads' },
  { href: '/calls',      label: 'Calls',       icon: Phone,     description: 'Full call history' },
  { href: '/monitoring', label: 'Monitoring',  icon: Activity,    description: 'Live calls & campaign stats' },
  { href: '/logs',       label: 'Logs',        icon: ScrollText,  description: 'Server errors & warnings' },
  { href: '/settings',   label: 'Settings',    icon: Settings,    description: 'API keys & providers' },
]

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname()
  const [mobileOpen, setMobileOpen] = useState(false)

  const currentPage = navItems.find(item =>
    item.href === '/' ? pathname === '/' : pathname.startsWith(item.href)
  )

  return (
    <div className="flex min-h-screen bg-slate-50">
      {/* ── Sidebar ── */}
      <aside className={cn(
        'fixed inset-y-0 left-0 z-50 w-64 bg-slate-900 text-white flex flex-col',
        'transform transition-transform duration-200 ease-in-out',
        'md:relative md:translate-x-0',
        mobileOpen ? 'translate-x-0' : '-translate-x-full'
      )}>
        {/* Brand */}
        <div className="flex h-16 items-center px-5 border-b border-slate-800 shrink-0">
          <div className="flex items-center gap-2.5 flex-1 min-w-0">
            <div className="w-8 h-8 bg-blue-600 rounded-lg flex items-center justify-center shrink-0">
              <Phone className="h-4 w-4 text-white" />
            </div>
            <div className="min-w-0">
              <div className="font-bold text-sm text-white leading-none">VoiceFlow</div>
              <div className="text-[10px] text-slate-400 mt-0.5 flex items-center gap-1">
                <Zap className="h-2.5 w-2.5" />
                AI Calling Platform
              </div>
            </div>
          </div>
          <button
            className="ml-2 md:hidden text-slate-400 hover:text-white transition-colors p-1"
            onClick={() => setMobileOpen(false)}
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        {/* Nav */}
        <nav className="flex-1 p-3 space-y-0.5 overflow-y-auto">
          <p className="px-3 pt-2 pb-3 text-[10px] font-semibold uppercase tracking-widest text-slate-600">
            Navigation
          </p>
          {navItems.map((item) => {
            const isActive = item.href === '/' ? pathname === '/' : pathname.startsWith(item.href)
            return (
              <Link
                key={item.href}
                href={item.href}
                onClick={() => setMobileOpen(false)}
                className={cn(
                  'group flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-all duration-150',
                  isActive
                    ? 'bg-blue-600 text-white shadow-sm'
                    : 'text-slate-400 hover:bg-slate-800 hover:text-white'
                )}
              >
                <item.icon className={cn(
                  'h-4 w-4 shrink-0 transition-colors',
                  isActive ? 'text-white' : 'text-slate-500 group-hover:text-slate-300'
                )} />
                <span className="flex-1 truncate">{item.label}</span>
                {isActive && <ChevronRight className="h-3.5 w-3.5 text-blue-300 shrink-0" />}
              </Link>
            )
          })}
        </nav>

        {/* Footer */}
        <div className="p-3 border-t border-slate-800 shrink-0">
          <div className="bg-slate-800/60 rounded-lg px-3 py-2.5">
            <p className="text-xs font-medium text-slate-300">WebCraftio VoiceFlow</p>
            <p className="text-[11px] text-slate-500 mt-0.5">v1.0 · AI-powered outbound calling</p>
          </div>
        </div>
      </aside>

      {/* Mobile overlay */}
      {mobileOpen && (
        <div
          className="fixed inset-0 z-40 bg-black/60 backdrop-blur-sm md:hidden"
          onClick={() => setMobileOpen(false)}
        />
      )}

      {/* ── Main area ── */}
      <div className="flex-1 flex flex-col min-w-0 overflow-hidden">
        {/* Top bar */}
        <header className="h-16 bg-white border-b border-slate-200 flex items-center px-4 sm:px-6 gap-3 sticky top-0 z-30 shrink-0">
          <button
            onClick={() => setMobileOpen(true)}
            className="md:hidden p-2 rounded-md hover:bg-slate-100 text-slate-500 transition-colors"
          >
            <Menu className="h-5 w-5" />
          </button>

          {/* Breadcrumb */}
          <div className="flex items-center gap-1.5 text-sm min-w-0">
            <span className="text-slate-400 hidden sm:block shrink-0">VoiceFlow</span>
            <ChevronRight className="h-3.5 w-3.5 text-slate-300 hidden sm:block shrink-0" />
            <span className="font-semibold text-slate-800 truncate">
              {currentPage?.label ?? 'Dashboard'}
            </span>
          </div>

          {/* Current page description */}
          {currentPage?.description && (
            <span className="hidden lg:block text-xs text-slate-400 bg-slate-100 rounded-full px-3 py-1 ml-2">
              {currentPage.description}
            </span>
          )}
        </header>

        <main className="flex-1 p-4 sm:p-6 overflow-auto">
          {children}
        </main>
      </div>
    </div>
  )
}
