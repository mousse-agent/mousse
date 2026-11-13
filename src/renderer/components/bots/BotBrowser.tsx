import { useEffect, useRef, useState } from 'react'
import { ArrowLeft, ArrowRight, Globe, Maximize, RefreshCw, X } from '../../lib/icons'
import type { BotSummary } from '../../../shared/bots/personal/chat'
import { BOT_BROWSER_PANE_WATCH, BOT_BROWSER_PREVIEW_WATCH, type BotBrowserDialog, type BotBrowserInput, type BotBrowserView } from '../../../shared/bots/personal/browser'
import { browserProblemForPerson } from '../../../shared/browser/navigation'
import { useBotBrowserStore, useBotBrowserStream, useBotBrowserWatch, type BotBrowserStream } from '../../stores/botBrowserStore'
import type { ChannelHealth } from '../../stores/browserInputChannel'
import { useAppStore } from '../../stores/appStore'
import { localDeviceName } from '../sideCard/deviceMenu'
import { WatchedBrowserFrame } from '../browser/WatchedBrowserFrame'
import { useBrowserInput } from '../browser/useBrowserInput'
import './botBrowser.css'

/**
 * A bot's own browser in its chat: a small live preview in the reply of the run that used it, and
 * the split view beside the chat, where the owner watches the bot use it and can take it over (to
 * sign in for it, say). Both show the tab the bot used last, as pictures the daemon pushes while
 * they are on screen, with the agent cursor drawn over them.
 */

/** How long, in a few characters: "8 s", "3 min", "2 h". */
export function sinceText(since: number, now: number): string {
  const seconds = Math.max(0, Math.round((now - since) / 1000))
  if (seconds < 60) return `${seconds} s`
  if (seconds < 3600) return `${Math.floor(seconds / 60)} min`
  return `${Math.floor(seconds / 3600)} h`
}

/** The time now, moving each second while `ticking`. */
function useNow(ticking: boolean): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!ticking) return
    setNow(Date.now())
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [ticking])
  return now
}

interface BrowserStatus {
  text: string
  /** The longer story, for the tooltip. */
  detail?: string
  /** Pictures can arrive now. */
  live: boolean
  /** Something the owner may want to look at (no new pictures, a page that failed or needs them). */
  attention?: boolean
}

/** A page's problem in a word or two, for the preview's status. */
const PROBLEM_WORD = { unreachable: 'Can\'t reach site', blocked: 'Refused', 'needs-you': 'Needs you', 'browser-refused': 'Won\'t open', 'cannot-start': 'Can\'t start' } as const

/** What the view says of the bot's browser: "Live" only while pictures can arrive. */
export function browserStatus(view: BotBrowserView, stream: BotBrowserStream | undefined, botName: string, now: number): BrowserStatus {
  if (view.setup) return { text: 'Setting up', live: false }
  if (!view.open) return view.stopped ? { text: 'Stopped', detail: 'The browser stopped. It starts again when it is next used.', live: false } : { text: 'Closed', live: false }
  if (stream && !stream.live) {
    const since = sinceText(stream.since, now)
    return { text: `Not updating · ${since}`, detail: `No new picture for ${since}. Mousse keeps trying.`, live: false, attention: true }
  }
  if (view.problem) {
    const said = browserProblemForPerson(view.problem)
    return { text: PROBLEM_WORD[view.problem.kind], detail: `${said.line}. ${said.detail}`, live: Boolean(stream?.live), attention: true }
  }
  // The tab the owner holds is the one in front (Take over and their input bring it there): never "on another tab".
  if (view.behind && view.control !== 'owner') return { text: 'On another tab', detail: `${botName} is using another of its tabs. This picture updates when it's back on this one.`, live: false }
  if (view.loading) return { text: 'Loading', detail: 'The page is still loading.', live: Boolean(stream?.live) }
  if (view.control === 'owner' && view.holder === 'another-view') return { text: 'In another window', detail: 'You took it over in another window.', live: Boolean(stream?.live) }
  if (view.control === 'owner') return { text: 'You have it', live: Boolean(stream?.live) }
  return stream?.live ? { text: 'Live', live: true } : { text: '', live: false }
}

function hostOf(url: string | undefined): string {
  if (!url) return ''
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return ''
  }
}

/** The small live preview in a reply; hovering shows Expand, which opens the split view. Watched only while on screen. */
export function BotBrowserPreview({ bot, view }: { bot: BotSummary; view: BotBrowserView }) {
  const host = hostOf(view.tab?.url)
  const figure = useRef<HTMLElement>(null)
  // The split view shows the same tab larger: while it is open, it alone is watched.
  const paneOpen = useBotBrowserStore((state) => state.paneBotId === bot.id)
  useBotBrowserWatch(bot.id, figure, view.open && !paneOpen ? BOT_BROWSER_PREVIEW_WATCH : undefined)
  const stream = useBotBrowserStream(bot.id)
  const now = useNow(Boolean(view.open && stream && !stream.live))
  const status = browserStatus(view, stream, bot.name, now)
  return <figure ref={figure} className={`bot-browser-preview${status.live && !status.attention ? ' is-live' : ''}${view.open && status.attention ? ' is-stale' : ''}`} aria-label={`${bot.name}'s browser`}>
    <WatchedBrowserFrame label={`${bot.name}'s browser`} view={view}>
      <button type="button" className="bot-browser-expand" aria-label={`Expand ${bot.name}'s browser`} title="Expand"
        onClick={() => useBotBrowserStore.getState().openPane(bot.id)}><Maximize size={14} /></button>
    </WatchedBrowserFrame>
    <figcaption>
      <span className="bot-browser-dot" aria-hidden />
      <span className="bot-browser-title">{view.tab?.title || host || 'Browser'}</span>
      {host && <span className="bot-browser-host">{host}</span>}
      <span className="bot-browser-status" title={status.detail}>{status.text}</span>
    </figcaption>
  </figure>
}

/** The split view's width, in steps, so a drag of its edge does not ask for a new size at every pixel. */
function useStageWidth(element: React.RefObject<HTMLElement | null>): number {
  const [width, setWidth] = useState<number>(BOT_BROWSER_PANE_WATCH.maxWidth)
  useEffect(() => {
    const target = element.current
    if (!target || typeof ResizeObserver === 'undefined') return
    const measure = () => {
      const inner = target.clientWidth
      if (inner > 0) setWidth(Math.min(BOT_BROWSER_PANE_WATCH.maxWidth, Math.max(320, Math.ceil(inner / 80) * 80)))
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

/** What the split view says of the person's input: nothing while it arrives, else one short line (and Retry). */
function inputLine(health: ChannelHealth | undefined, note: { text: string; at: number; detail?: string } | undefined, computer: string, now: number): { text: string; detail?: string; retry?: boolean } | undefined {
  if (health === 'unreachable') return { text: `Not reaching ${computer}`, detail: `What you did has not reached ${computer} yet. Mousse keeps trying; Retry sends it again now. Nothing is done twice.`, retry: true }
  if (health === 'sending') return { text: 'Sending…' }
  if (note && now - note.at < NOTE_MS) return { text: note.text, ...(note.detail ? { detail: note.detail } : {}) }
  return undefined
}

/** The page's dialog, answered here: the page waits for it and takes nothing else until then. */
function PageDialog({ dialog, canAnswer, answer }: { dialog: BotBrowserDialog; canAnswer: boolean; answer(accept: boolean, text?: string): void }) {
  const [text, setText] = useState(dialog.defaultPrompt ?? '')
  const leaving = dialog.type === 'beforeunload'
  return <div className="bot-browser-dialog" role="alertdialog" aria-label="The page asks">
    <div className="bot-browser-dialog-card">
      <p className="bot-browser-dialog-message">{leaving ? 'Leave this page? Changes you made may not be saved.' : dialog.message || 'The page asks you to continue.'}</p>
      {dialog.type === 'prompt' && <input aria-label="Your answer" value={text} maxLength={4096} disabled={!canAnswer} onChange={(event) => setText(event.target.value)}
        onKeyDown={(event) => { if (event.key === 'Enter') answer(true, text) }} />}
      {canAnswer
        ? <div className="bot-browser-dialog-actions">
          {dialog.type !== 'alert' && <button type="button" onClick={() => answer(false)}>{leaving ? 'Stay' : 'Cancel'}</button>}
          <button type="button" className="is-primary" onClick={() => answer(true, dialog.type === 'prompt' ? text : undefined)}>{leaving ? 'Leave' : 'OK'}</button>
        </div>
        : <p className="bot-browser-dialog-hint">Take over to answer it.</p>}
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
  return <div className="bot-browser-dialog" role="dialog" aria-label={asks}>
    <div className="bot-browser-dialog-card">
      <p className="bot-browser-dialog-message">{asks}.</p>
      <p className="bot-browser-dialog-hint">Only what you choose goes to the page.</p>
      <div className="bot-browser-dialog-actions">
        <button type="button" onClick={cancel}>Cancel</button>
        <button type="button" className="is-primary" onClick={choose}>Choose…</button>
      </div>
    </div>
  </div>
}

/**
 * The split view: the bot's browser beside its chat. The owner watches; Take over hands the
 * browser to this window (the bot's actions wait), and everything they do then reaches the page in
 * order, each input answered; Give back returns it. Another window that holds it is named, and can
 * be taken over from here. A closed browser can be opened again here, under the owner's control.
 */
export function BotBrowserPane({ bot, view }: { bot: BotSummary; view: BotBrowserView }) {
  const busy = useBotBrowserStore((state) => state.busy)
  const error = useBotBrowserStore((state) => state.error)
  const errorDetail = useBotBrowserStore((state) => state.errorDetail)
  const hold = useBotBrowserStore((state) => state.holds[bot.id])
  const health = useBotBrowserStore((state) => state.inputHealth[bot.id])
  const note = useBotBrowserStore((state) => state.inputNote[bot.id])
  const store = useBotBrowserStore.getState
  // This window holds it: its input goes to the page. Another window may hold it instead.
  const owner = view.open && view.control === 'owner' && Boolean(hold) && view.holder !== 'another-view'
  const elsewhere = view.open && view.control === 'owner' && !owner
  const url = view.tab?.url ?? ''
  const [address, setAddress] = useState(url)
  const editing = useRef(false)
  const frame = useRef<HTMLDivElement>(null)
  const stage = useRef<HTMLDivElement>(null)
  const keys = useRef<HTMLTextAreaElement>(null)
  useEffect(() => { if (!editing.current) setAddress(url) }, [url])
  // Watched while on screen: the panel's width up to 960 px, faster while the owner holds the browser.
  const width = useStageWidth(stage)
  useBotBrowserWatch(bot.id, stage, view.open ? { width, fps: owner ? BOT_BROWSER_PANE_WATCH.heldFps : BOT_BROWSER_PANE_WATCH.fps } : undefined)
  const stream = useBotBrowserStream(bot.id)
  const fresh = Boolean(note && Date.now() - note.at < NOTE_MS)
  const now = useNow(Boolean(view.open && stream && !stream.live) || fresh)
  const status = browserStatus(view, stream, bot.name, now)
  const quiet = view.open && !status.live && Boolean(status.detail)
  const input = useBrowserInput({
    owner, view, frame, keys,
    send: (entry, picture) => store().send(bot.id, entry, picture),
    note: (text) => useBotBrowserStore.setState((state) => ({ inputNote: { ...state.inputNote, [bot.id]: { text, at: Date.now() } } }))
  })
  // The browser runs on this computer: it is named as the app names this computer everywhere.
  const computer = useAppStore((state) => localDeviceName(state.appInfo?.deviceName))
  const said = owner ? inputLine(health, note, computer, now) : undefined
  const send = (entry: BotBrowserInput) => { input.send(entry) }

  const go = () => {
    editing.current = false
    const text = address.trim()
    if (!text) return
    const target = /^https?:\/\//i.test(text) ? text : `https://${text}`
    if (owner) send({ kind: 'navigate', url: target })
    else if (!view.open) void store().open(bot.id, target)
  }

  return <aside className="bot-browser-pane" aria-label={`${bot.name}'s browser`}>
    <header className="bot-browser-bar">
      <button type="button" aria-label="Back" title="Back" disabled={!owner || busy} onClick={() => send({ kind: 'back' })}><ArrowLeft size={15} /></button>
      <button type="button" aria-label="Forward" title="Forward" disabled={!owner || busy} onClick={() => send({ kind: 'forward' })}><ArrowRight size={15} /></button>
      <button type="button" aria-label="Reload" title="Reload" disabled={!owner || busy} onClick={() => send({ kind: 'reload' })}><RefreshCw size={15} /></button>
      <form className={`bot-browser-address${view.open && view.loading ? ' is-loading' : ''}`} onSubmit={(event) => { event.preventDefault(); go() }}
        aria-busy={view.open && view.loading ? true : undefined}>
        <Globe size={13} aria-hidden />
        <input aria-label={`${bot.name}'s browser address`} value={address} readOnly={view.open && !owner} placeholder="Enter a web address"
          onFocus={() => { editing.current = true }} onBlur={() => { editing.current = false }} onChange={(event) => setAddress(event.target.value)} spellCheck={false} />
      </form>
      {view.open && (owner
        ? <button type="button" className="bot-browser-control" disabled={busy} onClick={() => void store().giveBack(bot.id)}>Give back</button>
        : <button type="button" className="bot-browser-control" disabled={busy} title={elsewhere ? 'Held in another window' : undefined} onClick={() => void store().takeOver(bot.id, elsewhere)}>Take over</button>)}
      <button type="button" aria-label="Close the browser view" title="Close" onClick={() => store().closePane()}><X size={15} /></button>
    </header>
    <div className="bot-browser-stage" ref={stage}>
      <WatchedBrowserFrame label={`${bot.name}'s browser`} view={view} frameRef={frame} className={owner ? 'is-held' : undefined} {...input.frameHandlers}>
        {input.marks.map((mark) => <span key={mark.seq} className={`bot-browser-mark is-${mark.state}`} style={{ left: `${mark.left}%`, top: `${mark.top}%` }} aria-hidden />)}
        {owner && <textarea ref={keys} className="bot-browser-keys" aria-label={`Type into ${bot.name}'s browser`} autoComplete="off" autoCorrect="off" autoCapitalize="off" spellCheck={false}
          {...input.keyHandlers} />}
        {view.open && view.dialog && <PageDialog key={`${view.dialog.type}:${view.dialog.message}`} dialog={view.dialog} canAnswer={owner}
          answer={(accept, text) => send({ kind: 'dialog', accept, ...(text !== undefined ? { text } : {}) })} />}
        {owner && !view.dialog && view.chooser && <FileRequest chooser={view.chooser}
          choose={() => void store().chooseFiles(bot.id, view.chooser!)} cancel={() => send({ kind: 'files' })} />}
        {!view.open && !view.setup && <div className="bot-browser-closed">
          <p>{view.stopped ? 'The browser stopped.' : `${bot.name}'s browser is closed.`}</p>
          <button type="button" disabled={busy} onClick={() => void store().open(bot.id, /^https?:\/\//i.test(address.trim()) ? address.trim() : undefined)}>Open it</button>
        </div>}
      </WatchedBrowserFrame>
    </div>
    {said
      ? <p className="bot-browser-note is-input" role="status" title={said.detail}>
        <span>{said.text}</span>
        {said.retry && <button type="button" className="bot-browser-retry" onClick={() => store().retry(bot.id)}>Retry</button>}
      </p>
      : <p className={`bot-browser-note${quiet ? ' is-quiet' : ''}`} role="status" title={error ? errorDetail ?? undefined : view.open && view.problem ? browserProblemForPerson(view.problem).detail : quiet ? status.detail : undefined}>{error
        ? error
        : view.open && view.problem ? browserProblemForPerson(view.problem).line
        : quiet ? status.text
        : owner ? `You're using ${bot.name}'s browser. Sites you sign in to stay signed in for it. Give it back when you're done.`
        : elsewhere ? 'Held in another window. Take over to use it here.'
        : view.open ? `${bot.name} is using its own browser, apart from your tabs. Take over to click or type in it.`
        : `Only ${bot.name} uses this browser. Open it to sign in to a site for it.`}</p>}
  </aside>
}
