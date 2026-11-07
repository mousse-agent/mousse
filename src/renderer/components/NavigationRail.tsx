import { useEffect } from 'react'
import { Gauge, Search, Settings, Workflow, type LucideIcon } from '../lib/icons'
import { useShortcutTitle } from '../commands/commandRegistry'
import { openPalette } from '../commands/paletteActions'
import { activeRailPage, escapeLeavesRailPage, leaveRailPage, toggleRailPage, type RailPage } from '../lib/railPages'
import { refreshStorageReview, useStorageReviewPending } from '../lib/storageReview'
import { useAppStore } from '../stores/appStore'
import { useChatsStore } from '../stores/chatsStore'
import { DownloadsIndicator } from './downloads/DownloadsIndicator'
import '../styles/navigation-rail.css'

/**
 * The rail opens pages over the workspace. The workspace has no item of its own: clicking the open
 * page's item again, or Escape on that page, returns to it.
 */
export function NavigationRail() {
  const scheduledOpen = useAppStore((s) => s.scheduledOpen)
  const usageOpen = useAppStore((s) => s.usageOpen)
  const settingsOpen = useAppStore((s) => s.settingsOpen)
  // In the Chats tab, Search finds agent chats.
  const chatsMode = useAppStore((s) => s.sidebarMode === 'chats')
  const searchThreadsTitle = useShortcutTitle('Search threads', 'threads.search')

  const activePage = activeRailPage({ scheduledOpen, usageOpen, settingsOpen })
  const reviewPending = useStorageReviewPending()
  useEffect(() => { void refreshStorageReview() }, [])
  useEffect(() => {
    if (activePage === null) return
    // Bubble phase: a menu, select or editor that handles Escape first keeps it.
    const onKeyDown = (event: KeyboardEvent) => {
      if (escapeLeavesRailPage(event)) void leaveRailPage()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [activePage])

  const shortcut = (page: RailPage, label: string, Icon: LucideIcon) => {
    const active = activePage === page
    const notice = page === 'settings' && reviewPending
    const title = notice ? 'Settings · new cleanup rules to review in Storage' : label
    return (
      <button type="button" className={`navigation-rail-button${active ? ' active' : ''}`}
        aria-label={label} title={active ? 'Back to threads · Esc' : title} aria-current={active ? 'page' : undefined}
        onClick={() => void toggleRailPage(page)}>
        <Icon size={18} strokeWidth={1.8} aria-hidden="true" />
        {notice && <span className="navigation-rail-notice-dot" data-testid="settings-review-dot" aria-hidden="true" />}
      </button>
    )
  }

  const search = async () => {
    if (!chatsMode) return openPalette('messages')
    // The chat search is in the sidebar, which a rail page covers.
    await leaveRailPage()
    if (activeRailPage(useAppStore.getState()) === null) useChatsStore.setState({ searchOpen: true })
  }

  return (
    <nav className="navigation-rail" aria-label="Mousse navigation">
      <button type="button" className="navigation-rail-button"
        aria-label={chatsMode ? 'Search chats' : 'Search threads'} title={chatsMode ? 'Search chats' : searchThreadsTitle}
        onClick={() => void search()}>
        <Search size={18} strokeWidth={1.8} aria-hidden="true" />
      </button>
      {shortcut('automations', 'Automations', Workflow)}
      <div className="navigation-rail-separator" role="separator" />
      {shortcut('usage', 'Subscription usage', Gauge)}
      {shortcut('settings', 'Settings', Settings)}
      <DownloadsIndicator variant="rail" />
    </nav>
  )
}
