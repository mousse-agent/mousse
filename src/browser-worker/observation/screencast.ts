import type { CdpEventListener, CdpTransport } from '../cdp/transport'

/**
 * A screencast of the one tab a person watches (a bot's browser view). Chromium sends a JPEG each
 * time the page paints; each is acknowledged as it arrives, so the next paint follows at once, and
 * the latest is kept for `frame()`, which then costs nothing to answer. A page that does not change
 * sends nothing. The screencast stops once nobody has asked for a picture for a while.
 *
 * Only the image is kept: the frame's own metadata is not trusted for the page's size (Chromium
 * sometimes reports the scaled image's size as the device's), so `frame()` reads the viewport.
 */

export interface ScreencastPicture {
  /** The JPEG of the visible viewport, in base64, scaled to fit `maxWidth`. */
  data: string
  /** When it arrived (ms since the epoch). */
  at: number
}

interface ScreencastFrameEvent {
  data?: string
  sessionId?: number
}

/**
 * Every paint: a still page that changes once paints once, and a skipped paint would never show.
 * The screencast runs only while someone watches.
 */
const EVERY_NTH_FRAME = 1
export const SCREENCAST_MAX_HEIGHT = 2160
/**
 * A picture this old is not served: the caller takes one itself (`keep`). A safety net for a
 * screencast gone quiet, at the cost of one picture taken every so often of a still page.
 */
const STALE_MS = 2_000
/** The screencast stops when no picture was asked for in this long. */
const DEFAULT_IDLE_MS = 3_000

export class TabScreencast {
  private target: { cdpSessionId: string; maxWidth: number } | undefined
  private latest: ScreencastPicture | undefined
  private starting: Promise<void> | undefined
  private idle: ReturnType<typeof setTimeout> | undefined
  private disposed = false
  private readonly idleMs: number
  private readonly now: () => number
  private readonly quality: number

  constructor(private readonly cdp: CdpTransport, options: { idleMs?: number; now?: () => number; quality?: number } = {}) {
    this.idleMs = options.idleMs ?? DEFAULT_IDLE_MS
    this.now = options.now ?? Date.now
    this.quality = options.quality ?? 60
    cdp.on('Page.screencastFrame', this.onFrame)
  }

  /**
   * The latest painted picture of the tab, starting (or moving) the screencast to it when needed.
   * Undefined until its first picture arrives, or when the latest is stale: the caller takes one
   * itself then, and hands it to `keep`.
   */
  async watch(cdpSessionId: string, maxWidth: number): Promise<ScreencastPicture | undefined> {
    if (this.disposed) return undefined
    this.armIdle()
    if (this.target?.cdpSessionId !== cdpSessionId || this.target.maxWidth !== maxWidth) {
      const previous = this.target
      const target = { cdpSessionId, maxWidth }
      this.target = target
      this.latest = undefined
      if (previous && previous.cdpSessionId !== cdpSessionId) this.stop(previous.cdpSessionId)
      // Stopped first: after a new page commits, Chromium keeps the tab's screencast "active" but
      // sends nothing more, and refuses to start it again until it is stopped.
      this.starting = this.cdp.send('Page.stopScreencast', {}, { sessionId: cdpSessionId, timeoutMs: 5_000 }).catch(() => undefined)
        .then(() => this.cdp.send('Page.startScreencast', {
          format: 'jpeg', quality: this.quality, maxWidth, maxHeight: SCREENCAST_MAX_HEIGHT, everyNthFrame: EVERY_NTH_FRAME
        }, { sessionId: cdpSessionId, timeoutMs: 5_000 }))
        .then(() => undefined, () => {
          // A tab that cannot screencast is pictured by the caller each time instead.
          if (this.target === target) this.target = undefined
        })
    }
    await this.starting
    if (this.target?.cdpSessionId !== cdpSessionId || !this.latest) return undefined
    return this.now() - this.latest.at > STALE_MS ? undefined : this.latest
  }

  /** A picture the caller took of the watched tab: the latest until the page paints again. */
  keep(cdpSessionId: string, data: string): void {
    if (this.target?.cdpSessionId === cdpSessionId) this.latest = { data, at: this.now() }
  }

  /** The tab is gone (closed or detached), or a new page committed in it: its next picture starts again. */
  forget(cdpSessionId: string): void {
    if (this.target?.cdpSessionId !== cdpSessionId) return
    this.target = undefined
    this.latest = undefined
  }

  dispose(): void {
    this.disposed = true
    if (this.idle) clearTimeout(this.idle)
    this.idle = undefined
    this.cdp.off('Page.screencastFrame', this.onFrame)
    this.target = undefined
    this.latest = undefined
  }

  private readonly onFrame: CdpEventListener = (params, sessionId) => {
    const event = params as ScreencastFrameEvent
    if (!sessionId || typeof event?.sessionId !== 'number') return
    // Acknowledged on receipt, never after a viewer has it: Chromium sends nothing new until then,
    // and a change painted while waiting would never be sent.
    void this.cdp.send('Page.screencastFrameAck', { sessionId: event.sessionId }, { sessionId, timeoutMs: 5_000 }).catch(() => undefined)
    if (this.target?.cdpSessionId !== sessionId || typeof event.data !== 'string') return
    this.latest = { data: event.data, at: this.now() }
  }

  private stop(cdpSessionId: string): void {
    void this.cdp.send('Page.stopScreencast', {}, { sessionId: cdpSessionId, timeoutMs: 5_000 }).catch(() => undefined)
  }

  private armIdle(): void {
    if (this.idle) clearTimeout(this.idle)
    this.idle = setTimeout(() => {
      this.idle = undefined
      const target = this.target
      this.target = undefined
      this.latest = undefined
      if (target) this.stop(target.cdpSessionId)
    }, this.idleMs)
    this.idle.unref?.()
  }
}
