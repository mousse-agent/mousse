import type { CdpEventListener, CdpTransport } from '../cdp/transport'
import type { BrowserProblem } from '../../shared/browser/navigation'

/**
 * The pictures of a managed tab a person watches (a bot's browser view), for every viewer at once.
 *
 * - **One capture per tab**, shared by its watchers: a CDP screencast that sends a JPEG when the
 *   page paints, at the widest size a watcher asked for. A page that does not change sends nothing,
 *   and a picture the same as the last one is dropped. No watcher, no screencast.
 * - **Each watcher has one slot**: its next picture waits for its long-poll (`next`), at most
 *   `maxFps` a second. A picture painted meanwhile replaces the waiting one ("latest wins"), so a
 *   slow watcher drops pictures and never queues them.
 * - **Chromium is not asked for pictures nobody takes**: a painted picture is acknowledged only once
 *   a watcher takes one, so while every watcher is busy (or held back by its cap) Chromium keeps the
 *   few it sent and paints no more for the screencast.
 * - **The screencast runs at one quality** and is started again only for a new page or a new width.
 * - **A still page ends up sharp**: about 300 ms after the last new picture, one screenshot at full
 *   quality is taken, without touching the screencast. When that picture keeps being replaced soon
 *   after (a page that changes every second), the wait doubles, up to about 5 s, so such a page
 *   costs its changes and no extra pictures.
 * - **A page flipping between pictures it showed a moment ago** (a blinking caret, the screencast's
 *   own repaint after a screenshot) sends the flip back once, then at most one every 5 s, then
 *   10, 20, 40 and 60 s, unless the agent or the person acted on the tab since (then it goes at
 *   once). The view is never left on a picture the page no longer shows for longer than that gap.
 * - **No picture is larger than `MAX_PICTURE_CHARS`**: a larger one is replaced by a still at a
 *   lower quality, or smaller.
 * - **A tab behind is never brought to the front**: Chromium without a window paints only its front
 *   tab, and the agent acts on that one. A watched tab behind gets one still picture (a screenshot
 *   of a tab behind is fresh and leaves the front tab painting) and is marked `behind`; its
 *   screencast sends again by itself once the tab is in front.
 */

export const SCREENCAST_MAX_HEIGHT = 2160
/** The screencast's JPEG quality. */
const CAST_QUALITY = 60
/** The quality of the picture taken once the page is still, or of a tab behind. */
const STILL_QUALITY = 90
/** How long after the last new picture the still picture is taken, at first. */
export const SETTLE_MS = 300
/** The longest that wait grows to for a page whose still picture keeps being replaced at once. */
export const MAX_SETTLE_MS = 4_800
/** A still picture replaced sooner than this was not worth taking: the next wait is twice as long. */
const STILL_STANDS_MS = 2_000
/** Screencast pictures this soon after a screenshot that repeat a recent picture are its echo. */
const ECHO_MS = 250
/** How many of a tab's recent pictures a repeat is looked for in. */
const RECENT_PICTURES = 4
/** The first wait before a repeat of a recent picture is sent; it doubles up to `MAX_REPEAT_GAP_MS`. */
export const REPEAT_GAP_MS = 5_000
export const MAX_REPEAT_GAP_MS = 60_000
/** An action of the agent or the person on a tab counts this long: what it brings back is sent at once. */
const ACTED_MS = 2_000
/**
 * The largest picture handed out, in base64 characters: the daemon pushes each picture to a view in
 * one connection event of at most 1 MB.
 */
export const MAX_PICTURE_CHARS = 900_000
/** A watcher with no long-poll waiting for this long is gone (its daemon stopped asking). */
const WATCHER_LEASE_MS = 5_000
/** The longest a long-poll waits before it is answered with nothing new. */
export const MAX_WAIT_MS = 25_000

export interface ViewerTabInfo {
  /** The tab's CDP session. */
  cdpSessionId: string
  /** The tab's public id. */
  tabId: string
  url: string
  title: string
  /** The tab's main document now: it changes with each page the tab shows. */
  page?: string
}

export interface ViewerPicture {
  /** JPEG, base64. */
  data: string
  /** Its pixels. */
  width: number
  height: number
  /** When it was painted or taken (ms since the epoch). */
  at: number
  /** The still picture, taken once the page was still (or of a tab behind), at the best quality that fits. */
  sharp: boolean
}

/** What a watcher's long-poll answers: the tab's state, and its latest picture when the watcher has not had it. */
export interface ViewerUpdate {
  tabId: string
  url: string
  title: string
  viewport: { width: number; height: number }
  /** The tab is not the one in front: Chromium does not paint it, so its picture is a still. */
  behind: boolean
  /** The page is still loading. */
  loading: boolean
  /** What its last navigation ran into, or what the opened page needs. */
  problem?: BrowserProblem
  /** Pass back as `afterFrame` / `afterState`. */
  frameSeq: number
  stateSeq: number
  picture?: ViewerPicture
  /** Nothing changed within the wait. */
  idle?: true
}

export interface ViewerNextRequest {
  watchKey: string
  maxWidth: number
  maxFps: number
  afterFrame: number
  afterState: number
  waitMs: number
  signal?: AbortSignal
}

export interface ViewerCapturesOptions {
  /** Whether the tab is not the one in front (Chromium paints only that one). */
  behind(cdpSessionId: string): boolean
  /** Whether the tab's page is still loading when its capture starts. */
  loading?(cdpSessionId: string): boolean
  /** What the tab's last navigation ran into when its capture starts. */
  problem?(cdpSessionId: string): BrowserProblem | undefined
  now?: () => number
  settleMs?: number
  leaseMs?: number
}

interface ScreencastFrameEvent {
  data?: string
  sessionId?: number
}

interface Waiting {
  afterFrame: number
  afterState: number
  resolve(update: ViewerUpdate): void
  timers: Array<ReturnType<typeof setTimeout>>
  /** Waiting for the watcher's cap before its next picture. */
  capped?: ReturnType<typeof setTimeout>
  cancel(): void
}

interface Watcher {
  key: string
  capture: TabCapture
  maxWidth: number
  minIntervalMs: number
  /** When it was last handed a picture. */
  lastPictureAt: number
  /** When it last asked. */
  seenAt: number
  waiting?: Waiting
  /** A legacy reader (`frame`): it takes the latest when it asks and never waits. */
  legacy?: boolean
  /** New to this tab: its first answer carries the tab's state and picture whatever it passed. */
  fresh: boolean
}

interface TabCapture {
  info: ViewerTabInfo
  viewport: { width: number; height: number }
  /** Read since the capture started or its page last committed. */
  viewportRead: boolean
  /** The screencast's width now, 0 while it is stopped. */
  width: number
  starting?: Promise<void>
  latest?: ViewerPicture
  /** The last screencast picture, to drop one that repeats it. */
  lastCast?: string
  /** The tab's last few distinct screencast pictures (since its page committed or it came to the front). */
  recent: string[]
  /** The screencast picture `latest` shows (itself, or the one a still was taken over). */
  shownCast?: string
  frameSeq: number
  stateSeq: number
  /** The `frameSeq` a watcher last took. */
  handedSeq: number
  /** A repeat sent late: no still picture follows it. */
  quietSeq: number
  /** Screencast pictures not acknowledged yet. */
  held: number[]
  behind: boolean
  /** The page is still loading. */
  loading: boolean
  /** What its last navigation ran into, or what the opened page needs. */
  problem?: BrowserProblem
  settle?: ReturnType<typeof setTimeout>
  settling?: Promise<void>
  /** A still was asked for while another was under way. */
  stillAgain?: boolean
  /** How long after a new picture the still is taken now. */
  settleMs: number
  /** When the still now shown was taken (until a picture replaces it). */
  stillAt?: number
  /** Until when a screencast picture is the echo of a screenshot. */
  echoUntil: number
  /** The last still handed, and how it was taken: a second one taken the same way tells whether the page changed. */
  lastStill?: { data: string; params: Record<string, unknown> }
  /** An echo never seen before: the page may have changed as the still was taken. */
  echoPending?: string
  /** Checks of an echo since the last new picture (bounded). */
  echoChecks: number
  /** The latest repeat not sent yet, and when it goes. */
  repeat?: string
  repeatTimer?: ReturnType<typeof setTimeout>
  /** The wait before the next repeat goes (0: the next goes at once). */
  repeatGapMs: number
  /** When the agent or the person last acted on the tab. */
  actedAt: number
  watchers: Set<Watcher>
}

export class ViewerCaptures {
  private readonly captures = new Map<string, TabCapture>()
  private readonly watchers = new Map<string, Watcher>()
  private readonly now: () => number
  private readonly settleMs: number
  private readonly leaseMs: number
  private sweep: ReturnType<typeof setInterval> | undefined
  private disposed = false
  /** One counter for every capture's pictures and states, so numbers never go back when a capture starts again. */
  private seq = 0

  private bump(): number {
    this.seq += 1
    return this.seq
  }

  constructor(private readonly cdp: CdpTransport, private readonly options: ViewerCapturesOptions) {
    this.now = options.now ?? Date.now
    this.settleMs = options.settleMs ?? SETTLE_MS
    this.leaseMs = options.leaseMs ?? WATCHER_LEASE_MS
    cdp.on('Page.screencastFrame', this.onFrame)
  }

  /** How many tabs are being captured. */
  get active(): number {
    return this.captures.size
  }

  /** Whether a tab is being captured for someone watching. */
  watching(cdpSessionId: string): boolean {
    return this.captures.has(cdpSessionId)
  }

  /**
   * A watcher's long-poll: answers as soon as the tab has something the watcher has not seen (a
   * picture at most `maxFps` a second, or a change of state), or with `idle` after `waitMs`.
   */
  async next(info: ViewerTabInfo, request: ViewerNextRequest): Promise<ViewerUpdate> {
    if (this.disposed) throw new Error('The viewer is closed')
    const watcher = this.watcher(request.watchKey, info)
    watcher.maxWidth = request.maxWidth
    watcher.minIntervalMs = 1_000 / Math.max(1, request.maxFps)
    watcher.seenAt = this.now()
    const capture = watcher.capture
    // A second request of the same watcher answers the first (with nothing new): it is never left waiting.
    if (watcher.waiting) watcher.waiting.resolve(this.update(capture, watcher.waiting, false, true))
    this.describe(capture, info)
    await this.start(capture)
    this.refreshBehind(capture)
    return new Promise<ViewerUpdate>((resolve) => {
      const waiting: Waiting = {
        afterFrame: request.afterFrame,
        afterState: request.afterState,
        timers: [],
        resolve: (update) => { waiting.cancel(); resolve(update) },
        cancel: () => {
          for (const timer of waiting.timers) clearTimeout(timer)
          waiting.timers = []
          request.signal?.removeEventListener('abort', onAbort)
          if (watcher.waiting === waiting) watcher.waiting = undefined
          watcher.seenAt = this.now()
        }
      }
      const onAbort = () => waiting.resolve(this.update(capture, waiting, false, true))
      watcher.waiting = waiting
      waiting.timers.push(setTimeout(() => waiting.resolve(this.update(capture, waiting, false, true)), Math.min(MAX_WAIT_MS, Math.max(0, request.waitMs))))
      request.signal?.addEventListener('abort', onAbort, { once: true })
      if (request.signal?.aborted) onAbort()
      else this.pump(capture)
    })
  }

  /**
   * The latest picture of a tab for a reader that asks each time (`frame`, the older view), starting
   * the tab's capture when needed. Undefined until there is one: the caller takes it then (`keep`).
   */
  async latest(info: ViewerTabInfo, maxWidth: number): Promise<{ picture?: ViewerPicture; viewport: { width: number; height: number } }> {
    const watcher = this.watcher(`legacy:${info.cdpSessionId}`, info)
    watcher.legacy = true
    watcher.maxWidth = maxWidth
    watcher.seenAt = this.now()
    const capture = watcher.capture
    this.describe(capture, info)
    await this.start(capture)
    this.refreshBehind(capture)
    if (capture.latest) this.handed(capture)
    return { ...(capture.latest ? { picture: capture.latest } : {}), viewport: capture.viewport }
  }

  /** A picture the caller took of a watched tab: the latest until the page paints again. */
  keep(cdpSessionId: string, picture: ViewerPicture): void {
    const capture = this.captures.get(cdpSessionId)
    if (!capture) return
    capture.latest = picture
    capture.shownCast = undefined
    capture.frameSeq = this.bump()
    this.pump(capture)
  }

  /** A watcher stops: its long-poll is answered, and a tab nobody watches stops its screencast. */
  stop(watchKey: string): void {
    const watcher = this.watchers.get(watchKey)
    if (!watcher) return
    this.watchers.delete(watchKey)
    const capture = watcher.capture
    capture.watchers.delete(watcher)
    if (watcher.waiting) watcher.waiting.resolve(this.update(capture, watcher.waiting, false, true))
    if (!capture.watchers.size) this.stopCapture(capture)
    else void this.start(capture)
  }

  /** A new page committed in a tab: its screencast starts again (Chromium may stop sending after a commit), and its size is read again. */
  committed(cdpSessionId: string, url: string, page?: string): void {
    const capture = this.captures.get(cdpSessionId)
    if (!capture) return
    capture.info = { ...capture.info, url, ...(page ? { page } : {}) }
    capture.lastCast = undefined
    capture.viewportRead = false
    capture.stateSeq = this.bump()
    // A new page: what the last one showed says nothing about it, and its still comes as soon as it settles.
    this.forgetRecent(capture)
    capture.settleMs = this.settleMs
    if (capture.width) {
      capture.width = 0
      void this.start(capture)
    }
    this.pump(capture)
  }

  /** The page's title changed. */
  titled(cdpSessionId: string, title: string): void {
    const capture = this.captures.get(cdpSessionId)
    if (!capture || capture.info.title === title) return
    capture.info = { ...capture.info, title }
    capture.stateSeq = this.bump()
    this.pump(capture)
  }

  /** The page's viewport may have changed: read it again. */
  resized(cdpSessionId: string): void {
    const capture = this.captures.get(cdpSessionId)
    if (!capture) return
    void this.readViewport(capture).then((changed) => { if (changed) this.pump(capture) })
  }

  /** The agent cursor moved in a tab: its watchers hear of it at once (it is drawn over the picture). */
  cursorMoved(tabId: string): void {
    for (const capture of this.captures.values()) {
      if (capture.info.tabId !== tabId) continue
      capture.actedAt = this.now()
      capture.stateSeq = this.bump()
      this.pump(capture)
    }
  }

  /** The agent or the person acted on a tab: what it changes is sent at once, even a picture it showed before. */
  acted(tabId: string): void {
    for (const capture of this.captures.values()) {
      if (capture.info.tabId === tabId) capture.actedAt = this.now()
    }
  }

  /** Another tab came to the front (or went): each watched tab's `behind` is checked again. */
  frontChanged(): void {
    for (const capture of this.captures.values()) {
      if (this.refreshBehind(capture)) this.pump(capture)
    }
  }

  /** The tab closed or detached. */
  forget(cdpSessionId: string): void {
    const capture = this.captures.get(cdpSessionId)
    if (!capture) return
    for (const watcher of [...capture.watchers]) {
      this.watchers.delete(watcher.key)
      if (watcher.waiting) watcher.waiting.resolve(this.update(capture, watcher.waiting, false, true))
    }
    capture.watchers.clear()
    this.stopCapture(capture, false)
  }

  dispose(): void {
    this.disposed = true
    if (this.sweep) clearInterval(this.sweep)
    this.sweep = undefined
    for (const capture of [...this.captures.values()]) this.forget(capture.info.cdpSessionId)
    this.cdp.off('Page.screencastFrame', this.onFrame)
  }

  // -- watchers and captures

  /** The tab's page is loading (or stopped loading). */
  loading(cdpSessionId: string, loading: boolean): void {
    const capture = this.captures.get(cdpSessionId)
    if (!capture || capture.loading === loading) return
    capture.loading = loading
    capture.stateSeq = this.bump()
    this.pump(capture)
  }

  /** What the tab's last navigation ran into (or needs), or nothing. */
  problem(cdpSessionId: string, problem: BrowserProblem | undefined): void {
    const capture = this.captures.get(cdpSessionId)
    if (!capture || JSON.stringify(capture.problem) === JSON.stringify(problem)) return
    capture.problem = problem
    capture.stateSeq = this.bump()
    this.pump(capture)
  }

  /** The tab's address and title as the session knows them (it follows every commit and title). */
  private describe(capture: TabCapture, info: ViewerTabInfo): void {
    if (capture.info.url === info.url && capture.info.title === info.title && capture.info.tabId === info.tabId && capture.info.page === info.page) return
    capture.info = { ...info }
    capture.stateSeq = this.bump()
  }

  private watcher(key: string, info: ViewerTabInfo): Watcher {
    let watcher = this.watchers.get(key)
    if (watcher && watcher.capture.info.cdpSessionId !== info.cdpSessionId) {
      // The watcher moved to another tab: the first stops when nobody else watches it.
      this.stop(key)
      watcher = undefined
    }
    if (!watcher) {
      let capture = this.captures.get(info.cdpSessionId)
      if (!capture) {
        capture = {
          info, viewport: { width: 1280, height: 720 }, viewportRead: false, width: 0, recent: [], frameSeq: 0, stateSeq: this.bump(),
          handedSeq: 0, quietSeq: -1, held: [], behind: false, loading: this.options.loading?.(info.cdpSessionId) ?? false,
          settleMs: this.settleMs, echoUntil: 0, echoChecks: 0, repeatGapMs: 0, actedAt: 0, watchers: new Set()
        }
        const problem = this.options.problem?.(info.cdpSessionId)
        if (problem) capture.problem = problem
        this.captures.set(info.cdpSessionId, capture)
      }
      watcher = { key, capture, maxWidth: 960, minIntervalMs: 0, lastPictureAt: 0, seenAt: this.now(), fresh: true }
      capture.watchers.add(watcher)
      this.watchers.set(key, watcher)
    }
    this.sweep ??= setInterval(() => this.dropGone(), Math.max(250, Math.floor(this.leaseMs / 2)))
    this.sweep.unref?.()
    return watcher
  }

  /** Watchers that stopped asking (no long-poll waiting for a while) are dropped. */
  private dropGone(): void {
    const now = this.now()
    for (const watcher of [...this.watchers.values()]) {
      if (!watcher.waiting && now - watcher.seenAt > this.leaseMs) this.stop(watcher.key)
    }
    if (!this.watchers.size && this.sweep) {
      clearInterval(this.sweep)
      this.sweep = undefined
    }
  }

  /** Starts (or resizes) the tab's screencast to the widest watcher. */
  private async start(capture: TabCapture): Promise<void> {
    const width = Math.max(160, ...[...capture.watchers].map((watcher) => watcher.maxWidth))
    if (capture.width === width) {
      await capture.starting
      return
    }
    capture.width = width
    const starting = (async () => {
      if (!capture.viewportRead) {
        capture.viewportRead = true
        await this.readViewport(capture)
      }
      await this.cast(capture)
    })().catch(() => {
      // A tab that cannot screencast is still pictured once it is still (`settle`).
    })
    capture.starting = starting
    await starting
    // Chromium sends the page as it is when the screencast starts, but not for a tab behind, and a
    // still picture is taken anyway if nothing came.
    this.armSettle(capture, capture.settleMs)
  }

  /**
   * (Re)starts the tab's screencast at its width: for a new watcher's width, or a new page. Stopped
   * first: after a new page commits Chromium may keep the screencast "active" but send nothing more,
   * and it refuses to start it again until it is stopped. Chromium sends the page as it is when a
   * screencast starts (a tab in front), without painting it again.
   */
  private async cast(capture: TabCapture): Promise<void> {
    const sessionId = capture.info.cdpSessionId
    await this.cdp.send('Page.stopScreencast', {}, { sessionId, timeoutMs: 5_000 }).catch(() => undefined)
    // A new screencast counts its own pictures: the old one's are not acknowledged. At another width its pictures differ.
    capture.held = []
    this.forgetRecent(capture)
    await this.cdp.send('Page.startScreencast', {
      format: 'jpeg', quality: CAST_QUALITY, maxWidth: capture.width, maxHeight: SCREENCAST_MAX_HEIGHT, everyNthFrame: 1
    }, { sessionId, timeoutMs: 5_000 })
  }

  /** The tab's recent pictures no longer count as repeats (a new page, a new width, back in front). */
  private forgetRecent(capture: TabCapture): void {
    capture.recent = []
    capture.repeat = undefined
    if (capture.repeatTimer) clearTimeout(capture.repeatTimer)
    capture.repeatTimer = undefined
    capture.repeatGapMs = 0
  }

  private stopCapture(capture: TabCapture, send = true): void {
    if (capture.settle) clearTimeout(capture.settle)
    capture.settle = undefined
    this.forgetRecent(capture)
    this.captures.delete(capture.info.cdpSessionId)
    const held = capture.held.splice(0)
    if (!send || !capture.width) return
    capture.width = 0
    const sessionId = capture.info.cdpSessionId
    for (const id of held) void this.cdp.send('Page.screencastFrameAck', { sessionId: id }, { sessionId, timeoutMs: 5_000 }).catch(() => undefined)
    void this.cdp.send('Page.stopScreencast', {}, { sessionId, timeoutMs: 5_000 }).catch(() => undefined)
  }

  private readonly onFrame: CdpEventListener = (params, sessionId) => {
    const event = params as ScreencastFrameEvent
    if (!sessionId || typeof event?.sessionId !== 'number') return
    const capture = this.captures.get(sessionId)
    const ack = () => void this.cdp.send('Page.screencastFrameAck', { sessionId: event.sessionId }, { sessionId, timeoutMs: 5_000 }).catch(() => undefined)
    if (!capture || !capture.width || typeof event.data !== 'string') {
      ack()
      return
    }
    // Chromium does not paint a tab behind: a picture now is one our own still forced. It is not
    // sent, or each still would bring another.
    if (capture.behind) {
      ack()
      return
    }
    // The same picture again (a paint that changed nothing visible): nothing to send.
    const data = event.data
    if (data === capture.lastCast) {
      ack()
      return
    }
    capture.lastCast = data
    const now = this.now()
    const recent = capture.recent.includes(data)
    // A screenshot makes Chromium paint the page again, which the screencast sends (another encoding
    // of the same page, or one it sent before): that echo is not a change. One never seen may hide a
    // change made as the still was taken: a second screenshot, taken the same way, tells.
    if (now <= capture.echoUntil) {
      ack()
      if (recent) return
      capture.recent = [...capture.recent, data].slice(-RECENT_PICTURES)
      capture.echoPending = data
      this.settleWith(capture, () => this.checkEcho(capture))
      return
    }
    // Too large to push to a view: a still that fits is taken instead.
    if (data.length > MAX_PICTURE_CHARS) {
      ack()
      if (capture.settling) capture.stillAgain = true
      else this.settleWith(capture, () => this.takeStill(capture))
      return
    }
    // The page went back to a picture it showed a moment ago, and nobody acted (a blinking caret, a
    // flip between two states): sent once, then at most one every growing gap.
    if (recent && now - capture.actedAt > ACTED_MS) {
      ack()
      this.holdRepeat(capture, data)
      return
    }
    capture.recent = [...capture.recent.filter((entry) => entry !== data), data].slice(-RECENT_PICTURES)
    if (capture.repeatTimer) clearTimeout(capture.repeatTimer)
    capture.repeatTimer = undefined
    capture.repeat = undefined
    capture.repeatGapMs = 0
    this.show(capture, data)
    // Held until a watcher takes a picture: Chromium paints no more for nobody.
    capture.held.push(event.sessionId)
    if (capture.settle) clearTimeout(capture.settle)
    capture.settle = undefined
    this.pump(capture)
  }

  /** A screencast picture becomes the latest. A still it replaces soon after was not worth taking: the next one waits longer. */
  private show(capture: TabCapture, data: string): void {
    const now = this.now()
    if (capture.stillAt !== undefined) {
      capture.settleMs = now - capture.stillAt < STILL_STANDS_MS
        ? Math.min(MAX_SETTLE_MS, capture.settleMs * 2)
        : Math.max(this.settleMs, capture.settleMs / 2)
      capture.stillAt = undefined
    }
    const scale = Math.min(1, capture.width / capture.viewport.width, SCREENCAST_MAX_HEIGHT / capture.viewport.height)
    capture.latest = { data, width: Math.round(capture.viewport.width * scale), height: Math.round(capture.viewport.height * scale), at: now, sharp: false }
    capture.shownCast = data
    capture.frameSeq = this.bump()
    capture.echoPending = undefined
    capture.echoChecks = 0
  }

  /**
   * A repeat of a recent picture: the first after a new picture goes at once, the next after 5 s,
   * then 10, 20, 40 and 60 s, each the latest repeat, and only when the view does not show it already.
   * No still picture follows one sent late.
   */
  private holdRepeat(capture: TabCapture, data: string): void {
    capture.repeat = data
    if (capture.repeatTimer) return
    const send = () => {
      capture.repeatTimer = undefined
      const repeat = capture.repeat
      capture.repeat = undefined
      if (!repeat || repeat === capture.shownCast || capture.behind || this.captures.get(capture.info.cdpSessionId) !== capture) return
      const late = capture.repeatGapMs > 0
      capture.repeatGapMs = late ? Math.min(MAX_REPEAT_GAP_MS, capture.repeatGapMs * 2) : REPEAT_GAP_MS
      this.show(capture, repeat)
      if (late) capture.quietSeq = capture.frameSeq
      else if (capture.settle) {
        clearTimeout(capture.settle)
        capture.settle = undefined
      }
      this.pump(capture)
    }
    if (!capture.repeatGapMs) {
      send()
      return
    }
    capture.repeatTimer = setTimeout(send, capture.repeatGapMs)
    capture.repeatTimer.unref?.()
  }

  /** Answers each waiting watcher that has something new (a picture only once its cap allows). */
  private pump(capture: TabCapture): void {
    const now = this.now()
    let handed = false
    for (const watcher of capture.watchers) {
      const waiting = watcher.waiting
      if (!waiting) continue
      const newState = watcher.fresh || capture.stateSeq > waiting.afterState
      const newPicture = Boolean(capture.latest) && (watcher.fresh || capture.frameSeq > waiting.afterFrame)
      watcher.fresh = false
      // A timer may fire a millisecond before the clock says so: within that, the cap is met.
      const wait = newPicture ? watcher.lastPictureAt + watcher.minIntervalMs - now : 0
      if (newPicture && wait > 1) {
        if (newState) waiting.resolve(this.update(capture, waiting, false, false))
        else if (!waiting.capped) {
          waiting.capped = setTimeout(() => {
            waiting.capped = undefined
            this.pump(capture)
          }, Math.ceil(wait))
          waiting.timers.push(waiting.capped)
        }
        continue
      }
      if (!newPicture && !newState) continue
      if (newPicture) {
        watcher.lastPictureAt = now
        handed = true
      }
      waiting.resolve(this.update(capture, waiting, newPicture, false))
    }
    if (handed) this.handed(capture)
  }

  /**
   * A watcher took the latest picture: Chromium may paint again. A new picture, taken for the first
   * time, means a still page gets its sharp picture soon; a reader asking again for the same one
   * (an older view, every 40 ms) does not put that off.
   */
  private handed(capture: TabCapture): void {
    const held = capture.held.splice(0)
    const sessionId = capture.info.cdpSessionId
    for (const id of held) void this.cdp.send('Page.screencastFrameAck', { sessionId: id }, { sessionId, timeoutMs: 5_000 }).catch(() => undefined)
    if (capture.handedSeq === capture.frameSeq) return
    capture.handedSeq = capture.frameSeq
    // A tab behind had its one still when it went behind; a repeat sent late is followed by none.
    if (!capture.latest?.sharp && !capture.behind && capture.quietSeq !== capture.frameSeq) this.armSettle(capture, capture.settleMs)
  }

  private armSettle(capture: TabCapture, ms: number): void {
    if (capture.settle) clearTimeout(capture.settle)
    capture.settle = setTimeout(() => {
      capture.settle = undefined
      // Still held pictures: the page may still change; it is pictured when a watcher takes one.
      if (capture.held.length || capture.latest?.sharp || !capture.watchers.size || this.captures.get(capture.info.cdpSessionId) !== capture) return
      // A still (or a check) under way was taken before this: this one is taken after it.
      if (capture.settling) capture.stillAgain = true
      else this.settleWith(capture, () => this.takeStill(capture))
    }, ms)
    capture.settle.unref?.()
  }

  /** Runs one still or echo check at a time; a still asked for meanwhile comes after it. */
  private settleWith(capture: TabCapture, work: () => Promise<void>): void {
    if (capture.settling) return
    capture.settling = work().finally(() => {
      capture.settling = undefined
      if (!capture.stillAgain) return
      capture.stillAgain = false
      this.armSettle(capture, 0)
    })
  }

  /**
   * One picture of the tab as it is, at full quality (lower, or smaller, when that would be too
   * large), without bringing it to the front and without touching its screencast: a screenshot.
   * In front, the screenshot makes Chromium paint the page again, which the screencast sends; that
   * echo repeats a recent picture and is dropped (`onFrame`). Behind, the screencast sends nothing.
   */
  private async takeStill(capture: TabCapture): Promise<void> {
    const sessionId = capture.info.cdpSessionId
    if (!capture.width) return
    const before = capture.frameSeq
    const over = capture.lastCast
    try {
      const metrics = await this.cdp.send<LayoutMetrics>('Page.getLayoutMetrics', {}, { sessionId, timeoutMs: 5_000 })
      const viewportChanged = this.applyViewport(capture, metrics)
      const visual = metrics.cssVisualViewport ?? {}
      const { width, height } = capture.viewport
      let scale = Math.min(1, capture.width / width, SCREENCAST_MAX_HEIGHT / height)
      let shot: { data: string; params: Record<string, unknown> } | undefined
      // Full quality, then lower, then half the size: the first that fits.
      for (const [quality, shrink] of [[STILL_QUALITY, 1], [CAST_QUALITY, 1], [40, 1], [40, 0.5]] as const) {
        if (capture.frameSeq !== before || this.captures.get(sessionId) !== capture) break
        // The clip is in page coordinates: the visible viewport starts at the scroll offset.
        const params = { format: 'jpeg', quality, fromSurface: true, captureBeyondViewport: false, clip: { x: visual.pageX ?? 0, y: visual.pageY ?? 0, width, height, scale: scale * shrink } }
        const data = await this.screenshot(capture, params)
        if (data.length <= MAX_PICTURE_CHARS) {
          shot = { data, params }
          scale *= shrink
          break
        }
      }
      if (this.captures.get(sessionId) !== capture) return
      // The page painted meanwhile: that newer picture stands, and this one is not sent.
      if (capture.frameSeq !== before || !shot) {
        if (viewportChanged) this.pump(capture)
        return
      }
      capture.latest = { data: shot.data, width: Math.round(width * scale), height: Math.round(height * scale), at: this.now(), sharp: true }
      capture.lastStill = shot
      capture.shownCast = over
      capture.stillAt = capture.behind ? undefined : this.now()
      capture.frameSeq = this.bump()
      this.pump(capture)
      // An echo never seen came while it was taken: is it a change?
      while (capture.echoPending && capture.echoChecks < 3) await this.checkEcho(capture)
    } catch {
      // The tab closed or its renderer is busy: the last picture stands.
    }
  }

  /** One screenshot; the screencast pictures it makes Chromium send meanwhile and just after are its echo. */
  private async screenshot(capture: TabCapture, params: Record<string, unknown>): Promise<string> {
    capture.echoUntil = Number.POSITIVE_INFINITY
    try {
      return (await this.cdp.send<{ data: string }>('Page.captureScreenshot', params, { sessionId: capture.info.cdpSessionId, timeoutMs: 10_000 })).data
    } finally {
      capture.echoUntil = this.now() + ECHO_MS
    }
  }

  /**
   * An echo never seen before came with a still: the page may have changed as it was taken. A second
   * screenshot taken the same way is the same bytes when nothing changed (Chromium encodes the same
   * page the same way), and then nothing is sent; otherwise it is the page as it is now, and goes as
   * the still. A few checks at most between two new pictures.
   */
  private async checkEcho(capture: TabCapture): Promise<void> {
    const still = capture.lastStill
    const echo = capture.echoPending
    capture.echoPending = undefined
    if (!echo || !still || capture.latest?.data !== still.data || capture.echoChecks >= 3 || this.captures.get(capture.info.cdpSessionId) !== capture) return
    capture.echoChecks += 1
    const before = capture.frameSeq
    try {
      const data = await this.screenshot(capture, still.params)
      if (capture.frameSeq !== before || this.captures.get(capture.info.cdpSessionId) !== capture || data === still.data || data.length > MAX_PICTURE_CHARS) return
      capture.latest = { ...capture.latest, data, at: this.now() }
      capture.lastStill = { data, params: still.params }
      capture.shownCast = capture.lastCast
      capture.stillAt = capture.behind ? undefined : this.now()
      capture.frameSeq = this.bump()
      this.pump(capture)
    } catch {
      // The tab closed: nothing to check.
    }
  }

  private async readViewport(capture: TabCapture): Promise<boolean> {
    try {
      const metrics = await this.cdp.send<LayoutMetrics>('Page.getLayoutMetrics', {}, { sessionId: capture.info.cdpSessionId, timeoutMs: 5_000 })
      return this.applyViewport(capture, metrics)
    } catch {
      return false
    }
  }

  private applyViewport(capture: TabCapture, metrics: LayoutMetrics): boolean {
    const visual = metrics.cssVisualViewport ?? {}
    const width = visual.clientWidth && visual.clientWidth > 0 ? Math.round(visual.clientWidth) : capture.viewport.width
    const height = visual.clientHeight && visual.clientHeight > 0 ? Math.round(visual.clientHeight) : capture.viewport.height
    if (width === capture.viewport.width && height === capture.viewport.height) return false
    capture.viewport = { width, height }
    capture.stateSeq = this.bump()
    return true
  }

  /** Whether the tab went behind or came to the front; a tab that went behind gets one still picture now. */
  private refreshBehind(capture: TabCapture): boolean {
    const behind = this.options.behind(capture.info.cdpSessionId)
    if (behind === capture.behind) return false
    capture.behind = behind
    capture.stateSeq = this.bump()
    // Pictures after it moves are compared with nothing from before.
    this.forgetRecent(capture)
    if (behind) {
      // Its last picture may be from before it went behind: one fresh still, then nothing until it is in front.
      if (capture.latest) capture.latest = { ...capture.latest, sharp: false }
      this.armSettle(capture, 0)
    } else {
      this.armSettle(capture, capture.settleMs)
    }
    return true
  }

  private update(capture: TabCapture, waiting: Waiting, picture: boolean, idle: boolean): ViewerUpdate {
    return {
      tabId: capture.info.tabId,
      url: capture.info.url,
      title: capture.info.title,
      ...(capture.info.page ? { page: capture.info.page } : {}),
      viewport: { ...capture.viewport },
      behind: capture.behind,
      loading: capture.loading,
      ...(capture.problem ? { problem: capture.problem } : {}),
      frameSeq: picture ? capture.frameSeq : waiting.afterFrame,
      stateSeq: capture.stateSeq,
      ...(picture && capture.latest ? { picture: capture.latest } : {}),
      ...(idle && !picture && capture.stateSeq <= waiting.afterState ? { idle: true as const } : {})
    }
  }
}

interface LayoutMetrics {
  cssVisualViewport?: { pageX?: number; pageY?: number; clientWidth?: number; clientHeight?: number }
}
