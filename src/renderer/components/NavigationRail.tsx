import { useEffect, useRef, useState } from 'react'
import { FolderOpen, Gauge, House, MoreHorizontal, Radio, Search, Settings, Terminal, Workflow, type LucideIcon } from '../lib/icons'
import type { MainView } from '../../shared/types'
import { useActiveProjectPath } from '../hooks/useActiveProjectPath'
import { FloatingPortal, useFloatingPosition } from '../lib/floatingLayer'
import { openSurface } from '../lib/surfaces'
import { confirmNavigation } from '../services/navigationGuards'
import { useAppStore } from '../stores/appStore'
import { ThreadSearchDialog } from './ThreadSearchDialog'
import '../styles/navigation-rail.css'

interface NavigationRailProps {
  onMouseEnter?: () => void
  onMouseLeave?: () => void
}

export function NavigationRail({ onMouseEnter, onMouseLeave }: NavigationRailProps) {
  const mainView = useAppStore((s) => s.mainView)
  const sidebarMode = useAppStore((s) => s.sidebarMode)
  const mainAreaOpen = useAppStore((s) => s.mainAreaOpen)
  const scheduledOpen = useAppStore((s) => s.scheduledOpen)
  const channelsOpen = useAppStore((s) => s.channelsOpen)
  const setMainAreaOpen = useAppStore((s) => s.setMainAreaOpen)
  const setThreadsSidebarOpen = useAppStore((s) => s.setThreadsSidebarOpen)
  const setScheduledOpen = useAppStore((s) => s.setScheduledOpen)
  const setChannelsOpen = useAppStore((s) => s.setChannelsOpen)
  const usageOpen = useAppStore((s) => s.usageOpen)
  const settingsOpen = useAppStore((s) => s.settingsOpen)
  const setSettingsOpen = useAppStore((s) => s.setSettingsOpen)
  const switchToThread = useAppStore((s) => s.switchToThread)
  const projectPath = useActiveProjectPath()
  const [moreOpen, setMoreOpen] = useState(false)
  const [searchOpen, setSearchOpen] = useState(false)
  const moreRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const menuStyle = useFloatingPosition({
    open: moreOpen, anchorRef: moreRef, contentRef: menuRef, placement: 'right-start'
  })

  useEffect(() => {
    if (moreOpen && menuStyle.visibility === 'visible') {
      menuRef.current?.querySelector<HTMLButtonElement>('button')?.focus()
    }
  }, [moreOpen, menuStyle.visibility])

  useEffect(() => {
    if (!moreOpen) return
    const dismiss = (event: PointerEvent) => {
      const target = event.target as Node
      if (!moreRef.current?.contains(target) && !menuRef.current?.contains(target)) setMoreOpen(false)
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        setMoreOpen(false)
        moreRef.current?.focus()
      }
      if (!menuRef.current?.contains(document.activeElement)) return
      const buttons = [...menuRef.current.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')]
      const index = buttons.indexOf(document.activeElement as HTMLButtonElement)
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault()
        buttons[(index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length]?.focus()
      } else if (event.key === 'Tab') {
        setMoreOpen(false)
      }
    }
    window.addEventListener('pointerdown', dismiss)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('pointerdown', dismiss)
      window.removeEventListener('keydown', onKey)
    }
  }, [moreOpen])

  const openView = async (view: MainView) => {
    if ((view !== mainView || sidebarMode !== 'projects') && !await confirmNavigation()) return
    openSurface(view)
    setMoreOpen(false)
  }
  const showHome = async () => {
    if (sidebarMode !== 'projects' && !await confirmNavigation()) return
    useAppStore.getState().setSidebarMode('projects')
    setThreadsSidebarOpen(true)
    setMainAreaOpen(false)
  }
  const overlayOpen = scheduledOpen || channelsOpen || searchOpen
  const shortcut = (label: string, Icon: LucideIcon, active: boolean, onClick: () => void, disabled = false) => (
    <button type="button" className={`navigation-rail-button${active ? ' active' : ''}`}
      aria-label={label} title={label} aria-current={active ? 'page' : undefined}
      onClick={onClick} disabled={disabled}>
      <Icon size={18} strokeWidth={1.8} aria-hidden="true" />
      {label === 'Home' && active && <span className="navigation-rail-active-dot" aria-hidden="true" />}
    </button>
  )

  return (
    <>
      <nav className="navigation-rail" aria-label="Mousse navigation" onMouseEnter={onMouseEnter} onMouseLeave={onMouseLeave}>
        {shortcut('Home', House, !overlayOpen && !mainAreaOpen && sidebarMode === 'projects', () => void showHome())}
        {shortcut('Automations', Workflow, scheduledOpen, () => setScheduledOpen(true))}
        {shortcut('Channels', Radio, channelsOpen, () => setChannelsOpen(true))}
        <button ref={moreRef} type="button" className={`navigation-rail-button${moreOpen ? ' active' : ''}`}
          aria-label="More" title="More" aria-haspopup="menu" aria-expanded={moreOpen}
          aria-controls={moreOpen ? 'navigation-rail-more' : undefined} onClick={() => setMoreOpen(!moreOpen)}>
          <MoreHorizontal size={18} strokeWidth={1.8} aria-hidden="true" />
        </button>
        <div className="navigation-rail-separator" role="separator" />
        {shortcut('Subscription usage', Gauge, usageOpen, () => useAppStore.getState().setUsageOpen(true))}
        {shortcut('Settings', Settings, settingsOpen, () => setSettingsOpen(true))}
      </nav>
      {moreOpen && <FloatingPortal>
        <div ref={menuRef} id="navigation-rail-more" role="menu" aria-label="More navigation"
          className="navigation-rail-menu" style={menuStyle}>
          <button type="button" role="menuitem" onClick={() => { setMoreOpen(false); setSearchOpen(true) }}>
            <Search size={16} aria-hidden="true" />Search threads
          </button>
          <button type="button" role="menuitem" disabled={!projectPath} onClick={() => void openView('files')}>
            <FolderOpen size={16} aria-hidden="true" />Files
          </button>
          <button type="button" role="menuitem" onClick={() => void openView('terminal')}>
            <Terminal size={16} aria-hidden="true" />Terminal
          </button>
        </div>
      </FloatingPortal>}
      <ThreadSearchDialog open={searchOpen} onClose={() => setSearchOpen(false)} onSelect={(threadId) => {
        void confirmNavigation().then((allowed) => {
          if (!allowed) return
          switchToThread(threadId)
          void window.mousse.threads.select(threadId)
          setThreadsSidebarOpen(true)
        })
      }} />
    </>
  )
}
