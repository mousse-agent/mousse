import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent, type ReactNode } from 'react'
import { FolderOpen, Globe, Plus, Settings, X } from '../../lib/icons'
import type { BotChatMessage, BotLaunchedThread, BotSummary } from '../../../shared/bots/personal/chat'
import type { BotBrowserView } from '../../../shared/bots/personal/browser'
import type { ThreadBrowserView } from '../../../shared/browser/threadView'
import { useBotBrowserStore } from '../../stores/botBrowserStore'
import { useThreadBrowser, useThreadBrowserStore } from '../../stores/threadBrowserStore'
import { useBotsStore } from '../../stores/botsStore'
import { useAppStore } from '../../stores/appStore'
import { profilePreferenceKey } from '../../lib/profilePreferences'
import { motionOff, scaleMotionMs } from '../../lib/motion'
import { joinFolder } from '../../utils/filesBrowse'
import { FileTree } from '../FileTree'
import { PanelPicker, PanelPickerRow } from '../OpenSurfaceMenu'
import { BotAboutPanel } from './BotAboutPanel'
import { BotBrowserPane } from './BotBrowser'
import { ThreadBrowserPane } from '../browser/ThreadBrowserView'
import { BotFilePane, fileActions, useBotFiles } from './BotFiles'
import type { WatchedBrowserFullScreen } from '../browser/WatchedBrowserPane'
import '../filesPanel.css'
import './botSidePanel.css'

/**
 * A bot's side panel: its own column docked right of the chat pane, as the app panel docks beside a thread. It opens
 * on the app panel's empty picker (`PanelPicker`): the bot's Browser, its Files folder and Agent settings (the About
 * content). Each picked opens as a tab in the app panel's tab strip (`.main-view-tabs`), whose + opens the picker again
 * as a new tab. The panel slides in from the right edge as it fades in; the chat pane gives it room as it opens. The
 * browser can go full screen: the panel then takes the chat pane's place, the browser alone, until it leaves.
 */

export type BotSideView = 'browser' | 'files' | 'settings'

const VIEWS: ReadonlyArray<{ view: BotSideView; label: string; icon: typeof Globe }> = [
  { view: 'browser', label: 'Browser', icon: Globe },
  { view: 'files', label: 'Files', icon: FolderOpen },
  { view: 'settings', label: 'Agent settings', icon: Settings }
]

/** A tab of the panel: one of its views, or the picker (`view` null) until one is picked in it. */
export interface BotSideTab { id: number; view: BotSideView | null }

// ---------------------------------------------------------------------------------------------------------------
// Which tabs show: Agent settings follows the store's `aboutOpen` (the menu, the face and Pick a model open it), the
// Browser the browser store's split view (a preview's Expand opens it); Files is the panel's own.

export interface BotSidePanelState {
  open: boolean
  tabs: readonly BotSideTab[]
  active: number
  /** The view of the tab in front; null while it is the picker. */
  view: BotSideView | null
  /** Brings `view` to the front: its tab, else the picker in front becomes it, else a new tab. Opens the panel. */
  show(view: BotSideView): void
  select(tabId: number): void
  closeTab(tabId: number): void
  /** The + of the tab strip: the picker as a new tab (the one already open, when there is one). */
  addPicker(): void
  close(): void
  toggle(): void
}

interface SideState { open: boolean; tabs: BotSideTab[]; active: number }

const pickerOnly = (id: number): SideState => ({ open: false, tabs: [{ id, view: null }], active: id })
const activeView = (state: SideState) => state.tabs.find((tab) => tab.id === state.active)?.view ?? null

export function useBotSidePanel(botId: string): BotSidePanelState {
  const aboutOpen = useBotsStore((s) => s.aboutOpen)
  const paneOpen = useBotBrowserStore((s) => s.pane === botId)
  const nextId = useRef(1)
  const [side, setSide] = useState<SideState>(() => {
    const view: BotSideView | null = aboutOpen ? 'settings' : paneOpen ? 'browser' : null
    return { open: view !== null, tabs: [{ id: 0, view }], active: 0 }
  })
  const current = useRef(side)
  current.current = side

  // The stores follow the tab in front of an open panel: Agent settings is `aboutOpen`, the Browser the split view.
  const apply = useCallback((next: SideState) => {
    current.current = next
    setSide(next)
    const view = next.open ? activeView(next) : null
    if (useBotsStore.getState().aboutOpen !== (view === 'settings')) useBotsStore.setState({ aboutOpen: view === 'settings' })
    const browser = useBotBrowserStore.getState()
    if (view === 'browser' && browser.pane !== botId) browser.openPane(botId)
    if (view !== 'browser' && browser.pane === botId) browser.closePane()
  }, [botId])

  const show = useCallback((view: BotSideView) => {
    const state = current.current
    const found = state.tabs.find((tab) => tab.view === view)
    if (found) return apply({ ...state, open: true, active: found.id })
    if (activeView(state) === null && state.tabs.some((tab) => tab.id === state.active))
      return apply({ ...state, open: true, tabs: state.tabs.map((tab) => (tab.id === state.active ? { ...tab, view } : tab)) })
    const id = nextId.current++
    apply({ open: true, tabs: [...state.tabs, { id, view }], active: id })
  }, [apply])

  const select = useCallback((tabId: number) => apply({ ...current.current, open: true, active: tabId }), [apply])

  const closeTab = useCallback((tabId: number) => {
    const state = current.current
    const index = state.tabs.findIndex((tab) => tab.id === tabId)
    if (index < 0) return
    const tabs = state.tabs.filter((tab) => tab.id !== tabId)
    // The last tab closed closes the panel, which opens on the picker next time.
    if (tabs.length === 0) return apply(pickerOnly(nextId.current++))
    const active = state.active === tabId ? tabs[Math.max(0, index - 1)]!.id : state.active
    apply({ ...state, tabs, active })
  }, [apply])

  const addPicker = useCallback(() => {
    const state = current.current
    const picker = state.tabs.find((tab) => tab.view === null)
    if (picker) return apply({ ...state, open: true, active: picker.id })
    const id = nextId.current++
    apply({ open: true, tabs: [...state.tabs, { id, view: null }], active: id })
  }, [apply])

  const close = useCallback(() => {
    if (current.current.open) apply({ ...current.current, open: false })
  }, [apply])

  const toggle = useCallback(() => apply({ ...current.current, open: !current.current.open }), [apply])

  // Another bot's chat opens on the picker, closed.
  const shownBot = useRef(botId)
  useEffect(() => {
    if (shownBot.current === botId) return
    shownBot.current = botId
    const reset = pickerOnly(nextId.current++)
    current.current = reset
    setSide(reset)
  }, [botId])

  // Opened from elsewhere, the panel shows that view; closed from elsewhere while in front, its tab closes.
  const wasAbout = useRef(aboutOpen)
  useEffect(() => {
    const was = wasAbout.current
    wasAbout.current = aboutOpen
    const state = current.current
    if (aboutOpen && !was) show('settings')
    else if (!aboutOpen && was && state.open && activeView(state) === 'settings') closeTab(state.active)
  }, [aboutOpen, show, closeTab])
  const wasPane = useRef(paneOpen)
  useEffect(() => {
    const was = wasPane.current
    wasPane.current = paneOpen
    const state = current.current
    if (paneOpen && !was) show('browser')
    else if (!paneOpen && was && state.open && activeView(state) === 'browser') closeTab(state.active)
  }, [paneOpen, show, closeTab])

  return { open: side.open, tabs: side.tabs, active: side.active, view: activeView(side), show, select, closeTab, addPicker, close, toggle }
}

// ---------------------------------------------------------------------------------------------------------------
// Width, kept per profile like the sidebars' widths (the key About used, so a width set there carries over).

const WIDTH_KEY = 'mousse:bot-about-width'
const DEFAULT_WIDTH = 380
const MIN_WIDTH = 300
/**
 * The chat keeps at least this much beside the panel; the panel takes the rest, as the app's side panel does (a browser
 * there is used at nearly the window's width). Full screen is for the whole pane.
 */
const MIN_CHAT_WIDTH = 240

function usePanelWidth(profileId: string) {
  const key = profileId ? profilePreferenceKey(profileId, WIDTH_KEY) : WIDTH_KEY
  const [width, setWidth] = useState(() => {
    const stored = Number.parseInt(window.localStorage.getItem(key) ?? '', 10)
    return Number.isFinite(stored) ? Math.max(MIN_WIDTH, stored) : DEFAULT_WIDTH
  })
  const update = useCallback((next: number, rowWidth?: number) => {
    const max = rowWidth ? Math.max(MIN_WIDTH, rowWidth - MIN_CHAT_WIDTH) : Infinity
    const value = Math.round(Math.min(max, Math.max(MIN_WIDTH, next)))
    setWidth(value)
    window.localStorage.setItem(key, String(value))
  }, [key])
  return [width, update] as const
}

/** The width of the row the panel shares with the chat pane, which bounds its width. */
const rowWidthOf = (handle: HTMLElement) => handle.closest('.bot-side-slide')?.parentElement?.getBoundingClientRect().width

// ---------------------------------------------------------------------------------------------------------------

/**
 * The bot's files folder (`…/bots/files/<botId>`), from a path its chat named: an attachment, else a path in a
 * message. The window is never told the folder itself, so a bot that has named no file yet has none here.
 */
export function botFilesFolder(messages: readonly BotChatMessage[], botId: string): string | null {
  const id = botId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const inPath = new RegExp(`^(.*?[\\\\/]bots[\\\\/]files[\\\\/]${id})(?:[\\\\/]|$)`)
  const inText = new RegExp(`(?:[A-Za-z]:[\\\\/]|\\\\\\\\|/|~[\\\\/])[^\\s\`<>"|*?()\\[\\]]*?[\\\\/]bots[\\\\/]files[\\\\/]${id}(?=[\\\\/\\s\`'")]|$)`)
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]!
    for (const file of message.attachments ?? []) {
      const found = inPath.exec(file.path)?.[1]
      if (found) return found
    }
  }
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const found = inText.exec(messages[index]!.text)?.[0]
    if (found) return found
  }
  return null
}

function FilesView({ bot, folder, file, onFile }: { bot: BotSummary; folder: string | null; file: string | null; onFile(path: string | null): void }) {
  const host = useBotFiles()
  if (file) return <BotFilePane botId={bot.id} path={file} onClose={() => onFile(null)} />
  if (!folder) return <div className="bot-side-empty">
    <FolderOpen size={20} strokeWidth={1.6} aria-hidden />
    <p>No files yet. What {bot.name} makes, and what you send it, shows here.</p>
  </div>
  return <div className="bot-side-files">
    <div className="bot-side-files-head">
      <span className="bot-side-files-name" title={folder}>{bot.name}’s files</span>
      <button type="button" className="bot-file-button" title="Show in folder" aria-label="Show the files folder" onClick={() => fileActions.showInFolder(folder, host?.failed)}>
        <FolderOpen size={15} aria-hidden />
      </button>
    </div>
    <FileTree filesRoot={folder} listRoot={folder} threadId={null} selectedPath={null} refreshKey={0}
      onSelectFile={(path) => onFile(joinFolder(folder, path))} />
  </div>
}

/**
 * The threads the bot started whose agent has a browser open (or one that stopped by itself), in the order its header
 * lists them: each is a tab of the Browser view beside the bot's own browser. Their state is the threads' own
 * (`browser.view.*`), read only while the Browser view is in front.
 */
export function botBrowserThreadTabs(threads: readonly BotLaunchedThread[] | undefined, views: Readonly<Record<string, ThreadBrowserView | undefined>>): BotLaunchedThread[] {
  return (threads ?? []).filter((thread) => {
    const view = views[thread.threadId]
    return Boolean(view && (view.open || view.stopped))
  })
}

/** The browser the Browser view shows: the thread tab chosen while it is there, else the bot's own, else the first thread's. Null is the bot's own. */
export function shownBrowserTab(chosen: string | null, tabs: readonly Pick<BotLaunchedThread, 'threadId'>[], own: boolean): string | null {
  if (chosen !== null && tabs.some((tab) => tab.threadId === chosen)) return chosen
  if (own || tabs.length === 0) return null
  return tabs[0]!.threadId
}

/** Keeps one started thread's browser state read while the Browser view is in front; draws nothing. */
function ThreadBrowserProbe({ threadId }: { threadId: string }) {
  useThreadBrowser(threadId)
  return null
}

function BrowserTabs({ bot, tabs, shown, onChoose }: { bot: BotSummary; tabs: readonly BotLaunchedThread[]; shown: string | null; onChoose(threadId: string | null): void }) {
  return <div className="bot-browser-tabs" role="group" aria-label={`${bot.name}'s browsers`}>
    <button type="button" className={shown === null ? 'is-on' : undefined} aria-pressed={shown === null} title={`${bot.name}'s browser`} onClick={() => onChoose(null)}>
      <Globe size={12} aria-hidden /><span>{bot.name}</span>
    </button>
    {tabs.map((thread) => <button key={thread.threadId} type="button" className={shown === thread.threadId ? 'is-on' : undefined} aria-pressed={shown === thread.threadId}
      title={thread.title} onClick={() => onChoose(thread.threadId)}><span>{thread.title}</span></button>)}
  </div>
}

function BrowserView({ bot, view, fullScreen, tabs, shown, threadView, onChoose }: {
  bot: BotSummary
  view: BotBrowserView | undefined
  fullScreen: WatchedBrowserFullScreen
  tabs: readonly BotLaunchedThread[]
  shown: string | null
  threadView: ThreadBrowserView | undefined
  onChoose(threadId: string | null): void
}) {
  const busy = useBotBrowserStore((state) => state.busy)
  const thread = shown === null ? undefined : tabs.find((tab) => tab.threadId === shown)
  let pane: ReactNode
  if (thread && threadView) pane = <ThreadBrowserPane threadId={thread.threadId} view={threadView} label={`${thread.title}: the agent's browser`} fullScreen={fullScreen} />
  else if (view) pane = <BotBrowserPane bot={bot} view={view} fullScreen={fullScreen} />
  else pane = <div className="bot-side-empty">
    <Globe size={20} strokeWidth={1.6} aria-hidden />
    <p>{bot.name} hasn’t used its browser yet.</p>
    <button type="button" className="settings-btn" disabled={busy} onClick={() => void useBotBrowserStore.getState().open(bot.id, undefined)}>Open it</button>
  </div>
  return <>
    {(bot.threads ?? []).map((item) => <ThreadBrowserProbe key={item.threadId} threadId={item.threadId} />)}
    {tabs.length > 0 && !fullScreen.on && <BrowserTabs bot={bot} tabs={tabs} shown={shown} onChoose={onChoose} />}
    {pane}
  </>
}

/**
 * The panel itself: the tab strip, the view (each switch fades and slides in from the side of its tab), and the left
 * edge that drags the width. It mounts while open and for the slide out.
 */
export function BotSidePanel({ bot, state, browser, folder, file, onFile }: {
  bot: BotSummary
  state: BotSidePanelState
  browser: BotBrowserView | undefined
  folder: string | null
  file: string | null
  onFile(path: string | null): void
}) {
  const { open, view } = state
  const profileId = useAppStore((s) => s.profileId)
  const [width, setWidth] = usePanelWidth(profileId)
  const [mounted, setMounted] = useState(open)
  const [shown, setShown] = useState(open)
  const [settled, setSettled] = useState(open)
  useEffect(() => {
    if (open) {
      setMounted(true)
      if (motionOff()) { setShown(true); setSettled(true); return }
      // Two frames: the closed state is laid out first, so the change to open is a transition.
      let inner = 0
      const outer = requestAnimationFrame(() => { inner = requestAnimationFrame(() => setShown(true)) })
      return () => { cancelAnimationFrame(outer); cancelAnimationFrame(inner) }
    }
    setShown(false)
    setSettled(false)
    if (motionOff()) { setMounted(false); return }
    // transitionend, or this backstop when it never comes (a tab hidden mid-slide).
    const timer = window.setTimeout(() => setMounted(false), scaleMotionMs(200) + 80)
    return () => window.clearTimeout(timer)
  }, [open])

  // The Browser view's tabs: the bot's own browser, and one per thread it started whose agent has a browser. The
  // threads' state is read only while the view is in front.
  const browserFront = open && view === 'browser'
  const [chosen, setChosen] = useState<string | null>(null)
  useEffect(() => { setChosen(null) }, [bot.id])
  const tabIds = useThreadBrowserStore((s) => (browserFront ? botBrowserThreadTabs(bot.threads, s.views).map((thread) => thread.threadId).join('\n') : ''))
  const tabs = useMemo(() => {
    const ids = new Set(tabIds ? tabIds.split('\n') : [])
    return (bot.threads ?? []).filter((thread) => ids.has(thread.threadId))
  }, [tabIds, bot.threads])
  const shownThread = shownBrowserTab(chosen, tabs, Boolean(browser))
  const threadView = useThreadBrowserStore((s) => (shownThread ? s.views[shownThread] : undefined))

  // Full screen holds while a browser is the view in front of an open panel; anything else leaves it.
  const [full, setFull] = useState(false)
  const fullScreen = full && browserFront && (shownThread ? Boolean(threadView) : Boolean(browser))
  useEffect(() => { if (full && !fullScreen) setFull(false) }, [full, fullScreen])

  // The way a switch moves: from the side of the tab picked.
  const order = state.tabs.findIndex((tab) => tab.id === state.active)
  const previous = useRef(order)
  const from = useRef<'left' | 'right' | null>(null)
  if (previous.current !== order) {
    from.current = order > previous.current ? 'right' : 'left'
    previous.current = order
  }

  const startResize = (event: PointerEvent<HTMLDivElement>) => {
    event.preventDefault()
    const startX = event.clientX
    const startWidth = width
    const rowWidth = rowWidthOf(event.currentTarget)
    event.currentTarget.setPointerCapture(event.pointerId)
    const before = [document.body.style.cursor, document.body.style.userSelect] as const
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'
    const move = (moveEvent: globalThis.PointerEvent) => setWidth(startWidth - (moveEvent.clientX - startX), rowWidth)
    const stop = () => {
      ;[document.body.style.cursor, document.body.style.userSelect] = before
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', stop)
      window.removeEventListener('pointercancel', stop)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', stop)
    window.addEventListener('pointercancel', stop)
  }
  const resizeKey = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
    event.preventDefault()
    setWidth(width + (event.key === 'ArrowLeft' ? 16 : -16), rowWidthOf(event.currentTarget))
  }

  if (!mounted) return null
  let body: ReactNode
  if (view === 'settings') body = <BotAboutPanel bot={bot} inPanel />
  // The browser is watched only while the panel is open: sliding out, it asks for no more pictures.
  else if (view === 'browser') body = open ? <BrowserView bot={bot} view={browser} fullScreen={{ on: fullScreen, toggle: () => setFull(!fullScreen) }}
    tabs={tabs} shown={shownThread} threadView={threadView} onChoose={setChosen} /> : null
  else if (view === 'files') body = <FilesView bot={bot} folder={folder} file={file} onFile={onFile} />
  else body = <PanelPicker>
    {VIEWS.map(({ view: entry, label, icon }) => <li key={entry}><PanelPickerRow icon={icon} label={label} onPick={() => state.show(entry)} /></li>)}
  </PanelPicker>
  // The picker alone has no tab: as the app panel's, it shows by itself.
  const strip = state.tabs.length === 1 && view === null ? [] : state.tabs

  return <div className={`bot-side-slide${shown ? ' is-open' : ''}${settled ? ' is-settled' : ''}${fullScreen ? ' is-fullscreen' : ''}`} inert={!open || undefined}
    onTransitionEnd={(event) => {
      if (event.target !== event.currentTarget || event.propertyName !== 'width') return
      if (open) setSettled(true)
      else setMounted(false)
    }}>
    <aside className="bot-side" style={fullScreen ? undefined : { width }} aria-label={`${bot.name}'s side panel`} data-view={view ?? 'picker'}>
      <div className="panel-sidebar-resize-handle bot-side-resize" role="separator" aria-orientation="vertical" aria-label="Resize side panel" tabIndex={0}
        onPointerDown={startResize} onKeyDown={resizeKey} />
      <div className="header bot-side-header">
        <nav className="main-view-tabs bot-side-tabs" aria-label={`${bot.name}'s side panel view`}>
          {strip.map((tab) => {
            const entry = VIEWS.find((item) => item.view === tab.view)
            const label = entry?.label ?? 'New tab'
            const Icon = entry?.icon ?? Plus
            const selected = tab.id === state.active
            return <div key={tab.id} className={`main-view-tab${selected ? ' active' : ''}`}
              onMouseDown={(event) => { if (event.button === 1) event.preventDefault() }}
              onAuxClick={(event) => { if (event.button === 1) state.closeTab(tab.id) }}>
              <button type="button" className="main-view-tab-select" aria-current={selected ? 'page' : undefined} title={label} onClick={() => state.select(tab.id)}>
                <Icon size={14} strokeWidth={2} className="main-view-tab-icon" />
                <span className="main-view-tab-label">{label}</span>
              </button>
              <button type="button" className="main-view-tab-close" aria-label={`Close ${label}`} onClick={() => state.closeTab(tab.id)}><X size={12} strokeWidth={2} /></button>
            </div>
          })}
          {strip.length > 0 && <div className="main-view-tab-add-wrap">
            <button type="button" className="main-view-tab-add" aria-label="New tab" title="New tab" onClick={state.addPicker}><Plus size={14} strokeWidth={2} /></button>
          </div>}
        </nav>
        <button type="button" className="main-view-tab-add bot-side-close" aria-label="Close side panel" title="Close" onClick={state.close}><X size={14} strokeWidth={2} /></button>
      </div>
      <div key={state.active} className={`bot-side-view${from.current ? ` from-${from.current}` : ''}`}>{body}</div>
    </aside>
  </div>
}
