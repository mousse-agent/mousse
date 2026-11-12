import { useEffect, useRef, type RefObject } from 'react'
import { create } from 'zustand'
import {
  BOT_BROWSER_WATCH_RENEW_MS,
  type BotBrowserFrame,
  type BotBrowserFrameEvent,
  type BotBrowserInput,
  type BotBrowserView,
  type BotsBrowserApi,
  type BotsBrowserMethod
} from '../../shared/bots/personal/browser'
import { errorText } from '../services/personalBotsClient'
import { browserProblemForPerson, type BrowserProblem } from '../../shared/browser/navigation'

/**
 * Each bot's own browser as its chat shows it: the live preview in its reply and the split view.
 *
 * - **State** (open, who holds it, which runs used it) is read with `bots.browser.get` now and then
 *   while the bot's chat is open.
 * - **Pictures are watched only while seen**: the preview or the split view says what it needs
 *   (`useBotBrowserWatch`) while it is on screen and the window is visible; the store then watches
 *   the bot's browser once (`bots.browser.watch`, the widest and fastest of what is seen) and the
 *   daemon pushes pictures as the page paints. Nothing seen, no watch: the daemon captures nothing.
 * - **The view tells the truth**: a stream is live while its watch holds; when it stops or fails,
 *   the picture stays and the view says how long it has not updated, and it recovers by itself.
 * - A daemon without `watch` (older) is asked for a picture every `BOT_BROWSER_FRAME_MS` instead,
 *   only while seen. A daemon without the methods shows none.
 */

/** How often an older daemon (no `watch`) is asked for a picture while the browser is seen. */
export const BOT_BROWSER_FRAME_MS = 40
/** How often a bot's browser state is read while its chat is open. */
const STATE_POLL_MS = 3000
/** A watch that could not be renewed is tried again after this long (doubling, up to the renewal period). */
const RETRY_MS = 2000
/** How long a watch outlives the last view that showed it (one moving in the chat keeps it). */
export const STOP_GRACE_MS = 1000
/** A renewal not answered within this long counts as the stream stopping (a service that hangs). */
const RENEW_ANSWER_MS = 5000

/** Whether pictures can arrive: live, or not updating since a time (ms since the epoch). */
export type BotBrowserStream = { live: true } | { live: false; since: number }

/** What a preview or the split view needs while it is seen: its width in CSS pixels and pictures a second. */
export interface BotBrowserNeed { width: number; fps: number }

interface BotBrowserState {
  views: Record<string, BotBrowserView>
  /** Per bot being watched (or polled): whether pictures can arrive now. */
  streams: Record<string, BotBrowserStream>
  /** The bot whose browser is open in the split view beside its chat. */
  paneBotId: string | null
  /** Set when the daemon has no bot-browser methods (an older one): nothing polls or shows. */
  unavailable: boolean
  /** Set when the daemon cannot push pictures (no `watch`): they are asked for each time. */
  polling: boolean
  busy: boolean
  error: string | null
  /** The error's details (Chromium's code for a page that failed), for its tooltip. */
  errorDetail: string | null
  load(botId: string, frame: boolean): Promise<void>
  openPane(botId: string): void
  closePane(): void
  control(botId: string, control: 'owner' | 'bot'): Promise<void>
  input(botId: string, input: BotBrowserInput): Promise<void>
  open(botId: string, url?: string): Promise<void>
}

type Call = <M extends BotsBrowserMethod>(method: M, params: BotsBrowserApi[M]['params']) => Promise<BotsBrowserApi[M]['result']>
let transport: Call | null = null
type Subscribe = (listener: (event: BotBrowserFrameEvent) => void) => () => void
let frameSource: Subscribe | null = null
/** The transport the store calls through, and where pushed pictures come from; tests pass fakes. */
export function setBotBrowserTransport(next: Call | null, frames?: Subscribe | null): void {
  transport = next
  frameSource = frames ?? null
  for (const botId of [...watches.keys()]) stopWatch(botId)
  unsubscribeFrames?.()
  unsubscribeFrames = null
}
const call: Call = (method, params) => (transport ?? ((m, p) => window.mousse.platformRequest.request(m, p)) as Call)(method, params)
const subscribeFrames: Subscribe = (listener) => (frameSource ?? ((cb) => window.mousse.personalBots?.onBrowserFrame?.(cb) ?? (() => undefined)))(listener)

/** The daemon (or this app's bridge) does not know the method. */
const missingMethod = (cause: unknown) => /method not allowed|not allowlisted|unknown method|domain method is unavailable/i.test(errorText(cause))
  || ['platform_method_not_allowed', 'method_not_available', 'unknown_method'].includes(String((cause as { code?: unknown } | null)?.code ?? ''))

/** The same picture (whenever it was read). */
const samePicture = (a: BotBrowserFrame, b: BotBrowserFrame) =>
  a.data === b.data && a.width === b.width && a.height === b.height && a.viewport.width === b.viewport.width && a.viewport.height === b.viewport.height

/** Two views that show the same: the same picture object, and the rest alike. */
const sameView = (a: BotBrowserView, b: BotBrowserView) =>
  a.frame === b.frame && JSON.stringify({ ...a, frame: undefined }) === JSON.stringify({ ...b, frame: undefined })

export const useBotBrowserStore = create<BotBrowserState>((set, get) => {
  const act = async (botId: string, run: () => Promise<{ browser: BotBrowserView }>) => {
    set({ busy: true, error: null, errorDetail: null })
    try {
      put(botId, (await run()).browser)
      set({ busy: false })
    } catch (cause) {
      // A page that failed says so in the person's words; Chromium's own code goes in the tooltip.
      const problem = (cause as { details?: { problem?: BrowserProblem } } | null)?.details?.problem
      if (problem) {
        const said = browserProblemForPerson(problem)
        set({ busy: false, error: said.line, errorDetail: said.detail })
      } else set({ busy: false, error: errorText(cause), errorDetail: null })
    }
  }
  return {
    views: {},
    streams: {},
    paneBotId: null,
    unavailable: false,
    polling: false,
    busy: false,
    error: null,
    errorDetail: null,
    async load(botId, frame) {
      if (get().unavailable) return
      try {
        put(botId, (await call('bots.browser.get', { botId, ...(frame ? { frame: true } : {}) })).browser)
        if (frame) setStream(botId, { live: true })
      } catch (cause) {
        if (missingMethod(cause)) set({ unavailable: true })
        else if (frame || watches.has(botId)) setStream(botId, { live: false, since: lastGood.get(botId) ?? Date.now() })
      }
    },
    openPane: (botId) => set({ paneBotId: botId, error: null, errorDetail: null }),
    closePane: () => set({ paneBotId: null, error: null, errorDetail: null }),
    control: (botId, control) => act(botId, () => call('bots.browser.control', { botId, control })),
    input: (botId, input) => act(botId, () => call('bots.browser.input', { botId, input })),
    open: (botId, url) => act(botId, () => call('bots.browser.open', { botId, ...(url ? { url } : {}) }))
  }
})

/** Puts a view read from the daemon: a view without a picture keeps the last one, and nothing new re-renders nothing. */
function put(botId: string, view: BotBrowserView): void {
  useBotBrowserStore.setState((state) => {
    const previous = state.views[botId]
    const frame = view.frame && previous?.frame && samePicture(view.frame, previous.frame) ? previous.frame : view.frame ?? previous?.frame
    const next = { ...view, ...(frame ? { frame } : {}) }
    if (previous && sameView(previous, next)) return state
    return { views: { ...state.views, [botId]: next } }
  })
}

/** When pictures were last known to flow, per bot. */
const lastGood = new Map<string, number>()

function setStream(botId: string, stream: BotBrowserStream): void {
  if (stream.live) lastGood.set(botId, Date.now())
  useBotBrowserStore.setState((state) => {
    const current = state.streams[botId]
    if (current && current.live === stream.live && (stream.live || (current as { since: number }).since === stream.since)) return state
    return { streams: { ...state.streams, [botId]: stream } }
  })
}

// -- what is seen, and the one watch per bot it asks for

const needs = new Map<string, Map<number, BotBrowserNeed>>()
let nextNeed = 1

interface Watch {
  watchId: string
  width: number
  fps: number
  renew?: ReturnType<typeof setTimeout>
  retryMs: number
  /** An older daemon: pictures are asked for each time instead. */
  poll?: ReturnType<typeof setTimeout>
  /** Nothing is seen any more: the watch ends unless something is seen again first. */
  stopping?: ReturnType<typeof setTimeout>
  stopped: boolean
}
const watches = new Map<string, Watch>()
let unsubscribeFrames: (() => void) | null = null

function onFrame(event: BotBrowserFrameEvent): void {
  const watch = watches.get(event.botId)
  if (!watch || watch.watchId !== event.watchId) return
  useBotBrowserStore.setState((state) => {
    const previous = state.views[event.botId]
    if (!previous) return state
    const viewport = event.viewport ?? previous.frame?.viewport ?? { width: 1280, height: 720 }
    const next: BotBrowserView = { ...previous }
    if (event.frame) next.frame = { data: event.frame.data, mimeType: event.frame.mimeType, width: event.frame.width, height: event.frame.height, viewport, at: event.frame.at }
    else if (event.viewport && previous.frame) next.frame = { ...previous.frame, viewport }
    if (event.tab) next.tab = event.tab
    if (event.cursor === null) delete next.cursor
    else if (event.cursor) next.cursor = event.cursor
    if (event.behind === true) next.behind = true
    else if (event.behind === false) delete next.behind
    if (event.loading === true) next.loading = true
    else if (event.loading === false) delete next.loading
    if (event.problem === null) delete next.problem
    else if (event.problem) next.problem = event.problem
    return { views: { ...state.views, [event.botId]: next } }
  })
  // Only the daemon's word, or a new picture, changes whether pictures can arrive.
  if (event.stalled) setStream(event.botId, { live: false, since: lastGood.get(event.botId) ?? Date.now() })
  else if (event.live || event.frame) setStream(event.botId, { live: true })
}

/** What the bot's seen views need together: the widest, the fastest. */
function merged(botId: string): BotBrowserNeed | undefined {
  const list = [...(needs.get(botId)?.values() ?? [])]
  if (!list.length) return undefined
  return { width: Math.max(...list.map((need) => need.width)), fps: Math.max(...list.map((need) => need.fps)) }
}

/** Starts, changes or stops the bot's watch to match what is seen now. */
function syncWatch(botId: string): void {
  const need = merged(botId)
  const store = useBotBrowserStore.getState()
  let watch = watches.get(botId)
  if (store.unavailable) {
    stopWatch(botId)
    return
  }
  if (!need) {
    // A moment's grace: a view that moves in the chat (unmounted, then mounted again) keeps its watch.
    if (watch && !watch.stopping) watch.stopping = setTimeout(() => { if (!merged(botId)) stopWatch(botId) }, STOP_GRACE_MS)
    return
  }
  if (watch?.stopping) {
    clearTimeout(watch.stopping)
    watch.stopping = undefined
  }
  if (watch && watch.width === need.width && watch.fps === need.fps) return
  if (!watch) {
    watch = { watchId: `w${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36)}`, width: need.width, fps: need.fps, retryMs: RETRY_MS, stopped: false }
    watches.set(botId, watch)
    unsubscribeFrames ??= subscribeFrames(onFrame)
  }
  watch.width = need.width
  watch.fps = need.fps
  if (store.polling) startPolling(botId, watch)
  else void renew(botId, watch)
}

async function renew(botId: string, watch: Watch): Promise<void> {
  if (watch.renew) clearTimeout(watch.renew)
  watch.renew = undefined
  // A service that does not answer (it hangs, rather than fails) is not updating either.
  const unanswered = setTimeout(() => {
    if (!watch.stopped) setStream(botId, { live: false, since: lastGood.get(botId) ?? Date.now() })
  }, RENEW_ANSWER_MS)
  try {
    const { browser } = await call('bots.browser.watch', { botId, watchId: watch.watchId, width: watch.width, fps: watch.fps })
    clearTimeout(unanswered)
    if (watch.stopped) return
    put(botId, browser)
    // The daemon answers whether pictures can reach this view now: a renewal never makes it live by itself.
    setStream(botId, browser.stalled ? { live: false, since: lastGood.get(botId) ?? Date.now() } : { live: true })
    watch.retryMs = RETRY_MS
    watch.renew = setTimeout(() => { void renew(botId, watch) }, BOT_BROWSER_WATCH_RENEW_MS)
  } catch (cause) {
    clearTimeout(unanswered)
    if (watch.stopped) return
    if (missingMethod(cause)) {
      // An older daemon: it answers a picture each time it is asked.
      useBotBrowserStore.setState({ polling: true })
      startPolling(botId, watch)
      return
    }
    setStream(botId, { live: false, since: lastGood.get(botId) ?? Date.now() })
    watch.renew = setTimeout(() => { void renew(botId, watch) }, watch.retryMs)
    watch.retryMs = Math.min(BOT_BROWSER_WATCH_RENEW_MS, watch.retryMs * 2)
  }
}

function startPolling(botId: string, watch: Watch): void {
  if (watch.poll || watch.stopped) return
  const tick = async () => {
    const started = Date.now()
    await useBotBrowserStore.getState().load(botId, true)
    if (watch.stopped) return
    // Start to start: the time a read takes is not added to the wait.
    watch.poll = setTimeout(() => { void tick() }, Math.max(0, BOT_BROWSER_FRAME_MS - (Date.now() - started)))
  }
  watch.poll = setTimeout(() => { void tick() }, 0)
}

function stopWatch(botId: string): void {
  const watch = watches.get(botId)
  if (!watch) return
  watch.stopped = true
  watches.delete(botId)
  if (watch.renew) clearTimeout(watch.renew)
  if (watch.poll) clearTimeout(watch.poll)
  if (watch.stopping) clearTimeout(watch.stopping)
  if (!useBotBrowserStore.getState().polling) void call('bots.browser.unwatch', { botId, watchId: watch.watchId }).catch(() => undefined)
  useBotBrowserStore.setState((state) => {
    if (!state.streams[botId]) return state
    const streams = { ...state.streams }
    delete streams[botId]
    return { streams }
  })
  if (!watches.size) {
    unsubscribeFrames?.()
    unsubscribeFrames = null
  }
}

// The page goes (a reload, the window closing): its watches end now, not when the daemon's lease runs out.
if (typeof window !== 'undefined') window.addEventListener('pagehide', () => { for (const botId of [...watches.keys()]) stopWatch(botId) })

/** Whether the window is shown (not minimised or hidden). */
function windowShown(): boolean {
  return typeof document === 'undefined' || document.visibilityState !== 'hidden'
}

/**
 * While `element` is on screen in a shown window, the bot's browser is watched at `need`; scrolled
 * out of sight, the window hidden, or unmounted, it no longer is. Pass `need` undefined to need nothing.
 */
export function useBotBrowserWatch(botId: string, element: RefObject<Element | null>, need: BotBrowserNeed | undefined): void {
  const id = useRef(0)
  if (!id.current) id.current = nextNeed++
  const width = need?.width
  const fps = need?.fps
  useEffect(() => {
    if (width === undefined || fps === undefined) return
    const key = id.current
    let onScreen = typeof IntersectionObserver === 'undefined'
    const update = () => {
      const list = needs.get(botId) ?? new Map<number, BotBrowserNeed>()
      if (onScreen && windowShown()) list.set(key, { width, fps })
      else list.delete(key)
      if (list.size) needs.set(botId, list)
      else needs.delete(botId)
      syncWatch(botId)
    }
    const target = element.current
    const observer = typeof IntersectionObserver === 'undefined' || !target ? undefined : new IntersectionObserver((entries) => {
      onScreen = entries.some((entry) => entry.isIntersecting)
      update()
    })
    if (observer && target) observer.observe(target)
    else onScreen = true
    document.addEventListener('visibilitychange', update)
    update()
    return () => {
      observer?.disconnect()
      document.removeEventListener('visibilitychange', update)
      const list = needs.get(botId)
      list?.delete(key)
      if (list && !list.size) needs.delete(botId)
      syncWatch(botId)
    }
  }, [botId, element, width, fps])
}

/**
 * Keeps a bot's browser state fresh while its chat is open: a light read every few seconds. Its
 * pictures come from what is seen of it (`useBotBrowserWatch`).
 */
export function useBotBrowser(botId: string): BotBrowserView | undefined {
  const view = useBotBrowserStore((state) => state.views[botId])
  const unavailable = useBotBrowserStore((state) => state.unavailable)
  useEffect(() => {
    if (unavailable) return
    let stopped = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const tick = async () => {
      await useBotBrowserStore.getState().load(botId, false)
      if (!stopped) timer = setTimeout(() => { void tick() }, STATE_POLL_MS)
    }
    void tick()
    return () => { stopped = true; if (timer) clearTimeout(timer) }
  }, [botId, unavailable])
  return unavailable ? undefined : view
}

/** Whether a bot's pictures can arrive now (undefined while nothing of it is watched). */
export function useBotBrowserStream(botId: string): BotBrowserStream | undefined {
  return useBotBrowserStore((state) => state.streams[botId])
}
