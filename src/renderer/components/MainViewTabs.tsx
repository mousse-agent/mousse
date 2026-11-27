import { MarkdownFileSpeechControls } from '../readAloud/MarkdownFileSpeechControls'
import { setReferenceDragData } from '../../shared/chatReferences'
import { filesEntryReference } from '../utils/fileReference'
import { useFileWorkspaceStore } from '../stores/filesStore'
import { closeFileTab, fileTabRoot, useFileTabStatus } from '../services/fileTabs'
import { useActiveFileWorkspace } from '../hooks/useActiveFileWorkspace'
import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { MainView } from '../../shared/types'
import { BrowserTab, ChevronLeft, FileText, FolderOpen, GitCompare, GitPullRequest, Globe, MessagesSquare, Plus, Terminal, X } from '../lib/icons'
import { sideChatTitle, useOpenSideChat, useSideChatsStore } from '../stores/sideChatsStore'
import { documentTabsForThread, shownDocumentTab, useAppStore } from '../stores/appStore'
import { confirmNavigation } from '../services/navigationGuards'
import { surfaceTabItems, type SurfaceTabItem } from '../lib/surfaces'
import { focusInitialMenuItem, useMenuKeyboard } from '../hooks/useMenuKeyboard'
import { terminalLocations } from '../lib/folderLabel'
import { UNKNOWN_COMPUTER_NAME, useComputers } from '../lib/computers'
import { SurfaceChoiceList } from './OpenSurfaceMenu'

const TAB_ICONS = {
  browser: Globe,
  terminal: Terminal,
  files: FolderOpen,
  git: GitCompare,
  pullRequest: GitPullRequest,
  sideChats: MessagesSquare,
  documents: FileText
} as const

export function MainViewTabs() {
  const mainView = useAppStore((state) => state.mainView)
  const setMainView = useAppStore((state) => state.setMainView)
  const activeThreadId = useAppStore((state) => state.activeThreadId)
  const opened = useAppStore((state) => state.openedSurfaceKinds)
  const terminals = useAppStore((state) => state.projectTerminalTabs)
  const threads = useAppStore((state) => state.threads)
  const browsers = useAppStore((state) => state.browserTabs)
  const documentTabs = useAppStore((state) => state.documentTabs)
  const documents = documentTabsForThread(documentTabs, activeThreadId)
  const activeTerminalId = useAppStore((state) => state.activeProjectTerminalTabByThread[state.activeThreadId ?? '__standalone__'])
  const activeBrowserId = useAppStore((state) => state.browserActiveTabByThread[state.activeThreadId ?? '__standalone__'])
  const activeDocumentId = useAppStore((state) => shownDocumentTab(state)?.id)
  const openSideChat = useOpenSideChat(activeThreadId)
  const [menuOpen, setMenuOpen] = useState(false)
  const [menuPosition, setMenuPosition] = useState({ top: 0, left: 0 })
  const addRef = useRef<HTMLDivElement>(null)
  const addButtonRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const closeMenu = useCallback(() => {
    setMenuOpen(false)
    addButtonRef.current?.focus()
  }, [])
  const onMenuKeyDown = useMenuKeyboard(menuRef, closeMenu)

  const visibleTerminals = terminals.filter(
    (tab) => tab.ownerThreadId === activeThreadId || tab.ownerThreadId === null
  )
  const visibleBrowsers = browsers.filter(
    (tab) => tab.ownerThreadId === activeThreadId || tab.ownerThreadId === null
  )
  // A terminal runs on its thread's computer; its folder is the one the app started it in.
  const terminalNodes = visibleTerminals.map((tab) => ({
    tab,
    node: tab.ownerThreadId ? threads.find((thread) => thread.id === tab.ownerThreadId)?.node : undefined
  }))
  const { byNode } = useComputers(terminalNodes.some((entry) => entry.node))
  const { scope, workspace } = useActiveFileWorkspace()
  const dirtyPaths = useFileTabStatus((s) => s.dirtyPaths[scope])
  const items = surfaceTabItems({
    files: workspace?.openPaths,
    opened,
    terminals: visibleTerminals,
    browsers: visibleBrowsers,
    documents,
    ...(openSideChat ? { openSideChat: sideChatTitle(openSideChat) } : {}),
    terminalLocations: terminalLocations(terminalNodes.map(({ tab, node }) => ({
      id: tab.id,
      cwd: tab.cwd,
      node,
      computerName: node ? byNode[node]?.name ?? UNKNOWN_COMPUTER_NAME : undefined
    })))
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
      if (event.key === 'Escape') closeMenu()
    }
    const onResize = () => setMenuOpen(false)
    window.addEventListener('pointerdown', dismiss)
    window.addEventListener('keydown', onKey)
    window.addEventListener('resize', onResize)
    focusInitialMenuItem(menuRef.current)
    return () => {
      window.removeEventListener('pointerdown', dismiss)
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('resize', onResize)
    }
  }, [menuOpen, closeMenu])

  if (items.length === 0) return null

  const select = async (item: SurfaceTabItem) => {
    // The open side chat's tab, shown: back to the list.
    if (item.back && item.view === useAppStore.getState().mainView && activeThreadId) {
      useSideChatsStore.getState().open(activeThreadId, null)
      return
    }
    // Leaving the current view may discard an unsaved agent draft.
    if (item.view !== useAppStore.getState().mainView && !await confirmNavigation()) return
    const store = useAppStore.getState()
    store.setMainView(item.view)
    store.setMainAreaOpen(true)
    if (item.view === 'files') {
      const files = useFileWorkspaceStore.getState()
      if (item.resourceId) files.activateFile(scope, item.resourceId)
      else files.deactivateFile(scope)
    }
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
    // Closing the last tab closes the panel with it.
    const last = items.length === 1
    const closePanelIfLast = () => { if (last) useAppStore.getState().setMainAreaOpen(false) }
    if (item.view === 'files' && item.resourceId) {
      void closeFileTab(scope, item.resourceId).then((closed) => { if (closed) closePanelIfLast() })
      return
    }
    if (item.view === 'terminal' && item.resourceId) {
      const tab = store.projectTerminalTabs.find((entry) => entry.id === item.resourceId)
      if (tab?.ptyId) void window.mousse.pty.kill(tab.ptyId, tab.ownerThreadId ?? undefined).catch(() => {})
      store.closeProjectTerminalTab(item.resourceId)
      const remaining = store.projectTerminalTabs.filter(
        (tab) => tab.id !== item.resourceId && (tab.ownerThreadId === store.activeThreadId || tab.ownerThreadId === null)
      )
      if (remaining.length === 0) store.closeSurfaceKind('terminal')
      closePanelIfLast()
      return
    }
    if (item.view === 'browser' && item.resourceId) {
      store.closeBrowserTab(item.resourceId)
      const remaining = store.browserTabs.filter(
        (tab) => tab.id !== item.resourceId && (tab.ownerThreadId === store.activeThreadId || tab.ownerThreadId === null)
      )
      if (remaining.length === 0) store.closeSurfaceKind('browser')
      closePanelIfLast()
      return
    }
    if (item.view === 'documents' && item.resourceId) {
      store.closeDocumentTab(item.resourceId)
      closePanelIfLast()
      return
    }
    store.closeSurfaceKind(item.view)
    closePanelIfLast()
  }

  const active = (item: SurfaceTabItem) => {
    if (item.view !== mainView) return false
    if (item.view === 'terminal') return item.resourceId === activeTerminalId || (!activeTerminalId && item === items.find((entry) => entry.view === 'terminal'))
    if (item.view === 'browser') return item.resourceId === activeBrowserId || (!activeBrowserId && item === items.find((entry) => entry.view === 'browser'))
    if (item.view === 'files') return (item.resourceId ?? null) === (workspace?.activePath ?? null)
    if (item.view === 'documents') return item.resourceId === activeDocumentId
    return true
  }

  const openViews = new Set<MainView>(items.map((item) => item.view))
  // An open panel's menu row focuses its tab; of several browser tabs, the one last selected.
  const focusOpen = (view: MainView) => {
    const tabs = items.filter((item) => item.view === view)
    const item = tabs.find((entry) => entry.view === 'browser' && entry.resourceId === activeBrowserId) ?? tabs[0]
    if (item) void select(item)
  }

  return (
    <div className="header">
    <nav className="main-view-tabs" aria-label="Main area view">
      {items.map((item) => {
        const Icon = item.everyThread ? BrowserTab : item.back ? ChevronLeft : item.view === 'files' && item.resourceId ? FileText : TAB_ICONS[item.view]
        const dirty = item.view === 'files' && item.resourceId && dirtyPaths?.includes(item.resourceId)
        const selected = active(item)
        const name = item.detail ? `${item.label} · ${item.detail}` : item.label
        return (
          <div
            key={item.key}
            className={`main-view-tab${selected ? ' active' : ''}${item.back ? ' is-side-chat' : ''}${item.view === 'browser' ? ' is-browser' : ''}`}
            onKeyDown={(event) => {
              if (item.view === 'files' && item.resourceId && event.key === 'Delete') {
                event.preventDefault()
                close(item)
              }
            }}
            // Middle-click closes a tab; stopping the press keeps Chromium's autoscroll away.
            onMouseDown={item.closable ? (event) => { if (event.button === 1) event.preventDefault() } : undefined}
            onAuxClick={item.closable ? (event) => { if (event.button === 1) close(item) } : undefined}
          >
            <button
              type="button"
              className="main-view-tab-select"
              aria-current={selected ? 'page' : undefined}
              aria-label={item.detail ? name : undefined}
              title={dirty ? `${item.title} (unsaved)` : item.title ?? (item.everyThread ? 'Kept in every thread' : item.label)}
              draggable={item.view === 'files' && Boolean(item.resourceId)}
              onDragStart={item.view === 'files' && item.resourceId ? (event) => {
                setReferenceDragData(event.dataTransfer, filesEntryReference({
                  path: item.resourceId!, name: item.label, kind: 'file', filesRoot: fileTabRoot(scope),
                  threadId: activeThreadId, projectId: threads.find((thread) => thread.id === activeThreadId)?.projectId ?? null
                }))
                event.dataTransfer.setData('text/plain', item.resourceId!)
              } : undefined}
              onClick={() => void select(item)}
            >
              <Icon size={14} strokeWidth={2} className="main-view-tab-icon" />
              <span className="main-view-tab-label">{item.label}{dirty ? ' •' : ''}</span>
              {item.detail && <span className="main-view-tab-detail">{item.detail}</span>}
            </button>
            {item.view === 'files' && item.resourceId && <MarkdownFileSpeechControls scope={scope} path={item.resourceId} />}
            {item.closable && (
              <button
                type="button"
                className="main-view-tab-close"
                aria-label={`Close ${name}`}
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
          ref={addButtonRef}
          type="button"
          className="main-view-tab-add"
          aria-label="Add panel"
          title="Add panel"
          aria-haspopup="menu"
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
          <div ref={menuRef} className="surface-menu-popover" role="menu" aria-label="Add panel"
            style={{ position: 'fixed', ...menuPosition }} onKeyDown={onMenuKeyDown}>
            <SurfaceChoiceList menu openViews={openViews} onFocusOpen={focusOpen} onPick={() => setMenuOpen(false)} />
          </div>,
          document.body
        )}
      </div>
    </nav>
    </div>
  )
}
