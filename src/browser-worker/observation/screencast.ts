import type { CdpEventListener, CdpTransport } from '../cdp/transport'

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
 * - **A still page ends up sharp**: about 300 ms after the last change, one picture at full quality
 *   is taken. That also brings the last change when Chromium dropped its paint.
 * - **A tab behind is never brought to the front**: Chromium without a window paints only its front
 *   tab, and the agent acts on that one. A watched tab behind gets one still picture (a screenshot
 *   of a tab behind is fresh and leaves the front tab painting) and is marked `behind`; its
 *   screencast sends again by itself once the tab is in front.
 */

export const SCREENCAST_MAX_HEIGHT = 2160
/** The screencast's JPEG quality while the page changes. */
const MOVING_QUALITY = 60
/** The quality of the picture taken once the page is still, or of a tab behind. */
const STILL_QUALITY = 90
/** How long after the last change the still picture is taken. */
export const SETTLE_MS = 300
/** How long a screencast restarted at full quality has to send the page before a screenshot is taken instead. */
export const STILL_WAIT_MS = 400
/** How long after a still is asked for the screencast's pictures count as sharp. */
const STILL_WINDOW_MS = 1_000
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
}

export interface ViewerPicture {
  /** JPEG, base64. */
  data: string
  /** Its pixels. */
  width: number
  height: number
  /** When it was painted or taken (ms since the epoch). */
  at: number
  /** Taken at full quality once the page was still (or of a tab behind). */
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
  /** The screencast's JPEG quality now. */
  quality: number
  /** Until when the next picture is the sharp one asked for (a screencast restarted at full quality). */
  sharpenUntil: number
  starting?: Promise<void>
  latest?: ViewerPicture
  /** The last screencast picture, to drop one that repeats it. */
  lastCast?: string
  frameSeq: number
  stateSeq: number
  /** Screencast pictures not acknowledged yet. */
  held: number[]
  behind: boolean
  settle?: ReturnType<typeof setTimeout>
  settling?: Promise<void>
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
  committed(cdpSessionId: string, url: string): void {
    const capture = this.captures.get(cdpSessionId)
    if (!capture) return
    capture.info = { ...capture.info, url }
    capture.lastCast = undefined
    capture.viewportRead = false
    capture.stateSeq = this.bump()
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
      capture.stateSeq = this.bump()
      this.pump(capture)
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

  /** The tab's address and title as the session knows them (it follows every commit and title). */
  private describe(capture: TabCapture, info: ViewerTabInfo): void {
    if (capture.info.url === info.url && capture.info.title === info.title && capture.info.tabId === info.tabId) return
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
        capture = { info, viewport: { width: 1280, height: 720 }, viewportRead: false, width: 0, quality: MOVING_QUALITY, sharpenUntil: 0, frameSeq: 0, stateSeq: this.bump(), held: [], behind: false, watchers: new Set() }
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
      await this.cast(capture, MOVING_QUALITY)
    })().catch(() => {
      // A tab that cannot screencast is still pictured once it is still (`settle`).
    })
    capture.starting = starting
    await starting
    // Chromium sends the page as it is when the screencast starts, but not for a tab behind, and a
    // still picture is taken anyway if nothing came.
    this.armSettle(capture, this.settleMs)
  }

  /**
   * (Re)starts the tab's screencast at its width and `quality`. Stopped first: after a new page
   * commits Chromium may keep the screencast "active" but send nothing more, and it refuses to start
   * it again until it is stopped. Chromium sends the page as it is when a screencast starts (a tab
   * in front), without painting it again.
   */
  private async cast(capture: TabCapture, quality: number): Promise<void> {
    const sessionId = capture.info.cdpSessionId
    capture.quality = quality
    await this.cdp.send('Page.stopScreencast', {}, { sessionId, timeoutMs: 5_000 }).catch(() => undefined)
    // A new screencast counts its own pictures: the old one's are not acknowledged.
    capture.held = []
    await this.cdp.send('Page.startScreencast', {
      format: 'jpeg', quality, maxWidth: capture.width, maxHeight: SCREENCAST_MAX_HEIGHT, everyNthFrame: 1
    }, { sessionId, timeoutMs: 5_000 })
  }

  private stopCapture(capture: TabCapture, send = true): void {
    if (capture.settle) clearTimeout(capture.settle)
    capture.settle = undefined
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
    if (event.data === capture.lastCast) {
      ack()
      return
    }
    capture.lastCast = event.data
    // Pictures of a screencast started at full quality for the still page are sharp, for a moment:
    // the one Chromium sends at the start, and any a fallback screenshot made it send.
    const sharp = capture.quality === STILL_QUALITY && capture.sharpenUntil >= this.now()
    const scale = Math.min(1, capture.width / capture.viewport.width, SCREENCAST_MAX_HEIGHT / capture.viewport.height)
    capture.latest = { data: event.data, width: Math.round(capture.viewport.width * scale), height: Math.round(capture.viewport.height * scale), at: this.now(), sharp }
    capture.frameSeq = this.bump()
    // Held until a watcher takes a picture: Chromium paints no more for nobody.
    capture.held.push(event.sessionId)
    if (capture.settle) clearTimeout(capture.settle)
    capture.settle = undefined
    // The page changes again: this picture goes as it is, and the next ones at the lighter quality.
    if (!sharp && capture.quality === STILL_QUALITY) void this.cast(capture, MOVING_QUALITY).catch(() => undefined)
    this.pump(capture)
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

  /** A watcher took the latest picture: Chromium may paint again; a still page gets its sharp picture soon. */
  private handed(capture: TabCapture): void {
    const held = capture.held.splice(0)
    const sessionId = capture.info.cdpSessionId
    for (const id of held) void this.cdp.send('Page.screencastFrameAck', { sessionId: id }, { sessionId, timeoutMs: 5_000 }).catch(() => undefined)
    // A tab behind had its one still when it went behind.
    if (!capture.latest?.sharp && !capture.behind) this.armSettle(capture, this.settleMs)
  }

  private armSettle(capture: TabCapture, ms: number): void {
    if (capture.settle) clearTimeout(capture.settle)
    capture.settle = setTimeout(() => {
      capture.settle = undefined
      // Still held pictures: the page may still change; it is pictured when a watcher takes one.
      if (capture.held.length || capture.latest?.sharp || !capture.watchers.size || this.captures.get(capture.info.cdpSessionId) !== capture) return
      capture.settling ??= this.takeStill(capture).finally(() => { capture.settling = undefined })
    }, ms)
    capture.settle.unref?.()
  }

  /**
   * One picture at full quality of the tab as it is, without bringing it to the front.
   *
   * In front, the screencast starts again at full quality, and Chromium usually sends the page as it
   * is. Only when it sends nothing is a screenshot taken. A screenshot makes Chromium paint the page
   * again, which the screencast sends: those pictures, at full quality too, count as sharp for a
   * moment, so they never ask for another still (which would loop).
   *
   * Behind, the screencast sends nothing, so a screenshot it is (what it makes Chromium paint is not
   * sent while the tab is behind).
   */
  private async takeStill(capture: TabCapture): Promise<void> {
    const sessionId = capture.info.cdpSessionId
    if (!capture.width) return
    if (!capture.behind) {
      const started = capture.frameSeq
      capture.sharpenUntil = this.now() + STILL_WINDOW_MS
      try {
        await this.cast(capture, STILL_QUALITY)
      } catch {
        capture.sharpenUntil = 0
        return
      }
      await new Promise((resolve) => { setTimeout(resolve, STILL_WAIT_MS).unref?.() })
      if (capture.frameSeq !== started || this.captures.get(sessionId) !== capture || capture.behind) return
      capture.sharpenUntil = this.now() + STILL_WINDOW_MS
    }
    const before = capture.frameSeq
    try {
      const metrics = await this.cdp.send<LayoutMetrics>('Page.getLayoutMetrics', {}, { sessionId, timeoutMs: 5_000 })
      const viewportChanged = this.applyViewport(capture, metrics)
      const visual = metrics.cssVisualViewport ?? {}
      const { width, height } = capture.viewport
      const scale = Math.min(1, capture.width / width, SCREENCAST_MAX_HEIGHT / height)
      // The clip is in page coordinates: the visible viewport starts at the scroll offset.
      const shot = await this.cdp.send<{ data: string }>('Page.captureScreenshot', {
        format: 'jpeg', quality: STILL_QUALITY, fromSurface: true, captureBeyondViewport: false,
        clip: { x: visual.pageX ?? 0, y: visual.pageY ?? 0, width, height, scale }
      }, { sessionId, timeoutMs: 10_000 })
      if (this.captures.get(sessionId) !== capture) return
      // The page painted meanwhile: that newer picture stands, and this one is not sent.
      if (capture.frameSeq !== before) {
        if (viewportChanged) this.pump(capture)
        return
      }
      capture.latest = { data: shot.data, width: Math.round(width * scale), height: Math.round(height * scale), at: this.now(), sharp: true }
      capture.frameSeq = this.bump()
      this.pump(capture)
    } catch {
      // The tab closed or its renderer is busy: the last picture stands.
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
    if (behind) {
      // Its last picture may be from before it went behind: one fresh still, then nothing until it is in front.
      if (capture.latest) capture.latest = { ...capture.latest, sharp: false }
      this.armSettle(capture, 0)
    } else {
      this.armSettle(capture, this.settleMs)
    }
    return true
  }

  private update(capture: TabCapture, waiting: Waiting, picture: boolean, idle: boolean): ViewerUpdate {
    return {
      tabId: capture.info.tabId,
      url: capture.info.url,
      title: capture.info.title,
      viewport: { ...capture.viewport },
      behind: capture.behind,
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
