import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode, type RefObject } from 'react'
import type { StoreApi, UseBoundStore } from 'zustand'
import { ArrowLeft, ArrowRight, ArrowShrink, Bot, Maximize, Minus, MoreVertical, Plus, RefreshCw, User, X } from '../../lib/icons'
import { WATCHED_BROWSER_PANE, watchedBrowserPageSize, type WatchedBrowserDialog, type WatchedBrowserInput, type WatchedBrowserPageSize, type WatchedBrowserView } from '../../../shared/browser/watched'
import { browserProblemForPerson } from '../../../shared/browser/navigation'
import { BROWSER_WINDOW_LINE } from '../../../shared/browser/window'
import { BROWSER_MODIFIERS, MAX_BROWSER_PASTE_CHARS } from '../../../shared/browser/types'
import { FloatingPortal, FLOATING_LAYER_Z_INDEX, useFloatingPosition } from '../../lib/floatingLayer'
import { viewerPlatform } from '../../stores/browserInputChannel'
import type { WatchedBrowserNeed, WatchedBrowserState, WatchedBrowserStream } from '../../stores/watchedBrowserStore'
import type { ChannelHealth } from '../../stores/browserInputChannel'
import { useAppStore } from '../../stores/appStore'
import { localDeviceName } from '../sideCard/deviceMenu'
import { WatchedBrowserFrame } from './WatchedBrowserFrame'
import { useBrowserInput } from './useBrowserInput'
import { pageAtZoom, useWatchedBrowserZoom, WATCHED_BROWSER_ZOOM } from './watchedBrowserZoom'
import './watchedBrowser.css'

/**
 * A browser without a window, large, where the person watches it and can take it over: a bot's split
 * view beside its chat, or a thread agent's in that thread's Browser panel. It shows the tab its user
 * follows, as pictures the service pushes while it is on screen, with the agent cursor over them. Its bar is
 * the thread browser's: Back, Forward, Reload, the address, who has it (the agent's or the person's icon), and its
 * menu (zoom). Who has it is also the switch: from the agent's, it takes the browser over for this window (the
 * agent's actions wait), and everything the person does then reaches the page in order, each input answered; from
 * the person's, it gives it back. As in the thread browser, using it takes it over too: a click on the page, Back,
 * Forward, Reload or an address. Another window that holds it is named, and can be taken over from here.
 */

/** How long, in a few characters: "8 s", "3 min", "2 h". */
export function sinceText(since: number, now: number): string {
  const seconds = Math.max(0, Math.round((now - since) / 1000))
  if (seconds < 60) return `${seconds} s`
  if (seconds < 3600) return `${Math.floor(seconds / 60)} min`
  return `${Math.floor(seconds / 3600)} h`
}

/** The time now, moving each second while `ticking`. */
export function useNow(ticking: boolean): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!ticking) return
    setNow(Date.now())
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [ticking])
  return now
}

export interface WatchedBrowserStatus {
  text: string
  /** The longer story, for the tooltip. */
  detail?: string
  /** Pictures can arrive now. */
  live: boolean
  /** Something the person may want to look at (no new pictures, a page that failed or needs them). */
  attention?: boolean
}

/** A page's problem in a word or two, for the status. */
const PROBLEM_WORD = { unreachable: 'Can\'t reach site', blocked: 'Refused', 'needs-you': 'Needs you', 'browser-refused': 'Won\'t open', 'cannot-start': 'Can\'t start' } as const

/** What a view says of the browser in a word or two: "Live" only while pictures can arrive. `user` names who uses it. */
export function watchedBrowserStatus(view: WatchedBrowserView & { setup?: unknown }, stream: WatchedBrowserStream | undefined, user: string, now: number): WatchedBrowserStatus {
  if (view.setup) return { text: 'Setting up', live: false }
  if (!view.open) return view.stopped ? { text: 'Stopped', detail: 'The browser stopped. It starts again when it is next used.', live: false } : { text: 'Closed', live: false }
  if (view.windowed) return { text: 'In a window', live: false }
  if (stream && !stream.live) {
    const since = sinceText(stream.since, now)
    return { text: `Not updating · ${since}`, detail: `No new picture for ${since}. Mousse keeps trying.`, live: false, attention: true }
  }
  if (view.problem) {
    const said = browserProblemForPerson(view.problem)
    return { text: PROBLEM_WORD[view.problem.kind], detail: `${said.line}. ${said.detail}`, live: Boolean(stream?.live), attention: true }
  }
  // The tab the person holds is the one in front (Take over and their input bring it there): never "on another tab".
  if (view.behind && view.control !== 'owner') return { text: 'On another tab', detail: `${user} is using another of its tabs. This picture updates when it's back on this one.`, live: false }
  if (view.loading) return { text: 'Loading', detail: 'The page is still loading.', live: Boolean(stream?.live) }
  if (view.control === 'owner' && view.holder === 'another-view') return { text: 'In another window', detail: 'You took it over in another window.', live: Boolean(stream?.live) }
  if (view.control === 'owner') return { text: 'You have it', live: Boolean(stream?.live) }
  return stream?.live ? { text: 'Live', live: true } : { text: '', live: false }
}

/** The picture's width while the view's size is not known. */
const UNMEASURED_WIDTH = 960

/** How long the view's size must stay put (a drag of its edge, the app window resized) before the page takes it. */
export const PAGE_SIZE_SETTLE_MS = 250

/**
 * The view's own size, which the page is laid out at while it shows the browser: the stage's content
 * box in CSS pixels and the screen's pixel ratio, once it has stayed put for `PAGE_SIZE_SETTLE_MS`
 * (the first size at once). Undefined until it is measured; null where it cannot be (no size yet, no
 * way to measure it).
 */
export function useStagePageSize(element: RefObject<HTMLElement | null>): WatchedBrowserPageSize | null | undefined {
  const [page, setPage] = useState<WatchedBrowserPageSize | null | undefined>(undefined)
  useEffect(() => {
    const target = element.current
    if (!target || typeof ResizeObserver === 'undefined') {
      setPage(null)
      return
    }
    let timer: ReturnType<typeof setTimeout> | undefined
    let first = true
    const measure = () => {
      const style = getComputedStyle(target)
      const width = Math.floor(target.clientWidth - (parseFloat(style.paddingLeft) || 0) - (parseFloat(style.paddingRight) || 0))
      const height = Math.floor(target.clientHeight - (parseFloat(style.paddingTop) || 0) - (parseFloat(style.paddingBottom) || 0))
      if (width <= 0 || height <= 0) {
        setPage((known) => known ?? null)
        return
      }
      const next = watchedBrowserPageSize({ width, height, scale: window.devicePixelRatio || 1 })
      const apply = () => setPage((known) => known && known.width === next.width && known.height === next.height && known.scale === next.scale ? known : next)
      if (timer) clearTimeout(timer)
      timer = undefined
      if (first) {
        first = false
        apply()
      } else timer = setTimeout(apply, PAGE_SIZE_SETTLE_MS)
    }
    const observer = new ResizeObserver(measure)
    observer.observe(target)
    // The pixel ratio changes when the window moves to another screen, or the app is zoomed.
    window.addEventListener('resize', measure)
    measure()
    return () => {
      observer.disconnect()
      window.removeEventListener('resize', measure)
      if (timer) clearTimeout(timer)
    }
  }, [element])
  return page
}

/** Tells the app the page has the keyboard (its zoom keys are the page's), or no longer. An app without the call keeps its own. */
function pageKeyboard(on: boolean): void {
  try {
    void window.mousse?.zoom?.pageKeyboard(on)?.catch(() => undefined)
  } catch {
    // An older app's bridge: the app keeps its zoom keys.
  }
}

/** How long a refusal of the person's input stays said. */
const NOTE_MS = 4_000

/** What the view says of the person's input: nothing while it arrives, else one short line (and Retry). */
function inputLine(health: ChannelHealth | undefined, note: { text: string; at: number; detail?: string } | undefined, computer: string, now: number): { text: string; detail?: string; retry?: boolean } | undefined {
  if (health === 'unreachable') return { text: `Not reaching ${computer}`, detail: `What you did has not reached ${computer} yet. Mousse keeps trying; Retry sends it again now. Nothing is done twice.`, retry: true }
  if (health === 'sending') return { text: 'Sending…' }
  if (note && now - note.at < NOTE_MS) return { text: note.text, ...(note.detail ? { detail: note.detail } : {}) }
  return undefined
}

/** The page's dialog, answered here: the page waits for it and takes nothing else until then. */
function PageDialog({ dialog, canAnswer, answer }: { dialog: WatchedBrowserDialog; canAnswer: boolean; answer(accept: boolean, text?: string): void }) {
  const [text, setText] = useState(dialog.defaultPrompt ?? '')
  const leaving = dialog.type === 'beforeunload'
  return <div className="watched-browser-dialog" role="alertdialog" aria-label="The page asks">
    <div className="watched-browser-dialog-card">
      <p className="watched-browser-dialog-message">{leaving ? 'Leave this page? Changes you made may not be saved.' : dialog.message || 'The page asks you to continue.'}</p>
      {dialog.type === 'prompt' && <input aria-label="Your answer" value={text} maxLength={4096} disabled={!canAnswer} onChange={(event) => setText(event.target.value)}
        onKeyDown={(event) => { if (event.key === 'Enter') answer(true, text) }} />}
      {canAnswer
        ? <div className="watched-browser-dialog-actions">
          {dialog.type !== 'alert' && <button type="button" onClick={() => answer(false)}>{leaving ? 'Stay' : 'Cancel'}</button>}
          <button type="button" className="is-primary" onClick={() => answer(true, dialog.type === 'prompt' ? text : undefined)}>{leaving ? 'Leave' : 'OK'}</button>
        </div>
        : <p className="watched-browser-dialog-hint">Take over to answer it.</p>}
    </div>
  </div>
}

/** What the file request says: "example.com asks for a file", or "for files" when it takes several. */
export function filesAskText(chooser: { multiple: boolean; site?: string }): string {
  return `${chooser.site ?? 'The page'} asks for ${chooser.multiple ? 'files' : 'a file'}`
}

/**
 * The page asks for files: the card names the site and whether it takes one or several, and Choose…
 * opens this computer's own file dialog (the app's, not the page's). Only what the person chooses
 * there goes to the page; nothing goes until they do.
 */
function FileRequest({ chooser, choose, cancel }: { chooser: { multiple: boolean; site?: string }; choose(): void; cancel(): void }) {
  const asks = filesAskText(chooser)
  return <div className="watched-browser-dialog" role="dialog" aria-label={asks}>
    <div className="watched-browser-dialog-card">
      <p className="watched-browser-dialog-message">{asks}.</p>
      <p className="watched-browser-dialog-hint">Only what you choose goes to the page.</p>
      <div className="watched-browser-dialog-actions">
        <button type="button" onClick={cancel}>Cancel</button>
        <button type="button" className="is-primary" onClick={choose}>Choose…</button>
      </div>
    </div>
  </div>
}

/** The view store's hooks for one kind of browser (a bot's, a thread's). */
export interface WatchedBrowserKit<V extends WatchedBrowserView> {
  useStore: UseBoundStore<StoreApi<WatchedBrowserState<V>>>
  useWatch(key: string, element: RefObject<Element | null>, need: WatchedBrowserNeed | undefined): void
  useStream(key: string): WatchedBrowserStream | undefined
}

/**
 * Who has the browser, as this window sees it: what the line under the picture says when nothing else is.
 * `window`: this window holds it, and it is open in a real window of its own.
 */
export type WatchedBrowserHolding = 'this-window' | 'window' | 'another-window' | 'agent' | 'closed'

/** Full screen: the view over the whole centre pane (`on`), or back where it was. */
export interface WatchedBrowserFullScreen {
  on: boolean
  toggle(): void
}

/**
 * The view's menu, in the thread browser's look: under its More button (`bar`), or at the pointer for a right click on
 * the page. A press anywhere else, or Escape, closes it.
 */
function BrowserMenu({ at, anchor, onClose, children }: { at: { x: number; y: number } | 'bar'; anchor: RefObject<HTMLButtonElement | null>; onClose(refocus: boolean): void; children: ReactNode }) {
  const panel = useRef<HTMLDivElement>(null)
  const below = useFloatingPosition({ open: at === 'bar', anchorRef: anchor, contentRef: panel, placement: 'below-end', gap: 5 })
  useEffect(() => {
    const away = (event: PointerEvent) => {
      const target = event.target as Node
      if (panel.current?.contains(target) || (at === 'bar' && anchor.current?.contains(target))) return
      onClose(false)
    }
    const keys = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      event.stopPropagation()
      onClose(at !== 'bar')
    }
    document.addEventListener('pointerdown', away, true)
    document.addEventListener('keydown', keys, true)
    return () => { document.removeEventListener('pointerdown', away, true); document.removeEventListener('keydown', keys, true) }
  }, [at, anchor, onClose])
  // At the pointer, kept inside the window: the menu is 230 wide and about 200 tall.
  const style = at === 'bar' ? below : {
    position: 'fixed' as const, zIndex: FLOATING_LAYER_Z_INDEX,
    left: Math.max(8, Math.min(at.x + 2, window.innerWidth - 238)), top: Math.max(8, Math.min(at.y + 2, window.innerHeight - 208))
  }
  return <FloatingPortal>
    <div ref={panel} className="browser-menu browser-menu-floating watched-browser-menu" role="menu" aria-label={at === 'bar' ? 'Browser menu' : 'Page menu'} style={style}>
      {children}
    </div>
  </FloatingPortal>
}

/**
 * Who has the browser, beside the address (`BrowserAgentStatus`'s look): the agent's icon, or the person's once
 * this window holds it. Pressed, it takes the browser over, or gives it back.
 */
function ControlToggle({ user, held, elsewhere, busy, take, giveBack }: { user: string; held: boolean; elsewhere: boolean; busy: boolean; take(): void; giveBack(): void }) {
  const owner = held ? 'human' : 'agent'
  const Icon = held ? User : Bot
  const title = held ? 'You have it. Give it back' : elsewhere ? 'Held in another window. Take it over here' : `${user} has it. Take it over`
  return <button type="button" className={`browser-toolbar-btn browser-access browser-access-${owner} watched-browser-control`} data-state={owner}
    aria-label={held ? 'Give back' : 'Take over'} aria-pressed={held} title={title} disabled={busy} onClick={held ? giveBack : take}>
    <Icon size={14} className="browser-access-icon" aria-hidden="true" />
  </button>
}

export function WatchedBrowserPane<V extends WatchedBrowserView & { setup?: { percent?: number } }>({ kit, browserKey, label, user, view: given, line, lineDetail, closed, open, fullScreen, className }: {
  kit: WatchedBrowserKit<V>
  /** The browser's key in its store (a bot's id, a thread's id). */
  browserKey: string
  /** The browser's name ("Noobesh's browser"). */
  label: string
  /** Who uses it ("Noobesh", "The agent"). */
  user: string
  view: V
  /** The line under the picture when nothing else is to be said (none when empty). */
  line(holding: WatchedBrowserHolding): string
  /** Its tooltip. */
  lineDetail?(holding: WatchedBrowserHolding): string | undefined
  /** What the stage shows while the browser is closed, given the address the person typed. */
  closed(typed: string): ReactNode
  /** Opens a closed browser at an address (a bot's); without it the address waits for an open browser. */
  open?(url: string | undefined): void
  /** Full screen over the whole centre pane, and back (a bot's browser). */
  fullScreen?: WatchedBrowserFullScreen
  className?: string
}) {
  // The picture and cursor as they are now: whoever passed `view` may keep it still between pictures.
  const view = (kit.useStore((state) => state.views[browserKey]) as V | undefined) ?? given
  const busy = kit.useStore((state) => state.busy)
  const error = kit.useStore((state) => state.error)
  const errorDetail = kit.useStore((state) => state.errorDetail)
  const hold = kit.useStore((state) => state.holds[browserKey])
  const health = kit.useStore((state) => state.inputHealth[browserKey])
  const note = kit.useStore((state) => state.inputNote[browserKey])
  const store = kit.useStore.getState
  // This window holds it: its input goes to the page. Another window may hold it instead.
  const owner = view.open && view.control === 'owner' && Boolean(hold) && view.holder !== 'another-view'
  const elsewhere = view.open && view.control === 'owner' && !owner
  // In a real window of its own: the person uses it there, and nothing is pictured or sent from here.
  const windowed = view.open && Boolean(view.windowed)
  const drives = owner && !windowed
  const url = view.tab?.url ?? ''
  const [address, setAddress] = useState(url)
  const editing = useRef(false)
  const frame = useRef<HTMLDivElement>(null)
  const stage = useRef<HTMLDivElement>(null)
  const keys = useRef<HTMLTextAreaElement>(null)
  const [zoom, changeZoom] = useWatchedBrowserZoom()
  const [menuAt, setMenuAt] = useState<{ x: number; y: number } | 'bar' | null>(null)
  const menuButton = useRef<HTMLButtonElement>(null)
  useEffect(() => { if (!editing.current) setAddress(url) }, [url])
  // Taken over here: the page has the keyboard at once, so typing, copy and paste work without a click first.
  useEffect(() => { if (drives) keys.current?.focus({ preventScroll: true }) }, [drives])
  // Watched while on screen, faster while the person holds the browser. The page is laid out at the
  // view's own size, so its picture fills it; the picture is that size at the screen's pixel ratio.
  // Watched once it is measured; where it cannot be, the page keeps its size and the picture is 960 px wide.
  // At the view's zoom: the page is laid out larger (zoomed out) or smaller, and the picture stays the stage's size.
  const measured = useStagePageSize(stage)
  const page = measured ? pageAtZoom(measured, zoom) : measured
  const width = measured ? Math.min(WATCHED_BROWSER_PANE.maxWidth, Math.round(measured.width * measured.scale)) : UNMEASURED_WIDTH
  const fps = owner ? WATCHED_BROWSER_PANE.heldFps : WATCHED_BROWSER_PANE.fps
  kit.useWatch(browserKey, stage, view.open && !windowed && page !== undefined ? { width, fps, ...(page ? { page } : {}) } : undefined)
  const stream = kit.useStream(browserKey)
  const fresh = Boolean(note && Date.now() - note.at < NOTE_MS)
  const now = useNow(Boolean(view.open && stream && !stream.live) || fresh)
  const status = watchedBrowserStatus(view, stream, user, now)
  const quiet = view.open && !status.live && Boolean(status.detail)
  const input = useBrowserInput({
    owner: drives, view, frame, keys,
    send: (entry, picture) => store().send(browserKey, entry, picture),
    note: (text) => say(text),
    zoom: changeZoom,
    menu: (at) => setMenuAt(at)
  })
  function say(text: string) {
    kit.useStore.setState((state) => ({ inputNote: { ...state.inputNote, [browserKey]: { text, at: Date.now() } } }))
  }
  // The browser runs on this computer: it is named as the app names this computer everywhere.
  const computer = useAppStore((state) => localDeviceName(state.appInfo?.deviceName))
  const said = drives ? inputLine(health, note, computer, now) : undefined
  const send = (entry: WatchedBrowserInput) => { input.send(entry) }
  // The agent has it (not another window): using the page takes it over first, as in the thread browser.
  const takes = view.open && !windowed && !owner && !elsewhere
  const usable = drives || takes
  /** Takes the browser over when this window does not hold it yet; then `then`, once it does. */
  const using = async (then: () => void) => {
    if (!drives) {
      if (!takes) return
      await store().takeOver(browserKey)
      if (!store().holds[browserKey]) return
    }
    then()
  }
  const act = (entry: WatchedBrowserInput) => void using(() => send(entry))
  /**
   * A press on the page while the agent has it: taken over, and the press lands where it was made. Still held once the
   * browser is this window's, it stays down (a drag selects text); let go of before, it is a click; cancelled before
   * (the system took the pointer), nothing reaches the page.
   */
  const takeOnPress = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (busy || event.button !== 0 || event.pointerType === 'touch' || (event.target instanceof Element && event.target.closest('.watched-browser-dialog, .watched-browser-closed'))) return
    event.preventDefault()
    frame.current?.setPointerCapture?.(event.pointerId)
    const press = { clientX: event.clientX, clientY: event.clientY, button: event.button, altKey: event.altKey, ctrlKey: event.ctrlKey, metaKey: event.metaKey, shiftKey: event.shiftKey }
    // Read now, on the picture the person saw: a newer picture that arrives before the browser is theirs places nothing.
    const pinned = input.pin(press)
    if (!pinned) return
    const pointer = event.pointerId
    let ended: 'up' | 'cancelled' | undefined
    const release = (next: PointerEvent) => { if (next.pointerId === pointer) ended ??= 'up' }
    const cancel = (next: PointerEvent) => { if (next.pointerId === pointer) ended ??= 'cancelled' }
    window.addEventListener('pointerup', release, true)
    window.addEventListener('pointercancel', cancel, true)
    void using(() => {
      if (ended === 'cancelled') return
      if (ended === 'up') input.clickAt(press, 'left', pinned)
      else input.pressAt(press, pinned)
    }).finally(() => {
      window.removeEventListener('pointerup', release, true)
      window.removeEventListener('pointercancel', cancel, true)
    })
  }
  const holding: WatchedBrowserHolding = owner ? (windowed ? 'window' : 'this-window') : elsewhere ? 'another-window' : view.open ? 'agent' : 'closed'

  // The line under the picture: an error, the page's problem, a quiet status, else the view's own line, if any.
  const problem = view.open && view.problem ? browserProblemForPerson(view.problem) : undefined
  const noteText = error ? error : problem ? problem.line : quiet ? status.text : line(holding)
  const noteTitle = error ? errorDetail ?? undefined : problem ? problem.detail : quiet ? status.detail : lineDetail?.(holding) ?? noteText

  const go = () => {
    editing.current = false
    const text = address.trim()
    if (!text) return
    const target = /^https?:\/\//i.test(text) ? text : `https://${text}`
    if (usable) act({ kind: 'navigate', url: target })
    else if (!view.open) open?.(target)
  }

  // The page's edit menu: what a right click opens, as a browser's own menu would.
  const mac = viewerPlatform() === 'mac'
  const primary = mac ? BROWSER_MODIFIERS.meta : BROWSER_MODIFIERS.ctrl
  const shortcut = (letter: string) => `${mac ? '⌘' : 'Ctrl+'}${letter}`
  const closeMenu = useCallback((refocus: boolean) => {
    setMenuAt(null)
    if (refocus) keys.current?.focus({ preventScroll: true })
  }, [])
  const paste = async () => {
    let text = ''
    try {
      text = await navigator.clipboard.readText()
    } catch {
      say(`Press ${shortcut('V')} to paste`)
      return
    }
    if (!text) return
    if (text.length > MAX_BROWSER_PASTE_CHARS) say(`Too long to paste (over ${MAX_BROWSER_PASTE_CHARS.toLocaleString()} characters)`)
    else send({ kind: 'paste', text })
  }
  const selectAll = () => {
    send({ kind: 'keys', type: 'down', key: 'a', code: 'KeyA', keyCode: 65, modifiers: primary })
    send({ kind: 'keys', type: 'up', key: 'a', code: 'KeyA', keyCode: 65, modifiers: primary })
  }

  return <aside className={`watched-browser-pane${className ? ` ${className}` : ''}`} aria-label={label}>
    <header className="browser-toolbar watched-browser-bar">
      <button type="button" className="browser-toolbar-btn" aria-label="Back" title="Back" disabled={!usable || busy} onClick={() => act({ kind: 'back' })}><ArrowLeft size={16} /></button>
      <button type="button" className="browser-toolbar-btn" aria-label="Forward" title="Forward" disabled={!usable || busy} onClick={() => act({ kind: 'forward' })}><ArrowRight size={16} /></button>
      <button type="button" className="browser-toolbar-btn" aria-label="Reload" title="Reload" disabled={!usable || busy} onClick={() => act({ kind: 'reload' })}><RefreshCw size={16} className={view.open && view.loading ? 'spin' : undefined} /></button>
      <form className={`browser-url-form watched-browser-address${view.open && view.loading ? ' is-loading' : ''}`} onSubmit={(event) => { event.preventDefault(); go() }}
        aria-busy={view.open && view.loading ? true : undefined}>
        <input className="browser-url-input" aria-label={`${label} address`} value={address} readOnly={view.open ? !usable : !open} placeholder="Search or enter URL"
          onFocus={() => { editing.current = true }} onBlur={() => { editing.current = false }} onChange={(event) => setAddress(event.target.value)} spellCheck={false} />
      </form>
      {/* Give back also closes a window an older app opened it in. */}
      {view.open && <ControlToggle user={user} held={owner} elsewhere={elsewhere} busy={busy}
        take={() => void store().takeOver(browserKey, elsewhere)} giveBack={() => void store().giveBack(browserKey)} />}
      <button ref={menuButton} type="button" className={`browser-toolbar-btn${menuAt === 'bar' ? ' active' : ''}`} aria-label="Browser menu" title="More"
        aria-haspopup="menu" aria-expanded={menuAt === 'bar'} onClick={() => setMenuAt(menuAt === 'bar' ? null : 'bar')}><MoreVertical size={16} /></button>
      {fullScreen && <button type="button" className="browser-toolbar-btn" aria-label={fullScreen.on ? 'Exit full screen' : 'Full screen'} title={fullScreen.on ? 'Exit full screen' : 'Full screen'}
        aria-pressed={fullScreen.on} onClick={fullScreen.toggle}>{fullScreen.on ? <ArrowShrink size={16} /> : <Maximize size={16} />}</button>}
      <button type="button" className="browser-toolbar-btn" aria-label="Close the browser view" title="Close" onClick={() => store().closePane()}><X size={16} /></button>
    </header>
    <div className="watched-browser-stage" ref={stage}>
      <WatchedBrowserFrame label={label} view={view} frameRef={frame} className={drives ? 'is-held' : takes ? 'is-takeable' : undefined}
        title={takes && !busy ? 'Click to take over' : undefined} {...(windowed ? {} : drives ? input.frameHandlers : takes ? { onPointerDown: takeOnPress } : {})}>
        {input.marks.map((mark) => <span key={mark.seq} className={`watched-browser-mark is-${mark.state}`} style={{ left: `${mark.left}%`, top: `${mark.top}%` }} aria-hidden />)}
        {drives && <textarea ref={keys} className="watched-browser-keys" aria-label={`Type into ${label}`} autoComplete="off" autoCorrect="off" autoCapitalize="off" spellCheck={false}
          {...input.keyHandlers}
          // While the page has the keyboard, the zoom keys are its (this view's zoom), not the app's.
          onFocus={() => pageKeyboard(true)}
          onBlur={() => { pageKeyboard(false); input.keyHandlers.onBlur() }} />}
        {view.open && !windowed && view.dialog && <PageDialog key={`${view.dialog.type}:${view.dialog.message}`} dialog={view.dialog} canAnswer={owner}
          answer={(accept, text) => send({ kind: 'dialog', accept, ...(text !== undefined ? { text } : {}) })} />}
        {drives && !view.dialog && view.chooser && <FileRequest chooser={view.chooser}
          choose={() => void store().chooseFiles(browserKey, view.chooser!)} cancel={() => send({ kind: 'files' })} />}
        {!view.open && !view.setup && <div className="watched-browser-closed">{closed(address.trim())}</div>}
        {windowed && <div className="watched-browser-closed"><p>{BROWSER_WINDOW_LINE}</p></div>}
      </WatchedBrowserFrame>
    </div>
    {said
      ? <p className="watched-browser-note is-input" role="status" title={said.detail ?? said.text}>
        <span>{said.text}</span>
        {said.retry && <button type="button" className="watched-browser-retry" onClick={() => store().retry(browserKey)}>Retry</button>}
      </p>
      : noteText && <p className={`watched-browser-note${quiet ? ' is-quiet' : ''}`} role="status" title={noteTitle}>{noteText}</p>}
    {menuAt && <BrowserMenu at={menuAt} anchor={menuButton} onClose={closeMenu}>
      {menuAt !== 'bar' && <>
        <button type="button" role="menuitem" disabled={!drives} onClick={() => { closeMenu(true); send({ kind: 'copy', cut: true }) }}><span>Cut</span><kbd>{shortcut('X')}</kbd></button>
        <button type="button" role="menuitem" disabled={!drives} onClick={() => { closeMenu(true); send({ kind: 'copy' }) }}><span>Copy</span><kbd>{shortcut('C')}</kbd></button>
        <button type="button" role="menuitem" disabled={!drives} onClick={() => { closeMenu(true); void paste() }}><span>Paste</span><kbd>{shortcut('V')}</kbd></button>
        <button type="button" role="menuitem" disabled={!drives} onClick={() => { closeMenu(true); selectAll() }}><span>Select all</span><kbd>{shortcut('A')}</kbd></button>
        <div className="browser-menu-separator" />
      </>}
      <div className="browser-menu-zoom" role="group" aria-label="Zoom">
        <span>Zoom</span>
        <button type="button" aria-label="Zoom out" title="Zoom out" disabled={zoom <= WATCHED_BROWSER_ZOOM.min} onClick={() => changeZoom('out')}><Minus size={14} aria-hidden="true" /></button>
        <button type="button" className="watched-browser-zoom-value" aria-label="Reset zoom" title="Reset zoom" onClick={() => changeZoom('reset')}>{Math.round(zoom * 100)}%</button>
        <button type="button" aria-label="Zoom in" title="Zoom in" disabled={zoom >= WATCHED_BROWSER_ZOOM.max} onClick={() => changeZoom('in')}><Plus size={14} aria-hidden="true" /></button>
      </div>
    </BrowserMenu>}
  </aside>
}
