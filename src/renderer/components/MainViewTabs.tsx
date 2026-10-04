import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Bot, FileText, FolderOpen, GitBranch, Globe, Plus, Terminal, X } from '../lib/icons'
import { useAppStore } from '../stores/appStore'
import { surfaceTabItems, type SurfaceTabItem } from '../lib/surfaces'
import { SurfaceChoiceList } from './OpenSurfaceMenu'

const TAB_ICONS = {
  agents: Bot,
  browser: Globe,
  terminal: Terminal,
  files: FolderOpen,
  git: GitBranch,
  documents: FileText
} as const

export function MainViewTabs() {
  const mainView = useAppStore((state) => state.mainView)
  const setMainView = useAppStore((state) => state.setMainView)
  const activeThreadId = useAppStore((state) => state.activeThreadId)
  const hasAgents = useAppStore((state) => state.agents.length > 0)
  const opened = useAppStore((state) => state.openedSurfaceKinds)
  const terminals = useAppStore((state) => state.projectTerminalTabs)
  const browsers = useAppStore((state) => state.browserTabs)
  const documentTabs = useAppStore((state) => state.documentTabs)
  const documentsTabVisible = useAppStore((state) => state.documentsTabVisible)
  const documents = documentsTabVisible ? documentTabs : []
  const activeTerminalId = useAppStore((state) => state.activeProjectTerminalTabByThread[state.activeThreadId ?? '__standalone__'])
  const activeBrowserId = useAppStore((state) => state.browserActiveTabByThread[state.activeThreadId ?? '__standalone__'])
  const activeDocumentId = useAppStore((state) => state.activeDocumentTabId)
  const [menuOpen, setMenuOpen] = useState(false)
  const [menuPosition, setMenuPosition] = useState({ top: 0, left: 0 })
  const addRef = useRef<HTMLDivElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)

  const visibleTerminals = terminals.filter(
    (tab) => tab.ownerThreadId === activeThreadId || tab.ownerThreadId === null
  )
  const visibleBrowsers = browsers.filter(
    (tab) => tab.ownerThreadId === activeThreadId || tab.ownerThreadId === null
  )
  const items = surfaceTabItems({
    hasAgents,
    opened,
    terminals: visibleTerminals,
    browsers: visibleBrowsers,
    documents
  })
  const visibleViews = items.map((item) => item.view).join(',')

  useEffect(() => {
    if (!visibleViews) return
    const views = visibleViews.split(',')
    if (views.includes(mainView)) return
    setMainView(views[0] as SurfaceTabItem['view'])
  }, [visibleViews, mainView, setMainView])

  useEffect(() => {
    if (!menuOpen) return
    const dismiss = (event: PointerEvent) => {
      if (!addRef.current?.contains(event.target as Node) && !menuRef.current?.contains(event.target as Node)) setMenuOpen(false)
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setMenuOpen(false)
    }
    window.addEventListener('pointerdown', dismiss)
    window.addEventListener('keydown', onKey)
    const closeMenu = () => setMenuOpen(false)
    window.addEventListener('resize', closeMenu)
    return () => {
      window.removeEventListener('pointerdown', dismiss)
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('resize', closeMenu)
    }
  }, [menuOpen])

  if (items.length === 0) return null

  const select = (item: SurfaceTabItem) => {
    const store = useAppStore.getState()
    store.setMainView(item.view)
    store.setMainAreaOpen(true)
    if (item.view === 'terminal' && item.resourceId) {
      store.setActiveProjectTerminalTab(store.activeThreadId, item.resourceId)
    }
    if (item.view === 'browser' && item.resourceId) {
      store.setActiveBrowserTab(store.activeThreadId, item.resourceId)
    }
    if (item.view === 'documents' && item.resourceId) {
      store.setActiveDocumentTab(item.resourceId)
    }
  }

  const close = (item: SurfaceTabItem) => {
    const store = useAppStore.getState()
    if (item.view === 'terminal' && item.resourceId) {
      const tab = store.projectTerminalTabs.find((entry) => entry.id === item.resourceId)
      if (tab?.ptyId) void window.mousse.pty.kill(tab.ptyId).catch(() => {})
      store.closeProjectTerminalTab(item.resourceId)
      const remaining = store.projectTerminalTabs.filter(
        (tab) => tab.id !== item.resourceId && (tab.ownerThreadId === store.activeThreadId || tab.ownerThreadId === null)
      )
      if (remaining.length === 0) store.closeSurfaceKind('terminal')
      return
    }
    if (item.view === 'browser' && item.resourceId) {
      store.closeBrowserTab(item.resourceId)
      const remaining = store.browserTabs.filter(
        (tab) => tab.id !== item.resourceId && (tab.ownerThreadId === store.activeThreadId || tab.ownerThreadId === null)
      )
      if (remaining.length === 0) store.closeSurfaceKind('browser')
      return
    }
    if (item.view === 'documents' && item.resourceId) {
      store.closeDocumentTab(item.resourceId)
      return
    }
    store.closeSurfaceKind(item.view)
  }

  const active = (item: SurfaceTabItem) => {
    if (item.view !== mainView) return false
    if (item.view === 'terminal') return item.resourceId === activeTerminalId || (!activeTerminalId && item === items.find((entry) => entry.view === 'terminal'))
    if (item.view === 'browser') return item.resourceId === activeBrowserId || (!activeBrowserId && item === items.find((entry) => entry.view === 'browser'))
    if (item.view === 'documents') return item.resourceId === activeDocumentId
    return true
  }

  return (
    <div className="header">
    <nav className="main-view-tabs" aria-label="Main area view">
      {items.map((item) => {
        const Icon = TAB_ICONS[item.view]
        const selected = active(item)
        return (
          <div key={item.key} className={`main-view-tab${selected ? ' active' : ''}`}>
            <button
              type="button"
              className="main-view-tab-select"
              aria-current={selected ? 'page' : undefined}
              onClick={() => select(item)}
            >
              <Icon size={14} strokeWidth={2} className="main-view-tab-icon" />
              <span className="main-view-tab-label">{item.label}</span>
            </button>
            {item.closable && (
              <button
                type="button"
                className="main-view-tab-close"
                aria-label={`Close ${item.label}`}
                onClick={() => close(item)}
              >
                <X size={12} strokeWidth={2} />
              </button>
            )}
          </div>
        )
      })}
      <div className="main-view-tab-add-wrap" ref={addRef}>
        <button
          type="button"
          className="main-view-tab-add"
          aria-label="Open a surface"
          aria-expanded={menuOpen}
          onClick={() => {
            const bounds = addRef.current?.getBoundingClientRect()
            if (bounds) setMenuPosition({
              top: bounds.bottom + 6,
              left: Math.max(8, Math.min(bounds.left, window.innerWidth - 248))
            })
            setMenuOpen((open) => !open)
          }}
        >
          <Plus size={14} strokeWidth={2} />
        </button>
        {menuOpen && createPortal(
          <div ref={menuRef} className="surface-menu-popover" role="menu" style={{ position: 'fixed', ...menuPosition }}>
            <SurfaceChoiceList another onPick={() => setMenuOpen(false)} />
          </div>,
          document.body
        )}
      </div>
    </nav>
    </div>
  )
}
