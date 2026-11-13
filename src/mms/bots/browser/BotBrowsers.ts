import { randomUUID } from 'node:crypto'
import { rm, stat } from 'node:fs/promises'
import { hostname } from 'node:os'
import { basename, isAbsolute } from 'node:path'
import {
  BOT_BROWSER_FILES_LIMIT_TEXT,
  BOT_BROWSER_HOLD_LEASE_MS,
  BOT_BROWSER_PANE_WATCH,
  BOT_BROWSER_WATCH_RENEW_MS,
  MAX_BOT_BROWSER_FILES,
  MAX_BOT_BROWSER_FILES_BYTES,
  type BotBrowserAck,
  type BotBrowserChooser,
  type BotBrowserDialog,
  type BotBrowserFrame,
  type BotBrowserFrameEvent,
  type BotBrowserHold,
  type BotBrowserHoldEnd,
  type BotBrowserHolder,
  type BotBrowserInput,
  type BotBrowserRefusal,
  type BotBrowserSent,
  type BotBrowserView
} from '../../../shared/bots/personal/browser'
import { BROWSER_MODIFIERS, browserTakeoverMessage, type BrowserEditCommand, type BrowserHumanInput, type BrowserPictureSpot } from '../../../shared/browser/types'
import { InputSequencer } from './InputSequencer'
import type { BotLane } from '../../../shared/bots/personal/definition'
import { BOT_BROWSER_TOOLS, MAX_BOT_ACTIVE_MS } from '../../../shared/bots/personal/manifest'
import { agentCursorLive, type BrowserAgentCursor } from '../../../shared/browser/agentCursor'
import type { BrowserAutomationTool, BrowserToolContext, BrowserToolOutput } from '../../../shared/browser/automation'
import type { BrowserRuntimePort } from '../../../shared/browser/runtime'
import type { BrowserSetupStatus } from '../../../shared/browser/setup'
import type { BrowserSessionRecord, BrowserTab, BrowserViewerUpdate } from '../../../shared/browser/types'
import { BROWSER_PROBLEM_CODES, browserProblemForPerson, browserProblemMessage, type BrowserNavigation, type BrowserProblem } from '../../../shared/browser/navigation'
import type { ExecutionContext, ExecutionPolicySnapshot } from '../../../shared/execution/types'
import { BrowserAutomationError, defineBrowserSessionKeeper } from '../../browser/automation/BrowserSessionManager'
import type { MmsBrowserService } from '../../browser/MmsBrowserService'
import { ExecutionPolicyService } from '../../execution/ExecutionPolicyService'
import { snapshotBrowserExecutionBinding } from '../../orchestrator/browser/binding'
import { browserToolCapability } from '../../orchestrator/browser/tools'
import type { BotBrowserHost, BotTurnBrowser } from '../activation/dispatcher'

/**
 * Each personal bot's own browser ("use the browser", docs/bots.md). A bot gets one managed
 * Chromium session, never one of the owner's in-app tabs or a thread's: it runs without a window,
 * so a scheduled run works with no app open, on a persistent profile of its own
 * (`botbrowser_<botId>`), so the sites its owner signs in to for it stay signed in for that bot alone.
 *
 * - Each activation drives its own tabs in that session; another activation's tab is refused.
 * - The session is owned in the browser inventory by the bot's home thread, with no run, so both
 *   lanes share it; the owner's view uses the same scope.
 * - When an activation ends its tabs close; when the last one ends the browser closes after it has
 *   been idle a while, unless the owner watches it or holds it.
 * - The owner watches it through `watch`: pictures are pushed to each watching view as the page
 *   paints (one capture shared by every view, each view with its own latest-wins slot and cap), and
 *   nothing is sent while nothing changes. `view` answers the state (and, for an older app, a frame).
 *   The owner can take it over.
 * - Only this class reaches it: its session and its profile are kept (`BOT_BROWSER_KEEPER`), so the
 *   general browser methods, another thread's agent, a group chat or a workflow are refused.
 */

/** The browser surface `BotBrowsers` uses: the profile's sessions, tool dispatcher and artifacts. */
export type BotBrowserService = Pick<MmsBrowserService, 'sessions' | 'tools' | 'artifacts' | 'workspaceDataDir'>

export interface BotBrowsersOptions {
  profileId: string
  /** The profile's browser composition (created on first use); undefined when it is shutting down. */
  browser(): BotBrowserService | undefined
  /** The bot's home thread, which owns its browser session; undefined for an unknown or deleted bot. */
  homeThread(botId: string): string | undefined
  /** How long a browser no activation uses stays open while nobody watches (default 2 minutes). */
  idleMs?: number
  now?(): number
  setTimer?(fn: () => void, ms: number): { clear(): void }
  /** How often a first-use install is checked on (default 1 second). */
  setupPollMs?: number
  /** How long a view's hold lasts without its heartbeat (default `BOT_BROWSER_HOLD_LEASE_MS`). */
  holdLeaseMs?: number
  /** The timer of a hold's lease (tests). */
  leaseTimer?(fn: () => void, ms: number): { clear(): void }
  /** The computer's name for "Not reaching …" (default its network name). */
  computerName?: string
}

/** A short line in the bot's chat (a notice in its voice): the browser came back to it on its own. */
export type BotBrowserNotice = (botId: string, text: string) => void

/**
 * The managed browser's setup, installation-wide (`BrowserSetupService`). A bot the owner allowed
 * the browser installs it on first use: allowing it is what the download is for.
 */
export interface BotBrowserSetup {
  status(): Promise<BrowserSetupStatus>
  install(): Promise<unknown>
}

interface ActivationTabs {
  /** Tabs this activation opened in the bot's session: the only ones it may use. */
  tabs: Set<string>
  /** The tab it used last: where an observation without a tab looks. */
  current?: string
  ended: boolean
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
  /** Its number: input made on it names it (`BotBrowserSent.picture`). */
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
 * A view's hold of the bot's browser: the view that took it (Take over), the connection it took it on,
 * the tab it took, and its input channel. It lasts while the view says it is there (`beat`); the view
 * that holds it alone sends input, on that connection, and only to that tab.
 */
interface OwnerHold {
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
  /** The tab the person took: their input goes to it alone, wherever the bot's runs are. */
  tabId?: string
  /** Whether the view runs on a Mac: its Command is the page's Control when the page is not on one. */
  platform: 'mac' | 'other'
  beatAt: number
  lease?: { clear(): void }
  channel: InputSequencer<BotBrowserSent>
  /**
   * A click on this picture (or an older one) was refused, the page having changed under it: input
   * made on those pictures (typing meant for what was clicked) is refused too.
   */
  staleThrough: number
  /** An older app's window (`control`, `input`), renewed by its calls; its inputs are numbered here. */
  legacy?: { count: number }
}

/** One view that watches a bot's browser, on one connection. */
export interface BotBrowserViewer {
  /** Sends one update; resolves once the connection has taken it. */
  emit(event: BotBrowserFrameEvent): Promise<void>
  /** Ends when the connection closes. */
  lifetime?: AbortSignal
}

interface Viewer extends BotBrowserViewer {
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
  slot?: Omit<BotBrowserFrameEvent, 'botId' | 'watchId'>
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

interface BotBrowserState {
  botId: string
  homeThreadId: string
  sessionId?: string
  opening?: Promise<OpenedSession>
  activations: Map<string, ActivationTabs>
  /** Whose call drives the browser now, and who waits: one call at a time, in the order they came (`BrowserTurns`). */
  turns: BrowserTurns
  /** Activations that used the browser, oldest first (bounded). */
  used: string[]
  /**
   * The tab the owner's view follows, and their input goes to (`refollow`): while they hold the browser, the tab they
   * took, which nothing a run does changes; otherwise the tab of the activation the view follows (`followed`).
   */
  follow?: string
  /** The activation whose tab the view follows: its reply shows the preview. It changes only when it ends. */
  followed?: string
  /** The followed tab's latest picture and state, for `view` and a view that starts watching. */
  picture?: Picture
  /** The tab the latest picture shows: the one Take over holds when no tab is followed. */
  pictureTab?: string
  tab?: { url: string; title: string }
  cursor?: BrowserAgentCursor
  behind?: boolean
  loading?: boolean
  /** What the view shows: the followed tab's problem, else the bot's last. */
  problem?: BrowserProblem
  /** The followed tab's own (from the worker). */
  tabProblem?: BrowserProblem
  /** What the bot's last page ran into, wherever it was. */
  botProblem?: BrowserProblem
  /** The followed tab, its address and its page (document) when that was noted. */
  botProblemAt?: { tab?: string; url?: string; page?: string }
  /** The followed tab's page (its main document) as the worker last told it. */
  page?: string
  /** Why pictures cannot reach the views now (the followed tab closed, the worker does not answer), until they can again. */
  stalled?: string
  /** When a picture was last taken for `view` (an older app asks each time). */
  frameAt?: number
  lastViewedAt: number
  idle?: { clear(): void }
  viewers: Map<string, Viewer>
  capture?: Capture
  /** The view that holds the browser now (Take over), when one does. */
  hold?: OwnerHold
  /** Changes of who holds it, one at a time. */
  holding: Promise<unknown>
  /** The pictures sent lately, by number (bounded by count and time): what an input made on one meant. */
  pictures: PictureRecord[]
  pictureSerial: number
  /** The followed tab's open dialog and file picker. */
  dialog?: BotBrowserDialog
  chooser?: BotBrowserChooser
}

interface OpenedSession {
  sessionId: string
  /** The session's first observation when this call opened it. */
  opened?: BrowserToolOutput
}

const BOT_WORKSPACE_PREFIX = 'botbrowser_'

/** The persistent Chromium profile of a bot's browser. */
export function botBrowserWorkspace(botId: string): string {
  return `${BOT_WORKSPACE_PREFIX}${botId}`
}

/**
 * The keeper of every bot's browser: a session this class opens, and a bot's profile, answer only
 * calls that carry it (its owner's view and controls, and the bot's own tools). Anything else, such
 * as the general `browser.sessions.*` methods on a bot's home thread, is refused.
 */
export const BOT_BROWSER_KEEPER = defineBrowserSessionKeeper({
  name: 'bot',
  refusal: 'This browser belongs to a bot. Open it from the bot\'s page.',
  ownsWorkspace: (workspaceId) => workspaceId.startsWith(BOT_WORKSPACE_PREFIX)
})

/**
 * A frame asked for again within this long is the same frame (two views of one browser share it).
 * Short: the worker answers from the tab's screencast, so a fresh frame costs little.
 */
const FRAME_REUSE_MS = 30
/** The owner counts as watching for this long after their view last asked for a frame. */
const WATCHING_MS = 30_000
/** How long the worker holds a request for the next picture before answering that nothing changed. */
const CAPTURE_WAIT_MS = 20_000
/** A view not renewed for this long is dropped. */
const VIEWER_LEASE_MS = 3 * BOT_BROWSER_WATCH_RENEW_MS
/** The most views that watch one bot's browser at once (each app window watches it once). */
export const MAX_BOT_BROWSER_VIEWERS = 8
/** The largest update pushed to a view, with room under the connection event's 1 MB. */
const MAX_UPDATE_CHARS = 1_000_000
/** A view whose connection refuses this many updates in a row as busy is dropped. */
const MAX_BUSY_UPDATES = 40
/** How long a view waits after its connection refused an update as busy before the latest is tried again. */
const BUSY_RETRY_MS = 250
const MIN_VIEW_WIDTH = 160
/** Activations remembered per bot for its previews. */
const MAX_USED = 50
const LIVE_LIFECYCLES: ReadonlySet<BrowserSessionRecord['lifecycle']> = new Set(['ready', 'agent-controlled', 'human-controlled', 'waiting-approval'])
/** What the views say once the browser's process ended by itself. */
const BROWSER_STOPPED = 'The browser stopped.'
/** What the views say when the tab the owner took over has closed: they keep its last picture, never another tab. */
const HELD_TAB_CLOSED = 'The tab you took over has closed.'
/** Calls that may wait their turn on one bot's browser at once; one more is refused as busy. */
export const MAX_BROWSER_WAITERS = 24
/** The longest one call waits for its turn on the bot's browser before it is refused as busy. */
export const BROWSER_TURN_WAIT_MS = 5 * 60_000
/**
 * The longest one call may hold the bot's browser. The worker broker ends each request at 60 seconds, and the longest
 * call makes four (a new tab listed, opened and listed again, then observed): a little above that, a call that still
 * has not returned is abandoned with an error to its run, and the next one in line goes.
 */
export const BROWSER_TURN_HOLD_MS = 5 * 60_000
/** The limit on the owner's picture of a tab, and on closing an ended activation's tab: both are quick or broken. */
export const BROWSER_SIDE_CALL_MS = 15_000
/** How long the owner's input waits for the call under way before it is refused as busy. */
const OWNER_INPUT_WAIT_MS = 30_000
/**
 * How long the owner's input waits for a run's call under way before it stops that call and goes: a moment, so a run's
 * action that Take over already ended can answer how far it got, and well under the half second after which the
 * owner's view says "Sending…".
 */
export const OWNER_CUT_IN_MS = 150
/**
 * How long the browser stays the owner's after each of their inputs: their next input goes at once, and the runs' calls
 * wait. So a person typing gets the page's pace (each key would otherwise wait out a cut-in), and the runs read in
 * their pauses.
 */
export const OWNER_KEEP_MS = 1_000

/**
 * The call that holds a bot's browser now: its tab, whether it gives way to the owner's input, and how to stop it.
 * `kept` is no call: the moment after an owner's input, when only their next input may take the browser.
 */
interface TurnHolder {
  tab?: string
  yields?: boolean
  kept?: boolean
  stop?(reason: Error): void
}

/**
 * One call at a time on a bot's browser, in the order the calls came, across all its activations. A browser without a
 * window paints only its front tab, and both an action and a picture bring their tab to the front; the session also
 * takes one action at a time. So when several activations browse at once, each call waits for the one before it to end
 * instead of failing or pulling the other's tab away mid-action. The queue is bounded (`MAX_BROWSER_WAITERS`), each
 * wait too (`BROWSER_TURN_WAIT_MS`), and a stopped turn leaves it at once. The holder is bounded as well
 * (`BROWSER_TURN_HOLD_MS`): `work` gets a signal that ends its call there, and the turn passes on even if it ignores it.
 */
export class BrowserTurns {
  private holder: TurnHolder | undefined
  private keptUntil: ReturnType<typeof setTimeout> | undefined
  private readonly waiting: Array<{ go(): void; holder: TurnHolder }> = []

  /** The tab the call that holds the browser works on, when it named one. */
  get holderTab(): string | undefined {
    return this.holder?.tab
  }

  get busy(): boolean {
    return this.holder !== undefined
  }

  /**
   * Runs `work` when its turn comes; a wait longer than `waitMs`, a full queue or `signal` refuses it. It holds the turn
   * at most `holdMs`: then its signal ends it and it fails with a timeout, and the next waiter goes.
   *
   * A call that `yields` (a run's) gives way to one that cuts in (`cutIn`, the owner's input): the owner's input waits
   * for it `cutIn.afterMs` at most, then that call is stopped with `cutIn.reason()` and the input goes. A call that
   * `keeps` (the owner's input) holds the browser that long after it ends, for the next call that goes `first` alone.
   */
  async run<T>(work: (held: AbortSignal) => Promise<T>, options: { signal?: AbortSignal; tab?: string; waitMs?: number; holdMs?: number; busy?: () => Error; first?: boolean; yields?: boolean; cutIn?: { afterMs: number; reason: () => Error }; keepMs?: number } = {}): Promise<T> {
    const holder: TurnHolder = { ...(options.tab ? { tab: options.tab } : {}), ...(options.yields ? { yields: true } : {}) }
    if (this.holder?.kept && options.first) {
      // The owner's next input while the browser is still theirs: it goes at once.
      clearTimeout(this.keptUntil)
      this.keptUntil = undefined
      this.holder = undefined
    } else if (this.holder || this.waiting.length) {
      const busy = options.busy ?? (() => new BrowserAutomationError({ code: 'timeout', message: 'Your browser is busy with your other work right now. Try this again in a moment, or carry on without it.' }))
      if (this.waiting.length >= MAX_BROWSER_WAITERS) throw busy()
      await new Promise<void>((resolve, reject) => {
        const entry = { go: () => { cleanup(); resolve() }, holder }
        const leave = (error: Error): void => {
          const at = this.waiting.indexOf(entry)
          if (at < 0) return
          this.waiting.splice(at, 1)
          cleanup()
          reject(error)
        }
        const timer = setTimeout(() => leave(busy()), options.waitMs ?? BROWSER_TURN_WAIT_MS)
        timer.unref?.()
        let cut: ReturnType<typeof setTimeout> | undefined
        const onAbort = (): void => leave(new BrowserAutomationError({ code: 'cancelled', message: 'This run of the bot has ended.' }))
        const cleanup = (): void => {
          clearTimeout(timer)
          clearTimeout(cut)
          options.signal?.removeEventListener('abort', onAbort)
        }
        if (options.signal?.aborted) return onAbort()
        options.signal?.addEventListener('abort', onAbort, { once: true })
        // The owner's input goes ahead of the calls that wait: it waits only for the one under way.
        if (options.first) this.waiting.unshift(entry)
        else this.waiting.push(entry)
        // And it cuts into a run's call under way that has not ended after a moment.
        const under = this.holder
        if (options.cutIn && under?.yields) {
          const { afterMs, reason } = options.cutIn
          cut = setTimeout(() => { if (this.holder === under) under.stop?.(reason()) }, afterMs)
          cut.unref?.()
        }
      })
    }
    this.holder = holder
    const hold = new AbortController()
    holder.stop = (reason) => hold.abort(reason)
    const ceiling = setTimeout(() => hold.abort(new BrowserAutomationError({ code: 'timeout', message: 'The browser did not answer in time, so this call stopped. Try it again, or carry on without it.' })), options.holdMs ?? BROWSER_TURN_HOLD_MS)
    ceiling.unref?.()
    const abandoned = new Promise<never>((_resolve, reject) => hold.signal.addEventListener('abort', () => reject(hold.signal.reason), { once: true }))
    try {
      return await Promise.race([work(hold.signal), abandoned])
    } finally {
      clearTimeout(ceiling)
      if (options.keepMs && this.holder === holder) {
        // The owner's: theirs a moment longer, for their next input; then the next in line goes.
        const kept: TurnHolder = { ...(options.tab ? { tab: options.tab } : {}), kept: true }
        this.holder = kept
        this.keptUntil = setTimeout(() => {
          if (this.holder !== kept) return
          this.keptUntil = undefined
          this.handOn()
        }, options.keepMs)
        this.keptUntil.unref?.()
      } else this.handOn()
    }
  }

  /** The browser is free: the next in line goes; it takes the browser before anything that comes later. */
  private handOn(): void {
    this.holder = undefined
    const next = this.waiting.shift()
    if (next) {
      this.holder = next.holder
      next.go()
    }
  }
}

/**
 * Pictures remembered per bot for the input made on them: always the last `MIN_PICTURES` (a still page
 * sends few), and every one sent in the last `PICTURE_KEEP_MS` (five seconds at 30 a second is 150),
 * never more than `MAX_PICTURES`. Input made on a picture older than that is refused, not guessed at.
 */
const MIN_PICTURES = 32
const PICTURE_KEEP_MS = 5_000
const MAX_PICTURES = 256
/** The line in the bot's chat when the browser comes back to it because the view that held it went away. */
export const HOLD_EXPIRED_NOTICE = 'I have my browser back: the window you took it over in went away.'

/** The bot's answer when it tries to act, open or load a page while its owner holds the browser. */
function ownerHolds(): BrowserAutomationError {
  return new BrowserAutomationError({ code: 'human_controlled', message: 'Your owner is using your browser now. Wait for them to give it back, or carry on without it.' })
}

/** An older app's window, as a view: its connection (it names no view of its own). */
const legacyView = (connectionId: string): string => `app-${connectionId}`

/** Why a hold ends: given back, or `replaced` (the same view took the browser over again: a fresh channel, and nothing to tell). */
type HoldEndReason = BotBrowserHoldEnd | 'given-back' | 'replaced'

/** Another view holds the browser: this one takes it over only on an explicit Take over. */
function heldElsewhere(): BrowserAutomationError {
  return new BrowserAutomationError({ code: 'held_elsewhere', message: 'Held in another window.' })
}

/** A view tries to use a hold it no longer has (given back, ended, or taken in another window). */
function holdEnded(): BrowserAutomationError {
  return new BrowserAutomationError({ code: 'hold_ended', message: 'You don\'t hold this browser now.' })
}

const refused = (reason: BotBrowserRefusal, text: string): Omit<BotBrowserAck, 'seq'> => ({ status: 'refused', reason, text })
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

type PageInput = Exclude<BotBrowserInput, { kind: 'files' }>

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

/** The owner's input waited past `OWNER_INPUT_WAIT_MS` for the call under way. */
function ownerInputBusy(): BrowserAutomationError {
  return new BrowserAutomationError({ code: 'timeout', message: 'The bot\'s browser is busy finishing a step of its work. Try again in a moment.' })
}

/** A call that acts on a page, opens a tab or loads a page: refused while the owner holds the browser. */
function actsOrLoads(name: BrowserAutomationTool, params: Record<string, unknown>): boolean {
  return name === 'browser_act' || name === 'browser_open' || (name === 'browser_tabs' && params.operation === 'new')
}

/**
 * Why a view's connection refused an update: `gone` (it closed, or its profile changed), `busy` (too
 * many updates waiting on it, or its writes are backed up: the latest goes again shortly) or
 * `too_large` (the update is over the connection event limit: its picture is dropped).
 */
function refusal(error: unknown, viewer: BotBrowserViewer): 'gone' | 'busy' | 'too_large' {
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

export class BotBrowsers implements BotBrowserHost {
  private readonly bots = new Map<string, BotBrowserState>()
  private readonly policies = new ExecutionPolicyService()
  private setup: BotBrowserSetup | undefined
  /** A first-use install under way: how far it is, for the owner's view. */
  private installing: { percent?: number } | undefined
  private readonly now: () => number
  private readonly idleMs: number
  private readonly setTimer: (fn: () => void, ms: number) => { clear(): void }
  private readonly holdLeaseMs: number
  private readonly leaseTimer: (fn: () => void, ms: number) => { clear(): void }
  private readonly computer: string
  private notice: BotBrowserNotice | undefined

  constructor(private readonly options: BotBrowsersOptions) {
    this.now = options.now ?? Date.now
    this.idleMs = options.idleMs ?? 2 * 60_000
    this.setTimer = options.setTimer ?? defaultTimer
    this.holdLeaseMs = options.holdLeaseMs ?? BOT_BROWSER_HOLD_LEASE_MS
    this.leaseTimer = options.leaseTimer ?? defaultTimer
    this.computer = options.computerName ?? (hostname().replace(/\.local\.?$/i, '').trim() || 'this computer')
  }

  /** The installation's browser setup (composed by the daemon once the profile's browser is configured). */
  setSetup(setup: BotBrowserSetup | undefined): void {
    this.setup = setup
  }

  /** Where the bot's chat lines go (composed by the daemon once the bots are open). */
  setNotice(notice: BotBrowserNotice | undefined): void {
    this.notice = notice
  }

  turn(input: { botId: string; activationId: string; lane: BotLane; homeThreadId: string; runId: string; signal: AbortSignal }): BotTurnBrowser | undefined {
    if (!this.options.browser()) return undefined
    const state = this.state(input.botId, input.homeThreadId)
    // Work that let go of the browser while it waited (for room, or a usage limit's reset) opens fresh tabs when it goes on.
    const known = state.activations.get(input.activationId)
    const activation = known && !known.ended ? known : { tabs: new Set<string>(), ended: false }
    state.activations.set(input.activationId, activation)
    const policy = this.policy(500)
    const execution: ExecutionContext = {
      profileId: this.options.profileId,
      // The home thread owns the bot's browser, with no run, so both lanes use the same one.
      threadId: input.homeThreadId,
      turnId: input.runId,
      actor: { kind: 'agent', definitionId: `bot:${input.botId}` },
      policySnapshotId: policy.id,
      source: 'schedule',
      cancellationId: input.runId
    }
    const binding = snapshotBrowserExecutionBinding({ execution, policy, mode: 'structured', vision: false })
    const runtime: BrowserRuntimePort = {
      resolveTarget: () => ({ backend: 'managed-chromium' }),
      // The owner's grant is the bot's access: there is no tab-access prompt for its own browser.
      requestAccess: async () => 'already-allowed',
      capabilities: () => this.record(state)?.capabilities,
      readScreenshot: (context, sessionId, artifactId) => this.readScreenshot(state, context, sessionId, artifactId),
      dispatch: (context, name, args) => this.dispatch(state, input.activationId, input.signal, context, name, args)
    }
    return { binding, runtime }
  }

  activationEnded(input: { botId: string; activationId: string }): void {
    const state = this.bots.get(input.botId)
    const activation = state?.activations.get(input.activationId)
    if (!state || !activation || activation.ended) return
    activation.ended = true
    const others = [...state.activations.values()].some((entry) => !entry.ended)
    if (others && state.sessionId) {
      // Another activation still works in the browser: only this one's tabs go.
      const sessionId = state.sessionId
      const tabs = [...activation.tabs]
      activation.tabs.clear()
      activation.current = undefined
      this.refollow(state)
      // In the browser's turn: closing a tab while another activation acts would move its front tab.
      void (async () => {
        for (const tabId of tabs) {
          await state.turns.run((held) => this.ownerCall(state, (context) => this.service().sessions.tabs(context, sessionId, { operation: 'close', tabId }), AbortSignal.any([held, AbortSignal.timeout(BROWSER_SIDE_CALL_MS)])), { holdMs: BROWSER_SIDE_CALL_MS }).catch(() => undefined)
          this.tabClosed(state, tabId)
        }
      })()
      return
    }
    // The last one: the browser stays a while for the owner's view, then closes.
    this.armIdle(state)
  }

  async removeBot(botId: string, purge: boolean): Promise<void> {
    const state = this.bots.get(botId)
    if (state) {
      state.idle?.clear()
      for (const key of [...state.viewers.keys()]) this.dropViewer(state, key)
      await this.closeSession(state).catch(() => undefined)
      this.bots.delete(botId)
    }
    if (!purge) return
    const browser = this.options.browser()
    if (browser) await rm(browser.workspaceDataDir(botBrowserWorkspace(botId)), { recursive: true, force: true })
  }

  /**
   * The owner's view of a bot's browser. `frame` takes a fresh picture of the followed tab (an older
   * app asks this way); `last` adds the latest picture known, taking none.
   */
  async view(botId: string, options: { frame?: boolean; last?: boolean; viewId?: string; connectionId?: string } = {}): Promise<BotBrowserView> {
    const state = this.stateFor(botId)
    if (options.frame) state.lastViewedAt = this.now()
    const record = this.record(state)
    const open = Boolean(record && LIVE_LIFECYCLES.has(record.lifecycle))
    if (open && options.frame && (!state.frameAt || this.now() - state.frameAt > FRAME_REUSE_MS)) await this.takeFrame(state).catch(() => undefined)
    const last = state.picture
    // The preview sits on the reply of the activation whose tab it shows.
    const activationId = state.followed
    const frame: BotBrowserFrame | undefined = last ? { data: last.data, mimeType: 'image/jpeg', width: last.width, height: last.height, viewport: last.viewport, at: last.at, ...(last.id !== undefined ? { id: last.id } : {}) } : undefined
    const holder = open && options.viewId ? this.holderFor(state, options.viewId) : undefined
    // The hold itself is told only on the connection that has it (a window that reloaded keeps its connection).
    const hold = holder === 'this-view' && state.hold && (options.connectionId === undefined || options.connectionId === state.hold.connectionId) ? this.holdAnswer(state.hold) : undefined
    return {
      open,
      control: record?.lifecycle === 'human-controlled' ? 'owner' : 'bot',
      ...(holder ? { holder } : {}),
      ...(hold ? { hold } : {}),
      ...(open && state.dialog ? { dialog: { ...state.dialog } } : {}),
      ...(open && state.chooser && holder === 'this-view' ? { chooser: { ...state.chooser } } : {}),
      ...(state.tab ? { tab: { ...state.tab } } : {}),
      activations: [...state.used],
      ...(activationId ? { activationId } : {}),
      ...(frame && (options.frame || options.last || !open) ? { frame } : {}),
      ...(open && state.cursor && agentCursorLive(state.cursor, this.now()) ? { cursor: state.cursor } : {}),
      ...(open && state.behind ? { behind: true } : {}),
      ...(open && state.loading ? { loading: true } : {}),
      ...(open && state.problem ? { problem: { ...state.problem } } : {}),
      ...(open && state.stalled ? { stalled: state.stalled } : {}),
      ...(!open && this.stopped(state) ? { stopped: true as const } : {}),
      ...(this.installing && !open ? { setup: { ...this.installing } } : {})
    }
  }

  /**
   * A view starts (or renews, or resizes) watching a bot's browser: while the browser is open, the
   * followed tab's pictures are pushed to it as the page paints, at most `fps` a second and `width`
   * wide (capped: 960, 15 a second, 30 while the owner holds the browser). One capture is shared by
   * every view; each has its own slot, so a slow one drops pictures and never queues them. It ends
   * with `unwatch`, its connection, or when it is not renewed. A connection watches a bot once: a new
   * watch on it replaces the one before (an app window that reloaded). At most
   * `MAX_BOT_BROWSER_VIEWERS` watch one bot. Answers the state, with whether pictures can reach the
   * view now (`stalled` when not), and the last picture unless the view has had one.
   */
  async watch(botId: string, watchId: string, input: { width: number; fps: number; connectionId: string; viewId?: string } & BotBrowserViewer): Promise<BotBrowserView> {
    const state = this.stateFor(botId)
    const key = `${input.connectionId}\u0000${watchId}`
    let viewer = state.viewers.get(key)
    // An older app's window keeps its hold alive by watching (it has no heartbeat).
    if (state.hold?.legacy && state.hold.viewId === legacyView(input.connectionId)) this.beat(state, state.hold)
    if (!viewer) {
      for (const other of [...state.viewers.values()]) if (other.connectionId === input.connectionId) this.dropViewer(state, other.key)
      if (state.viewers.size >= MAX_BOT_BROWSER_VIEWERS) throw new BrowserAutomationError({ code: 'timeout', message: 'Too many views are watching this bot\'s browser. Close one, then try again.' })
      viewer = { key, connectionId: input.connectionId, watchId, ...(input.viewId ? { viewId: input.viewId } : {}), emit: input.emit, ...(input.lifetime ? { lifetime: input.lifetime } : {}), width: 0, fps: 0, until: 0, delivering: false, lastPictureAt: 0, sent: {}, busy: 0 }
      state.viewers.set(key, viewer)
      if (input.lifetime) {
        const lifetime = input.lifetime
        const end = () => this.dropViewer(state, key)
        lifetime.addEventListener('abort', end, { once: true })
        viewer.release = () => lifetime.removeEventListener('abort', end)
        if (lifetime.aborted) end()
      }
    }
    viewer.width = Math.max(MIN_VIEW_WIDTH, Math.min(BOT_BROWSER_PANE_WATCH.maxWidth, Math.floor(input.width)))
    viewer.fps = Math.max(1, Math.min(BOT_BROWSER_PANE_WATCH.heldFps, Math.floor(input.fps)))
    viewer.until = this.now() + VIEWER_LEASE_MS
    // Everything it has not seen goes with its first update.
    const hadPicture = viewer.lastPictureAt > 0
    if (!hadPicture) viewer.sent = {}
    // The answer says whether pictures can reach it now; a stall it heard of stays told.
    if (state.stalled) viewer.sent.stalled = true
    this.runCapture(state)
    this.refreshCapture(state)
    state.capture?.wake?.()
    const view = await this.view(botId, { last: !hadPicture, connectionId: input.connectionId, ...(viewer.viewId ? { viewId: viewer.viewId } : {}) })
    // The answer told it who holds the browser and what the page asks: only changes are pushed from here.
    viewer.sent.holder = `${view.control}:${view.holder ?? ''}`
    viewer.sent.dialog = JSON.stringify(view.dialog ?? null)
    viewer.sent.chooser = JSON.stringify(view.chooser ?? null)
    return view
  }

  /** A view stops watching. When none is left, the worker stops the tab's screencast. */
  unwatch(botId: string, watchId: string, connectionId: string): void {
    const state = this.bots.get(botId)
    if (state) this.dropViewer(state, `${connectionId}\u0000${watchId}`)
  }

  // -- the owner's hold

  /**
   * A view's hold of the browser (`bots.browser.hold`). Who holds it is decided here alone, and every
   * view of the bot hears it at once (`holder`):
   *
   * - `take`: the view takes the browser over; the bot's actions wait. The tab the views follow is the
   *   one it takes: it comes to the front and the person's input goes to it alone. The hold is bound to
   *   the connection that took it. A view that takes it again gets a fresh hold (a new id, numbered
   *   from 1): whatever its channel was waiting on is dropped cleanly. A window that reloaded keeps its
   *   connection and picks its hold up from `view` instead, at the host's last input number. Another
   *   view's hold is refused (`held_elsewhere`) unless `force`: then that hold ends, what it left pressed
   *   is let go of, and this view holds the browser.
   * - `renew`: the view is still there. A hold not renewed for two minutes ends: what the person left
   *   pressed is let go of, the browser goes back to the bot, and its chat says so in one line. A window
   *   back on a new connection renews there, and the hold moves to it (`claim`).
   * - `release`: Give back. Pressed keys and buttons go up, a composition is dropped, and the bot has it.
   */
  async hold(botId: string, viewId: string, request: { op: 'take'; force?: boolean; platform?: 'mac' | 'other' } | { op: 'renew' | 'release'; holdId: string }, connectionId = 'local'): Promise<{ browser: BotBrowserView; hold?: BotBrowserHold }> {
    const state = this.stateFor(botId)
    if (request.op === 'take') {
      const hold = await this.takeHold(state, viewId, connectionId, { ...(request.force ? { force: true } : {}), platform: request.platform ?? 'other' })
      return { browser: await this.viewAfterChange(state, viewId, connectionId), hold: this.holdAnswer(hold) }
    }
    if (request.op === 'renew') {
      const hold = state.hold
      if (!hold || !this.claim(hold, viewId, request.holdId, connectionId)) throw holdEnded()
      this.beat(state, hold)
      return { browser: await this.view(botId, { viewId, connectionId }), hold: this.holdAnswer(hold) }
    }
    await this.inTurn(state, async () => {
      const hold = state.hold
      // A hold that already ended is given back already.
      if (hold && this.claim(hold, viewId, request.holdId, connectionId)) await this.endHold(state, hold, 'given-back')
    })
    return { browser: await this.viewAfterChange(state, viewId, connectionId) }
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
   * Numbered inputs of a view's hold (`bots.browser.send`): each is applied once, in number order, to
   * the tab the view took, and answered. A view that does not hold the browser, or a connection that
   * is not the hold's, has each refused.
   */
  async send(botId: string, viewId: string, holdId: string, inputs: BotBrowserSent[], connectionId = 'local'): Promise<{ acks: BotBrowserAck[]; lastSeq: number }> {
    const state = this.stateFor(botId)
    const hold = state.hold
    if (!hold || !this.claim(hold, viewId, holdId, connectionId)) {
      const text = hold && hold.viewId !== viewId ? 'Held in another window' : 'You don\'t hold the browser now'
      return { acks: inputs.map((sent) => ({ seq: sent.seq, status: 'refused', reason: 'not-held', text })), lastSeq: 0 }
    }
    // Input is a sign of life too.
    this.beat(state, hold)
    const acks = await Promise.all(inputs.map((sent) => hold.channel.submit(sent.seq, sent)))
    return { acks, lastSeq: hold.channel.lastSeq }
  }

  /**
   * The files the person chose in this computer's own file dialog for the page's file picker
   * (`bots.browser.files`, called by the app's main process alone): checked against the hold, the picker
   * open on its tab, and the limits (at most `MAX_BOT_BROWSER_FILES` files, `MAX_BOT_BROWSER_FILES_BYTES`
   * in all, each a file). Answers a one-time token the view sends as its `files` input; only the
   * latest one counts, and none outlives the hold. The paths are never logged.
   */
  async chooseFiles(botId: string, viewId: string, holdId: string, paths: string[], connectionId = 'local'): Promise<{ token: string; count: number }> {
    const state = this.stateFor(botId)
    const hold = state.hold
    if (!hold || !this.claim(hold, viewId, holdId, connectionId)) throw holdEnded()
    const chooser = state.chooser
    if (!chooser || state.follow !== hold.tabId) throw new BrowserAutomationError({ code: 'not_actionable', message: 'The page is not asking for a file now.' })
    if (paths.length > 1 && !chooser.multiple) throw new BrowserAutomationError({ code: 'too_large', message: 'The page takes one file here.' })
    if (!paths.length || paths.length > MAX_BOT_BROWSER_FILES) throw new BrowserAutomationError({ code: 'too_large', message: BOT_BROWSER_FILES_LIMIT_TEXT })
    let total = 0
    for (const path of paths) {
      if (!isAbsolute(path) || path.includes('\0')) throw new BrowserAutomationError({ code: 'invalid_action', message: 'A chosen file has no place on this computer.' })
      const info = await stat(path).catch(() => undefined)
      if (!info?.isFile()) throw new BrowserAutomationError({ code: 'not_actionable', message: `${basename(path)} is not a file Mousse can read.` })
      total += info.size
    }
    if (total > MAX_BOT_BROWSER_FILES_BYTES) throw new BrowserAutomationError({ code: 'too_large', message: BOT_BROWSER_FILES_LIMIT_TEXT })
    const token = `files_${randomUUID()}`
    // One picker, one answer: a token chosen before no longer counts.
    hold.files.clear()
    hold.files.set(token, [...paths])
    return { token, count: paths.length }
  }

  /** An older app's Take over (`owner`) or Give back (`bot`): a hold of that window's connection. */
  async control(botId: string, control: 'owner' | 'bot', connectionId = 'local'): Promise<BotBrowserView> {
    const state = this.stateFor(botId)
    const viewId = legacyView(connectionId)
    if (control === 'owner') await this.takeHold(state, viewId, connectionId, { force: true, keep: true, platform: process.platform === 'darwin' ? 'mac' : 'other', legacy: true })
    else await this.inTurn(state, async () => {
      if (state.hold) await this.endHold(state, state.hold, 'given-back')
      else if (this.record(state)?.lifecycle === 'human-controlled') await this.ownerCall(state, (context) => this.service().sessions.control(context, this.requireLive(state), 'agent'))
    })
    return this.viewAfterChange(state)
  }

  /** An older app's click, scroll, typing or navigation, while its window holds the browser (`control`). */
  async input(botId: string, input: PageInput, connectionId = 'local'): Promise<BotBrowserView> {
    const state = this.stateFor(botId)
    this.requireLive(state)
    const hold = state.hold
    if (!hold?.legacy || hold.viewId !== legacyView(connectionId)) throw new BrowserAutomationError({ code: 'human_controlled', message: 'Take control of the browser first' })
    this.beat(state, hold)
    hold.legacy.count += 1
    const ack = await hold.channel.submit(hold.legacy.count, { seq: hold.legacy.count, input })
    if (ack.status === 'refused') {
      // A page that failed keeps its class and Chromium's code, as the worker said it.
      const problem = ack.reason === 'failed' && (input.kind === 'navigate' || input.kind === 'back' || input.kind === 'forward' || input.kind === 'reload') ? state.botProblem : undefined
      if (problem) throw new BrowserAutomationError({ code: BROWSER_PROBLEM_CODES[problem.kind], message: browserProblemMessage(problem), details: { problem } })
      throw new BrowserAutomationError({ code: ack.reason === 'tab-closed' ? 'stale_ref' : ack.reason === 'page-changed' ? 'stale_observation' : 'not_actionable', message: ack.text ?? 'The input did not reach the page' })
    }
    return this.viewAfterChange(state)
  }

  /** After the owner changed something: a watching view gets the new picture pushed; an older one takes a fresh frame. */
  private viewAfterChange(state: BotBrowserState, viewId?: string, connectionId?: string): Promise<BotBrowserView> {
    const asked = { ...(viewId ? { viewId } : {}), ...(connectionId ? { connectionId } : {}) }
    if (state.viewers.size) return this.view(state.botId, { last: true, ...asked })
    state.frameAt = undefined
    return this.view(state.botId, { frame: true, ...asked })
  }

  /**
   * Opens the bot's browser for its owner, under their control: to sign in to a site for the bot. It
   * is the view's hold (`viewId`; an older app's window when absent), bound to its connection. An open
   * browser is handed to the owner as it is, on `url` when one is given; one another view holds is
   * refused ("Held in another window": only Take over takes it from there). A closed one opens blank
   * and is the owner's before it loads anything, so `url` loads as the owner's page.
   */
  async open(botId: string, url?: string, view: { viewId?: string; platform?: 'mac' | 'other'; connectionId?: string } = {}): Promise<{ browser: BotBrowserView; hold?: BotBrowserHold }> {
    const state = this.stateFor(botId)
    const connectionId = view.connectionId ?? 'local'
    const viewId = view.viewId ?? legacyView(connectionId)
    const hold = await this.inTurn(state, async () => {
      if (state.hold && state.hold.viewId !== viewId) throw heldElsewhere()
      // The owner takes the tab they see (with none followed, the one the last picture showed).
      if (!state.hold && !state.follow && state.pictureTab) this.followTab(state, state.pictureTab)
      await this.ownerCall(state, async (context) => {
        const opened = await this.ensureSession(state, context, undefined)
        if (this.record(state)?.lifecycle !== 'human-controlled') await this.service().sessions.control(context, opened.sessionId, 'human', { ...(state.follow ? { tabId: state.follow } : {}), chooser: true })
      })
      const held = await this.holdFor(state, viewId, connectionId, { keep: true, platform: view.platform ?? 'other', ...(view.viewId ? {} : { legacy: true }) })
      // The page loads as the owner's input: in the next turn, so it never lands beside a run's call.
      if (url) {
        const sessionId = this.requireLive(state)
        await this.ownerInput(state, (context) => this.service().sessions.humanInput(context, { sessionId, input: { kind: 'navigate', url }, ...(held.tabId ? { tabId: held.tabId } : {}) }), held.tabId)
      }
      return held
    })
    state.lastViewedAt = this.now()
    if (![...state.activations.values()].some((entry) => !entry.ended)) this.armIdle(state)
    this.runCapture(state)
    this.refreshCapture(state)
    return { browser: await this.viewAfterChange(state, viewId, connectionId), ...(view.viewId ? { hold: this.holdAnswer(hold) } : {}) }
  }

  /** Who holds the browser, as the view `viewId` sees it. */
  private holderFor(state: BotBrowserState, viewId: string): BotBrowserHolder {
    if (this.record(state)?.lifecycle !== 'human-controlled') return 'bot'
    return state.hold?.viewId === viewId ? 'this-view' : 'another-view'
  }

  private holdAnswer(hold: OwnerHold): BotBrowserHold {
    return { id: hold.id, lastSeq: hold.channel.lastSeq, computer: this.computer }
  }

  /** Changes of who holds the bot's browser, one at a time (two windows taking it at once). */
  private inTurn<T>(state: BotBrowserState, work: () => Promise<T>): Promise<T> {
    const next = state.holding.then(work, work)
    state.holding = next.catch(() => undefined)
    return next
  }

  /** `take`: the bot's browser becomes the view's (see `hold`). */
  private takeHold(state: BotBrowserState, viewId: string, connectionId: string, options: { force?: boolean; keep?: boolean; platform: 'mac' | 'other'; legacy?: boolean }): Promise<OwnerHold> {
    return this.inTurn(state, async () => {
      const sessionId = this.requireLive(state)
      const current = state.hold
      if (current && current.viewId !== viewId && !options.force) throw heldElsewhere()
      // The owner takes the tab they see: the one the view follows (with none followed, the one the last picture
      // showed), as it is now, whatever a run does while the browser changes hands. It comes to the front, so Chromium
      // paints what they do, and its file picker is answered in their view.
      const tabId = current ? current.tabId : state.follow ?? state.pictureTab
      if (!current && this.record(state)?.lifecycle !== 'human-controlled') {
        await this.ownerCall(state, (context) => this.service().sessions.control(context, sessionId, 'human', { ...(tabId ? { tabId } : {}), chooser: true }))
      }
      const hold = await this.holdFor(state, viewId, connectionId, { ...options, ...(tabId ? { tabId } : {}) })
      // Up to 30 pictures a second while the owner holds it, back to 15 when the bot has it again.
      this.refreshCapture(state)
      return hold
    })
  }

  /**
   * The view's hold of a browser the owner has (in turn): its own, kept (`keep`, on the same
   * connection), or a fresh one, which ends the hold before it, this view's own or another's.
   */
  private async holdFor(state: BotBrowserState, viewId: string, connectionId: string, options: { keep?: boolean; platform: 'mac' | 'other'; legacy?: boolean; tabId?: string }): Promise<OwnerHold> {
    const current = state.hold
    if (current?.viewId === viewId && current.connectionId === connectionId && options.keep) {
      this.beat(state, current)
      return current
    }
    // A hold that replaces another keeps its tab: nothing a run did meanwhile moved it.
    const tabId = current ? current.tabId : options.tabId ?? state.follow
    if (current) await this.endHold(state, current, current.viewId === viewId ? 'replaced' : 'taken', { keepControl: true })
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
      channel: undefined as unknown as InputSequencer<BotBrowserSent>
    }
    hold.channel = new InputSequencer<BotBrowserSent>({ apply: (sent) => this.applyInput(state, hold, sent) })
    state.hold = hold
    // The views show the tab the owner holds, until they give it back.
    if (hold.tabId) this.followTab(state, hold.tabId)
    this.beat(state, hold)
    this.notifyHolder(state)
    return hold
  }

  /** The view is still there: its hold lasts another lease from now. */
  private beat(state: BotBrowserState, hold: OwnerHold): void {
    hold.beatAt = this.now()
    if (hold.lease) return
    const arm = (ms: number) => {
      hold.lease = this.leaseTimer(() => {
        hold.lease = undefined
        if (state.hold !== hold) return
        const left = hold.beatAt + this.holdLeaseMs - this.now()
        if (left > 0) {
          arm(left)
          return
        }
        void this.inTurn(state, async () => {
          if (state.hold !== hold || hold.beatAt + this.holdLeaseMs > this.now()) return
          await this.endHold(state, hold, 'expired')
        }).catch((error) => console.warn('a bot browser hold could not end', { botId: state.botId, error: error instanceof Error ? error.message : String(error) }))
      }, ms)
    }
    arm(this.holdLeaseMs)
  }

  /**
   * A hold ends (in turn): what waits in its channel is refused, what is being applied finishes, and
   * then what the person left pressed is let go of. Unless another view takes it on (`keepControl`), the
   * browser goes back to the bot. The view that held it hears why, unless it gave it back itself; a
   * hold that ran out says so in the bot's chat.
   */
  private async endHold(state: BotBrowserState, hold: OwnerHold, end: HoldEndReason, options: { keepControl?: boolean } = {}): Promise<void> {
    if (state.hold !== hold) return
    state.hold = undefined
    hold.lease?.clear()
    hold.lease = undefined
    hold.files.clear()
    await hold.channel.close('not-held', end === 'taken' ? 'Held in another window' : end === 'replaced' ? 'You took the browser over again' : 'You gave the browser back')
    const sessionId = this.liveSession(state)
    if (sessionId) {
      if (options.keepControl) {
        await this.ownerInput(state, (context) => this.service().sessions.humanInput(context, { sessionId, input: { kind: 'release' }, ...(hold.tabId ? { tabId: hold.tabId } : {}) })).catch(() => undefined)
      } else {
        // The worker lets go of what the person left pressed before the bot has it again.
        await this.ownerCall(state, (context) => this.service().sessions.control(context, sessionId, 'agent')).catch((error) => {
          console.warn('a bot browser could not be given back', { botId: state.botId, error: error instanceof Error ? error.message : String(error) })
        })
      }
    }
    if (end !== 'given-back' && end !== 'replaced') {
      for (const viewer of state.viewers.values()) {
        if (viewer.viewId !== hold.viewId) continue
        viewer.slot = { ...viewer.slot, holdEnded: end }
        this.deliver(state, viewer)
      }
    }
    if (end === 'expired') this.notice?.(state.botId, HOLD_EXPIRED_NOTICE)
    // The bot has its browser again: the view follows a run's tab again.
    if (!options.keepControl) {
      this.refollow(state)
      this.runCapture(state)
      state.capture?.wake?.()
    }
    this.refreshCapture(state)
    // A hold another one replaces at once (`keepControl`): the views hear of the new one instead.
    if (!options.keepControl) this.notifyHolder(state)
  }

  /** A hold ends with its browser (closed, the bot removed): nothing to give back. */
  private dropHold(state: BotBrowserState): void {
    const hold = state.hold
    if (!hold) return
    state.hold = undefined
    hold.lease?.clear()
    hold.lease = undefined
    hold.files.clear()
    void hold.channel.close('not-held', 'The browser closed')
  }

  /** Each view hears who holds the browser now, when that changed for it. */
  private notifyHolder(state: BotBrowserState): void {
    const control = this.record(state)?.lifecycle === 'human-controlled' ? 'owner' : 'bot'
    for (const viewer of state.viewers.values()) {
      const holder = viewer.viewId && this.liveSession(state) ? this.holderFor(state, viewer.viewId) : undefined
      const said = `${control}:${holder ?? ''}`
      if (viewer.sent.holder === said) continue
      viewer.slot = { ...viewer.slot, control, ...(holder ? { holder } : {}) }
      this.deliver(state, viewer)
    }
  }

  /**
   * Where a picture the person acted on was taken, when this host can say: one of the pictures it
   * remembers, of the tab the view took, with its document and scroll. An older app names no picture:
   * its input is placed on the latest picture of that tab (the one it asked for last).
   */
  private place(state: BotBrowserState, hold: OwnerHold, picture: number | undefined): BrowserPictureSpot | undefined {
    const record = picture !== undefined
      ? state.pictures.find((entry) => entry.id === picture)
      : hold.legacy ? [...state.pictures].reverse().find((entry) => entry.tabId === hold.tabId) : undefined
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
  private async applyInput(state: BotBrowserState, hold: OwnerHold, sent: BotBrowserSent): Promise<Omit<BotBrowserAck, 'seq'>> {
    if ('skip' in sent) return refused('skipped', 'Skipped')
    const sessionId = this.liveSession(state)
    if (!sessionId || state.hold !== hold) return refused('not-held', 'You gave the browser back')
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
    let spot = this.place(state, hold, sent.picture)
    // An older app names no picture: with none of the tab known yet, the page as it is now is its picture.
    if (!spot && hold.legacy && located(input)) {
      await this.takeFrame(state).catch(() => undefined)
      spot = this.place(state, hold, sent.picture)
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
      const [result] = await this.ownerInput(state, (context) => this.service().sessions.humanInputs(context, { sessionId, tabId, inputs: [{ input, ...(spot && located(input) ? { spot } : {}) }] }), tabId)
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
      // The owner's own page replaces what the bot's last page ran into.
      if (navigates) this.noteBotProblem(state, result.navigation?.problem)
      return { status: 'applied', ...(result.copied !== undefined ? { copied: result.copied } : {}) }
    } catch (error) {
      const code = error instanceof BrowserAutomationError ? error.code : undefined
      const problem = error instanceof BrowserAutomationError ? error.details?.problem as BrowserProblem | undefined : undefined
      if (navigates && problem) {
        this.noteBotProblem(state, problem)
        const said = browserProblemForPerson(problem)
        return { ...refused('failed', said.line), detail: said.detail }
      }
      if (code === 'stale_ref') return refused('tab-closed', TAB_CLOSED)
      if (code === 'human_controlled') return refused('not-held', 'You gave the browser back')
      return refused('failed', error instanceof Error ? error.message : String(error))
    }
  }

  /**
   * One input of the owner's to the worker, in the browser's turn (`BrowserTurns`), so it never lands beside a run's
   * call: ahead of the runs' calls that wait, and cutting into a run's call under way once `OWNER_CUT_IN_MS` has passed
   * (that call is refused to its run as an owner who uses the browser now, as acting is during a hold), so it never
   * waits out a run's long call either. The browser stays theirs `OWNER_KEEP_MS` after it, so typing goes at the
   * page's pace and the runs read in the pauses. It resolves once the worker applied it, so the view's acknowledgement
   * says the input reached the page, not that it was queued.
   */
  private ownerInput<T>(state: BotBrowserState, call: (context: BrowserToolContext) => Promise<T>, tabId?: string): Promise<T> {
    return state.turns.run((held) => this.ownerCall(state, call, held), {
      first: true,
      waitMs: OWNER_INPUT_WAIT_MS,
      busy: ownerInputBusy,
      cutIn: { afterMs: OWNER_CUT_IN_MS, reason: ownerHolds },
      keepMs: OWNER_KEEP_MS,
      ...(tabId ? { tab: tabId } : {})
    })
  }

  async close(botId: string): Promise<BotBrowserView> {
    const state = this.stateFor(botId)
    state.idle?.clear()
    await this.closeSession(state)
    return this.view(botId)
  }

  /** Closes every bot browser (the profile is stopping). */
  async dispose(): Promise<void> {
    await Promise.allSettled([...this.bots.values()].map(async (state) => {
      state.idle?.clear()
      for (const key of [...state.viewers.keys()]) this.dropViewer(state, key)
      await this.closeSession(state)
    }))
    this.bots.clear()
  }

  // -- the bot's tool calls

  private async dispatch(state: BotBrowserState, activationId: string, turnSignal: AbortSignal, original: BrowserToolContext, name: BrowserAutomationTool, args: unknown): Promise<BrowserToolOutput> {
    const activation = state.activations.get(activationId)
    if (!activation || activation.ended || turnSignal.aborted) throw new BrowserAutomationError({ code: 'cancelled', message: 'This run of the bot has ended.' })
    if (original.execution.threadId !== state.homeThreadId || original.execution.profileId !== this.options.profileId)
      throw new BrowserAutomationError({ code: 'profile_mismatch', message: 'This browser belongs to another bot.' })
    if (!args || typeof args !== 'object' || Array.isArray(args)) throw new BrowserAutomationError({ code: 'invalid_action', message: 'Browser arguments must be an object' })
    const context: BrowserToolContext = {
      ...original,
      target: { backend: 'managed-chromium' },
      keeper: BOT_BROWSER_KEEPER,
      signal: original.signal ? AbortSignal.any([original.signal, turnSignal]) : turnSignal
    }
    const params = { ...(args as Record<string, unknown>) }
    if (name === 'browser_open' && Object.keys(params).some((key) => key !== 'url')) throw new BrowserAutomationError({ code: 'invalid_action', message: 'browser_open takes only a url' })
    this.markUsed(state, activationId)
    state.idle?.clear()
    state.idle = undefined
    // While the owner holds the browser the bot reads it, and acts, opens or loads nothing.
    const opens = actsOrLoads(name, params)
    if (opens && this.held(state)) throw ownerHolds()
    // A page the bot could not open (in a tab that closed again, too): its owner's view says so.
    // Only the run the view follows: another run's page never shows over its tab.
    const noted = (error: unknown): never => {
      const problem = error instanceof BrowserAutomationError ? error.details?.problem as BrowserProblem | undefined : undefined
      if (opens && problem && this.isFollowed(state, activation)) this.noteBotProblem(state, problem)
      throw error
    }
    // Opening the session (and a first use's install) is shared and needs no turn: the open is made once.
    const url = name === 'browser_open' && typeof params.url === 'string' ? params.url : undefined
    const opened = name === 'browser_open' ? await this.ensureSession(state, context, url).catch(noted) : undefined
    // Each call drives the browser on its own, in its turn: another activation's call never pulls its tab away mid-way.
    // It gives way to its owner's input (`OWNER_CUT_IN_MS`).
    const tab = typeof params.tabId === 'string' ? params.tabId : activation.current
    return state.turns.run(async (held) => {
      if (activation.ended || turnSignal.aborted) throw new BrowserAutomationError({ code: 'cancelled', message: 'This run of the bot has ended.' })
      return this.dispatchInTurn(state, activation, { ...context, signal: AbortSignal.any([context.signal ?? turnSignal, held]) }, name, params, opened, url).catch(noted)
    }, { signal: context.signal ?? turnSignal, yields: true, ...(tab ? { tab } : {}) })
  }

  /** One of the bot's tool calls, while it holds the browser (`BrowserTurns`). */
  private async dispatchInTurn(state: BotBrowserState, activation: ActivationTabs, context: BrowserToolContext, name: BrowserAutomationTool, params: Record<string, unknown>, opened: OpenedSession | undefined, url: string | undefined): Promise<BrowserToolOutput> {
    let result: BrowserToolOutput
    const opens = actsOrLoads(name, params)
    // Checked again in the call's turn: the owner may have taken the browser over while it waited.
    if (opens && this.held(state)) throw ownerHolds()
    if (opened) {
      const open = async (session: OpenedSession): Promise<BrowserToolOutput> => {
        let tabId: string | undefined
        // How the page went (a slow or failed page leaves the browser open).
        let navigation = session.opened?.navigation
        if (session.opened) tabId = session.opened.observation?.tabId
        else if (url || !activation.current) ({ tabId, navigation } = await this.newTab(context, session.sessionId, url))
        else tabId = activation.current
        if (tabId) this.useTab(state, activation, tabId)
        const observed = await this.invoke(context, 'browser_observe', { sessionId: session.sessionId, ...(tabId ? { tabId } : {}) })
        const record = this.record(state)
        return { ...observed, ...(record ? { session: record, capabilities: record.capabilities } : {}), ...(navigation ? { navigation } : {}) }
      }
      // The browser stopped by itself since its last use (nothing was done in it): it starts again, once.
      result = await open(opened).catch(async (error: unknown) => {
        if (!(error instanceof BrowserAutomationError && error.code === 'worker_disconnected') || !this.stopped(state)) throw error
        return open(await this.ensureSession(state, context, url))
      })
    } else {
      const sessionId = this.liveSession(state)
      if (!sessionId) throw new BrowserAutomationError({ code: 'session_closed', message: 'Your browser is closed. Open a page with browser_open first.' })
      if (params.sessionId !== undefined && params.sessionId !== sessionId) throw new BrowserAutomationError({ code: 'profile_mismatch', message: 'That browser session is not yours. Use the sessionId browser_open returned.' })
      params.sessionId = sessionId
      if (name === 'browser_tabs') {
        result = await this.tabs(state, activation, context, sessionId, params)
      } else {
        // An observation without a tab looks at this activation's own tab; another's is refused.
        if (params.tabId === undefined && activation.current) params.tabId = activation.current
        if (typeof params.tabId === 'string' && !activation.tabs.has(params.tabId))
          throw new BrowserAutomationError({ code: 'profile_mismatch', message: 'That tab belongs to another of your runs. Open your own with browser_open.' })
        result = await this.invoke(context, name, params)
      }
    }
    // Its owner took the browser over while this action ran: the bot hears it in its owner's terms,
    // and whether the action took effect.
    if (result.action?.takeover) result = { ...result, action: { ...result.action, message: browserTakeoverMessage(result.action.takeover, 'Your owner') + ' Wait for them to give the browser back, or carry on without it.' } }
    const navigation = result.navigation ?? result.action?.navigation
    if (opens && navigation && this.isFollowed(state, activation)) this.noteBotProblem(state, navigation.problem)
    const tabId = result.observation?.tabId ?? result.action?.observation?.tabId
    if (tabId && activation.tabs.has(tabId)) this.useTab(state, activation, tabId)
    return result
  }

  private async tabs(state: BotBrowserState, activation: ActivationTabs, context: BrowserToolContext, sessionId: string, params: Record<string, unknown>): Promise<BrowserToolOutput> {
    const operation = params.operation ?? 'list'
    let navigation: BrowserNavigation | undefined
    if (operation === 'new') {
      const made = await this.newTab(context, sessionId, typeof params.url === 'string' ? params.url : undefined)
      navigation = made.navigation
      if (made.tabId) this.useTab(state, activation, made.tabId)
    } else if (operation === 'switch' || operation === 'close') {
      if (typeof params.tabId !== 'string' || !activation.tabs.has(params.tabId))
        throw new BrowserAutomationError({ code: 'profile_mismatch', message: 'That tab belongs to another of your runs.' })
      await this.invoke(context, 'browser_tabs', { sessionId, operation, tabId: params.tabId })
      if (operation === 'switch') this.useTab(state, activation, params.tabId)
      else {
        activation.tabs.delete(params.tabId)
        if (activation.current === params.tabId) activation.current = [...activation.tabs].pop()
        this.tabClosed(state, params.tabId)
        this.refollow(state)
      }
    } else if (operation !== 'list') throw new BrowserAutomationError({ code: 'invalid_action', message: 'Invalid browser operation' })
    // Every operation answers with this activation's own tabs.
    const listed = await this.invoke(context, 'browser_tabs', { sessionId, operation: 'list' })
    return { tabs: (listed.tabs ?? []).filter((tab: BrowserTab) => activation.tabs.has(tab.id)), ...(navigation ? { navigation } : {}) }
  }

  private useTab(state: BotBrowserState, activation: ActivationTabs, tabId: string): void {
    activation.tabs.add(tabId)
    activation.current = tabId
    // While the owner holds the browser the view stays on the tab they took, whatever a run reads (`refollow`).
    this.refollow(state)
  }

  /** The view follows another tab (or none): a capture of the previous one ends and starts on this one. */
  private followTab(state: BotBrowserState, tabId: string | undefined): void {
    if (state.follow === tabId) {
      this.runCapture(state)
      return
    }
    state.follow = tabId
    const capture = state.capture
    if (capture?.tabId && capture.tabId !== tabId) this.stopWorkerWatch(state, capture.key)
    this.runCapture(state)
    capture?.wake?.()
  }

  /**
   * Sets the tab the owner's view follows. While the owner holds the browser nothing changes: it stays the tab they took.
   * Otherwise it is the current tab of one activation (`followed`), the newest that uses the browser when the one it
   * followed has ended; another activation's call never moves it, so the preview and the split view never jump
   * between runs.
   */
  private refollow(state: BotBrowserState): void {
    if (this.held(state)) return
    let followed = state.followed ? state.activations.get(state.followed) : undefined
    if (!followed || followed.ended) {
      const next = [...state.used].reverse().find((id) => state.activations.get(id)?.ended === false)
      if (next) {
        state.followed = next
        followed = state.activations.get(next)
      }
    }
    if (followed?.current) this.followTab(state, followed.current)
  }

  /** The view follows this activation's tab, or none yet. */
  private isFollowed(state: BotBrowserState, activation: ActivationTabs): boolean {
    return !state.followed || state.activations.get(state.followed) === activation
  }

  /**
   * The owner holds the bot's browser: a view's hold (`hold`, `open`, or an older app's `control`), the one rule for who
   * controls it. The session is the person's (human-controlled) exactly while a hold lasts; in the moment between the
   * two, inside Take over, the worker itself refuses the bot's actions.
   */
  private held(state: BotBrowserState): boolean {
    return state.hold !== undefined
  }

  /**
   * A tab of the bot's closed (its run ended, or the run closed it). The view no longer follows it; if it is the tab the
   * owner holds, their input is refused from now on ("The tab you took over has closed"), never sent to another tab,
   * and the views keep its last picture.
   */
  private tabClosed(state: BotBrowserState, tabId: string): void {
    if (state.hold?.tabId === tabId) state.hold.tabId = undefined
    if (state.follow === tabId) this.followTab(state, undefined)
  }

  /**
   * A new tab in the bot's session: the one the browser opened for this call, whatever other
   * activations opened meanwhile, and how its page went.
   */
  private async newTab(context: BrowserToolContext, sessionId: string, url: string | undefined): Promise<{ tabId?: string; navigation?: BrowserNavigation }> {
    const made = await this.invoke(context, 'browser_tabs', { sessionId, operation: 'new', ...(url ? { url } : {}) })
    return { ...(made.tab?.id ? { tabId: made.tab.id } : {}), ...(made.navigation ? { navigation: made.navigation } : {}) }
  }

  private async invoke(context: BrowserToolContext, name: BrowserAutomationTool, args: Record<string, unknown>): Promise<BrowserToolOutput> {
    const result = await this.service().tools.invoke(name, args, context)
    if (!result.ok) throw new BrowserAutomationError(result.error)
    return result.value
  }

  private async readScreenshot(state: BotBrowserState, context: BrowserToolContext, sessionId: string, artifactId: string): Promise<{ data: string; mimeType: 'image/png' }> {
    if (!context.vision) throw new BrowserAutomationError({ code: 'policy_denied', message: 'Screenshots need a model that can see images' })
    if (sessionId !== state.sessionId) throw new BrowserAutomationError({ code: 'profile_mismatch', message: 'That screenshot is not from your browser' })
    const artifact = await this.service().artifacts.read({ profileId: this.options.profileId, threadId: state.homeThreadId, sessionId }, artifactId, Math.min(context.policy.maxArtifactBytes, 16 * 1024 * 1024))
    if (artifact.ref.mediaType !== 'image/png') throw new BrowserAutomationError({ code: 'invalid_action', message: 'Browser screenshot must be PNG' })
    return { data: Buffer.from(artifact.bytes).toString('base64'), mimeType: 'image/png' }
  }

  // -- the session

  /** The bot's open session, or a new one on its own persistent profile. */
  private async ensureSession(state: BotBrowserState, context: BrowserToolContext, url: string | undefined): Promise<OpenedSession> {
    const live = this.liveSession(state)
    if (live) return { sessionId: live }
    if (state.opening) return { sessionId: (await state.opening).sessionId }
    const opening = (async (): Promise<OpenedSession> => {
      await this.ensureInstalled(context.signal)
      // A session left disconnected (a worker restart) is closed first: it would hold the profile.
      if (state.sessionId) await this.closeSession(state).catch(() => undefined)
      const opened = await this.invoke(context, 'browser_open', { ...(url ? { url } : {}), persistent: true, workspaceId: botBrowserWorkspace(state.botId) })
      if (!opened.session) throw new BrowserAutomationError({ code: 'worker_disconnected', message: 'The browser did not open' })
      state.sessionId = opened.session.id
      state.behind = false
      this.followTab(state, opened.observation?.tabId)
      return { sessionId: opened.session.id, opened }
    })()
    state.opening = opening
    try {
      return await opening
    } finally {
      if (state.opening === opening) state.opening = undefined
    }
  }

  /**
   * The managed browser, installed: on a computer without it, a bot's first browser use downloads it
   * (once for every bot and profile) and waits for it, until the call's signal ends the wait.
   */
  private async ensureInstalled(signal: AbortSignal | undefined): Promise<void> {
    const setup = this.setup
    if (!setup) return
    let status = await setup.status()
    if (status.availability === 'ready') return
    if (status.availability === 'unsupported' || status.availability === 'blocked' || (status.availability === 'setup-required' && !status.canInstall))
      throw new BrowserAutomationError({ code: 'setup_required', message: `The browser can't run on this computer: ${status.message}` })
    if (status.availability === 'setup-required') status = (await setup.install() as { status?: BrowserSetupStatus }).status ?? status
    const pollMs = this.options.setupPollMs ?? 1_000
    try {
      for (;;) {
        if (status.availability === 'ready') return
        const operation = status.operation
        if (operation && (operation.state === 'failed' || operation.state === 'cancelled'))
          throw new BrowserAutomationError({ code: 'setup_required', message: `Setting up the browser did not finish: ${operation.error?.message ?? operation.state}. Try again later.` })
        const fraction = operation?.progress.fraction
        this.installing = typeof fraction === 'number' && Number.isFinite(fraction) ? { percent: Math.round(fraction * 100) } : {}
        if (signal?.aborted) throw new BrowserAutomationError({ code: 'cancelled', message: 'Setting up the browser goes on; this call ended before it finished.' })
        await new Promise((resolve) => setTimeout(resolve, pollMs))
        status = await setup.status()
      }
    } finally {
      this.installing = undefined
    }
  }

  private async closeSession(state: BotBrowserState): Promise<void> {
    const sessionId = state.sessionId
    if (!sessionId) return
    this.dropHold(state)
    state.sessionId = undefined
    state.follow = undefined
    state.behind = false
    state.dialog = undefined
    state.chooser = undefined
    for (const activation of state.activations.values()) {
      activation.tabs.clear()
      activation.current = undefined
    }
    if (!this.options.browser()) return
    await this.ownerCall(state, (context) => this.service().sessions.close(context, sessionId))
  }

  /**
   * A picture for a view that asks each time (an older app): the worker answers from the tab's capture and never brings
   * a tab forward for it, so it needs no turn and never pulls a run's tab away. It has 15 seconds at most.
   */
  private async takeFrame(state: BotBrowserState): Promise<void> {
    const sessionId = this.liveSession(state)
    if (!sessionId) return
    // The tab the owner holds has gone: the view keeps its last picture, never another run's tab.
    if (!state.follow && this.held(state)) return
    const frame = await this.ownerCall(state, (context) => this.service().sessions.frame(context, { sessionId, ...(state.follow ? { tabId: state.follow } : {}), maxWidth: 960 }), AbortSignal.timeout(BROWSER_SIDE_CALL_MS))
    state.frameAt = this.now()
    const id = ++state.pictureSerial
    this.rememberPicture(state, { id, tabId: frame.tabId, ...(frame.spot ? { spot: frame.spot } : {}), at: this.now() })
    state.picture = { data: frame.data, width: frame.width, height: frame.height, viewport: frame.viewport, at: Date.parse(frame.capturedAt) || this.now(), id }
    state.pictureTab = frame.tabId
    state.tab = { url: frame.url, title: frame.title }
    state.cursor = frame.cursor
  }

  // -- watching views

  /**
   * While views watch and the browser is open, asks the worker for the followed tab's next update
   * (a long-poll it answers when the page paints or the tab changes) and hands it to each view. The
   * next is asked for only once a view is free to take it, so while every view is still busy
   * delivering, Chromium is asked for nothing.
   */
  private runCapture(state: BotBrowserState): void {
    if (state.capture || !state.viewers.size || !this.liveSession(state)) return
    const capture: Capture = { key: `view_${randomUUID()}`, afterFrame: 0, afterState: 0 }
    state.capture = capture
    void (async () => {
      let failures = 0
      try {
        for (;;) {
          this.expireViewers(state)
          if (!state.viewers.size || state.capture !== capture) return
          const sessionId = this.liveSession(state)
          if (!sessionId) {
            this.stall(state, this.stopped(state) ? BROWSER_STOPPED : 'The browser closed.')
            return
          }
          await this.viewerFree(state, capture)
          if (!state.viewers.size || state.capture !== capture) return
          const tabId = state.follow
          // The tab the owner holds has closed: the views keep its last picture, never another run's tab, until the
          // view follows a tab again (Give back) or the views change.
          if (!tabId && this.held(state)) {
            this.stall(state, HELD_TAB_CLOSED)
            await new Promise<void>((resolve) => { capture.wake = () => { capture.wake = undefined; resolve() } })
            continue
          }
          const moved = capture.tabId !== tabId
          const wanted = this.captureParams(state)
          capture.requested = wanted
          let update: BrowserViewerUpdate
          try {
            update = await this.ownerCall(state, (context) => this.service().sessions.viewerNext(context, {
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
            if (this.stopped(state)) {
              this.stall(state, BROWSER_STOPPED)
              return
            }
            failures += 1
            if (failures >= 2) this.stall(state, error instanceof Error ? error.message : String(error))
            await new Promise((resolve) => setTimeout(resolve, Math.min(5_000, 250 * 2 ** failures)))
            continue
          }
          failures = 0
          // The worker answers again: pictures can reach the views, even while the page stays still.
          this.unstall(state)
          // The view moved to another tab while this was asked: the answer is about the one it left.
          if (state.follow !== tabId && update.tabId !== state.follow) continue
          capture.tabId = update.tabId
          capture.afterFrame = update.frameSeq
          capture.afterState = update.stateSeq
          if (update.idle) continue
          this.distribute(state, update)
        }
      } finally {
        if (state.capture === capture) state.capture = undefined
        this.stopWorkerWatch(state, capture.key)
        // A view that came while this one ended starts the next.
        if (state.viewers.size && this.liveSession(state)) this.runCapture(state)
      }
    })()
  }

  /** The capture's size and rate: the widest view, and the fastest within the cap (higher while the owner holds the browser). */
  private captureParams(state: BotBrowserState): { width: number; fps: number } {
    const viewers = [...state.viewers.values()]
    const cap = this.record(state)?.lifecycle === 'human-controlled' ? BOT_BROWSER_PANE_WATCH.heldFps : BOT_BROWSER_PANE_WATCH.fps
    return {
      width: Math.max(MIN_VIEW_WIDTH, ...viewers.map((viewer) => viewer.width)),
      fps: Math.max(1, ...viewers.map((viewer) => Math.min(viewer.fps, cap)))
    }
  }

  /** The views or the cap changed: the worker's wait ends, and the next is asked for at the new size and rate. */
  private refreshCapture(state: BotBrowserState): void {
    const capture = state.capture
    if (!capture?.requested || !state.viewers.size) return
    const wanted = this.captureParams(state)
    if (wanted.width !== capture.requested.width || wanted.fps !== capture.requested.fps) this.stopWorkerWatch(state, capture.key)
  }

  /** Waits until some view is free to take a new picture (none is free while every one is delivering). */
  private viewerFree(state: BotBrowserState, capture: Capture): Promise<void> {
    if ([...state.viewers.values()].some((viewer) => !viewer.delivering)) return Promise.resolve()
    return new Promise((resolve) => {
      capture.wake = () => {
        capture.wake = undefined
        resolve()
      }
    })
  }

  /** Ends the worker's wait for this capture (and its screencast, when nobody else watches the tab). */
  private stopWorkerWatch(state: BotBrowserState, watchKey: string): void {
    const sessionId = this.liveSession(state)
    if (!sessionId) return
    void this.ownerCall(state, (context) => this.service().sessions.viewerStop(context, { sessionId, watchKey })).catch(() => undefined)
  }

  /** Hands a worker update to each view: its picture into the view's slot, and what changed of the rest. */
  private distribute(state: BotBrowserState, update: BrowserViewerUpdate): void {
    const now = this.now()
    if (update.picture) {
      // Each picture has a number, and what it showed is kept a while: input made on it lands on that.
      const { spot, ...picture } = update.picture
      const id = ++state.pictureSerial
      this.rememberPicture(state, { id, tabId: update.tabId, ...(spot ? { spot } : {}), at: now })
      state.picture = { ...picture, viewport: update.viewport, id }
    } else if (state.picture) state.picture = { ...state.picture, viewport: update.viewport }
    state.pictureTab = update.tabId
    state.dialog = update.dialog
    state.chooser = update.chooser
    const dialog = JSON.stringify(update.dialog ?? null)
    state.tab = { url: update.url, title: update.title }
    state.page = update.page
    state.cursor = update.cursor
    state.behind = update.behind
    state.loading = update.loading === true
    state.tabProblem = update.problem
    // What the bot's last page ran into (in a tab that closed again) holds only until the followed tab
    // moves on: another tab, another address, or another page at the same address (the bot or the owner
    // carried on, or the page replaced itself: a redirect or reload once a check was passed).
    const at = state.botProblemAt
    const moved = (at?.tab !== undefined && at.tab !== update.tabId) || (at?.url !== undefined && at.url !== update.url) || (at?.page !== undefined && update.page !== undefined && at.page !== update.page)
    if (state.botProblem && at && moved) {
      state.botProblem = undefined
      state.botProblemAt = undefined
    }
    // The followed tab's own problem, else what the bot's last page ran into.
    state.problem = update.problem ?? state.botProblem
    const problem = JSON.stringify(state.problem ?? null)
    const cursor = update.cursor && agentCursorLive(update.cursor, now) ? update.cursor : null
    for (const viewer of state.viewers.values()) {
      const next: NonNullable<Viewer['slot']> = { ...viewer.slot }
      if (update.picture) next.frame = { data: update.picture.data, mimeType: 'image/jpeg', width: update.picture.width, height: update.picture.height, at: update.picture.at, ...(update.picture.sharp ? { sharp: true } : {}), id: state.pictureSerial }
      if ((viewer.sent.dialog ?? 'null') !== dialog) next.dialog = update.dialog ?? null
      // A file picker is answered by the view that holds the browser alone.
      const chooser = JSON.stringify(viewer.viewId && state.hold?.viewId === viewer.viewId ? update.chooser ?? null : null)
      if ((viewer.sent.chooser ?? 'null') !== chooser) next.chooser = JSON.parse(chooser) as BotBrowserChooser | null
      const viewport = JSON.stringify(update.viewport)
      if (viewer.sent.viewport !== viewport) next.viewport = update.viewport
      if (viewer.sent.tab !== JSON.stringify(state.tab)) next.tab = { ...state.tab }
      if ((viewer.sent.cursorAt ?? null) !== (cursor?.at ?? null)) next.cursor = cursor
      if (viewer.sent.behind !== update.behind) next.behind = update.behind
      if ((viewer.sent.loading ?? false) !== (update.loading === true)) next.loading = update.loading === true
      if ((viewer.sent.problem ?? 'null') !== problem) next.problem = state.problem ?? null
      viewer.slot = next
      this.deliver(state, viewer)
    }
  }

  /**
   * Keeps what a picture sent to the views showed: the last `MIN_PICTURES` always, any sent in the last
   * `PICTURE_KEEP_MS`, at most `MAX_PICTURES`. The oldest go first.
   */
  private rememberPicture(state: BotBrowserState, record: PictureRecord): void {
    const pictures = state.pictures
    pictures.push(record)
    let drop = Math.max(0, pictures.length - MAX_PICTURES)
    while (drop < pictures.length - MIN_PICTURES && record.at - pictures[drop]!.at > PICTURE_KEEP_MS) drop += 1
    if (drop) pictures.splice(0, drop)
  }

  /**
   * What the bot's last page ran into, or nothing once a page went well: shown to its owner even
   * when it was in a tab that closed again (a tab opened on an address nothing answers on).
   */
  private noteBotProblem(state: BotBrowserState, problem: BrowserProblem | undefined): void {
    state.botProblem = problem
    // It stands while the view stays on the same tab at the same address; once that moves on, the tab's own state is shown.
    state.botProblemAt = problem ? { ...(state.follow ? { tab: state.follow } : {}), ...(state.tab ? { url: state.tab.url } : {}), ...(state.page ? { page: state.page } : {}) } : undefined
    const shown = state.tabProblem ?? problem
    if (JSON.stringify(shown ?? null) === JSON.stringify(state.problem ?? null)) return
    state.problem = shown
    for (const viewer of state.viewers.values()) {
      viewer.slot = { ...viewer.slot, problem: shown ?? null }
      this.deliver(state, viewer)
    }
  }

  /**
   * Sends a view's waiting update once the one before it is delivered: a picture at most `fps` a
   * second (the rest goes at once), always the latest.
   */
  private deliver(state: BotBrowserState, viewer: Viewer): void {
    if (viewer.delivering || !viewer.slot || state.viewers.get(viewer.key) !== viewer) return
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
      viewer.timer = defaultTimer(() => { viewer.timer = undefined; this.deliver(state, viewer) }, Math.ceil(wait))
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
    void viewer.emit({ botId: state.botId, watchId: viewer.watchId, ...update })
      .then(() => {
        viewer.delivering = false
        viewer.busy = 0
        this.deliver(state, viewer)
      }, (error: unknown) => {
        viewer.delivering = false
        const refused = refusal(error, viewer)
        if (refused === 'gone' || (refused === 'busy' && ++viewer.busy >= MAX_BUSY_UPDATES)) {
          this.dropViewer(state, viewer.key)
          return
        }
        // Not delivered: what it carried goes again, under anything newer, except a picture too large to go at all.
        viewer.sent = sent
        const { frame, ...rest } = update
        viewer.slot = { ...rest, ...(refused === 'busy' && frame ? { frame } : {}), ...viewer.slot }
        if (refused === 'too_large') {
          this.deliver(state, viewer)
          return
        }
        viewer.timer?.clear()
        viewer.timer = defaultTimer(() => { viewer.timer = undefined; this.deliver(state, viewer) }, BUSY_RETRY_MS)
      })
      .finally(() => state.capture?.wake?.())
  }

  /** Pictures stopped: each view hears it once, so it says it is not updating, and a renewal says so too. */
  private stall(state: BotBrowserState, reason: string): void {
    state.stalled = reason
    for (const viewer of state.viewers.values()) {
      if (viewer.sent.stalled) continue
      viewer.slot = { ...viewer.slot, stalled: reason }
      delete viewer.slot.live
      this.deliver(state, viewer)
    }
  }

  /** Pictures can reach the views again: each that heard of a stall hears it is live. */
  private unstall(state: BotBrowserState): void {
    state.stalled = undefined
    for (const viewer of state.viewers.values()) {
      if (!viewer.sent.stalled && !viewer.slot?.stalled) continue
      viewer.slot = { ...viewer.slot, live: true }
      delete viewer.slot.stalled
      this.deliver(state, viewer)
    }
  }

  private expireViewers(state: BotBrowserState): void {
    const now = this.now()
    for (const viewer of [...state.viewers.values()]) if (viewer.until < now) this.dropViewer(state, viewer.key)
  }

  private dropViewer(state: BotBrowserState, key: string): void {
    const viewer = state.viewers.get(key)
    if (!viewer) return
    state.viewers.delete(key)
    viewer.timer?.clear()
    viewer.release?.()
    // The last view left: the worker's wait ends now and the screencast stops. Otherwise it may shrink.
    if (!state.viewers.size && state.capture) this.stopWorkerWatch(state, state.capture.key)
    else this.refreshCapture(state)
    state.capture?.wake?.()
  }

  /** After the last activation, the browser closes once nobody has watched or held it for a while. */
  private armIdle(state: BotBrowserState): void {
    state.idle?.clear()
    state.idle = this.setTimer(() => {
      state.idle = undefined
      if ([...state.activations.values()].some((entry) => !entry.ended)) return
      const watched = state.viewers.size > 0 || this.now() - state.lastViewedAt < WATCHING_MS
      const held = this.record(state)?.lifecycle === 'human-controlled'
      if (watched || held) {
        this.armIdle(state)
        return
      }
      void this.closeSession(state).catch((error) => console.warn('a bot browser could not be closed', { botId: state.botId, error: error instanceof Error ? error.message : String(error) }))
    }, this.idleMs)
  }

  // -- scopes and records

  private policy(maxToolCalls: number): ExecutionPolicySnapshot {
    return this.policies.snapshot(this.options.profileId, {
      allowedTools: [...BOT_BROWSER_TOOLS],
      allowedCapabilities: [...new Set(BOT_BROWSER_TOOLS.map(browserToolCapability))],
      allowedEffects: ['read', 'external'],
      maxToolCalls,
      maxElapsedMs: MAX_BOT_ACTIVE_MS,
      maxArtifactBytes: 16 * 1024 * 1024
    })
  }

  /**
   * One call in the owner's scope over the bot's browser: the same owner as the bot's turns, as a
   * person's view (`source: 'gui'`), whose budget is retired after each call. `signal` ends it early.
   */
  private async ownerCall<T>(state: BotBrowserState, call: (context: BrowserToolContext) => Promise<T>, signal?: AbortSignal): Promise<T> {
    const policy = this.policy(1_000)
    const context: BrowserToolContext = {
      ...(signal ? { signal } : {}),
      execution: {
        profileId: this.options.profileId,
        threadId: state.homeThreadId,
        turnId: `owner-${state.botId}`,
        actor: { kind: 'main' },
        policySnapshotId: policy.id,
        source: 'gui',
        cancellationId: `owner-${state.botId}`
      },
      policy,
      target: { backend: 'managed-chromium' },
      keeper: BOT_BROWSER_KEEPER
    }
    try {
      return await call(context)
    } finally {
      this.options.browser()?.sessions.retireViewerBudget(context)
    }
  }

  private record(state: BotBrowserState): BrowserSessionRecord | undefined {
    if (!state.sessionId) return undefined
    try {
      return this.options.browser()?.sessions.trustedSessionScope({ profileId: this.options.profileId, threadId: state.homeThreadId, sessionId: state.sessionId, keeper: BOT_BROWSER_KEEPER }).record
    } catch {
      return undefined
    }
  }

  private liveSession(state: BotBrowserState): string | undefined {
    const record = this.record(state)
    return record && LIVE_LIFECYCLES.has(record.lifecycle) ? record.id : undefined
  }

  /** The bot's browser stopped by itself (its process ended): the next use starts it again. */
  private stopped(state: BotBrowserState): boolean {
    return this.record(state)?.lifecycle === 'disconnected'
  }

  private requireLive(state: BotBrowserState): string {
    const sessionId = this.liveSession(state)
    if (!sessionId) throw new BrowserAutomationError({ code: 'session_closed', message: 'The bot\'s browser is closed.' })
    return sessionId
  }

  private markUsed(state: BotBrowserState, activationId: string): void {
    if (state.used.includes(activationId)) return
    state.used.push(activationId)
    if (state.used.length > MAX_USED) state.used.splice(0, state.used.length - MAX_USED)
  }

  private state(botId: string, homeThreadId: string): BotBrowserState {
    const known = this.bots.get(botId)
    if (known && known.homeThreadId === homeThreadId) return known
    const state: BotBrowserState = { botId, homeThreadId, activations: new Map(), turns: new BrowserTurns(), used: [], lastViewedAt: 0, viewers: new Map(), holding: Promise.resolve(), pictures: [], pictureSerial: 0 }
    this.bots.set(botId, state)
    return state
  }

  private stateFor(botId: string): BotBrowserState {
    const home = this.options.homeThread(botId)
    if (!home) throw new BrowserAutomationError({ code: 'session_closed', message: 'This bot has no browser.' })
    return this.state(botId, home)
  }

  private service(): BotBrowserService {
    const browser = this.options.browser()
    if (!browser) throw new BrowserAutomationError({ code: 'session_closed', message: 'The browser is not available while Mousse stops.' })
    return browser
  }
}
