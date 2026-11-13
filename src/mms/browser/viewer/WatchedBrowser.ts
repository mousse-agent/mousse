import { randomUUID } from 'node:crypto'
import { stat } from 'node:fs/promises'
import { basename, isAbsolute } from 'node:path'
import {
  MAX_WATCHED_BROWSER_FILES,
  MAX_WATCHED_BROWSER_FILES_BYTES,
  WATCHED_BROWSER_FILES_LIMIT_TEXT,
  WATCHED_BROWSER_HOLD_LEASE_MS,
  WATCHED_BROWSER_PANE,
  WATCHED_BROWSER_RENEW_MS,
  type WatchedBrowserAck,
  type WatchedBrowserChooser,
  type WatchedBrowserDialog,
  type WatchedBrowserFrame,
  type WatchedBrowserHold,
  type WatchedBrowserHoldEnd,
  type WatchedBrowserHolder,
  type WatchedBrowserInput,
  type WatchedBrowserRefusal,
  type WatchedBrowserSent,
  type WatchedBrowserUpdate,
  type WatchedBrowserView
} from '../../../shared/browser/watched'
import { BROWSER_MODIFIERS, type BrowserEditCommand, type BrowserHumanInput, type BrowserPictureSpot } from '../../../shared/browser/types'
import { agentCursorLive, type BrowserAgentCursor } from '../../../shared/browser/agentCursor'
import type { BrowserSessionKeeper, BrowserToolContext } from '../../../shared/browser/automation'
import type { BrowserSessionRecord, BrowserViewerUpdate } from '../../../shared/browser/types'
import { BROWSER_PROBLEM_CODES, browserProblemForPerson, browserProblemMessage, type BrowserProblem } from '../../../shared/browser/navigation'
import { BrowserAutomationError } from '../automation/BrowserSessionManager'
import type { MmsBrowserService } from '../MmsBrowserService'
import { InputSequencer } from './InputSequencer'

/**
 * One browser without a window, as a person's views watch and hold it: the session that the profile
 * and thread own in the browser inventory (`profileId`, `threadId`), whichever one is open now
 * (`sessionId`), answering only its keeper.
 *
 * - Views watch it (`watch`): pictures of the followed tab are pushed to each watching view as the
 *   page paints (one capture shared by every view, each view with its own latest-wins slot and cap),
 *   and nothing is sent while nothing changes. `view` answers the state (and, for an older app, a frame).
 * - A view can take it over (`hold`): its numbered input then reaches the tab it took, in order, each
 *   input answered, while it says it is there (its heartbeat).
 * - Its user decides which tab the views follow (`followTab`), when a session opens and closes, and
 *   what an input waits for (`input`: the browser's turn).
 */

/** The browser surface a watched browser uses: the profile's sessions. */
export type WatchedBrowserService = Pick<MmsBrowserService, 'sessions'>

/** One view that watches the browser, on one connection. */
export interface WatchedBrowserWatcher {
  /** Sends one update; resolves once the connection has taken it. */
  emit(update: WatchedBrowserUpdate): Promise<void>
  /** Ends when the connection closes. */
  lifetime?: AbortSignal
}

export interface WatchedBrowserOptions {
  /** The profile and thread that own the session in the browser inventory. */
  profileId: string
  threadId: string
  /** The session open now; undefined while the browser is closed (it is a new one each time it opens). */
  sessionId(): string | undefined
  /** The session's keeper: it answers calls that carry it alone. */
  keeper: BrowserSessionKeeper
  /** The profile's browser composition; undefined when it is shutting down. */
  browser(): WatchedBrowserService | undefined
  /** One call in the person's scope over this browser; `signal` ends it early. */
  call<T>(call: (context: BrowserToolContext) => Promise<T>, signal?: AbortSignal): Promise<T>
  /** One input of the person's, in the browser's turn: resolves once the worker applied it. */
  input<T>(call: (context: BrowserToolContext) => Promise<T>, tabId?: string): Promise<T>
  /** A hold ended and nobody else took it on: the browser is its agent's again, and its user picks the tab the views follow. */
  givenBack?(): void
  /** A hold ran out: the view that held it went away. */
  expired?(): void
  /** What the person reads in the words of the browser's user. */
  text: {
    /** The browser is closed. */
    closed: string
    /** `MAX_BROWSER_VIEWERS` views watch it already. */
    tooManyViews: string
  }
  /** What the log calls this browser (`a <name> hold could not end`), and the fields that name it. */
  log: { name: string; fields: Record<string, unknown> }
  now?(): number
  /** How long a view's hold lasts without its heartbeat (default `WATCHED_BROWSER_HOLD_LEASE_MS`). */
  holdLeaseMs?: number
  /** The timer of a hold's lease (tests). */
  leaseTimer?(fn: () => void, ms: number): { clear(): void }
  /** The computer's name for "Not reaching …". */
  computer: string
}

/** The latest picture of the followed tab, and what it shows. */
interface Picture {
  data: string
  width: number
  height: number
  viewport: { width: number; height: number }
  /** When it was painted (ms since the epoch). */
  at: number
  sharp?: boolean
  /** Its number: input made on it names it (`WatchedBrowserSent.picture`). */
  id?: number
}

/** What one picture sent to the views showed: its tab, and the document and scroll it was taken at. */
interface PictureRecord {
  id: number
  tabId?: string
  spot?: BrowserPictureSpot
  /** When it was sent (this host's clock): pictures are remembered by time as well as by count. */
  at: number
}

/**
 * A view's hold of the browser: the view that took it (Take over), the connection it took it on,
 * the tab it took, and its input channel. It lasts while the view says it is there (`beat`); the view
 * that holds it alone sends input, on that connection, and only to that tab.
 */
export interface OwnerHold {
  id: string
  viewId: string
  /**
   * The connection that took it: a call on another one is not this hold's. A window that comes back on
   * a new connection (its old one dropped) presents the hold there and it moves, once: a connection it
   * moved away from never has it back (`retired`).
   */
  connectionId: string
  retired: Set<string>
  /** Files this computer's file dialog answered for the page's picker, by one-time token (`chooseFiles`). */
  files: Map<string, string[]>
  /** The tab the person took: their input goes to it alone, wherever the agent's runs are. */
  tabId?: string
  /** Whether the view runs on a Mac: its Command is the page's Control when the page is not on one. */
  platform: 'mac' | 'other'
  beatAt: number
  lease?: { clear(): void }
  channel: InputSequencer<WatchedBrowserSent>
  /**
   * A click on this picture (or an older one) was refused, the page having changed under it: input
   * made on those pictures (typing meant for what was clicked) is refused too.
   */
  staleThrough: number
  /** An older app's window (`control`, `input`), renewed by its calls; its inputs are numbered here. */
  legacy?: { count: number }
}

interface Viewer extends WatchedBrowserWatcher {
  key: string
  /** The connection it watches on. */
  connectionId: string
  watchId: string
  /** The view it is (its holds are its own); none for an older app. */
  viewId?: string
  width: number
  fps: number
  /** Dropped when not renewed by then. */
  until: number
  /** The update waiting for the one being delivered: newer fields replace older ones (latest wins). */
  slot?: Omit<WatchedBrowserUpdate, 'watchId'>
  delivering: boolean
  lastPictureAt: number
  timer?: { clear(): void }
  /** What it was last sent, so only changes go. */
  sent: { viewport?: string; tab?: string; cursorAt?: number | null; behind?: boolean; stalled?: boolean; loading?: boolean; problem?: string; holder?: string; dialog?: string; chooser?: string }
  /** Updates its connection refused one after another as busy. */
  busy: number
  release?: () => void
}

/** The loop that asks the worker for the followed tab's next update while views watch. */
interface Capture {
  key: string
  tabId?: string
  /** The size and rate it asked the worker for last. */
  requested?: { width: number; fps: number }
  afterFrame: number
  afterState: number
  /** Wakes the loop when a view's slot frees, or the views change. */
  wake?: () => void
}

/**
 * A frame asked for again within this long is the same frame (two views of one browser share it).
 * Short: the worker answers from the tab's screencast, so a fresh frame costs little.
 */
const FRAME_REUSE_MS = 30
/** The person counts as watching for this long after their view last asked for a frame. */
const WATCHING_MS = 30_000
/** How long the worker holds a request for the next picture before answering that nothing changed. */
const CAPTURE_WAIT_MS = 20_000
/** A view not renewed for this long is dropped. */
const VIEWER_LEASE_MS = 3 * WATCHED_BROWSER_RENEW_MS
/** The most views that watch one browser at once (each app window watches it once). */
export const MAX_BROWSER_VIEWERS = 8
/** The largest update pushed to a view, with room under the connection event's 1 MB. */
const MAX_UPDATE_CHARS = 1_000_000
/** A view whose connection refuses this many updates in a row as busy is dropped. */
const MAX_BUSY_UPDATES = 40
/** How long a view waits after its connection refused an update as busy before the latest is tried again. */
const BUSY_RETRY_MS = 250
const MIN_VIEW_WIDTH = 160
const LIVE_LIFECYCLES: ReadonlySet<BrowserSessionRecord['lifecycle']> = new Set(['ready', 'agent-controlled', 'human-controlled', 'waiting-approval'])
/** What the views say once the browser's process ended by itself. */
const BROWSER_STOPPED = 'The browser stopped.'
/** What the views say when the tab the person took over has closed: they keep its last picture, never another tab. */
const HELD_TAB_CLOSED = 'The tab you took over has closed.'
/** The limit on a picture taken for a view that asks each time: quick or broken. */
export const BROWSER_SIDE_CALL_MS = 15_000

/**
 * Pictures remembered per browser for the input made on them: always the last `MIN_PICTURES` (a still
 * page sends few), and every one sent in the last `PICTURE_KEEP_MS` (five seconds at 30 a second is
 * 150), never more than `MAX_PICTURES`. Input made on a picture older than that is refused, not guessed at.
 */
const MIN_PICTURES = 32
const PICTURE_KEEP_MS = 5_000
const MAX_PICTURES = 256

/** An older app's window, as a view: its connection (it names no view of its own). */
export const legacyView = (connectionId: string): string => `app-${connectionId}`

/** Why a hold ends: given back, or `replaced` (the same view took the browser over again: a fresh channel, and nothing to tell). */
type HoldEndReason = WatchedBrowserHoldEnd | 'given-back' | 'replaced'

/** Another view holds the browser: this one takes it over only on an explicit Take over. */
export function heldElsewhere(): BrowserAutomationError {
  return new BrowserAutomationError({ code: 'held_elsewhere', message: 'Held in another window.' })
}

/** A view tries to use a hold it no longer has (given back, ended, or taken in another window). */
function holdEnded(): BrowserAutomationError {
  return new BrowserAutomationError({ code: 'hold_ended', message: 'You don\'t hold this browser now.' })
}

const refused = (reason: WatchedBrowserRefusal, text: string): Omit<WatchedBrowserAck, 'seq'> => ({ status: 'refused', reason, text })
/** What the person reads when the page moved on under the picture they acted on. */
const PAGE_CHANGED = 'Page changed · click again'
const TAB_CLOSED = 'The tab you took over has closed. Give the browser back, then take it over again.'

/** Input made at a point of a picture: it lands on what the picture showed. */
function located(input: BrowserHumanInput): input is Extract<BrowserHumanInput, { x: number; y: number }> {
  return input.kind === 'click' || input.kind === 'scroll' || input.kind === 'pointer'
}

/** Input that a click refused just before was meant to go with (typing into what was clicked). */
function followsClick(input: BrowserHumanInput): boolean {
  return input.kind === 'keys' ? input.type === 'down' : input.kind === 'type' || input.kind === 'key' || input.kind === 'paste' || input.kind === 'compose'
}

/** A press, a click or a wheel turn: a refusal of one on a stale picture is worth telling (a hover's is not). */
function pressLike(input: BrowserHumanInput): boolean {
  return input.kind === 'click' || input.kind === 'scroll' || (input.kind === 'pointer' && input.type === 'down')
}

/** A press or a click: what was under it is what the person meant. */
function press(input: BrowserHumanInput): boolean {
  return input.kind === 'click' || (input.kind === 'pointer' && input.type === 'down')
}

export type PageInput = Exclude<WatchedBrowserInput, { kind: 'files' }>

/**
 * The editing command a shortcut stands for on the page's platform (`primary`: Command on a Mac, else
 * Control). Copy and cut have none: the view sends the person's copy as `copy`, read from the page,
 * never through the browser's own clipboard.
 */
function editCommand(input: Extract<PageInput, { kind: 'keys' }>, primary: number): BrowserEditCommand | undefined {
  if (input.type !== 'down' || (input.modifiers & (BROWSER_MODIFIERS.ctrl | BROWSER_MODIFIERS.meta)) !== primary || input.modifiers & BROWSER_MODIFIERS.alt) return undefined
  const shift = Boolean(input.modifiers & BROWSER_MODIFIERS.shift)
  switch (input.code || `Key${input.key.toUpperCase()}`) {
    case 'KeyA': return shift ? undefined : 'selectAll'
    case 'KeyZ': return shift ? 'redo' : 'undo'
    case 'KeyY': return primary === BROWSER_MODIFIERS.ctrl && !shift ? 'redo' : undefined
    default: return undefined
  }
}

/**
 * A view's input as the page's platform reads it: a Mac view's Command is the page's Control when the
 * page is not on a Mac (and the other way round), so the usual shortcuts work; an editing shortcut
 * carries its command.
 */
export function inputForPage(input: PageInput, viewer: 'mac' | 'other', pageMac = process.platform === 'darwin'): PageInput {
  if (!('modifiers' in input) || input.modifiers === undefined) return input
  let modifiers = input.modifiers
  if ((viewer === 'mac') !== pageMac) {
    const ctrl = modifiers & BROWSER_MODIFIERS.ctrl
    const meta = modifiers & BROWSER_MODIFIERS.meta
    modifiers = (modifiers & ~(BROWSER_MODIFIERS.ctrl | BROWSER_MODIFIERS.meta)) | (ctrl ? BROWSER_MODIFIERS.meta : 0) | (meta ? BROWSER_MODIFIERS.ctrl : 0)
  }
  if (input.kind !== 'keys') return { ...input, modifiers }
  const { command: _command, ...rest } = input
  const command = editCommand({ ...rest, modifiers }, pageMac ? BROWSER_MODIFIERS.meta : BROWSER_MODIFIERS.ctrl)
  return { ...rest, modifiers, ...(command ? { command } : {}) }
}

/**
 * Why a view's connection refused an update: `gone` (it closed, or its profile changed), `busy` (too
 * many updates waiting on it, or its writes are backed up: the latest goes again shortly) or
 * `too_large` (the update is over the connection event limit: its picture is dropped).
 */
function refusal(error: unknown, viewer: WatchedBrowserWatcher): 'gone' | 'busy' | 'too_large' {
  if (viewer.lifetime?.aborted) return 'gone'
  if (error instanceof Error && error.name === 'FrameTooLargeError') return 'too_large'
  const code = (error as { code?: unknown } | null)?.code
  if (code === 'resource_limit') return 'busy'
  // A write backlog reads as closed, but the connection still lives while its lifetime does.
  if (code === 'connection_closed' && viewer.lifetime) return 'busy'
  return 'gone'
}

const defaultTimer = (fn: () => void, ms: number): { clear(): void } => {
  const timer = setTimeout(fn, ms)
  timer.unref?.()
  return { clear: () => clearTimeout(timer) }
}

export class WatchedBrowser {
  /** The tab the views follow, and the held view's input goes to (its user sets it: `followTab`). */
  private follow?: string
  /** The followed tab's latest picture and state, for `view` and a view that starts watching. */
  private picture?: Picture
  /** The tab the latest picture shows: the one Take over holds when no tab is followed. */
  private pictureTab?: string
  private tab?: { url: string; title: string }
  private cursor?: BrowserAgentCursor
  private behind?: boolean
  private loading?: boolean
  /** What the views show: the followed tab's problem, else the agent's last. */
  private problem?: BrowserProblem
  /** The followed tab's own (from the worker). */
  private tabProblem?: BrowserProblem
  /** What the agent's last page ran into, wherever it was. */
  private agentProblem?: BrowserProblem
  /** The followed tab, its address and its page (document) when that was noted. */
  private agentProblemAt?: { tab?: string; url?: string; page?: string }
  /** The followed tab's page (its main document) as the worker last told it. */
  private page?: string
  /** Why pictures cannot reach the views now (the followed tab closed, the worker does not answer), until they can again. */
  private stalled?: string
  /** When a picture was last taken for `view` (an older app asks each time). */
  private frameAt?: number
  private lastViewedAt = 0
  private readonly viewers = new Map<string, Viewer>()
  private capture?: Capture
  /** The view that holds the browser now (Take over), when one does. */
  private hold?: OwnerHold
  /** Changes of who holds it, one at a time. */
  private holding: Promise<unknown> = Promise.resolve()
  /** The pictures sent lately, by number (bounded by count and time): what an input made on one meant. */
  private readonly pictures: PictureRecord[] = []
  private pictureSerial = 0
  /** The followed tab's open dialog and file picker. */
  private dialog?: WatchedBrowserDialog
  private chooser?: WatchedBrowserChooser
  private readonly now: () => number
  private readonly holdLeaseMs: number
  private readonly leaseTimer: (fn: () => void, ms: number) => { clear(): void }

  constructor(private readonly options: WatchedBrowserOptions) {
    this.now = options.now ?? Date.now
    this.holdLeaseMs = options.holdLeaseMs ?? WATCHED_BROWSER_HOLD_LEASE_MS
    this.leaseTimer = options.leaseTimer ?? defaultTimer
  }

  /**
   * The view of the browser. `frame` takes a fresh picture of the followed tab (an older app asks
   * this way); `last` adds the latest picture known, taking none.
   */
  async view(options: { frame?: boolean; last?: boolean; viewId?: string; connectionId?: string } = {}): Promise<WatchedBrowserView> {
    if (options.frame) this.lastViewedAt = this.now()
    const record = this.record()
    const open = Boolean(record && LIVE_LIFECYCLES.has(record.lifecycle))
    if (open && options.frame && (!this.frameAt || this.now() - this.frameAt > FRAME_REUSE_MS)) await this.takeFrame().catch(() => undefined)
    const last = this.picture
    const frame: WatchedBrowserFrame | undefined = last ? { data: last.data, mimeType: 'image/jpeg', width: last.width, height: last.height, viewport: last.viewport, at: last.at, ...(last.id !== undefined ? { id: last.id } : {}) } : undefined
    const holder = open && options.viewId ? this.holderFor(options.viewId) : undefined
    // The hold itself is told only on the connection that has it (a window that reloaded keeps its connection).
    const hold = holder === 'this-view' && this.hold && (options.connectionId === undefined || options.connectionId === this.hold.connectionId) ? this.holdAnswer(this.hold) : undefined
    return {
      open,
      control: record?.lifecycle === 'human-controlled' ? 'owner' : 'bot',
      ...(holder ? { holder } : {}),
      ...(hold ? { hold } : {}),
      ...(open && this.dialog ? { dialog: { ...this.dialog } } : {}),
      ...(open && this.chooser && holder === 'this-view' ? { chooser: { ...this.chooser } } : {}),
      ...(this.tab ? { tab: { ...this.tab } } : {}),
      ...(frame && (options.frame || options.last || !open) ? { frame } : {}),
      ...(open && this.cursor && agentCursorLive(this.cursor, this.now()) ? { cursor: this.cursor } : {}),
      ...(open && this.behind ? { behind: true } : {}),
      ...(open && this.loading ? { loading: true } : {}),
      ...(open && this.problem ? { problem: { ...this.problem } } : {}),
      ...(open && this.stalled ? { stalled: this.stalled } : {}),
      ...(!open && this.stopped() ? { stopped: true as const } : {})
    }
  }

  /**
   * A view starts (or renews, or resizes) watching the browser: while it is open, the followed tab's
   * pictures are pushed to it as the page paints, at most `fps` a second and `width` wide (capped:
   * 960, 15 a second, 30 while the person holds the browser). One capture is shared by every view;
   * each has its own slot, so a slow one drops pictures and never queues them. It ends with
   * `unwatch`, its connection, or when it is not renewed. A connection watches a browser once: a new
   * watch on it replaces the one before (an app window that reloaded). At most `MAX_BROWSER_VIEWERS`
   * watch one browser. Answers the state, with whether pictures can reach the view now (`stalled`
   * when not), and the last picture unless the view has had one.
   */
  async watch(watchId: string, input: { width: number; fps: number; connectionId: string; viewId?: string } & WatchedBrowserWatcher): Promise<WatchedBrowserView> {
    const key = `${input.connectionId}\u0000${watchId}`
    let viewer = this.viewers.get(key)
    // An older app's window keeps its hold alive by watching (it has no heartbeat).
    if (this.hold?.legacy && this.hold.viewId === legacyView(input.connectionId)) this.beat(this.hold)
    if (!viewer) {
      for (const other of [...this.viewers.values()]) if (other.connectionId === input.connectionId) this.dropViewer(other.key)
      if (this.viewers.size >= MAX_BROWSER_VIEWERS) throw new BrowserAutomationError({ code: 'timeout', message: this.options.text.tooManyViews })
      viewer = { key, connectionId: input.connectionId, watchId, ...(input.viewId ? { viewId: input.viewId } : {}), emit: input.emit, ...(input.lifetime ? { lifetime: input.lifetime } : {}), width: 0, fps: 0, until: 0, delivering: false, lastPictureAt: 0, sent: {}, busy: 0 }
      this.viewers.set(key, viewer)
      if (input.lifetime) {
        const lifetime = input.lifetime
        const end = () => this.dropViewer(key)
        lifetime.addEventListener('abort', end, { once: true })
        viewer.release = () => lifetime.removeEventListener('abort', end)
        if (lifetime.aborted) end()
      }
    }
    viewer.width = Math.max(MIN_VIEW_WIDTH, Math.min(WATCHED_BROWSER_PANE.maxWidth, Math.floor(input.width)))
    viewer.fps = Math.max(1, Math.min(WATCHED_BROWSER_PANE.heldFps, Math.floor(input.fps)))
    viewer.until = this.now() + VIEWER_LEASE_MS
    // Everything it has not seen goes with its first update.
    const hadPicture = viewer.lastPictureAt > 0
    if (!hadPicture) viewer.sent = {}
    // The answer says whether pictures can reach it now; a stall it heard of stays told.
    if (this.stalled) viewer.sent.stalled = true
    this.runCapture()
    this.refreshCapture()
    this.capture?.wake?.()
    const view = await this.view({ last: !hadPicture, connectionId: input.connectionId, ...(viewer.viewId ? { viewId: viewer.viewId } : {}) })
    // The answer told it who holds the browser and what the page asks: only changes are pushed from here.
    viewer.sent.holder = `${view.control}:${view.holder ?? ''}`
    viewer.sent.dialog = JSON.stringify(view.dialog ?? null)
    viewer.sent.chooser = JSON.stringify(view.chooser ?? null)
    return view
  }

  /** A view stops watching. When none is left, the worker stops the tab's screencast. */
  unwatch(watchId: string, connectionId: string): void {
    this.dropViewer(`${connectionId}\u0000${watchId}`)
  }

  /** Every view stops watching (the browser's user is going). */
  dropViewers(): void {
    for (const key of [...this.viewers.keys()]) this.dropViewer(key)
  }

  /** A view watches, or one asked for a picture lately. */
  watched(): boolean {
    return this.viewers.size > 0 || this.now() - this.lastViewedAt < WATCHING_MS
  }

  /** A view looked at the browser now. */
  markViewed(): void {
    this.lastViewedAt = this.now()
  }

  // -- the person's hold

  /**
   * A view's hold of the browser. Who holds it is decided here alone, and every view of the browser
   * hears it at once (`holder`):
   *
   * - `take`: the view takes the browser over; the agent's actions wait. The tab the views follow is the
   *   one it takes: it comes to the front and the person's input goes to it alone. The hold is bound to
   *   the connection that took it. A view that takes it again gets a fresh hold (a new id, numbered
   *   from 1): whatever its channel was waiting on is dropped cleanly. A window that reloaded keeps its
   *   connection and picks its hold up from `view` instead, at the host's last input number. Another
   *   view's hold is refused (`held_elsewhere`) unless `force`: then that hold ends, what it left pressed
   *   is let go of, and this view holds the browser.
   * - `renew`: the view is still there. A hold not renewed for two minutes ends: what the person left
   *   pressed is let go of, the browser goes back to the agent, and `expired` is told. A window back on
   *   a new connection renews there, and the hold moves to it (`claim`).
   * - `release`: Give back. Pressed keys and buttons go up, a composition is dropped, and the agent has it.
   */
  async holdRequest(viewId: string, request: { op: 'take'; force?: boolean; platform?: 'mac' | 'other' } | { op: 'renew' | 'release'; holdId: string }, connectionId = 'local'): Promise<{ browser: WatchedBrowserView; hold?: WatchedBrowserHold }> {
    if (request.op === 'take') {
      const hold = await this.takeHold(viewId, connectionId, { ...(request.force ? { force: true } : {}), platform: request.platform ?? 'other' })
      return { browser: await this.viewAfterChange(viewId, connectionId), hold: this.holdAnswer(hold) }
    }
    if (request.op === 'renew') {
      const hold = this.hold
      if (!hold || !this.claim(hold, viewId, request.holdId, connectionId)) throw holdEnded()
      this.beat(hold)
      return { browser: await this.view({ viewId, connectionId }), hold: this.holdAnswer(hold) }
    }
    await this.inTurn(async () => {
      const hold = this.hold
      // A hold that already ended is given back already.
      if (hold && this.claim(hold, viewId, request.holdId, connectionId)) await this.endHold(hold, 'given-back')
    })
    return { browser: await this.viewAfterChange(viewId, connectionId) }
  }

  /**
   * Whether a call is the hold's: its view, its id, and its connection. A call on another connection
   * with the right view and id is the window back on a new connection (its old one dropped): the hold
   * moves to it, once, and the old connection is never the hold's again.
   */
  private claim(hold: OwnerHold | undefined, viewId: string, holdId: string, connectionId: string): boolean {
    if (!hold || hold.id !== holdId || hold.viewId !== viewId) return false
    if (hold.connectionId === connectionId) return true
    if (hold.retired.has(connectionId)) return false
    hold.retired.add(hold.connectionId)
    hold.connectionId = connectionId
    return true
  }

  /**
   * Numbered inputs of a view's hold: each is applied once, in number order, to the tab the view took,
   * and answered. A view that does not hold the browser, or a connection that is not the hold's, has
   * each refused.
   */
  async send(viewId: string, holdId: string, inputs: WatchedBrowserSent[], connectionId = 'local'): Promise<{ acks: WatchedBrowserAck[]; lastSeq: number }> {
    const hold = this.hold
    if (!hold || !this.claim(hold, viewId, holdId, connectionId)) {
      const text = hold && hold.viewId !== viewId ? 'Held in another window' : 'You don\'t hold the browser now'
      return { acks: inputs.map((sent) => ({ seq: sent.seq, status: 'refused', reason: 'not-held', text })), lastSeq: 0 }
    }
    // Input is a sign of life too.
    this.beat(hold)
    const acks = await Promise.all(inputs.map((sent) => hold.channel.submit(sent.seq, sent)))
    return { acks, lastSeq: hold.channel.lastSeq }
  }

  /**
   * The files the person chose in this computer's own file dialog for the page's file picker (called
   * by the app's main process alone): checked against the hold, the picker open on its tab, and the
   * limits (at most `MAX_WATCHED_BROWSER_FILES` files, `MAX_WATCHED_BROWSER_FILES_BYTES` in all, each a
   * file). Answers a one-time token the view sends as its `files` input; only the latest one counts,
   * and none outlives the hold. The paths are never logged.
   */
  async chooseFiles(viewId: string, holdId: string, paths: string[], connectionId = 'local'): Promise<{ token: string; count: number }> {
    const hold = this.hold
    if (!hold || !this.claim(hold, viewId, holdId, connectionId)) throw holdEnded()
    const chooser = this.chooser
    if (!chooser || this.follow !== hold.tabId) throw new BrowserAutomationError({ code: 'not_actionable', message: 'The page is not asking for a file now.' })
    if (paths.length > 1 && !chooser.multiple) throw new BrowserAutomationError({ code: 'too_large', message: 'The page takes one file here.' })
    if (!paths.length || paths.length > MAX_WATCHED_BROWSER_FILES) throw new BrowserAutomationError({ code: 'too_large', message: WATCHED_BROWSER_FILES_LIMIT_TEXT })
    let total = 0
    for (const path of paths) {
      if (!isAbsolute(path) || path.includes('\0')) throw new BrowserAutomationError({ code: 'invalid_action', message: 'A chosen file has no place on this computer.' })
      const info = await stat(path).catch(() => undefined)
      if (!info?.isFile()) throw new BrowserAutomationError({ code: 'not_actionable', message: `${basename(path)} is not a file Mousse can read.` })
      total += info.size
    }
    if (total > MAX_WATCHED_BROWSER_FILES_BYTES) throw new BrowserAutomationError({ code: 'too_large', message: WATCHED_BROWSER_FILES_LIMIT_TEXT })
    const token = `files_${randomUUID()}`
    // One picker, one answer: a token chosen before no longer counts.
    hold.files.clear()
    hold.files.set(token, [...paths])
    return { token, count: paths.length }
  }

  /** An older app's Take over (`owner`) or Give back (`bot`): a hold of that window's connection. */
  async control(control: 'owner' | 'bot', connectionId = 'local'): Promise<WatchedBrowserView> {
    const viewId = legacyView(connectionId)
    if (control === 'owner') await this.takeHold(viewId, connectionId, { force: true, keep: true, platform: process.platform === 'darwin' ? 'mac' : 'other', legacy: true })
    else await this.inTurn(async () => {
      if (this.hold) await this.endHold(this.hold, 'given-back')
      else if (this.record()?.lifecycle === 'human-controlled') await this.options.call((context) => this.sessions().control(context, this.requireLive(), 'agent'))
    })
    return this.viewAfterChange()
  }

  /** An older app's click, scroll, typing or navigation, while its window holds the browser (`control`). */
  async input(input: PageInput, connectionId = 'local'): Promise<WatchedBrowserView> {
    this.requireLive()
    const hold = this.hold
    if (!hold?.legacy || hold.viewId !== legacyView(connectionId)) throw new BrowserAutomationError({ code: 'human_controlled', message: 'Take control of the browser first' })
    this.beat(hold)
    hold.legacy.count += 1
    const ack = await hold.channel.submit(hold.legacy.count, { seq: hold.legacy.count, input })
    if (ack.status === 'refused') {
      // A page that failed keeps its class and Chromium's code, as the worker said it.
      const problem = ack.reason === 'failed' && (input.kind === 'navigate' || input.kind === 'back' || input.kind === 'forward' || input.kind === 'reload') ? this.agentProblem : undefined
      if (problem) throw new BrowserAutomationError({ code: BROWSER_PROBLEM_CODES[problem.kind], message: browserProblemMessage(problem), details: { problem } })
      throw new BrowserAutomationError({ code: ack.reason === 'tab-closed' ? 'stale_ref' : ack.reason === 'page-changed' ? 'stale_observation' : 'not_actionable', message: ack.text ?? 'The input did not reach the page' })
    }
    return this.viewAfterChange()
  }

  /** After the person changed something: a watching view gets the new picture pushed; an older one takes a fresh frame. */
  viewAfterChange(viewId?: string, connectionId?: string): Promise<WatchedBrowserView> {
    const asked = { ...(viewId ? { viewId } : {}), ...(connectionId ? { connectionId } : {}) }
    if (this.viewers.size) return this.view({ last: true, ...asked })
    this.frameAt = undefined
    return this.view({ frame: true, ...asked })
  }

  /**
   * Opens the browser for the person, under their control (to sign in to a site, say): it is the
   * view's hold (`viewId`; an older app's window when `legacy`), bound to its connection. An open
   * browser is handed to the person as it is, on `url` when one is given; one another view holds is
   * refused ("Held in another window": only Take over takes it from there). `ensure` opens a closed
   * one blank, in the same call, and it is the person's before it loads anything, so `url` loads as
   * their page.
   */
  async open(viewId: string, connectionId: string, options: { platform: 'mac' | 'other'; legacy?: boolean; url?: string }, ensure: (context: BrowserToolContext) => Promise<string>): Promise<OwnerHold> {
    return this.inTurn(async () => {
      if (this.hold && this.hold.viewId !== viewId) throw heldElsewhere()
      // The person takes the tab they see (with none followed, the one the last picture showed).
      if (!this.hold && !this.follow && this.pictureTab) this.followTab(this.pictureTab)
      await this.options.call(async (context) => {
        const sessionId = await ensure(context)
        if (this.record()?.lifecycle !== 'human-controlled') await this.sessions().control(context, sessionId, 'human', { ...(this.follow ? { tabId: this.follow } : {}), chooser: true })
      })
      const held = await this.holdFor(viewId, connectionId, { keep: true, platform: options.platform, ...(options.legacy ? { legacy: true } : {}) })
      // The page loads as the person's input: in the next turn, so it never lands beside an agent's call.
      if (options.url) {
        const sessionId = this.requireLive()
        const url = options.url
        await this.options.input((context) => this.sessions().humanInput(context, { sessionId, input: { kind: 'navigate', url }, ...(held.tabId ? { tabId: held.tabId } : {}) }), held.tabId)
      }
      return held
    })
  }

  /** Who holds the browser, as the view `viewId` sees it. */
  private holderFor(viewId: string): WatchedBrowserHolder {
    if (this.record()?.lifecycle !== 'human-controlled') return 'bot'
    return this.hold?.viewId === viewId ? 'this-view' : 'another-view'
  }

  holdAnswer(hold: OwnerHold): WatchedBrowserHold {
    return { id: hold.id, lastSeq: hold.channel.lastSeq, computer: this.options.computer }
  }

  /** Changes of who holds the browser, one at a time (two windows taking it at once). */
  private inTurn<T>(work: () => Promise<T>): Promise<T> {
    const next = this.holding.then(work, work)
    this.holding = next.catch(() => undefined)
    return next
  }

  /** `take`: the browser becomes the view's (see `holdRequest`). */
  private takeHold(viewId: string, connectionId: string, options: { force?: boolean; keep?: boolean; platform: 'mac' | 'other'; legacy?: boolean }): Promise<OwnerHold> {
    return this.inTurn(async () => {
      const sessionId = this.requireLive()
      const current = this.hold
      if (current && current.viewId !== viewId && !options.force) throw heldElsewhere()
      // The person takes the tab they see: the one the view follows (with none followed, the one the last picture
      // showed), as it is now, whatever a run does while the browser changes hands. It comes to the front, so Chromium
      // paints what they do, and its file picker is answered in their view.
      const tabId = current ? current.tabId : this.follow ?? this.pictureTab
      if (!current && this.record()?.lifecycle !== 'human-controlled') {
        await this.options.call((context) => this.sessions().control(context, sessionId, 'human', { ...(tabId ? { tabId } : {}), chooser: true }))
      }
      const hold = await this.holdFor(viewId, connectionId, { ...options, ...(tabId ? { tabId } : {}) })
      // Up to 30 pictures a second while the person holds it, back to 15 when the agent has it again.
      this.refreshCapture()
      return hold
    })
  }

  /**
   * The view's hold of a browser the person has (in turn): its own, kept (`keep`, on the same
   * connection), or a fresh one, which ends the hold before it, this view's own or another's.
   */
  private async holdFor(viewId: string, connectionId: string, options: { keep?: boolean; platform: 'mac' | 'other'; legacy?: boolean; tabId?: string }): Promise<OwnerHold> {
    const current = this.hold
    if (current?.viewId === viewId && current.connectionId === connectionId && options.keep) {
      this.beat(current)
      return current
    }
    // A hold that replaces another keeps its tab: nothing a run did meanwhile moved it.
    const tabId = current ? current.tabId : options.tabId ?? this.follow
    if (current) await this.endHold(current, current.viewId === viewId ? 'replaced' : 'taken', { keepControl: true })
    const hold: OwnerHold = {
      id: `hold_${randomUUID()}`,
      viewId,
      connectionId,
      retired: new Set(),
      files: new Map(),
      ...(tabId ? { tabId } : {}),
      platform: options.platform,
      beatAt: this.now(),
      staleThrough: 0,
      ...(options.legacy ? { legacy: { count: 0 } } : {}),
      channel: undefined as unknown as InputSequencer<WatchedBrowserSent>
    }
    hold.channel = new InputSequencer<WatchedBrowserSent>({ apply: (sent) => this.applyInput(hold, sent) })
    this.hold = hold
    // The views show the tab the person holds, until they give it back.
    if (hold.tabId) this.followTab(hold.tabId)
    this.beat(hold)
    this.notifyHolder()
    return hold
  }

  /** The view is still there: its hold lasts another lease from now. */
  private beat(hold: OwnerHold): void {
    hold.beatAt = this.now()
    if (hold.lease) return
    const arm = (ms: number) => {
      hold.lease = this.leaseTimer(() => {
        hold.lease = undefined
        if (this.hold !== hold) return
        const left = hold.beatAt + this.holdLeaseMs - this.now()
        if (left > 0) {
          arm(left)
          return
        }
        void this.inTurn(async () => {
          if (this.hold !== hold || hold.beatAt + this.holdLeaseMs > this.now()) return
          await this.endHold(hold, 'expired')
        }).catch((error) => console.warn(`a ${this.options.log.name} hold could not end`, { ...this.options.log.fields, error: error instanceof Error ? error.message : String(error) }))
      }, ms)
    }
    arm(this.holdLeaseMs)
  }

  /**
   * A hold ends (in turn): what waits in its channel is refused, what is being applied finishes, and
   * then what the person left pressed is let go of. Unless another view takes it on (`keepControl`), the
   * browser goes back to the agent. The view that held it hears why, unless it gave it back itself; a
   * hold that ran out is told to the browser's user (`expired`).
   */
  private async endHold(hold: OwnerHold, end: HoldEndReason, options: { keepControl?: boolean } = {}): Promise<void> {
    if (this.hold !== hold) return
    this.hold = undefined
    hold.lease?.clear()
    hold.lease = undefined
    hold.files.clear()
    await hold.channel.close('not-held', end === 'taken' ? 'Held in another window' : end === 'replaced' ? 'You took the browser over again' : 'You gave the browser back')
    const sessionId = this.liveSession()
    if (sessionId) {
      if (options.keepControl) {
        await this.options.input((context) => this.sessions().humanInput(context, { sessionId, input: { kind: 'release' }, ...(hold.tabId ? { tabId: hold.tabId } : {}) })).catch(() => undefined)
      } else {
        // The worker lets go of what the person left pressed before the agent has it again.
        await this.options.call((context) => this.sessions().control(context, sessionId, 'agent')).catch((error) => {
          console.warn(`a ${this.options.log.name} could not be given back`, { ...this.options.log.fields, error: error instanceof Error ? error.message : String(error) })
        })
      }
    }
    if (end !== 'given-back' && end !== 'replaced') {
      for (const viewer of this.viewers.values()) {
        if (viewer.viewId !== hold.viewId) continue
        viewer.slot = { ...viewer.slot, holdEnded: end }
        this.deliver(viewer)
      }
    }
    if (end === 'expired') this.options.expired?.()
    // The agent has its browser again: the view follows a run's tab again.
    if (!options.keepControl) {
      this.options.givenBack?.()
      this.runCapture()
      this.capture?.wake?.()
    }
    this.refreshCapture()
    // A hold another one replaces at once (`keepControl`): the views hear of the new one instead.
    if (!options.keepControl) this.notifyHolder()
  }

  /** A hold ends with its browser (closed, its user gone): nothing to give back. */
  private dropHold(): void {
    const hold = this.hold
    if (!hold) return
    this.hold = undefined
    hold.lease?.clear()
    hold.lease = undefined
    hold.files.clear()
    void hold.channel.close('not-held', 'The browser closed')
  }

  /** Each view hears who holds the browser now, when that changed for it. */
  private notifyHolder(): void {
    const control = this.record()?.lifecycle === 'human-controlled' ? 'owner' : 'bot'
    for (const viewer of this.viewers.values()) {
      const holder = viewer.viewId && this.liveSession() ? this.holderFor(viewer.viewId) : undefined
      const said = `${control}:${holder ?? ''}`
      if (viewer.sent.holder === said) continue
      viewer.slot = { ...viewer.slot, control, ...(holder ? { holder } : {}) }
      this.deliver(viewer)
    }
  }

  /**
   * Where a picture the person acted on was taken, when this host can say: one of the pictures it
   * remembers, of the tab the view took, with its document and scroll. An older app names no picture:
   * its input is placed on the latest picture of that tab (the one it asked for last).
   */
  private place(hold: OwnerHold, picture: number | undefined): BrowserPictureSpot | undefined {
    const record = picture !== undefined
      ? this.pictures.find((entry) => entry.id === picture)
      : hold.legacy ? [...this.pictures].reverse().find((entry) => entry.tabId === hold.tabId) : undefined
    return record?.spot && record.tabId === hold.tabId ? record.spot : undefined
  }

  /**
   * Applies one numbered input of a hold, to the tab the view took (a skip applies nothing). A point
   * on a picture lands on what that picture showed: the worker moves it by the scroll since, and
   * refuses it on another page, out of view, or where what was under it has changed. A press on a
   * picture this host cannot place (too old, of another tab, or none) is refused here and never
   * reaches the page, and so is a key made on one; typing that followed a refused click is refused
   * too. A button the person lets go of is always let go of. Files go as the paths this computer's
   * own file dialog answered for this hold (`chooseFiles`). Never logged: what the person types goes
   * to the page only.
   */
  private async applyInput(hold: OwnerHold, sent: WatchedBrowserSent): Promise<Omit<WatchedBrowserAck, 'seq'>> {
    if ('skip' in sent) return refused('skipped', 'Skipped')
    const sessionId = this.liveSession()
    if (!sessionId || this.hold !== hold) return refused('not-held', 'You gave the browser back')
    const tabId = hold.tabId
    if (!tabId) return refused('tab-closed', TAB_CLOSED)
    let input: BrowserHumanInput
    if (sent.input.kind === 'files') {
      const token = sent.input.token
      const paths = token ? hold.files.get(token) : []
      if (token) hold.files.delete(token)
      if (!paths) return refused('failed', 'Choose the file again')
      input = { kind: 'files', paths }
    } else input = inputForPage(sent.input, hold.platform)
    let spot = this.place(hold, sent.picture)
    // An older app names no picture: with none of the tab known yet, the page as it is now is its picture.
    if (!spot && hold.legacy && located(input)) {
      await this.takeFrame().catch(() => undefined)
      spot = this.place(hold, sent.picture)
    }
    if (located(input)) {
      // A button let go of goes without a place: the worker lets it go where the pointer is.
      if (!spot && !(input.kind === 'pointer' && input.type === 'up')) {
        if (pressLike(input) && sent.picture !== undefined) hold.staleThrough = Math.max(hold.staleThrough, sent.picture)
        return refused('page-changed', PAGE_CHANGED)
      }
    } else if (sent.picture !== undefined && followsClick(input) && (sent.picture <= hold.staleThrough || !spot)) {
      return refused('page-changed', PAGE_CHANGED)
    }
    const navigates = input.kind === 'navigate' || input.kind === 'back' || input.kind === 'forward' || input.kind === 'reload'
    try {
      const [result] = await this.options.input((context) => this.sessions().humanInputs(context, { sessionId, tabId, inputs: [{ input, ...(spot && located(input) ? { spot } : {}) }] }), tabId)
      if (!result) return refused('failed', 'The browser did not answer')
      if (!result.applied) {
        if (result.code === 'page_changed') {
          if (pressLike(input) && sent.picture !== undefined) hold.staleThrough = Math.max(hold.staleThrough, sent.picture)
          return refused('page-changed', PAGE_CHANGED)
        }
        if (result.code === 'dialog_open') return refused('dialog', 'Answer the page\'s dialog first')
        if (result.code === 'too_large') return refused('too-large', result.message)
        return refused('failed', result.message)
      }
      // A press on this picture landed: typing made on it is the person's again.
      if (press(input) && sent.picture !== undefined && hold.staleThrough >= sent.picture) hold.staleThrough = sent.picture - 1
      // The person's own page replaces what the agent's last page ran into.
      if (navigates) this.noteProblem(result.navigation?.problem)
      return { status: 'applied', ...(result.copied !== undefined ? { copied: result.copied } : {}) }
    } catch (error) {
      const code = error instanceof BrowserAutomationError ? error.code : undefined
      const problem = error instanceof BrowserAutomationError ? error.details?.problem as BrowserProblem | undefined : undefined
      if (navigates && problem) {
        this.noteProblem(problem)
        const said = browserProblemForPerson(problem)
        return { ...refused('failed', said.line), detail: said.detail }
      }
      if (code === 'stale_ref') return refused('tab-closed', TAB_CLOSED)
      if (code === 'human_controlled') return refused('not-held', 'You gave the browser back')
      return refused('failed', error instanceof Error ? error.message : String(error))
    }
  }

  /**
   * The person holds the browser: a view's hold (`holdRequest`, `open`, or an older app's `control`), the one rule
   * for who controls it. The session is the person's (human-controlled) exactly while a hold lasts; in the moment
   * between the two, inside Take over, the worker itself refuses the agent's actions.
   */
  get held(): boolean {
    return this.hold !== undefined
  }

  // -- the followed tab and the session

  /** The views follow another tab (or none): a capture of the previous one ends and starts on this one. */
  followTab(tabId: string | undefined): void {
    if (this.follow === tabId) {
      this.runCapture()
      return
    }
    this.follow = tabId
    const capture = this.capture
    if (capture?.tabId && capture.tabId !== tabId) this.stopWorkerWatch(capture.key)
    this.runCapture()
    capture?.wake?.()
  }

  /**
   * A tab of the browser closed. The views no longer follow it; if it is the tab the person holds, their input is
   * refused from now on ("The tab you took over has closed"), never sent to another tab, and the views keep its
   * last picture.
   */
  tabClosed(tabId: string): void {
    if (this.hold?.tabId === tabId) this.hold.tabId = undefined
    if (this.follow === tabId) this.followTab(undefined)
  }

  /** A session opened (`sessionId` answers it now): the views follow its first tab. */
  opened(tabId: string | undefined): void {
    this.behind = false
    this.followTab(tabId)
  }

  /** The session is closing: a hold ends with it, and the views follow no tab. */
  closed(): void {
    this.dropHold()
    this.follow = undefined
    this.behind = false
    this.dialog = undefined
    this.chooser = undefined
  }

  /**
   * What the agent's last page ran into, or nothing once a page went well: shown to the person even
   * when it was in a tab that closed again (a tab opened on an address nothing answers on).
   */
  noteProblem(problem: BrowserProblem | undefined): void {
    this.agentProblem = problem
    // It stands while the view stays on the same tab at the same address; once that moves on, the tab's own state is shown.
    this.agentProblemAt = problem ? { ...(this.follow ? { tab: this.follow } : {}), ...(this.tab ? { url: this.tab.url } : {}), ...(this.page ? { page: this.page } : {}) } : undefined
    const shown = this.tabProblem ?? problem
    if (JSON.stringify(shown ?? null) === JSON.stringify(this.problem ?? null)) return
    this.problem = shown
    for (const viewer of this.viewers.values()) {
      viewer.slot = { ...viewer.slot, problem: shown ?? null }
      this.deliver(viewer)
    }
  }

  /**
   * A picture for a view that asks each time (an older app): the worker answers from the tab's capture and never brings
   * a tab forward for it, so it needs no turn and never pulls a run's tab away. It has 15 seconds at most.
   */
  private async takeFrame(): Promise<void> {
    const sessionId = this.liveSession()
    if (!sessionId) return
    // The tab the person holds has gone: the view keeps its last picture, never another run's tab.
    if (!this.follow && this.held) return
    const frame = await this.options.call((context) => this.sessions().frame(context, { sessionId, ...(this.follow ? { tabId: this.follow } : {}), maxWidth: 960 }), AbortSignal.timeout(BROWSER_SIDE_CALL_MS))
    this.frameAt = this.now()
    const id = ++this.pictureSerial
    this.rememberPicture({ id, tabId: frame.tabId, ...(frame.spot ? { spot: frame.spot } : {}), at: this.now() })
    this.picture = { data: frame.data, width: frame.width, height: frame.height, viewport: frame.viewport, at: Date.parse(frame.capturedAt) || this.now(), id }
    this.pictureTab = frame.tabId
    this.tab = { url: frame.url, title: frame.title }
    this.cursor = frame.cursor
  }

  // -- watching views

  /** A capture starts if views wait for one, at the size and rate they ask for now. */
  startCapture(): void {
    this.runCapture()
    this.refreshCapture()
  }

  /**
   * While views watch and the browser is open, asks the worker for the followed tab's next update
   * (a long-poll it answers when the page paints or the tab changes) and hands it to each view. The
   * next is asked for only once a view is free to take it, so while every view is still busy
   * delivering, Chromium is asked for nothing.
   */
  private runCapture(): void {
    if (this.capture || !this.viewers.size || !this.liveSession()) return
    const capture: Capture = { key: `view_${randomUUID()}`, afterFrame: 0, afterState: 0 }
    this.capture = capture
    void (async () => {
      let failures = 0
      try {
        for (;;) {
          this.expireViewers()
          if (!this.viewers.size || this.capture !== capture) return
          const sessionId = this.liveSession()
          if (!sessionId) {
            this.stall(this.stopped() ? BROWSER_STOPPED : 'The browser closed.')
            return
          }
          await this.viewerFree(capture)
          if (!this.viewers.size || this.capture !== capture) return
          const tabId = this.follow
          // The tab the person holds has closed: the views keep its last picture, never another run's tab, until the
          // view follows a tab again (Give back) or the views change.
          if (!tabId && this.held) {
            this.stall(HELD_TAB_CLOSED)
            await new Promise<void>((resolve) => { capture.wake = () => { capture.wake = undefined; resolve() } })
            continue
          }
          const moved = capture.tabId !== tabId
          const wanted = this.captureParams()
          capture.requested = wanted
          let update: BrowserViewerUpdate
          try {
            update = await this.options.call((context) => this.sessions().viewerNext(context, {
              sessionId,
              ...(tabId ? { tabId } : {}),
              watchKey: capture.key,
              maxWidth: wanted.width,
              maxFps: wanted.fps,
              afterFrame: moved ? 0 : capture.afterFrame,
              afterState: moved ? 0 : capture.afterState,
              waitMs: CAPTURE_WAIT_MS
            }))
          } catch (error) {
            // The browser stopped by itself (its process ended): the views hear it now, not after retries.
            if (this.stopped()) {
              this.stall(BROWSER_STOPPED)
              return
            }
            failures += 1
            if (failures >= 2) this.stall(error instanceof Error ? error.message : String(error))
            await new Promise((resolve) => setTimeout(resolve, Math.min(5_000, 250 * 2 ** failures)))
            continue
          }
          failures = 0
          // The worker answers again: pictures can reach the views, even while the page stays still.
          this.unstall()
          // The view moved to another tab while this was asked: the answer is about the one it left.
          if (this.follow !== tabId && update.tabId !== this.follow) continue
          capture.tabId = update.tabId
          capture.afterFrame = update.frameSeq
          capture.afterState = update.stateSeq
          if (update.idle) continue
          this.distribute(update)
        }
      } finally {
        if (this.capture === capture) this.capture = undefined
        this.stopWorkerWatch(capture.key)
        // A view that came while this one ended starts the next.
        if (this.viewers.size && this.liveSession()) this.runCapture()
      }
    })()
  }

  /** The capture's size and rate: the widest view, and the fastest within the cap (higher while the person holds the browser). */
  private captureParams(): { width: number; fps: number } {
    const viewers = [...this.viewers.values()]
    const cap = this.record()?.lifecycle === 'human-controlled' ? WATCHED_BROWSER_PANE.heldFps : WATCHED_BROWSER_PANE.fps
    return {
      width: Math.max(MIN_VIEW_WIDTH, ...viewers.map((viewer) => viewer.width)),
      fps: Math.max(1, ...viewers.map((viewer) => Math.min(viewer.fps, cap)))
    }
  }

  /** The views or the cap changed: the worker's wait ends, and the next is asked for at the new size and rate. */
  private refreshCapture(): void {
    const capture = this.capture
    if (!capture?.requested || !this.viewers.size) return
    const wanted = this.captureParams()
    if (wanted.width !== capture.requested.width || wanted.fps !== capture.requested.fps) this.stopWorkerWatch(capture.key)
  }

  /** Waits until some view is free to take a new picture (none is free while every one is delivering). */
  private viewerFree(capture: Capture): Promise<void> {
    if ([...this.viewers.values()].some((viewer) => !viewer.delivering)) return Promise.resolve()
    return new Promise((resolve) => {
      capture.wake = () => {
        capture.wake = undefined
        resolve()
      }
    })
  }

  /** Ends the worker's wait for this capture (and its screencast, when nobody else watches the tab). */
  private stopWorkerWatch(watchKey: string): void {
    const sessionId = this.liveSession()
    if (!sessionId) return
    void this.options.call((context) => this.sessions().viewerStop(context, { sessionId, watchKey })).catch(() => undefined)
  }

  /** Hands a worker update to each view: its picture into the view's slot, and what changed of the rest. */
  private distribute(update: BrowserViewerUpdate): void {
    const now = this.now()
    if (update.picture) {
      // Each picture has a number, and what it showed is kept a while: input made on it lands on that.
      const { spot, ...picture } = update.picture
      const id = ++this.pictureSerial
      this.rememberPicture({ id, tabId: update.tabId, ...(spot ? { spot } : {}), at: now })
      this.picture = { ...picture, viewport: update.viewport, id }
    } else if (this.picture) this.picture = { ...this.picture, viewport: update.viewport }
    this.pictureTab = update.tabId
    this.dialog = update.dialog
    this.chooser = update.chooser
    const dialog = JSON.stringify(update.dialog ?? null)
    this.tab = { url: update.url, title: update.title }
    this.page = update.page
    this.cursor = update.cursor
    this.behind = update.behind
    this.loading = update.loading === true
    this.tabProblem = update.problem
    // What the agent's last page ran into (in a tab that closed again) holds only until the followed tab
    // moves on: another tab, another address, or another page at the same address (the agent or the person
    // carried on, or the page replaced itself: a redirect or reload once a check was passed).
    const at = this.agentProblemAt
    const moved = (at?.tab !== undefined && at.tab !== update.tabId) || (at?.url !== undefined && at.url !== update.url) || (at?.page !== undefined && update.page !== undefined && at.page !== update.page)
    if (this.agentProblem && at && moved) {
      this.agentProblem = undefined
      this.agentProblemAt = undefined
    }
    // The followed tab's own problem, else what the agent's last page ran into.
    this.problem = update.problem ?? this.agentProblem
    const problem = JSON.stringify(this.problem ?? null)
    const cursor = update.cursor && agentCursorLive(update.cursor, now) ? update.cursor : null
    for (const viewer of this.viewers.values()) {
      const next: NonNullable<Viewer['slot']> = { ...viewer.slot }
      if (update.picture) next.frame = { data: update.picture.data, mimeType: 'image/jpeg', width: update.picture.width, height: update.picture.height, at: update.picture.at, ...(update.picture.sharp ? { sharp: true } : {}), id: this.pictureSerial }
      if ((viewer.sent.dialog ?? 'null') !== dialog) next.dialog = update.dialog ?? null
      // A file picker is answered by the view that holds the browser alone.
      const chooser = JSON.stringify(viewer.viewId && this.hold?.viewId === viewer.viewId ? update.chooser ?? null : null)
      if ((viewer.sent.chooser ?? 'null') !== chooser) next.chooser = JSON.parse(chooser) as WatchedBrowserChooser | null
      const viewport = JSON.stringify(update.viewport)
      if (viewer.sent.viewport !== viewport) next.viewport = update.viewport
      if (viewer.sent.tab !== JSON.stringify(this.tab)) next.tab = { ...this.tab }
      if ((viewer.sent.cursorAt ?? null) !== (cursor?.at ?? null)) next.cursor = cursor
      if (viewer.sent.behind !== update.behind) next.behind = update.behind
      if ((viewer.sent.loading ?? false) !== (update.loading === true)) next.loading = update.loading === true
      if ((viewer.sent.problem ?? 'null') !== problem) next.problem = this.problem ?? null
      viewer.slot = next
      this.deliver(viewer)
    }
  }

  /**
   * Keeps what a picture sent to the views showed: the last `MIN_PICTURES` always, any sent in the last
   * `PICTURE_KEEP_MS`, at most `MAX_PICTURES`. The oldest go first.
   */
  private rememberPicture(record: PictureRecord): void {
    const pictures = this.pictures
    pictures.push(record)
    let drop = Math.max(0, pictures.length - MAX_PICTURES)
    while (drop < pictures.length - MIN_PICTURES && record.at - pictures[drop]!.at > PICTURE_KEEP_MS) drop += 1
    if (drop) pictures.splice(0, drop)
  }

  /**
   * Sends a view's waiting update once the one before it is delivered: a picture at most `fps` a
   * second (the rest goes at once), always the latest.
   */
  private deliver(viewer: Viewer): void {
    if (viewer.delivering || !viewer.slot || this.viewers.get(viewer.key) !== viewer) return
    const now = this.now()
    const slot = viewer.slot
    // Nothing this view has not seen.
    if (!Object.keys(slot).length) {
      viewer.slot = undefined
      return
    }
    const wait = slot.frame ? viewer.lastPictureAt + 1_000 / viewer.fps - now : 0
    let send = slot
    if (wait > 0) {
      const { frame, viewport, ...rest } = slot
      viewer.timer?.clear()
      viewer.timer = defaultTimer(() => { viewer.timer = undefined; this.deliver(viewer) }, Math.ceil(wait))
      if (!Object.keys(rest).length) return
      send = rest
      viewer.slot = { frame, ...(viewport ? { viewport } : {}) }
    } else viewer.slot = undefined
    // A picture too large for one connection event is never sent: the next one is (the worker keeps them under the limit).
    if (send.frame && send.frame.data.length > MAX_UPDATE_CHARS) {
      const { frame: _tooLarge, ...rest } = send
      send = rest
      if (!Object.keys(send).length) return
    }
    const sent = { ...viewer.sent }
    if (send.frame) viewer.lastPictureAt = now
    if (send.viewport) viewer.sent.viewport = JSON.stringify(send.viewport)
    if (send.tab) viewer.sent.tab = JSON.stringify(send.tab)
    if (send.cursor !== undefined) viewer.sent.cursorAt = send.cursor?.at ?? null
    if (send.behind !== undefined) viewer.sent.behind = send.behind
    if (send.loading !== undefined) viewer.sent.loading = send.loading
    if (send.problem !== undefined) viewer.sent.problem = JSON.stringify(send.problem)
    if (send.control !== undefined) viewer.sent.holder = `${send.control}:${send.holder ?? ''}`
    if (send.dialog !== undefined) viewer.sent.dialog = JSON.stringify(send.dialog)
    if (send.chooser !== undefined) viewer.sent.chooser = JSON.stringify(send.chooser)
    if (send.live) viewer.sent.stalled = false
    if (send.stalled) viewer.sent.stalled = true
    viewer.delivering = true
    const update = send
    void viewer.emit({ watchId: viewer.watchId, ...update })
      .then(() => {
        viewer.delivering = false
        viewer.busy = 0
        this.deliver(viewer)
      }, (error: unknown) => {
        viewer.delivering = false
        const refused = refusal(error, viewer)
        if (refused === 'gone' || (refused === 'busy' && ++viewer.busy >= MAX_BUSY_UPDATES)) {
          this.dropViewer(viewer.key)
          return
        }
        // Not delivered: what it carried goes again, under anything newer, except a picture too large to go at all.
        viewer.sent = sent
        const { frame, ...rest } = update
        viewer.slot = { ...rest, ...(refused === 'busy' && frame ? { frame } : {}), ...viewer.slot }
        if (refused === 'too_large') {
          this.deliver(viewer)
          return
        }
        viewer.timer?.clear()
        viewer.timer = defaultTimer(() => { viewer.timer = undefined; this.deliver(viewer) }, BUSY_RETRY_MS)
      })
      .finally(() => this.capture?.wake?.())
  }

  /** Pictures stopped: each view hears it once, so it says it is not updating, and a renewal says so too. */
  private stall(reason: string): void {
    this.stalled = reason
    for (const viewer of this.viewers.values()) {
      if (viewer.sent.stalled) continue
      viewer.slot = { ...viewer.slot, stalled: reason }
      delete viewer.slot.live
      this.deliver(viewer)
    }
  }

  /** Pictures can reach the views again: each that heard of a stall hears it is live. */
  private unstall(): void {
    this.stalled = undefined
    for (const viewer of this.viewers.values()) {
      if (!viewer.sent.stalled && !viewer.slot?.stalled) continue
      viewer.slot = { ...viewer.slot, live: true }
      delete viewer.slot.stalled
      this.deliver(viewer)
    }
  }

  private expireViewers(): void {
    const now = this.now()
    for (const viewer of [...this.viewers.values()]) if (viewer.until < now) this.dropViewer(viewer.key)
  }

  private dropViewer(key: string): void {
    const viewer = this.viewers.get(key)
    if (!viewer) return
    this.viewers.delete(key)
    viewer.timer?.clear()
    viewer.release?.()
    // The last view left: the worker's wait ends now and the screencast stops. Otherwise it may shrink.
    if (!this.viewers.size && this.capture) this.stopWorkerWatch(this.capture.key)
    else this.refreshCapture()
    this.capture?.wake?.()
  }

  // -- the session's record

  /** The session's record in the profile's browser inventory, reached through its keeper. */
  record(): BrowserSessionRecord | undefined {
    const sessionId = this.options.sessionId()
    if (!sessionId) return undefined
    try {
      return this.options.browser()?.sessions.trustedSessionScope({ profileId: this.options.profileId, threadId: this.options.threadId, sessionId, keeper: this.options.keeper }).record
    } catch {
      return undefined
    }
  }

  liveSession(): string | undefined {
    const record = this.record()
    return record && LIVE_LIFECYCLES.has(record.lifecycle) ? record.id : undefined
  }

  /** The browser stopped by itself (its process ended): the next use starts it again. */
  stopped(): boolean {
    return this.record()?.lifecycle === 'disconnected'
  }

  requireLive(): string {
    const sessionId = this.liveSession()
    if (!sessionId) throw new BrowserAutomationError({ code: 'session_closed', message: this.options.text.closed })
    return sessionId
  }

  private sessions(): WatchedBrowserService['sessions'] {
    const browser = this.options.browser()
    if (!browser) throw new BrowserAutomationError({ code: 'session_closed', message: 'The browser is not available while Mousse stops.' })
    return browser.sessions
  }
}
