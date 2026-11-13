import { useEffect, useRef, type RefObject } from 'react'
import { create } from 'zustand'
import {
  BOT_BROWSER_HOLD_BEAT_MS,
  BOT_BROWSER_WATCH_RENEW_MS,
  type BotBrowserAck,
  type BotBrowserFrame,
  type BotBrowserFrameEvent,
  type BotBrowserHold,
  type BotBrowserInput,
  type BotBrowserView,
  type BotsBrowserApi,
  type BotsBrowserMethod
} from '../../shared/bots/personal/browser'
import { errorText } from '../services/personalBotsClient'
import { browserProblemForPerson, type BrowserProblem } from '../../shared/browser/navigation'
import { BrowserInputChannel, viewerPlatform, type ChannelHealth } from './browserInputChannel'

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
 * - **Take over is this window's hold** (`bots.browser.hold`): the window is one view, with an id kept
 *   across its reloads, so a window that reloads picks its hold up again. While it holds the browser
 *   it says so every 5 seconds (with or without the split view on screen); every input goes on the
 *   hold's numbered channel (`BrowserInputChannel`) and is answered. Whether input arrives is known per
 *   bot (`inputHealth`), and a refusal is said once (`inputNote`).
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
  /** This window's hold of a bot's browser, per bot: its id, and the computer the browser runs on. */
  holds: Record<string, { id: string; computer: string }>
  /** Whether this window's input reaches each bot's browser (absent: nothing waits for an answer). */
  inputHealth: Record<string, ChannelHealth>
  /** The last refusal of this window's input, per bot, said once ("Page changed · click again"); `detail` for its tooltip. */
  inputNote: Record<string, { text: string; at: number; detail?: string }>
  load(botId: string, frame: boolean): Promise<void>
  openPane(botId: string): void
  closePane(): void
  /** Take over (`force`: from another window that holds it) and Give back. */
  takeOver(botId: string, force?: boolean): Promise<void>
  giveBack(botId: string): Promise<void>
  /** The person's input, made on picture `picture`, on this window's hold; settles with the host's answer. */
  send(botId: string, input: BotBrowserInput, picture?: number): { seq: number; done: Promise<BotBrowserAck> }
  /** Sends what has no answer yet again. */
  retry(botId: string): void
  open(botId: string, url?: string): Promise<void>
  /**
   * The page asks for files: this computer's own file dialog (opened by the app, not the page) picks
   * them, and the page gets only those, by a one-time token; the paths never pass through here.
   */
  chooseFiles(botId: string, chooser: { multiple: boolean; site?: string }): Promise<void>
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
  for (const botId of [...channels.keys()]) dropHold(botId)
  legacyDaemon = false
  unsubscribeFrames?.()
  unsubscribeFrames = null
}
const call: Call = (method, params) => (transport ?? ((m, p) => window.mousse.platformRequest.request(m, p)) as Call)(method, params)
const subscribeFrames: Subscribe = (listener) => (frameSource ?? ((cb) => window.mousse.personalBots?.onBrowserFrame?.(cb) ?? (() => undefined)))(listener)

/** The daemon (or this app's bridge) does not know the method. */
const missingMethod = (cause: unknown) => /method not allowed|not allowlisted|unknown method|domain method is unavailable/i.test(errorText(cause))
  || ['platform_method_not_allowed', 'method_not_available', 'unknown_method'].includes(String((cause as { code?: unknown } | null)?.code ?? ''))

/** An older daemon refuses a view's id (it predates holds). */
const refusesViewId = (cause: unknown) => String((cause as { code?: unknown } | null)?.code ?? '') === 'unknown_field' || /unexpected field: viewId/i.test(errorText(cause))

/** The same picture (whenever it was read). */
const samePicture = (a: BotBrowserFrame, b: BotBrowserFrame) =>
  a.data === b.data && a.width === b.width && a.height === b.height && a.viewport.width === b.viewport.width && a.viewport.height === b.viewport.height

/** Two views that show the same: the same picture object, and the rest alike. */
const sameView = (a: BotBrowserView, b: BotBrowserView) =>
  a.frame === b.frame && JSON.stringify({ ...a, frame: undefined }) === JSON.stringify({ ...b, frame: undefined })

export const useBotBrowserStore = create<BotBrowserState>((set, get) => {
  const act = async (botId: string, run: () => Promise<{ browser: BotBrowserView; hold?: BotBrowserHold }>) => {
    set({ busy: true, error: null, errorDetail: null })
    try {
      const answer = await run()
      if (answer.hold) adoptHold(botId, answer.hold)
      put(botId, answer.browser)
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
    holds: {},
    inputHealth: {},
    inputNote: {},
    async load(botId, frame) {
      if (get().unavailable) return
      const read = () => call('bots.browser.get', { botId, ...(frame ? { frame: true } : {}), ...(legacyDaemon ? {} : { viewId: viewId() }) })
      try {
        put(botId, (await read().catch((cause: unknown) => {
          // An older daemon knows no views: asked again without.
          if (legacyDaemon || !refusesViewId(cause)) throw cause
          legacyDaemon = true
          return read()
        })).browser)
        if (frame) setStream(botId, { live: true })
      } catch (cause) {
        if (missingMethod(cause)) set({ unavailable: true })
        else if (frame || watches.has(botId)) setStream(botId, { live: false, since: lastGood.get(botId) ?? Date.now() })
      }
    },
    openPane: (botId) => set({ paneBotId: botId, error: null, errorDetail: null }),
    closePane: () => set({ paneBotId: null, error: null, errorDetail: null }),
    takeOver: (botId, force) => act(botId, async () => {
      if (!legacyDaemon) {
        try {
          return await call('bots.browser.hold', { botId, viewId: viewId(), request: { op: 'take', ...(force ? { force: true } : {}), platform: viewerPlatform() } })
        } catch (cause) {
          if (!missingMethod(cause)) throw cause
          legacyDaemon = true
        }
      }
      // An older daemon: its own Take over, with this window's input sent one at a time.
      const answer = await call('bots.browser.control', { botId, control: 'owner' })
      adoptHold(botId, { id: LEGACY_HOLD, lastSeq: 0, computer: 'this computer' })
      return answer
    }),
    giveBack: (botId) => act(botId, async () => {
      const hold = get().holds[botId]
      // What the person did before Give back reaches the page first.
      await channels.get(botId)?.drain(1_500)
      dropHold(botId)
      if (!hold || hold.id === LEGACY_HOLD) return call('bots.browser.control', { botId, control: 'bot' })
      return call('bots.browser.hold', { botId, viewId: viewId(), request: { op: 'release', holdId: hold.id } })
    }),
    send(botId, input, picture) {
      const channel = channels.get(botId)
      if (!channel) return { seq: 0, done: Promise.resolve({ seq: 0, status: 'refused', reason: 'not-held', text: 'Take over first' } satisfies BotBrowserAck) }
      return channel.push(input, picture)
    },
    retry: (botId) => channels.get(botId)?.retry(),
    open: (botId, url) => act(botId, () => call('bots.browser.open', { botId, ...(url ? { url } : {}), ...(legacyDaemon ? {} : { viewId: viewId(), platform: viewerPlatform() }) })),
    async chooseFiles(botId, chooser) {
      const hold = get().holds[botId]
      const choose = window.mousse?.personalBots?.chooseBrowserFiles
      if (!hold || hold.id === LEGACY_HOLD || !choose) return
      try {
        const answer = await choose({ botId, viewId: viewId(), holdId: hold.id, multiple: chooser.multiple, ...(chooser.site ? { site: chooser.site } : {}) })
        // Cancelled in the dialog: the card stays, and the page waits.
        if (answer.cancelled) return
        if (answer.refused) {
          setInput(botId, { note: answer.refused })
          return
        }
        if (answer.token) get().send(botId, { kind: 'files', token: answer.token })
      } catch (cause) {
        setInput(botId, { note: errorText(cause) })
      }
    }
  }
})

// -- this window's holds

/** A hold an older daemon gave this window (`control`): its inputs go one at a time, unnumbered. */
const LEGACY_HOLD = 'legacy'
/** Whether the daemon predates holds and views (`bots.browser.hold`): set when it says so. */
let legacyDaemon = false
let windowViewId: string | undefined

/** This window's id as a view of bots' browsers, kept across its reloads: a hold it took is picked up again. */
export function viewId(): string {
  if (windowViewId) return windowViewId
  const key = 'mousse.botBrowser.viewId'
  try {
    const kept = typeof sessionStorage !== 'undefined' ? sessionStorage.getItem(key) : null
    if (kept && /^[A-Za-z0-9_-]{8,64}$/.test(kept)) return (windowViewId = kept)
  } catch {
    // No storage (a test, a locked-down page): a fresh id for this page.
  }
  windowViewId = `v${Math.random().toString(36).slice(2, 12)}${Date.now().toString(36)}`
  try {
    sessionStorage.setItem(key, windowViewId)
  } catch {
    // Kept for this page only.
  }
  return windowViewId
}

const channels = new Map<string, BrowserInputChannel>()
const beats = new Map<string, { timer: ReturnType<typeof setInterval>; stop(): void }>()

/** Inputs whose refusal is worth a line (a hover's is not). */
function worthSaying(input: BotBrowserInput): boolean {
  if (input.kind === 'pointer') return input.type === 'down'
  if (input.kind === 'keys') return input.type === 'down'
  return input.kind !== 'compose' && input.kind !== 'release'
}

/**
 * Refusals the view says in a line, once. Not a gap (it goes again by itself) and not one held back
 * while the page does not answer (the view already says "Not reaching …").
 */
function sayRefusal(ack: BotBrowserAck): boolean {
  return Boolean(ack.reason) && ack.status !== 'applied' && ack.reason !== 'gap' && ack.reason !== 'busy' && ack.reason !== 'skipped'
}

/** The person's clipboard gets what they copied from the page; nothing else ever writes it. */
async function writeClipboard(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text)
  } catch {
    const area = document.createElement('textarea')
    area.value = text
    area.style.position = 'fixed'
    area.style.opacity = '0'
    document.body.appendChild(area)
    area.select()
    document.execCommand('copy')
    area.remove()
  }
}

function setInput(botId: string, patch: { health?: ChannelHealth | null; note?: string | null; detail?: string }): void {
  useBotBrowserStore.setState((state) => {
    const next: Partial<BotBrowserState> = {}
    if (patch.health !== undefined) {
      const inputHealth = { ...state.inputHealth }
      if (patch.health && patch.health !== 'ok') inputHealth[botId] = patch.health
      else delete inputHealth[botId]
      next.inputHealth = inputHealth
    }
    if (patch.note !== undefined) {
      const inputNote = { ...state.inputNote }
      if (patch.note) inputNote[botId] = { text: patch.note, at: Date.now(), ...(patch.detail ? { detail: patch.detail } : {}) }
      else delete inputNote[botId]
      next.inputNote = inputNote
    }
    return next
  })
}

/** This window holds the bot's browser (taken now, or picked up again after a reload): its channel and heartbeat. */
function adoptHold(botId: string, hold: BotBrowserHold): void {
  const known = useBotBrowserStore.getState().holds[botId]
  if (known?.id === hold.id && channels.has(botId)) return
  dropHold(botId)
  const legacy = hold.id === LEGACY_HOLD
  const channel = new BrowserInputChannel({
    lastSeq: hold.lastSeq,
    send: legacy ? (inputs) => sendOneByOne(botId, inputs) : (inputs) => call('bots.browser.send', { botId, viewId: viewId(), holdId: hold.id, inputs }),
    health: (health) => setInput(botId, { health }),
    answered: (ack, input) => {
      if (ack.copied !== undefined && input.kind === 'copy') void writeClipboard(ack.copied)
      // A duplicate of one refused before says why it was.
      if (sayRefusal(ack) && worthSaying(input)) setInput(botId, { note: ack.text ?? 'That did not reach the page', ...(ack.detail ? { detail: ack.detail } : {}) })
    }
  })
  channels.set(botId, channel)
  useBotBrowserStore.setState((state) => ({ holds: { ...state.holds, [botId]: { id: hold.id, computer: hold.computer } } }))
  if (legacy) return
  // Said every 5 seconds while this window holds it, whatever is on screen: a window that goes away lets it go after 2 minutes.
  let unanswered = false
  const beat = () => {
    void call('bots.browser.hold', { botId, viewId: viewId(), request: { op: 'renew', holdId: hold.id } }).then((answer) => {
      // The service answers again after it did not: the hold goes on at its last number, and what has no answer goes again.
      if (unanswered && answer.hold) channels.get(botId)?.resume(answer.hold.lastSeq)
      unanswered = false
      put(botId, answer.browser)
    }, (cause) => {
      if (String((cause as { code?: unknown } | null)?.code ?? '') === 'hold_ended' || /don't hold this browser/i.test(errorText(cause))) {
        dropHold(botId, 'You don\'t hold the browser now')
        useBotBrowserStore.setState({ error: 'You no longer hold this browser: it went back while this window was away. Take over to use it again.', errorDetail: null })
      } else unanswered = true
    })
  }
  // A window shown again asks at once: a hold that ended while it was hidden is said now, not at the next beat.
  const shown = () => { if (typeof document === 'undefined' || document.visibilityState === 'visible') beat() }
  if (typeof document !== 'undefined') document.addEventListener('visibilitychange', shown)
  beats.set(botId, { timer: setInterval(beat, BOT_BROWSER_HOLD_BEAT_MS), stop: () => { if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', shown) } })
}

/** This window no longer holds the bot's browser: what it sent with no answer is refused here. */
function dropHold(botId: string, why?: string): void {
  const beat = beats.get(botId)
  if (beat) {
    clearInterval(beat.timer)
    beat.stop()
  }
  beats.delete(botId)
  channels.get(botId)?.close(why)
  channels.delete(botId)
  setInput(botId, { health: null })
  useBotBrowserStore.setState((state) => {
    if (!state.holds[botId]) return state
    const holds = { ...state.holds }
    delete holds[botId]
    return { holds }
  })
}

/** An older daemon takes one input per call: answered as applied when it went, refused when it did not. */
async function sendOneByOne(botId: string, inputs: Parameters<NonNullable<ConstructorParameters<typeof BrowserInputChannel>[0]>['send']>[0]): Promise<{ acks: BotBrowserAck[]; lastSeq: number }> {
  const acks: BotBrowserAck[] = []
  for (const sent of inputs) {
    // An older daemon counts nothing: a skip is answered here.
    if ('skip' in sent) {
      acks.push({ seq: sent.seq, status: 'refused', reason: 'skipped' })
      continue
    }
    try {
      put(botId, (await call('bots.browser.input', { botId, input: sent.input })).browser)
      acks.push({ seq: sent.seq, status: 'applied' })
    } catch (cause) {
      acks.push({ seq: sent.seq, status: 'refused', reason: 'failed', text: errorText(cause) })
    }
  }
  return { acks, lastSeq: inputs.at(-1)?.seq ?? 0 }
}

/** Puts a view read from the daemon: a view without a picture keeps the last one, and nothing new re-renders nothing. */
function put(botId: string, view: BotBrowserView): void {
  // This window holds it (a window that reloaded picks its hold up again, at the host's last number).
  if (view.holder === 'this-view' && view.hold && !legacyDaemon) adoptHold(botId, view.hold)
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
    if (event.frame) next.frame = { data: event.frame.data, mimeType: event.frame.mimeType, width: event.frame.width, height: event.frame.height, viewport, at: event.frame.at, ...(event.frame.id !== undefined ? { id: event.frame.id } : {}) }
    else if (event.viewport && previous.frame) next.frame = { ...previous.frame, viewport }
    // Who holds the browser, as the daemon tells every view at once.
    if (event.control) next.control = event.control
    if (event.holder) next.holder = event.holder
    if (event.holder && event.holder !== 'this-view') delete next.hold
    if (event.dialog === null) delete next.dialog
    else if (event.dialog) next.dialog = event.dialog
    if (event.chooser === null) delete next.chooser
    else if (event.chooser) next.chooser = event.chooser
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
  // This window's hold ended without its Give back (taken in another window, run out), or another holds it now.
  const held = useBotBrowserStore.getState().holds[event.botId]
  if (held && held.id !== LEGACY_HOLD && (event.holdEnded || (event.holder && event.holder !== 'this-view'))) {
    dropHold(event.botId, event.holdEnded === 'taken' || event.holder === 'another-view' ? 'Taken over in another window' : 'You don\'t hold the browser now')
  }
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
    const ask = () => call('bots.browser.watch', { botId, watchId: watch.watchId, width: watch.width, fps: watch.fps, ...(legacyDaemon ? {} : { viewId: viewId() }) })
    const { browser } = await ask().catch((cause: unknown) => {
      if (legacyDaemon || !refusesViewId(cause)) throw cause
      legacyDaemon = true
      return ask()
    })
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
