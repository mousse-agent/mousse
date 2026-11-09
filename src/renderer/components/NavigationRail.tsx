import { useEffect } from 'react'
import { Automations, CircleGauge, House, Search, Settings, type LucideIcon } from '../lib/icons'
import { useShortcutTitle } from '../commands/commandRegistry'
import { openPalette } from '../commands/paletteActions'
import { activeRailPage, sidebarProfileShown, escapeLeavesRailPage, leaveRailPage, toggleRailPage, type RailPage } from '../lib/railPages'
import { refreshStorageReview, useStorageReviewPending } from '../lib/storageReview'
import { useAppStore } from '../stores/appStore'
import { useChatsStore } from '../stores/chatsStore'
import { DownloadsIndicator } from './downloads/DownloadsIndicator'
import { ProfileSwitcher } from './profiles/ProfileSwitcher'
import '../styles/navigation-rail.css'

/**
 * The rail opens pages over the workspace. Home, the open page's item again, or Escape on that page
 * returns to it.
 */
export function NavigationRail({ onMouseEnter, onMouseLeave, onPointerDown }: {
  /** Hovering the rail peeks the closed threads sidebar (App owns the timing). */
  onMouseEnter?: () => void
  onMouseLeave?: () => void
  onPointerDown?: () => void
} = {}) {
  const scheduledOpen = useAppStore((s) => s.scheduledOpen)
  const usageOpen = useAppStore((s) => s.usageOpen)
  const settingsOpen = useAppStore((s) => s.settingsOpen)
  // The sidebar's footer shows the profile; while the sidebar is closed (a hover peek included) the rail does.
  const profileShown = useAppStore((s) => !sidebarProfileShown(s))
  const profileReady = useAppStore((s) => s.profileReady)
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
    <nav className="navigation-rail" aria-label="Mousse navigation"
      onMouseEnter={onMouseEnter} onMouseLeave={onMouseLeave} onPointerDown={onPointerDown}>
      {/* The workspace: active while no rail page is open; a click there leaves the open page. */}
      <button type="button" className={`navigation-rail-button${activePage === null ? ' active' : ''}`}
        aria-label="Home" title="Home" aria-current={activePage === null ? 'page' : undefined}
        onClick={() => void leaveRailPage()}>
        <House size={18} strokeWidth={1.8} aria-hidden="true" />
      </button>
      <button type="button" className="navigation-rail-button"
        aria-label={chatsMode ? 'Search chats' : 'Search threads'} title={chatsMode ? 'Search chats' : searchThreadsTitle}
        onClick={() => void search()}>
        <Search size={18} strokeWidth={1.8} aria-hidden="true" />
      </button>
      {shortcut('automations', 'Automations', Automations)}
      {/* Pinned to the bottom; the empty space above it is still rail, so hovering it peeks. */}
      <div className="navigation-rail-bottom">
        <DownloadsIndicator variant="rail" />
        {shortcut('usage', 'Subscription usage', CircleGauge)}
        {shortcut('settings', 'Settings', Settings)}
        {profileReady && <div className="navigation-rail-profile" data-shown={profileShown} inert={!profileShown} aria-hidden={!profileShown || undefined}>
          <ProfileSwitcher variant="rail" onSwitched={(profile) => useAppStore.getState().activateProfile(profile.id)} />
        </div>}
      </div>
    </nav>
  )
}
