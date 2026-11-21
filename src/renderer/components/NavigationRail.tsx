import { useEffect } from 'react'
import { Automations, CircleGauge, House, SearchEverything, Settings, type LucideIcon } from '../lib/icons'
import { useShortcutTitle } from '../commands/commandRegistry'
import { openPalette } from '../commands/paletteActions'
import { activeRailPage, sidebarProfileShown, escapeLeavesRailPage, leaveRailPage, toggleRailPage, type RailPage } from '../lib/railPages'
import { refreshStorageReview, useStorageReviewPending } from '../lib/storageReview'
import { useAppStore } from '../stores/appStore'
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
  // The profile shows from the warm start (showWarmView) until the window's own binding is known.
  const profileShownEarly = useAppStore((s) => s.profileReady || Boolean(s.warmView?.profile))
  // One search on every tab: threads, archived threads, bots, chats and messages.
  const searchTitle = useShortcutTitle('Search everything', 'threads.search')

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

  // Every item is one `rail-item` with its name in data-mousse-item; the open page's item has aria-current="page".
  const shortcut = (page: RailPage, label: string, Icon: LucideIcon) => {
    const active = activePage === page
    const notice = page === 'settings' && reviewPending
    const title = notice ? 'Settings · new cleanup rules to review in Storage' : label
    return (
      <button type="button" className="navigation-rail-button" data-mousse="rail-item" data-mousse-item={page}
        aria-label={label} title={active ? 'Back to threads · Esc' : title} aria-current={active ? 'page' : undefined}
        onClick={() => void toggleRailPage(page)}>
        <Icon size={18} strokeWidth={1.8} aria-hidden="true" />
        {notice && <span className="navigation-rail-notice-dot" data-testid="settings-review-dot" aria-hidden="true" />}
      </button>
    )
  }

  return (
    <nav data-mousse="rail" className="navigation-rail" aria-label="Mousse navigation"
      onMouseEnter={onMouseEnter} onMouseLeave={onMouseLeave} onPointerDown={onPointerDown}>
      {/* The workspace: active while no rail page is open; a click there leaves the open page. */}
      <button type="button" className="navigation-rail-button" data-mousse="rail-item" data-mousse-item="home"
        aria-label="Home" title="Home" aria-current={activePage === null ? 'page' : undefined}
        onClick={() => void leaveRailPage()}>
        <House size={18} strokeWidth={1.8} aria-hidden="true" />
      </button>
      <button type="button" className="navigation-rail-button" data-mousse="rail-item" data-mousse-item="search"
        aria-label="Search everything" title={searchTitle}
        onClick={() => openPalette('messages')}>
        <SearchEverything size={18} strokeWidth={1.8} aria-hidden="true" />
      </button>
      {shortcut('automations', 'Automations', Automations)}
      {/* Pinned to the bottom; the empty space above it is still rail, so hovering it peeks. */}
      <div className="navigation-rail-bottom">
        <DownloadsIndicator variant="rail" />
        {shortcut('usage', 'Subscription usage', CircleGauge)}
        {shortcut('settings', 'Settings', Settings)}
        {profileShownEarly && <div className="navigation-rail-profile" data-shown={profileShown} inert={!profileShown} aria-hidden={!profileShown || undefined}>
          <ProfileSwitcher variant="rail" onSwitched={(profile) => useAppStore.getState().activateProfile(profile.id)} />
        </div>}
      </div>
    </nav>
  )
}
