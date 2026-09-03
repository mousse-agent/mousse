import { randomUUID } from 'crypto'
import { homedir } from 'os'
import { join } from 'path'

/**
 * Dev-only bridge between the MMS daemon (where orchestrator tools execute)
 * and the Electron GUI (which owns the BrowserWindow).
 *
 * The daemon cannot touch Electron APIs directly: the GUI polls
 * `gui.devtoolsPoll` for pending dev-GUI requests, executes them against the
 * live window, and answers via `gui.devtoolsRespond`. Tool calls in
 * DevGuiTools await the GUI round-trip with a bounded timeout.
 *
 * Only active in development (`npm run dev` / electron-vite). In packaged
 * builds the bridge refuses to queue work so the tools stay inert.
 */

export type DevGuiAction = 'screenshot' | 'console' | 'reload' | 'devtools' | 'evaluate'

export interface DevGuiRequest {
  id: string
  action: DevGuiAction
  payload: Record<string, unknown>
  createdAt: string
}

export interface DevGuiResult {
  ok: boolean
  /** Human-readable summary (console lines, evaluate serialization, ack). */
  text?: string
  /** Screenshot PNG as `data:image/png;base64,…` (screenshot only). */
  dataUrl?: string
  /** Absolute path of the saved screenshot copy (screenshot only). */
  savedPath?: string
  width?: number
  height?: number
  error?: string
}

export interface DevGuiBridgeStatus {
  enabled: boolean
  /** True when a dev GUI polled recently (an attached window is serving tools). */
  pollerAttached: boolean
  /** ms since the last GUI poll, or null when no GUI ever polled. */
  lastPollAgoMs: number | null
  pendingCount: number
  daemonPid: number
  mousseHome: string
}

export interface DevGuiRequestOptions {
  /**
   * Override the no-poller grace period (tests). When exceeded with no fresh
   * poll, the request fails fast instead of waiting out the full timeout.
   */
  graceMs?: number
  /** Override the poller-freshness window (tests). */
  freshMs?: number
}

interface PendingEntry {
  resolve: (result: DevGuiResult) => void
  reject: (err: Error) => void
  timer: ReturnType<typeof setTimeout>
  watchdog: ReturnType<typeof setInterval>
}

/** Default time a tool waits for the dev GUI to poll + answer. */
export const DEV_GUI_REQUEST_TIMEOUT_MS = 30_000

/**
 * A GUI polling every second counts as attached when its last poll is this fresh.
 * Kept generous so slow machines and reconnect windows don't false-negative.
 */
export const DEV_GUI_POLLER_FRESH_MS = 6_000

/**
 * Time to wait for the first GUI poll before failing fast. Covers daemon/GUI
 * cold starts (GUI usually polls within ~2s of connecting) without stalling a
 * full 30s timeout when no dev window is attached at all.
 */
export const DEV_GUI_NO_POLLER_GRACE_MS = 10_000

/** Watchdog cadence for the fail-fast check inside {@link DevGuiBridge.request}. */
const NO_POLLER_WATCHDOG_MS = 500

/** Dev GUI tools are available when the dev-managed daemon or explicit opt-in is set. */
export function isDevGuiToolsEnabled(): boolean {
  if (process.env.MOUSSE_DEV_GUI_TOOLS === '0') return false
  if (process.env.MOUSSE_DEV_GUI_TOOLS === '1') return true
  if (process.env.MOUSSE_DEV_MANAGED_DAEMON === '1') return true
  if (process.env.MOUSSE_DEV_MANAGED_DAEMON === 'true') return true
  if (process.env.ELECTRON_RENDERER_URL) return true
  return false
}

class DevGuiBridge {
  private queue: DevGuiRequest[] = []
  private inflight = new Map<string, DevGuiRequest>()
  private pending = new Map<string, PendingEntry>()
  private lastPollAt: number | null = null

  /** Queue a GUI action and wait for the dev GUI to execute it. */
  request(
    action: DevGuiAction,
    payload: Record<string, unknown> = {},
    timeoutMs: number = DEV_GUI_REQUEST_TIMEOUT_MS,
    opts: DevGuiRequestOptions = {}
  ): Promise<DevGuiResult> {
    if (!isDevGuiToolsEnabled()) {
      return Promise.reject(
        new Error(
          'Dev GUI tools are only available in development (`npm run dev`). ' +
            'The GUI is not running a dev session, so this request was not queued.'
        )
      )
    }
    const request: DevGuiRequest = {
      id: randomUUID(),
      action,
      payload,
      createdAt: new Date().toISOString()
    }
    const graceMs = opts.graceMs ?? DEV_GUI_NO_POLLER_GRACE_MS
    const freshMs = opts.freshMs ?? DEV_GUI_POLLER_FRESH_MS
    const queuedAt = Date.now()
    const result = new Promise<DevGuiResult>((resolve, reject) => {
      const settle = (fn: () => void): void => {
        const entry = this.pending.get(request.id)
        if (!entry) return
        clearTimeout(entry.timer)
        clearInterval(entry.watchdog)
        this.pending.delete(request.id)
        this.removeFromQueue(request.id)
        this.inflight.delete(request.id)
        fn()
      }
      const timer = setTimeout(() => {
        settle(() =>
          reject(
            new Error(
              `Dev GUI did not answer "${action}" within ${timeoutMs}ms. ` +
                'Is the Electron dev window running (`npm run dev`)?'
            )
          )
        )
      }, timeoutMs)
      // Fail fast when no dev GUI is attached: an attached window polls every
      // second, so waiting out the full timeout with no fresh poll only stalls
      // the turn. The grace period covers daemon/GUI cold starts.
      const watchdog = setInterval(() => {
        if (Date.now() - queuedAt < graceMs) return
        const ago = this.lastPollAgoMs()
        if (ago === null) {
          settle(() =>
            reject(
              new Error(
                `No dev GUI is attached (no window has polled for "${action}"). ` +
                  'Launch the Electron window via `npm run dev` from this session, ' +
                  'then retry. Check `mousse_gui_status` for details.'
              )
            )
          )
        } else if (ago > freshMs) {
          settle(() =>
            reject(
              new Error(
                `Dev GUI detached (last poll ${(ago / 1000).toFixed(0)}s ago) — ` +
                  `"${action}" was not executed. Reconnect the dev window and retry.`
              )
            )
          )
        }
      }, NO_POLLER_WATCHDOG_MS)
      this.pending.set(request.id, { resolve, reject, timer, watchdog })
    })
    const entry = this.pending.get(request.id)
    if (entry) {
      const originalResolve = entry.resolve
      entry.resolve = (value) => {
        clearTimeout(entry.timer)
        clearInterval(entry.watchdog)
        this.pending.delete(request.id)
        this.removeFromQueue(request.id)
        this.inflight.delete(request.id)
        originalResolve(value)
      }
    }
    this.queue.push(request)
    if (!this.isPollerAttached() && graceMs > 0) {
      console.warn(
        `[devgui] queued "${action}" (${request.id}) with no attached dev GUI ` +
          `— failing fast in ~${Math.round(graceMs / 1000)}s unless a window polls.`
      )
    }
    return result
  }

  /**
   * Take all queued requests for GUI execution (drains the queue into
   * in-flight; entries resolve via {@link respond} or expire on timeout).
   */
  poll(): DevGuiRequest[] {
    this.lastPollAt = Date.now()
    if (this.queue.length === 0) return []
    const taken = this.queue
    this.queue = []
    for (const req of taken) this.inflight.set(req.id, req)
    return taken
  }

  /** Resolve a polled request with the GUI execution outcome. */
  respond(id: string, result: DevGuiResult): boolean {
    const entry = this.pending.get(id)
    this.inflight.delete(id)
    if (!entry) return false
    entry.resolve(result)
    return true
  }

  /** ms since the last GUI poll, or null when no GUI ever polled. */
  lastPollAgoMs(now: number = Date.now()): number | null {
    return this.lastPollAt === null ? null : Math.max(0, now - this.lastPollAt)
  }

  /** True when a dev GUI polled within the freshness window. */
  isPollerAttached(now: number = Date.now()): boolean {
    const ago = this.lastPollAgoMs(now)
    return ago !== null && ago <= DEV_GUI_POLLER_FRESH_MS
  }

  /** Instant local snapshot for `mousse_gui_status` — never queued. */
  getStatus(): DevGuiBridgeStatus {
    return {
      enabled: isDevGuiToolsEnabled(),
      pollerAttached: this.isPollerAttached(),
      lastPollAgoMs: this.lastPollAgoMs(),
      pendingCount: this.pendingCount,
      daemonPid: process.pid,
      mousseHome: process.env.MOUSSE_HOME ?? join(homedir(), '.mousse')
    }
  }

  /** Pending (queued + in-flight) request count — exposed for diagnostics. */
  get pendingCount(): number {
    return this.queue.length + this.inflight.size
  }

  /**
   * Drop all queue/in-flight/pending state and poll history. Tests only —
   * keeps the process singleton isolated between cases.
   */
  resetForTests(): void {
    for (const [, entry] of this.pending) {
      clearTimeout(entry.timer)
      clearInterval(entry.watchdog)
      entry.resolve({ ok: false, error: 'DevGuiBridge reset' })
    }
    this.pending.clear()
    this.queue = []
    this.inflight.clear()
    this.lastPollAt = null
  }

  private removeFromQueue(id: string): void {
    const index = this.queue.findIndex((req) => req.id === id)
    if (index >= 0) this.queue.splice(index, 1)
  }
}

/** Daemon-process singleton (mirrors the userQuestionService pattern). */
export const devGuiBridge = new DevGuiBridge()
