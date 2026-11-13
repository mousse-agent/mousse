import { useEffect, useRef, useState, type ReactNode, type RefObject } from 'react'
import type { StoreApi, UseBoundStore } from 'zustand'
import { ArrowLeft, ArrowRight, Globe, RefreshCw, X } from '../../lib/icons'
import { WATCHED_BROWSER_PANE, type WatchedBrowserDialog, type WatchedBrowserInput, type WatchedBrowserView } from '../../../shared/browser/watched'
import { browserProblemForPerson } from '../../../shared/browser/navigation'
import { BROWSER_WINDOW_LINE, BROWSER_WINDOW_TOOLTIP } from '../../../shared/browser/window'
import type { WatchedBrowserNeed, WatchedBrowserState, WatchedBrowserStream } from '../../stores/watchedBrowserStore'
import type { ChannelHealth } from '../../stores/browserInputChannel'
import { useAppStore } from '../../stores/appStore'
import { localDeviceName } from '../sideCard/deviceMenu'
import { WatchedBrowserFrame } from './WatchedBrowserFrame'
import { useBrowserInput } from './useBrowserInput'
import './watchedBrowser.css'

/**
 * A browser without a window, large, where the person watches it and can take it over: a bot's split
 * view beside its chat, or a thread agent's in that thread's Browser panel. It shows the tab its user
 * follows, as pictures the service pushes while it is on screen, with the agent cursor over them. Take
 * over hands the browser to this window (the agent's actions wait), and everything the person does then
 * reaches the page in order, each input answered; Give back returns it. Another window that holds it is
 * named, and can be taken over from here.
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

/** The split view's width, in steps, so a drag of its edge does not ask for a new size at every pixel. */
function useStageWidth(element: RefObject<HTMLElement | null>): number {
  const [width, setWidth] = useState<number>(WATCHED_BROWSER_PANE.maxWidth)
  useEffect(() => {
    const target = element.current
    if (!target || typeof ResizeObserver === 'undefined') return
    const measure = () => {
      const inner = target.clientWidth
      if (inner > 0) setWidth(Math.min(WATCHED_BROWSER_PANE.maxWidth, Math.max(320, Math.ceil(inner / 80) * 80)))
    }
    const observer = new ResizeObserver(measure)
    observer.observe(target)
    measure()
    return () => observer.disconnect()
  }, [element])
  return width
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

/** Open in a window and Close window (a bot's browser on this computer): `offered` when this view may open one. */
export interface WatchedBrowserWindowControl {
  offered: boolean
  open(): void
  close(): void
}

export function WatchedBrowserPane<V extends WatchedBrowserView & { setup?: { percent?: number } }>({ kit, browserKey, label, user, view, line, lineDetail, closed, open, inWindow, className }: {
  kit: WatchedBrowserKit<V>
  /** The browser's key in its store (a bot's id, a thread's id). */
  browserKey: string
  /** The browser's name ("Noobesh's browser"). */
  label: string
  /** Who uses it ("Noobesh", "The agent"). */
  user: string
  view: V
  /** The line under the picture when nothing else is to be said. */
  line(holding: WatchedBrowserHolding): string
  /** Its tooltip. */
  lineDetail?(holding: WatchedBrowserHolding): string | undefined
  /** What the stage shows while the browser is closed, given the address the person typed. */
  closed(typed: string): ReactNode
  /** Opens a closed browser at an address (a bot's); without it the address waits for an open browser. */
  open?(url: string | undefined): void
  /** Open in a window and Close window (a bot's browser on this computer). */
  inWindow?: WatchedBrowserWindowControl
  className?: string
}) {
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
  useEffect(() => { if (!editing.current) setAddress(url) }, [url])
  // Watched while on screen: the panel's width up to 960 px, faster while the person holds the browser.
  const width = useStageWidth(stage)
  kit.useWatch(browserKey, stage, view.open && !windowed ? { width, fps: owner ? WATCHED_BROWSER_PANE.heldFps : WATCHED_BROWSER_PANE.fps } : undefined)
  const stream = kit.useStream(browserKey)
  const fresh = Boolean(note && Date.now() - note.at < NOTE_MS)
  const now = useNow(Boolean(view.open && stream && !stream.live) || fresh)
  const status = watchedBrowserStatus(view, stream, user, now)
  const quiet = view.open && !status.live && Boolean(status.detail)
  const input = useBrowserInput({
    owner: drives, view, frame, keys,
    send: (entry, picture) => store().send(browserKey, entry, picture),
    note: (text) => kit.useStore.setState((state) => ({ inputNote: { ...state.inputNote, [browserKey]: { text, at: Date.now() } } }))
  })
  // The browser runs on this computer: it is named as the app names this computer everywhere.
  const computer = useAppStore((state) => localDeviceName(state.appInfo?.deviceName))
  const said = drives ? inputLine(health, note, computer, now) : undefined
  const send = (entry: WatchedBrowserInput) => { input.send(entry) }
  const holding: WatchedBrowserHolding = owner ? (windowed ? 'window' : 'this-window') : elsewhere ? 'another-window' : view.open ? 'agent' : 'closed'

  const go = () => {
    editing.current = false
    const text = address.trim()
    if (!text) return
    const target = /^https?:\/\//i.test(text) ? text : `https://${text}`
    if (drives) send({ kind: 'navigate', url: target })
    else if (!view.open) open?.(target)
  }

  return <aside className={`watched-browser-pane${className ? ` ${className}` : ''}`} aria-label={label}>
    <header className="watched-browser-bar">
      <button type="button" aria-label="Back" title="Back" disabled={!drives || busy} onClick={() => send({ kind: 'back' })}><ArrowLeft size={15} /></button>
      <button type="button" aria-label="Forward" title="Forward" disabled={!drives || busy} onClick={() => send({ kind: 'forward' })}><ArrowRight size={15} /></button>
      <button type="button" aria-label="Reload" title="Reload" disabled={!drives || busy} onClick={() => send({ kind: 'reload' })}><RefreshCw size={15} /></button>
      <form className={`watched-browser-address${view.open && view.loading ? ' is-loading' : ''}`} onSubmit={(event) => { event.preventDefault(); go() }}
        aria-busy={view.open && view.loading ? true : undefined}>
        <Globe size={13} aria-hidden />
        <input aria-label={`${label} address`} value={address} readOnly={view.open ? !drives : !open} placeholder="Enter a web address"
          onFocus={() => { editing.current = true }} onBlur={() => { editing.current = false }} onChange={(event) => setAddress(event.target.value)} spellCheck={false} />
      </form>
      {view.open && !windowed && !elsewhere && inWindow?.offered && <button type="button" className="watched-browser-control" disabled={busy} title={BROWSER_WINDOW_TOOLTIP}
        onClick={() => inWindow.open()}>Open in a window</button>}
      {view.open && (windowed && owner
        ? <button type="button" className="watched-browser-control" disabled={busy} title={BROWSER_WINDOW_TOOLTIP} onClick={() => inWindow?.close()}>Close window</button>
        : owner
        ? <button type="button" className="watched-browser-control" disabled={busy} onClick={() => void store().giveBack(browserKey)}>Give back</button>
        : <button type="button" className="watched-browser-control" disabled={busy} title={elsewhere ? 'Held in another window' : undefined} onClick={() => void store().takeOver(browserKey, elsewhere)}>Take over</button>)}
      <button type="button" aria-label="Close the browser view" title="Close" onClick={() => store().closePane()}><X size={15} /></button>
    </header>
    <div className="watched-browser-stage" ref={stage}>
      <WatchedBrowserFrame label={label} view={view} frameRef={frame} className={drives ? 'is-held' : undefined} {...(windowed ? {} : input.frameHandlers)}>
        {input.marks.map((mark) => <span key={mark.seq} className={`watched-browser-mark is-${mark.state}`} style={{ left: `${mark.left}%`, top: `${mark.top}%` }} aria-hidden />)}
        {drives && <textarea ref={keys} className="watched-browser-keys" aria-label={`Type into ${label}`} autoComplete="off" autoCorrect="off" autoCapitalize="off" spellCheck={false}
          {...input.keyHandlers} />}
        {view.open && !windowed && view.dialog && <PageDialog key={`${view.dialog.type}:${view.dialog.message}`} dialog={view.dialog} canAnswer={owner}
          answer={(accept, text) => send({ kind: 'dialog', accept, ...(text !== undefined ? { text } : {}) })} />}
        {drives && !view.dialog && view.chooser && <FileRequest chooser={view.chooser}
          choose={() => void store().chooseFiles(browserKey, view.chooser!)} cancel={() => send({ kind: 'files' })} />}
        {!view.open && !view.setup && <div className="watched-browser-closed">{closed(address.trim())}</div>}
        {windowed && <div className="watched-browser-closed"><p>{BROWSER_WINDOW_LINE}</p></div>}
      </WatchedBrowserFrame>
    </div>
    {said
      ? <p className="watched-browser-note is-input" role="status" title={said.detail}>
        <span>{said.text}</span>
        {said.retry && <button type="button" className="watched-browser-retry" onClick={() => store().retry(browserKey)}>Retry</button>}
      </p>
      : <p className={`watched-browser-note${quiet ? ' is-quiet' : ''}`} role="status" title={error ? errorDetail ?? undefined : view.open && view.problem ? browserProblemForPerson(view.problem).detail : quiet ? status.detail : lineDetail?.(holding)}>{error
        ? error
        : view.open && view.problem ? browserProblemForPerson(view.problem).line
        : quiet ? status.text
        : line(holding)}</p>}
  </aside>
}
