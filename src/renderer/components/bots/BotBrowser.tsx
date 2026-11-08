import { useEffect, useRef, useState, type KeyboardEvent, type MouseEvent, type WheelEvent } from 'react'
import { ArrowLeft, ArrowRight, Globe, Maximize, RefreshCw, X } from '../../lib/icons'
import type { BotSummary } from '../../../shared/bots/personal/chat'
import type { BotBrowserInput, BotBrowserView } from '../../../shared/bots/personal/browser'
import { useBotBrowserStore } from '../../stores/botBrowserStore'
import { AgentCursor } from '../browser/AgentCursor'
import './botBrowser.css'

/**
 * A bot's own browser in its chat: a small live preview in the reply of the run that used it, and
 * the split view beside the chat, where the owner watches the bot use it and can take it over (to
 * sign in for it, say). Both show the tab the bot used last, as pictures the daemon takes, with
 * the agent cursor drawn over them.
 */

function hostOf(url: string | undefined): string {
  if (!url) return ''
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return ''
  }
}

function frameSrc(view: BotBrowserView): string | undefined {
  return view.frame ? `data:${view.frame.mimeType};base64,${view.frame.data}` : undefined
}

function statusText(view: BotBrowserView): string {
  if (view.setup) return 'Setting up'
  if (!view.open) return 'Closed'
  return view.control === 'owner' ? 'You have it' : 'Live'
}

/** The picture of the bot's tab at its page's shape, with the agent cursor over it. */
function BrowserFrame({ bot, view, children, ...handlers }: {
  bot: BotSummary
  view: BotBrowserView
  children?: React.ReactNode
  onClick?(event: MouseEvent<HTMLDivElement>): void
  onWheel?(event: WheelEvent<HTMLDivElement>): void
  onKeyDown?(event: KeyboardEvent<HTMLDivElement>): void
  tabIndex?: number
  frameRef?: React.Ref<HTMLDivElement>
}) {
  const src = frameSrc(view)
  const viewport = view.frame?.viewport ?? { width: 16, height: 10 }
  const { frameRef, ...events } = handlers
  return <div ref={frameRef} className="bot-browser-frame" style={{ aspectRatio: `${viewport.width} / ${viewport.height}` }} {...events}>
    {src
      ? <img src={src} alt={view.tab?.title || `${bot.name}'s browser`} draggable={false} />
      : <div className="bot-browser-frame-empty"><Globe size={22} aria-hidden /></div>}
    {view.open && <AgentCursor cursor={view.cursor} />}
    {view.setup && <div className="bot-browser-closed" role="status"><p>Setting up the browser on this computer{view.setup.percent !== undefined ? ` · ${view.setup.percent}%` : '…'}</p></div>}
    {children}
  </div>
}

/** The small live preview in a reply; hovering shows Expand, which opens the split view. */
export function BotBrowserPreview({ bot, view }: { bot: BotSummary; view: BotBrowserView }) {
  const host = hostOf(view.tab?.url)
  return <figure className={`bot-browser-preview${view.open ? ' is-live' : ''}`} aria-label={`${bot.name}'s browser`}>
    <BrowserFrame bot={bot} view={view}>
      <button type="button" className="bot-browser-expand" aria-label={`Expand ${bot.name}'s browser`} title="Expand"
        onClick={() => useBotBrowserStore.getState().openPane(bot.id)}><Maximize size={14} /></button>
    </BrowserFrame>
    <figcaption>
      <span className="bot-browser-dot" aria-hidden />
      <span className="bot-browser-title">{view.tab?.title || host || 'Browser'}</span>
      {host && <span className="bot-browser-host">{host}</span>}
      <span className="bot-browser-status">{statusText(view)}</span>
    </figcaption>
  </figure>
}

/** Keys the split view sends as keys; other single characters are typed. */
const KEYS = new Set(['Enter', 'Tab', 'Backspace', 'Delete', 'Escape', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End', 'PageUp', 'PageDown'])

/**
 * The split view: the bot's browser beside its chat. The owner watches; Take over hands the
 * browser to them (the bot's actions wait), and clicks, scrolling and typing then reach the page;
 * Give back returns it. A closed browser can be opened again here, under the owner's control.
 */
export function BotBrowserPane({ bot, view }: { bot: BotSummary; view: BotBrowserView }) {
  const busy = useBotBrowserStore((state) => state.busy)
  const error = useBotBrowserStore((state) => state.error)
  const store = useBotBrowserStore.getState
  const owner = view.open && view.control === 'owner'
  const url = view.tab?.url ?? ''
  const [address, setAddress] = useState(url)
  const editing = useRef(false)
  const frame = useRef<HTMLDivElement>(null)
  const typed = useRef('')
  const flush = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const lastWheel = useRef(0)
  useEffect(() => { if (!editing.current) setAddress(url) }, [url])
  useEffect(() => () => clearTimeout(flush.current), [])

  const send = (input: BotBrowserInput) => { void store().input(bot.id, input) }
  const point = (event: { clientX: number; clientY: number }) => {
    const rect = frame.current?.getBoundingClientRect()
    const viewport = view.frame?.viewport
    if (!rect || !viewport || !rect.width || !rect.height) return undefined
    const x = Math.max(0, Math.min(viewport.width, ((event.clientX - rect.left) / rect.width) * viewport.width))
    const y = Math.max(0, Math.min(viewport.height, ((event.clientY - rect.top) / rect.height) * viewport.height))
    return { x, y }
  }
  const go = () => {
    editing.current = false
    const text = address.trim()
    if (!text) return
    const target = /^https?:\/\//i.test(text) ? text : `https://${text}`
    if (owner) send({ kind: 'navigate', url: target })
    else if (!view.open) void store().open(bot.id, target)
  }
  const typeLater = (text: string) => {
    typed.current += text
    clearTimeout(flush.current)
    flush.current = setTimeout(() => {
      const chunk = typed.current
      typed.current = ''
      if (chunk) send({ kind: 'type', text: chunk })
    }, 120)
  }

  return <aside className="bot-browser-pane" aria-label={`${bot.name}'s browser`}>
    <header className="bot-browser-bar">
      <button type="button" aria-label="Back" title="Back" disabled={!owner || busy} onClick={() => send({ kind: 'back' })}><ArrowLeft size={15} /></button>
      <button type="button" aria-label="Forward" title="Forward" disabled={!owner || busy} onClick={() => send({ kind: 'forward' })}><ArrowRight size={15} /></button>
      <button type="button" aria-label="Reload" title="Reload" disabled={!owner || busy} onClick={() => send({ kind: 'reload' })}><RefreshCw size={15} /></button>
      <form className="bot-browser-address" onSubmit={(event) => { event.preventDefault(); go() }}>
        <Globe size={13} aria-hidden />
        <input aria-label={`${bot.name}'s browser address`} value={address} readOnly={view.open && !owner} placeholder="Enter a web address"
          onFocus={() => { editing.current = true }} onBlur={() => { editing.current = false }} onChange={(event) => setAddress(event.target.value)} spellCheck={false} />
      </form>
      {view.open && (owner
        ? <button type="button" className="bot-browser-control" disabled={busy} onClick={() => void store().control(bot.id, 'bot')}>Give back</button>
        : <button type="button" className="bot-browser-control" disabled={busy} onClick={() => void store().control(bot.id, 'owner')}>Take over</button>)}
      <button type="button" aria-label="Close the browser view" title="Close" onClick={() => store().closePane()}><X size={15} /></button>
    </header>
    <div className="bot-browser-stage">
      <BrowserFrame bot={bot} view={view} frameRef={frame} tabIndex={owner ? 0 : -1}
        onClick={(event) => {
          if (!owner) return
          frame.current?.focus()
          const at = point(event)
          if (at) send({ kind: 'click', ...at })
        }}
        onWheel={(event) => {
          if (!owner || Date.now() - lastWheel.current < 120) return
          lastWheel.current = Date.now()
          const at = point(event)
          if (at) send({ kind: 'scroll', ...at, deltaX: event.deltaX, deltaY: event.deltaY })
        }}
        onKeyDown={(event) => {
          if (!owner || event.metaKey || event.ctrlKey || event.altKey) return
          if (KEYS.has(event.key)) {
            event.preventDefault()
            send({ kind: 'key', key: event.key })
          } else if (event.key.length === 1) {
            event.preventDefault()
            typeLater(event.key)
          }
        }}>
        {!view.open && !view.setup && <div className="bot-browser-closed">
          <p>{bot.name}'s browser is closed.</p>
          <button type="button" disabled={busy} onClick={() => void store().open(bot.id, /^https?:\/\//i.test(address.trim()) ? address.trim() : undefined)}>Open it</button>
        </div>}
      </BrowserFrame>
    </div>
    <p className="bot-browser-note" role="status">{error
      ? error
      : owner ? `You're using ${bot.name}'s browser. Sites you sign in to stay signed in for it. Give it back when you're done.`
      : view.open ? `${bot.name} is using its own browser, apart from your tabs. Take over to click or type in it.`
      : `Only ${bot.name} uses this browser. Open it to sign in to a site for it.`}</p>
  </aside>
}
