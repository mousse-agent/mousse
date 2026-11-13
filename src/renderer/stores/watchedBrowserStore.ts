import { useEffect, useRef, type RefObject } from 'react'
import { create } from 'zustand'
import {
  WATCHED_BROWSER_HOLD_BEAT_MS,
  WATCHED_BROWSER_RENEW_MS,
  type WatchedBrowserAck,
  type WatchedBrowserFrame,
  type WatchedBrowserHold,
  type WatchedBrowserInput,
  type WatchedBrowserSent,
  type WatchedBrowserUpdate,
  type WatchedBrowserView
} from '../../shared/browser/watched'
import { errorText } from '../services/personalBotsClient'
import { browserProblemForPerson, type BrowserProblem } from '../../shared/browser/navigation'
import { BrowserInputChannel, viewerPlatform, type ChannelHealth } from './browserInputChannel'

/**
 * A browser without a window as this window shows it: a bot's own browser (its reply's live preview
 * and the split view) or a thread agent's (its Browser panel). One store per kind; each browser in it
 * is named by its key (a bot's id, a thread's id).
 *
 * - **State** (open, who holds it) is read now and then while its surface is open (`useBrowserState`).
 * - **Pictures are watched only while seen**: a surface says what it needs (`useWatch`) while it is on
 *   screen and the window is visible; the store then watches the browser once (the widest and fastest
 *   of what is seen) and the service pushes pictures as the page paints. Nothing seen, no watch: the
 *   service captures nothing.
 * - **The view tells the truth**: a stream is live while its watch holds; when it stops or fails, the
 *   picture stays and the view says how long it has not updated, and it recovers by itself.
 * - A service that predates watching (a bot's, only) is asked for a picture every `WATCHED_BROWSER_FRAME_MS`
 *   instead, only while seen. A service without the methods shows none.
 * - **Take over is this window's hold**: the window is one view, with an id kept across its reloads, so a
 *   window that reloads picks its hold up again. While it holds the browser it says so every 5 seconds
 *   (whatever is on screen); every input goes on the hold's numbered channel (`BrowserInputChannel`) and
 *   is answered. Whether input arrives is known per browser (`inputHealth`), and a refusal is said once
 *   (`inputNote`).
 */

/** How often a service that cannot push pictures is asked for one while the browser is seen. */
export const WATCHED_BROWSER_FRAME_MS = 40
/** How often a browser's state is read while its surface is open. */
const STATE_POLL_MS = 3000
/** A watch that could not be renewed is tried again after this long (doubling, up to the renewal period). */
const RETRY_MS = 2000
/** How long a watch outlives the last view that showed it (one moving on the page keeps it). */
export const STOP_GRACE_MS = 1000
/** A renewal not answered within this long counts as the stream stopping (a service that hangs). */
const RENEW_ANSWER_MS = 5000

/** Whether pictures can arrive: live, or not updating since a time (ms since the epoch). */
export type WatchedBrowserStream = { live: true } | { live: false; since: number }

/** What a surface needs while it is seen: its width in CSS pixels and pictures a second. */
export interface WatchedBrowserNeed { width: number; fps: number }

/** The page's file request as a view answers it: this computer's own dialog, by the app. */
export type ChooseFiles = (request: { key: string; viewId: string; holdId: string; multiple: boolean; site?: string }) => Promise<{ token?: string; count?: number; cancelled?: true; refused?: string }>

export interface WatchedBrowserState<V extends WatchedBrowserView> {
  views: Record<string, V>
  /** Per browser being watched (or polled): whether pictures can arrive now. */
  streams: Record<string, WatchedBrowserStream>
  /** The browser open in its larger view (a bot's split view, a thread's view in its Browser panel). */
  pane: string | null
  /** Set when the service has none of these methods (an older one): nothing polls or shows. */
  unavailable: boolean
  /** Set when the service cannot push pictures (no `watch`): they are asked for each time. */
  polling: boolean
  busy: boolean
  error: string | null
  /** The error's details (Chromium's code for a page that failed), for its tooltip. */
  errorDetail: string | null
  /** This window's hold of each browser: its id, and the computer the browser runs on. */
  holds: Record<string, { id: string; computer: string }>
  /** Whether this window's input reaches each browser (absent: nothing waits for an answer). */
  inputHealth: Record<string, ChannelHealth>
  /** The last refusal of this window's input, per browser, said once ("Page changed · click again"); `detail` for its tooltip. */
  inputNote: Record<string, { text: string; at: number; detail?: string }>
  load(key: string, frame: boolean): Promise<void>
  openPane(key: string): void
  closePane(): void
  /** Take over (`force`: from another window that holds it) and Give back. */
  takeOver(key: string, force?: boolean): Promise<void>
  giveBack(key: string): Promise<void>
  /** The person's input, made on picture `picture`, on this window's hold; settles with the service's answer. */
  send(key: string, input: WatchedBrowserInput, picture?: number): { seq: number; done: Promise<WatchedBrowserAck> }
  /** Sends what has no answer yet again. */
  retry(key: string): void
  /** Opens a closed browser for the person, under their control (a bot's only). */
  open(key: string, url?: string): Promise<void>
  /**
   * The page asks for files: this computer's own file dialog (opened by the app, not the page) picks
   * them, and the page gets only those, by a one-time token; the paths never pass through here.
   */
  chooseFiles(key: string, chooser: { multiple: boolean; site?: string }): Promise<void>
  /**
   * Open in a window (`open`): this window takes the browser over (when it does not hold it yet) and the app opens it
   * as a real window on this computer's screen, for as long as the hold lasts. Close window (`close`) closes it and
   * gives the browser back. A bot's only, through the app (`config.window`).
   */
  inWindow(key: string, op: 'open' | 'close'): Promise<void>
}

/** Open in a window and Close window, through the app: the browser's view after, or why it was refused. */
export type BrowserInWindow<V> = (request: { key: string; viewId: string; holdId: string; op: 'open' | 'close' }) => Promise<{ browser?: V; refused?: string }>

/** One call to the service: method and params as the store names them. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type WatchedBrowserCall = (method: string, params: Record<string, unknown>) => Promise<any>
export type WatchedBrowserFrames<E> = (listener: (event: E) => void) => () => void

export interface WatchedBrowserStoreConfig<E extends WatchedBrowserUpdate> {
  /** What names one browser in each call: `{ botId }`, `{ threadId }`. */
  owner(key: string): Record<string, string>
  /** The browser a pushed update is of. */
  keyOf(event: E): string | undefined
  methods: {
    get: string
    watch: string
    unwatch: string
    hold: string
    send: string
    /** A service's own Open (the person opens a closed browser): a bot's only. */
    open?: string
    /** What a service that predates holds takes instead (`control`, `input`): a bot's only. */
    legacy?: { control: string; input: string }
  }
  /** Where pushed pictures come from in the app. */
  frames: WatchedBrowserFrames<E>
  /** This computer's own file dialog, through the app. */
  chooseFiles(): ChooseFiles | undefined
  /** Open in a window and Close window, through the app (a bot's only). */
  window?(): BrowserInWindow<WatchedBrowserView> | undefined
}

/** The service (or this app's bridge) does not know the method. */
const missingMethod = (cause: unknown) => /method not allowed|not allowlisted|unknown method|domain method is unavailable/i.test(errorText(cause))
  || ['platform_method_not_allowed', 'method_not_available', 'unknown_method'].includes(String((cause as { code?: unknown } | null)?.code ?? ''))

/** An older service refuses a view's id (it predates holds). */
const refusesViewId = (cause: unknown) => String((cause as { code?: unknown } | null)?.code ?? '') === 'unknown_field' || /unexpected field: viewId/i.test(errorText(cause))

/** The same picture (whenever it was read). */
const samePicture = (a: WatchedBrowserFrame, b: WatchedBrowserFrame) =>
  a.data === b.data && a.width === b.width && a.height === b.height && a.viewport.width === b.viewport.width && a.viewport.height === b.viewport.height

/** Two views that show the same: the same picture object, and the rest alike. */
const sameView = (a: WatchedBrowserView, b: WatchedBrowserView) =>
  a.frame === b.frame && JSON.stringify({ ...a, frame: undefined }) === JSON.stringify({ ...b, frame: undefined })

let windowViewId: string | undefined

/** This window's id as a view of browsers without a window, kept across its reloads: a hold it took is picked up again. */
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

/** Inputs whose refusal is worth a line (a hover's is not). */
function worthSaying(input: WatchedBrowserInput): boolean {
  if (input.kind === 'pointer') return input.type === 'down'
  if (input.kind === 'keys') return input.type === 'down'
  return input.kind !== 'compose' && input.kind !== 'release'
}

/**
 * Refusals the view says in a line, once. Not a gap (it goes again by itself) and not one held back
 * while the page does not answer (the view already says "Not reaching …").
 */
function sayRefusal(ack: WatchedBrowserAck): boolean {
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

/** Whether the window is shown (not minimised or hidden). */
function windowShown(): boolean {
  return typeof document === 'undefined' || document.visibilityState !== 'hidden'
}

/** A hold a service that predates holds gave this window (`control`): its inputs go one at a time, unnumbered. */
const LEGACY_HOLD = 'legacy'

interface Watch {
  watchId: string
  width: number
  fps: number
  renew?: ReturnType<typeof setTimeout>
  retryMs: number
  /** A service that cannot push: pictures are asked for each time instead. */
  poll?: ReturnType<typeof setTimeout>
  /** Nothing is seen any more: the watch ends unless something is seen again first. */
  stopping?: ReturnType<typeof setTimeout>
  stopped: boolean
}

export function createWatchedBrowserStore<V extends WatchedBrowserView, E extends WatchedBrowserUpdate & { watchId: string }>(config: WatchedBrowserStoreConfig<E>) {
  let transport: WatchedBrowserCall | null = null
  let frameSource: WatchedBrowserFrames<E> | null = null
  /** Whether the service predates holds and views: set when it says so (a bot's only). */
  let legacyService = false
  const channels = new Map<string, BrowserInputChannel>()
  const beats = new Map<string, { timer: ReturnType<typeof setInterval>; stop(): void }>()
  const needs = new Map<string, Map<number, WatchedBrowserNeed>>()
  let nextNeed = 1
  const watches = new Map<string, Watch>()
  let unsubscribeFrames: (() => void) | null = null
  /** When pictures were last known to flow, per browser. */
  const lastGood = new Map<string, number>()
  /** Holds this window gave back: an answer read before it did (a watch, a poll) never picks one up again. */
  const givenBack = new Set<string>()
  /** Holds that opened the browser in a real window: one that ends went back with its window, which is no error. */
  const windowHolds = new Set<string>()

  const call: WatchedBrowserCall = (method, params) => (transport ?? ((m, p) => window.mousse.platformRequest.request(m as never, p)))(method, params)
  const subscribeFrames: WatchedBrowserFrames<E> = (listener) => (frameSource ?? config.frames)(listener)
  const params = (key: string, extra: Record<string, unknown> = {}) => ({ ...config.owner(key), ...extra })

  const useStore = create<WatchedBrowserState<V>>((set, get) => {
    const act = async (key: string, run: () => Promise<{ browser: V; hold?: WatchedBrowserHold }>) => {
      set({ busy: true, error: null, errorDetail: null })
      try {
        const answer = await run()
        if (answer.hold) adoptHold(key, answer.hold)
        put(key, answer.browser)
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
      pane: null,
      unavailable: false,
      polling: false,
      busy: false,
      error: null,
      errorDetail: null,
      holds: {},
      inputHealth: {},
      inputNote: {},
      async load(key, frame) {
        if (get().unavailable) return
        const read = () => call(config.methods.get, params(key, { ...(frame ? { frame: true } : {}), ...(legacyService ? {} : { viewId: viewId() }) }))
        try {
          put(key, (await read().catch((cause: unknown) => {
            // An older service knows no views: asked again without.
            if (legacyService || !config.methods.legacy || !refusesViewId(cause)) throw cause
            legacyService = true
            return read()
          })).browser)
          if (frame) setStream(key, { live: true })
        } catch (cause) {
          if (missingMethod(cause)) set({ unavailable: true })
          else if (frame || watches.has(key)) setStream(key, { live: false, since: lastGood.get(key) ?? Date.now() })
        }
      },
      openPane: (key) => set({ pane: key, error: null, errorDetail: null }),
      closePane: () => set({ pane: null, error: null, errorDetail: null }),
      takeOver: (key, force) => act(key, async () => {
        const legacy = config.methods.legacy
        if (!legacyService) {
          try {
            return await call(config.methods.hold, params(key, { viewId: viewId(), request: { op: 'take', ...(force ? { force: true } : {}), platform: viewerPlatform() } }))
          } catch (cause) {
            if (!legacy || !missingMethod(cause)) throw cause
            legacyService = true
          }
        }
        // An older service: its own Take over, with this window's input sent one at a time.
        const answer = await call(legacy!.control, params(key, { control: 'owner' }))
        adoptHold(key, { id: LEGACY_HOLD, lastSeq: 0, computer: 'this computer' })
        return answer
      }),
      giveBack: (key) => act(key, async () => {
        const hold = get().holds[key]
        // What the person did before Give back reaches the page first.
        await channels.get(key)?.drain(1_500)
        if (hold && hold.id !== LEGACY_HOLD) givenBack.add(hold.id)
        dropHold(key)
        const legacy = config.methods.legacy
        if (legacy && (!hold || hold.id === LEGACY_HOLD)) return call(legacy.control, params(key, { control: 'bot' }))
        if (!hold) return { browser: get().views[key]! }
        return call(config.methods.hold, params(key, { viewId: viewId(), request: { op: 'release', holdId: hold.id } }))
      }),
      send(key, input, picture) {
        const channel = channels.get(key)
        if (!channel) return { seq: 0, done: Promise.resolve({ seq: 0, status: 'refused', reason: 'not-held', text: 'Take over first' } satisfies WatchedBrowserAck) }
        return channel.push(input, picture)
      },
      retry: (key) => channels.get(key)?.retry(),
      open: (key, url) => act(key, () => {
        if (!config.methods.open) throw new Error('This browser opens when its agent uses it.')
        return call(config.methods.open, params(key, { ...(url ? { url } : {}), ...(legacyService ? {} : { viewId: viewId(), platform: viewerPlatform() }) }))
      }),
      inWindow: (key, op) => act(key, async () => {
        const run = config.window?.()
        if (!run) throw new Error('This app can\'t open the browser in a window.')
        // Opening takes the browser over first: the window is this person's for as long as they hold it.
        let taken = false
        if (op === 'open' && !get().holds[key]) {
          const answer = await call(config.methods.hold, params(key, { viewId: viewId(), request: { op: 'take', platform: viewerPlatform() } })) as { browser: V; hold?: WatchedBrowserHold }
          if (answer.hold) adoptHold(key, answer.hold)
          put(key, answer.browser)
          taken = Boolean(answer.hold)
        }
        const hold = get().holds[key]
        if (!hold || hold.id === LEGACY_HOLD) throw new Error('Take over first.')
        // What the person did in the pictures reaches the page before the browser starts again.
        await channels.get(key)?.drain(1_500)
        const answer = await run({ key, viewId: viewId(), holdId: hold.id, op })
        if (answer.refused || !answer.browser) {
          // Nothing half-open: a hold taken only for the window is given back.
          if (taken) {
            givenBack.add(hold.id)
            dropHold(key)
            const released = await call(config.methods.hold, params(key, { viewId: viewId(), request: { op: 'release', holdId: hold.id } })).catch(() => undefined) as { browser?: V } | undefined
            if (released?.browser) put(key, released.browser)
          }
          throw new Error(answer.refused ?? 'The window did not open.')
        }
        if (op === 'close') {
          givenBack.add(hold.id)
          dropHold(key)
        } else windowHolds.add(hold.id)
        return { browser: answer.browser as V }
      }),
      async chooseFiles(key, chooser) {
        const hold = get().holds[key]
        const choose = config.chooseFiles()
        if (!hold || hold.id === LEGACY_HOLD || !choose) return
        try {
          const answer = await choose({ key, viewId: viewId(), holdId: hold.id, multiple: chooser.multiple, ...(chooser.site ? { site: chooser.site } : {}) })
          // Cancelled in the dialog: the card stays, and the page waits.
          if (answer.cancelled) return
          if (answer.refused) {
            setInput(key, { note: answer.refused })
            return
          }
          if (answer.token) get().send(key, { kind: 'files', token: answer.token })
        } catch (cause) {
          setInput(key, { note: errorText(cause) })
        }
      }
    }
  })

  // -- this window's holds

  function setInput(key: string, patch: { health?: ChannelHealth | null; note?: string | null; detail?: string }): void {
    useStore.setState((state) => {
      const next: Partial<WatchedBrowserState<V>> = {}
      if (patch.health !== undefined) {
        const inputHealth = { ...state.inputHealth }
        if (patch.health && patch.health !== 'ok') inputHealth[key] = patch.health
        else delete inputHealth[key]
        next.inputHealth = inputHealth
      }
      if (patch.note !== undefined) {
        const inputNote = { ...state.inputNote }
        if (patch.note) inputNote[key] = { text: patch.note, at: Date.now(), ...(patch.detail ? { detail: patch.detail } : {}) }
        else delete inputNote[key]
        next.inputNote = inputNote
      }
      return next
    })
  }

  /** This window holds the browser (taken now, or picked up again after a reload): its channel and heartbeat. */
  function adoptHold(key: string, hold: WatchedBrowserHold): void {
    if (givenBack.has(hold.id)) return
    const known = useStore.getState().holds[key]
    if (known?.id === hold.id && channels.has(key)) return
    dropHold(key)
    const legacy = hold.id === LEGACY_HOLD
    const channel = new BrowserInputChannel({
      lastSeq: hold.lastSeq,
      send: legacy ? (inputs) => sendOneByOne(key, inputs) : (inputs) => call(config.methods.send, params(key, { viewId: viewId(), holdId: hold.id, inputs })),
      health: (health) => setInput(key, { health }),
      answered: (ack, input) => {
        if (ack.copied !== undefined && input.kind === 'copy') void writeClipboard(ack.copied)
        // A duplicate of one refused before says why it was.
        if (sayRefusal(ack) && worthSaying(input)) setInput(key, { note: ack.text ?? 'That did not reach the page', ...(ack.detail ? { detail: ack.detail } : {}) })
      }
    })
    channels.set(key, channel)
    useStore.setState((state) => ({ holds: { ...state.holds, [key]: { id: hold.id, computer: hold.computer } } }))
    if (legacy) return
    // Said every 5 seconds while this window holds it, whatever is on screen: a window that goes away lets it go after 2 minutes.
    let unanswered = false
    const beat = () => {
      void call(config.methods.hold, params(key, { viewId: viewId(), request: { op: 'renew', holdId: hold.id } })).then((answer: { browser: V; hold?: WatchedBrowserHold }) => {
        // The service answers again after it did not: the hold goes on at its last number, and what has no answer goes again.
        if (unanswered && answer.hold) channels.get(key)?.resume(answer.hold.lastSeq)
        unanswered = false
        put(key, answer.browser)
      }, (cause) => {
        if (String((cause as { code?: unknown } | null)?.code ?? '') === 'hold_ended' || /don't hold this browser/i.test(errorText(cause))) {
          // A browser in a window goes back when its window closes: nothing went wrong, the view reads it again.
          const inWindow = windowHolds.has(hold.id) || Boolean(useStore.getState().views[key]?.windowed)
          dropHold(key, 'You don\'t hold the browser now')
          if (inWindow) void useStore.getState().load(key, false)
          else useStore.setState({ error: 'You no longer hold this browser: it went back while this window was away. Take over to use it again.', errorDetail: null })
        } else unanswered = true
      })
    }
    // A window shown again asks at once: a hold that ended while it was hidden is said now, not at the next beat.
    const shown = () => { if (typeof document === 'undefined' || document.visibilityState === 'visible') beat() }
    if (typeof document !== 'undefined') document.addEventListener('visibilitychange', shown)
    beats.set(key, { timer: setInterval(beat, WATCHED_BROWSER_HOLD_BEAT_MS), stop: () => { if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', shown) } })
  }

  /** This window no longer holds the browser: what it sent with no answer is refused here. */
  function dropHold(key: string, why?: string): void {
    const beat = beats.get(key)
    if (beat) {
      clearInterval(beat.timer)
      beat.stop()
    }
    beats.delete(key)
    channels.get(key)?.close(why)
    channels.delete(key)
    setInput(key, { health: null })
    useStore.setState((state) => {
      if (!state.holds[key]) return state
      const holds = { ...state.holds }
      delete holds[key]
      return { holds }
    })
  }

  /** An older service takes one input per call: answered as applied when it went, refused when it did not. */
  async function sendOneByOne(key: string, inputs: WatchedBrowserSent[]): Promise<{ acks: WatchedBrowserAck[]; lastSeq: number }> {
    const acks: WatchedBrowserAck[] = []
    for (const sent of inputs) {
      // An older service counts nothing: a skip is answered here.
      if ('skip' in sent) {
        acks.push({ seq: sent.seq, status: 'refused', reason: 'skipped' })
        continue
      }
      try {
        put(key, (await call(config.methods.legacy!.input, params(key, { input: sent.input }))).browser)
        acks.push({ seq: sent.seq, status: 'applied' })
      } catch (cause) {
        acks.push({ seq: sent.seq, status: 'refused', reason: 'failed', text: errorText(cause) })
      }
    }
    return { acks, lastSeq: inputs.at(-1)?.seq ?? 0 }
  }

  /** Puts a view read from the service: a view without a picture keeps the last one, and nothing new re-renders nothing. */
  function put(key: string, view: V): void {
    // This window holds it (a window that reloaded picks its hold up again, at the service's last number).
    if (view.holder === 'this-view' && view.hold && !legacyService) adoptHold(key, view.hold)
    // A hold whose browser is in a window (this app reloaded while it was): it goes back with that window.
    if (view.windowed && view.hold) windowHolds.add(view.hold.id)
    useStore.setState((state) => {
      const previous = state.views[key]
      const frame = view.frame && previous?.frame && samePicture(view.frame, previous.frame) ? previous.frame : view.frame ?? previous?.frame
      const next = { ...view, ...(frame ? { frame } : {}) }
      if (previous && sameView(previous, next)) return state
      return { views: { ...state.views, [key]: next } }
    })
  }

  function setStream(key: string, stream: WatchedBrowserStream): void {
    if (stream.live) lastGood.set(key, Date.now())
    useStore.setState((state) => {
      const current = state.streams[key]
      if (current && current.live === stream.live && (stream.live || (current as { since: number }).since === stream.since)) return state
      return { streams: { ...state.streams, [key]: stream } }
    })
  }

  // -- what is seen, and the one watch per browser it asks for

  function onFrame(event: E): void {
    const key = config.keyOf(event)
    if (key === undefined) return
    const watch = watches.get(key)
    if (!watch || watch.watchId !== event.watchId) return
    useStore.setState((state) => {
      const previous = state.views[key]
      if (!previous) return state
      const viewport = event.viewport ?? previous.frame?.viewport ?? { width: 1280, height: 720 }
      const next: V = { ...previous }
      if (event.frame) next.frame = { data: event.frame.data, mimeType: event.frame.mimeType, width: event.frame.width, height: event.frame.height, viewport, at: event.frame.at, ...(event.frame.id !== undefined ? { id: event.frame.id } : {}) }
      else if (event.viewport && previous.frame) next.frame = { ...previous.frame, viewport }
      // Who holds the browser, as the service tells every view at once.
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
      return { views: { ...state.views, [key]: next } }
    })
    // Only the service's word, or a new picture, changes whether pictures can arrive.
    if (event.stalled) setStream(key, { live: false, since: lastGood.get(key) ?? Date.now() })
    else if (event.live || event.frame) setStream(key, { live: true })
    // This window's hold ended without its Give back (taken in another window, run out), or another holds it now.
    const held = useStore.getState().holds[key]
    if (held && held.id !== LEGACY_HOLD && (event.holdEnded || (event.holder && event.holder !== 'this-view'))) {
      dropHold(key, event.holdEnded === 'taken' || event.holder === 'another-view' ? 'Taken over in another window' : 'You don\'t hold the browser now')
    }
  }

  /** What the browser's seen views need together: the widest, the fastest. */
  function merged(key: string): WatchedBrowserNeed | undefined {
    const list = [...(needs.get(key)?.values() ?? [])]
    if (!list.length) return undefined
    return { width: Math.max(...list.map((need) => need.width)), fps: Math.max(...list.map((need) => need.fps)) }
  }

  /** Starts, changes or stops the browser's watch to match what is seen now. */
  function syncWatch(key: string): void {
    const need = merged(key)
    const store = useStore.getState()
    let watch = watches.get(key)
    if (store.unavailable) {
      stopWatch(key)
      return
    }
    if (!need) {
      // A moment's grace: a view that moves on the page (unmounted, then mounted again) keeps its watch.
      if (watch && !watch.stopping) watch.stopping = setTimeout(() => { if (!merged(key)) stopWatch(key) }, STOP_GRACE_MS)
      return
    }
    if (watch?.stopping) {
      clearTimeout(watch.stopping)
      watch.stopping = undefined
    }
    if (watch && watch.width === need.width && watch.fps === need.fps) return
    if (!watch) {
      watch = { watchId: `w${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36)}`, width: need.width, fps: need.fps, retryMs: RETRY_MS, stopped: false }
      watches.set(key, watch)
      unsubscribeFrames ??= subscribeFrames(onFrame)
    }
    watch.width = need.width
    watch.fps = need.fps
    if (store.polling) startPolling(key, watch)
    else void renew(key, watch)
  }

  async function renew(key: string, watch: Watch): Promise<void> {
    if (watch.renew) clearTimeout(watch.renew)
    watch.renew = undefined
    // A service that does not answer (it hangs, rather than fails) is not updating either.
    const unanswered = setTimeout(() => {
      if (!watch.stopped) setStream(key, { live: false, since: lastGood.get(key) ?? Date.now() })
    }, RENEW_ANSWER_MS)
    try {
      const ask = () => call(config.methods.watch, params(key, { watchId: watch.watchId, width: watch.width, fps: watch.fps, ...(legacyService ? {} : { viewId: viewId() }) }))
      const { browser } = await ask().catch((cause: unknown) => {
        if (legacyService || !config.methods.legacy || !refusesViewId(cause)) throw cause
        legacyService = true
        return ask()
      }) as { browser: V }
      clearTimeout(unanswered)
      if (watch.stopped) return
      put(key, browser)
      // The service answers whether pictures can reach this view now: a renewal never makes it live by itself.
      setStream(key, browser.stalled ? { live: false, since: lastGood.get(key) ?? Date.now() } : { live: true })
      watch.retryMs = RETRY_MS
      watch.renew = setTimeout(() => { void renew(key, watch) }, WATCHED_BROWSER_RENEW_MS)
    } catch (cause) {
      clearTimeout(unanswered)
      if (watch.stopped) return
      if (missingMethod(cause)) {
        if (!config.methods.legacy) {
          useStore.setState({ unavailable: true })
          stopWatch(key)
          return
        }
        // An older service: it answers a picture each time it is asked.
        useStore.setState({ polling: true })
        startPolling(key, watch)
        return
      }
      setStream(key, { live: false, since: lastGood.get(key) ?? Date.now() })
      watch.renew = setTimeout(() => { void renew(key, watch) }, watch.retryMs)
      watch.retryMs = Math.min(WATCHED_BROWSER_RENEW_MS, watch.retryMs * 2)
    }
  }

  function startPolling(key: string, watch: Watch): void {
    if (watch.poll || watch.stopped) return
    const tick = async () => {
      const started = Date.now()
      await useStore.getState().load(key, true)
      if (watch.stopped) return
      // Start to start: the time a read takes is not added to the wait.
      watch.poll = setTimeout(() => { void tick() }, Math.max(0, WATCHED_BROWSER_FRAME_MS - (Date.now() - started)))
    }
    watch.poll = setTimeout(() => { void tick() }, 0)
  }

  function stopWatch(key: string): void {
    const watch = watches.get(key)
    if (!watch) return
    watch.stopped = true
    watches.delete(key)
    if (watch.renew) clearTimeout(watch.renew)
    if (watch.poll) clearTimeout(watch.poll)
    if (watch.stopping) clearTimeout(watch.stopping)
    if (!useStore.getState().polling) void call(config.methods.unwatch, params(key, { watchId: watch.watchId })).catch(() => undefined)
    useStore.setState((state) => {
      if (!state.streams[key]) return state
      const streams = { ...state.streams }
      delete streams[key]
      return { streams }
    })
    if (!watches.size) {
      unsubscribeFrames?.()
      unsubscribeFrames = null
    }
  }

  // The page goes (a reload, the window closing): its watches end now, not when the service's lease runs out.
  if (typeof window !== 'undefined') window.addEventListener('pagehide', () => { for (const key of [...watches.keys()]) stopWatch(key) })

  /**
   * While `element` is on screen in a shown window, the browser is watched at `need`; scrolled out of
   * sight, the window hidden, or unmounted, it no longer is. Pass `need` undefined to need nothing.
   */
  function useWatch(key: string, element: RefObject<Element | null>, need: WatchedBrowserNeed | undefined): void {
    const id = useRef(0)
    if (!id.current) id.current = nextNeed++
    const width = need?.width
    const fps = need?.fps
    useEffect(() => {
      if (width === undefined || fps === undefined) return
      const slot = id.current
      let onScreen = typeof IntersectionObserver === 'undefined'
      const update = () => {
        const list = needs.get(key) ?? new Map<number, WatchedBrowserNeed>()
        if (onScreen && windowShown()) list.set(slot, { width, fps })
        else list.delete(slot)
        if (list.size) needs.set(key, list)
        else needs.delete(key)
        syncWatch(key)
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
        const list = needs.get(key)
        list?.delete(slot)
        if (list && !list.size) needs.delete(key)
        syncWatch(key)
      }
    }, [key, element, width, fps])
  }

  /**
   * Keeps a browser's state fresh while its surface is open: a light read every few seconds. Its
   * pictures come from what is seen of it (`useWatch`). `off` reads nothing.
   */
  function useBrowserState(key: string | undefined, off = false): V | undefined {
    const view = useStore((state) => (key ? state.views[key] : undefined))
    const unavailable = useStore((state) => state.unavailable)
    useEffect(() => {
      if (unavailable || off || !key) return
      let stopped = false
      let timer: ReturnType<typeof setTimeout> | undefined
      const tick = async () => {
        if (windowShown()) await useStore.getState().load(key, false)
        if (!stopped) timer = setTimeout(() => { void tick() }, STATE_POLL_MS)
      }
      void tick()
      return () => { stopped = true; if (timer) clearTimeout(timer) }
    }, [key, unavailable, off])
    return unavailable ? undefined : view
  }

  /** Whether a browser's pictures can arrive now (undefined while nothing of it is watched). */
  function useStream(key: string): WatchedBrowserStream | undefined {
    return useStore((state) => state.streams[key])
  }

  /** The transport the store calls through, and where pushed pictures come from; tests pass fakes. */
  function setTransport(next: WatchedBrowserCall | null, frames?: WatchedBrowserFrames<E> | null): void {
    transport = next
    frameSource = frames ?? null
    for (const key of [...watches.keys()]) stopWatch(key)
    for (const key of [...channels.keys()]) dropHold(key)
    // Another service: its holds are its own.
    givenBack.clear()
    windowHolds.clear()
    legacyService = false
    unsubscribeFrames?.()
    unsubscribeFrames = null
  }

  return { useStore, useWatch, useBrowserState, useStream, setTransport }
}
