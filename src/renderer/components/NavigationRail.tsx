import { useEffect } from 'react'
import { Gauge, House, Settings, Workflow, type LucideIcon } from '../lib/icons'
import { refreshStorageReview, useStorageReviewPending } from '../lib/storageReview'
import { confirmNavigation } from '../services/navigationGuards'
import { useAppStore } from '../stores/appStore'
import { ThreadSearchDialog } from './ThreadSearchDialog'
import { DownloadsIndicator } from './downloads/DownloadsIndicator'
import '../styles/navigation-rail.css'

export type RailPage = 'home' | 'automations' | 'usage' | 'settings'

/** One rail page at most is current; an open page or search means Home is not. */
export function activeRailPage(state: {
  scheduledOpen: boolean
  usageOpen: boolean
  settingsOpen: boolean
  threadSearchOpen: boolean
  mainAreaOpen: boolean
  sidebarMode: 'projects' | 'chats'
}): RailPage | null {
  if (state.settingsOpen) return 'settings'
  if (state.usageOpen) return 'usage'
  if (state.scheduledOpen) return 'automations'
  if (state.threadSearchOpen || state.mainAreaOpen || state.sidebarMode !== 'projects') return null
  return 'home'
}

interface NavigationRailProps {
  onMouseEnter?: () => void
  onMouseLeave?: () => void
}

export function NavigationRail({ onMouseEnter, onMouseLeave }: NavigationRailProps) {
  const sidebarMode = useAppStore((s) => s.sidebarMode)
  const mainAreaOpen = useAppStore((s) => s.mainAreaOpen)
  const scheduledOpen = useAppStore((s) => s.scheduledOpen)
  const setMainAreaOpen = useAppStore((s) => s.setMainAreaOpen)
  const setThreadsSidebarOpen = useAppStore((s) => s.setThreadsSidebarOpen)
  const setScheduledOpen = useAppStore((s) => s.setScheduledOpen)
  const usageOpen = useAppStore((s) => s.usageOpen)
  const settingsOpen = useAppStore((s) => s.settingsOpen)
  const setSettingsOpen = useAppStore((s) => s.setSettingsOpen)
  const switchToThread = useAppStore((s) => s.switchToThread)
  const searchOpen = useAppStore((s) => s.threadSearchOpen)
  const setSearchOpen = useAppStore((s) => s.setThreadSearchOpen)

  const leaveRailPage = () => {
    setScheduledOpen(false)
    useAppStore.getState().setUsageOpen(false)
    setSettingsOpen(false)
  }
  const navigateRail = async (action: () => void) => {
    if (!await confirmNavigation()) return
    action()
  }

  const showHome = async () => {
    if ((scheduledOpen || usageOpen || settingsOpen || sidebarMode !== 'projects') && !await confirmNavigation()) return
    leaveRailPage()
    useAppStore.getState().setSidebarMode('projects')
    setThreadsSidebarOpen(true)
    setMainAreaOpen(false)
  }
  const activePage = activeRailPage({ scheduledOpen, usageOpen, settingsOpen, threadSearchOpen: searchOpen, mainAreaOpen, sidebarMode })
  const reviewPending = useStorageReviewPending()
  useEffect(() => { void refreshStorageReview() }, [])
  const shortcut = (label: string, Icon: LucideIcon, active: boolean, onClick: () => void, disabled = false) => (
    <button type="button" className={`navigation-rail-button${active ? ' active' : ''}`}
      aria-label={label} title={label === 'Settings' && reviewPending ? 'Settings · new cleanup rules to review in Storage' : label} aria-current={active ? 'page' : undefined}
      onClick={onClick} disabled={disabled}>
      <Icon size={18} strokeWidth={1.8} aria-hidden="true" />
      {label === 'Home' && active && <span className="navigation-rail-active-dot" aria-hidden="true" />}
      {label === 'Settings' && reviewPending && <span className="navigation-rail-notice-dot" data-testid="settings-review-dot" aria-hidden="true" />}
    </button>
  )

  return (
    <>
      <nav className="navigation-rail" aria-label="Mousse navigation" onMouseEnter={onMouseEnter} onMouseLeave={onMouseLeave}>
        {shortcut('Home', House, activePage === 'home', () => void showHome())}
        {shortcut('Automations', Workflow, activePage === 'automations', () => void navigateRail(() => setScheduledOpen(true)))}
        <div className="navigation-rail-separator" role="separator" />
        {shortcut('Subscription usage', Gauge, activePage === 'usage', () => void navigateRail(() => useAppStore.getState().setUsageOpen(true)))}
        {shortcut('Settings', Settings, activePage === 'settings', () => void navigateRail(() => setSettingsOpen(true)))}
        <DownloadsIndicator variant="rail" />
      </nav>
      <ThreadSearchDialog open={searchOpen} onClose={() => setSearchOpen(false)} onSelect={(threadId) => {
        void confirmNavigation().then((allowed) => {
          if (!allowed) return
          leaveRailPage()
          switchToThread(threadId)
          void window.mousse.threads.select(threadId)
          setThreadsSidebarOpen(true)
        })
      }} />
    </>
  )
}
