import { randomUUID } from 'node:crypto'
import { rm } from 'node:fs/promises'
import { BOT_BROWSER_PANE_WATCH, BOT_BROWSER_WATCH_RENEW_MS, type BotBrowserFrame, type BotBrowserFrameEvent, type BotBrowserInput, type BotBrowserView } from '../../../shared/bots/personal/browser'
import type { BotLane } from '../../../shared/bots/personal/definition'
import { BOT_BROWSER_TOOLS, MAX_BOT_ACTIVE_MS } from '../../../shared/bots/personal/manifest'
import { agentCursorLive, type BrowserAgentCursor } from '../../../shared/browser/agentCursor'
import type { BrowserAutomationTool, BrowserToolContext, BrowserToolOutput } from '../../../shared/browser/automation'
import type { BrowserRuntimePort } from '../../../shared/browser/runtime'
import type { BrowserSetupStatus } from '../../../shared/browser/setup'
import type { BrowserSessionRecord, BrowserTab, BrowserViewerUpdate } from '../../../shared/browser/types'
import type { BrowserNavigation, BrowserProblem } from '../../../shared/browser/navigation'
import type { ExecutionContext, ExecutionPolicySnapshot } from '../../../shared/execution/types'
import { BrowserAutomationError } from '../../browser/automation/BrowserSessionManager'
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
}

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
  watchId: string
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
  sent: { viewport?: string; tab?: string; cursorAt?: number | null; behind?: boolean; stalled?: boolean; loading?: boolean; problem?: string }
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
  /** Activations that used the browser, oldest first (bounded). */
  used: string[]
  /** The tab the owner's view follows. */
  follow?: string
  /** The followed tab's latest picture and state, for `view` and a view that starts watching. */
  picture?: Picture
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
  /** When a picture was last taken for `view` (an older app asks each time). */
  frameAt?: number
  lastViewedAt: number
  idle?: { clear(): void }
  viewers: Map<string, Viewer>
  capture?: Capture
}

interface OpenedSession {
  sessionId: string
  /** The session's first observation when this call opened it. */
  opened?: BrowserToolOutput
}

/** The persistent Chromium profile of a bot's browser. */
export function botBrowserWorkspace(botId: string): string {
  return `botbrowser_${botId}`
}

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
const MIN_VIEW_WIDTH = 160
/** Activations remembered per bot for its previews. */
const MAX_USED = 50
const LIVE_LIFECYCLES: ReadonlySet<BrowserSessionRecord['lifecycle']> = new Set(['ready', 'agent-controlled', 'human-controlled', 'waiting-approval'])

/** The bot's answer when it tries to act, open or load a page while its owner holds the browser. */
function ownerHolds(): BrowserAutomationError {
  return new BrowserAutomationError({ code: 'human_controlled', message: 'Your owner is using your browser now. Wait for them to give it back, or carry on without it.' })
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

  constructor(private readonly options: BotBrowsersOptions) {
    this.now = options.now ?? Date.now
    this.idleMs = options.idleMs ?? 2 * 60_000
    this.setTimer = options.setTimer ?? defaultTimer
  }

  /** The installation's browser setup (composed by the daemon once the profile's browser is configured). */
  setSetup(setup: BotBrowserSetup | undefined): void {
    this.setup = setup
  }

  turn(input: { botId: string; activationId: string; lane: BotLane; homeThreadId: string; runId: string; signal: AbortSignal }): BotTurnBrowser | undefined {
    if (!this.options.browser()) return undefined
    const state = this.state(input.botId, input.homeThreadId)
    const activation = state.activations.get(input.activationId) ?? { tabs: new Set<string>(), ended: false }
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
      void (async () => {
        for (const tabId of tabs) {
          await this.ownerCall(state, (context) => this.service().sessions.tabs(context, sessionId, { operation: 'close', tabId })).catch(() => undefined)
          if (state.follow === tabId) this.followTab(state, undefined)
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
  async view(botId: string, options: { frame?: boolean; last?: boolean } = {}): Promise<BotBrowserView> {
    const state = this.stateFor(botId)
    if (options.frame) state.lastViewedAt = this.now()
    const record = this.record(state)
    const open = Boolean(record && LIVE_LIFECYCLES.has(record.lifecycle))
    if (open && options.frame && (!state.frameAt || this.now() - state.frameAt > FRAME_REUSE_MS)) await this.takeFrame(state).catch(() => undefined)
    const last = state.picture
    const live = [...state.activations.entries()].filter(([, entry]) => !entry.ended).map(([id]) => id)
    const activationId = live.reverse().find((id) => state.used.includes(id))
    const frame: BotBrowserFrame | undefined = last ? { data: last.data, mimeType: 'image/jpeg', width: last.width, height: last.height, viewport: last.viewport, at: last.at } : undefined
    return {
      open,
      control: record?.lifecycle === 'human-controlled' ? 'owner' : 'bot',
      ...(state.tab ? { tab: { ...state.tab } } : {}),
      activations: [...state.used],
      ...(activationId ? { activationId } : {}),
      ...(frame && (options.frame || options.last || !open) ? { frame } : {}),
      ...(open && state.cursor && agentCursorLive(state.cursor, this.now()) ? { cursor: state.cursor } : {}),
      ...(open && state.behind ? { behind: true } : {}),
      ...(open && state.loading ? { loading: true } : {}),
      ...(open && state.problem ? { problem: { ...state.problem } } : {}),
      ...(this.installing && !open ? { setup: { ...this.installing } } : {})
    }
  }

  /**
   * A view starts (or renews, or resizes) watching a bot's browser: while the browser is open, the
   * followed tab's pictures are pushed to it as the page paints, at most `fps` a second and `width`
   * wide (capped: 960, 15 a second, 30 while the owner holds the browser). One capture is shared by
   * every view; each has its own slot, so a slow one drops pictures and never queues them. It ends
   * with `unwatch`, its connection, or when it is not renewed. Answers the state and the last picture.
   */
  async watch(botId: string, watchId: string, input: { width: number; fps: number; connectionId: string } & BotBrowserViewer): Promise<BotBrowserView> {
    const state = this.stateFor(botId)
    const key = `${input.connectionId}\u0000${watchId}`
    let viewer = state.viewers.get(key)
    if (!viewer) {
      viewer = { key, watchId, emit: input.emit, width: 0, fps: 0, until: 0, delivering: false, lastPictureAt: 0, sent: {} }
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
    if (!viewer.lastPictureAt) viewer.sent = {}
    this.runCapture(state)
    this.refreshCapture(state)
    state.capture?.wake?.()
    return this.view(botId, { last: true })
  }

  /** A view stops watching. When none is left, the worker stops the tab's screencast. */
  unwatch(botId: string, watchId: string, connectionId: string): void {
    const state = this.bots.get(botId)
    if (state) this.dropViewer(state, `${connectionId}\u0000${watchId}`)
  }

  /** The owner takes the browser over (`owner`: the bot's actions wait) or gives it back (`bot`). */
  async control(botId: string, control: 'owner' | 'bot'): Promise<BotBrowserView> {
    const state = this.stateFor(botId)
    const sessionId = this.requireLive(state)
    await this.ownerCall(state, (context) => this.service().sessions.control(context, sessionId, control === 'owner' ? 'human' : 'agent'))
    // Up to 30 pictures a second while the owner holds it, back to 15 when the bot has it again.
    this.refreshCapture(state)
    return this.viewAfterChange(state)
  }

  /** The owner's click, scroll, typing or navigation, while they hold the browser. */
  async input(botId: string, input: BotBrowserInput): Promise<BotBrowserView> {
    const state = this.stateFor(botId)
    const sessionId = this.requireLive(state)
    const navigates = input.kind === 'navigate' || input.kind === 'back' || input.kind === 'forward' || input.kind === 'reload'
    try {
      const { navigation } = await this.ownerCall(state, (context) => this.service().sessions.humanInput(context, { sessionId, input, ...(state.follow ? { tabId: state.follow } : {}) }))
      // The owner's own page replaces what the bot's last page ran into.
      if (navigates) this.noteBotProblem(state, navigation?.problem)
    } catch (error) {
      const problem = error instanceof BrowserAutomationError ? error.details?.problem as BrowserProblem | undefined : undefined
      if (navigates && problem) this.noteBotProblem(state, problem)
      throw error
    }
    return this.viewAfterChange(state)
  }

  /** After the owner changed something: a watching view gets the new picture pushed; an older one takes a fresh frame. */
  private viewAfterChange(state: BotBrowserState): Promise<BotBrowserView> {
    if (state.viewers.size) return this.view(state.botId, { last: true })
    state.frameAt = undefined
    return this.view(state.botId, { frame: true })
  }

  /**
   * Opens the bot's browser for its owner, under their control: to sign in to a site for the bot.
   * An open browser is handed to the owner as it is, on `url` when one is given. A closed one opens
   * blank and is the owner's before it loads anything, so `url` loads as the owner's page.
   */
  async open(botId: string, url?: string): Promise<BotBrowserView> {
    const state = this.stateFor(botId)
    await this.ownerCall(state, async (context) => {
      const opened = await this.ensureSession(state, context, undefined)
      if (this.record(state)?.lifecycle !== 'human-controlled') await this.service().sessions.control(context, opened.sessionId, 'human')
      if (url) await this.service().sessions.humanInput(context, { sessionId: opened.sessionId, input: { kind: 'navigate', url }, ...(state.follow ? { tabId: state.follow } : {}) })
    })
    state.lastViewedAt = this.now()
    if (![...state.activations.values()].some((entry) => !entry.ended)) this.armIdle(state)
    this.runCapture(state)
    return this.viewAfterChange(state)
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
      signal: original.signal ? AbortSignal.any([original.signal, turnSignal]) : turnSignal
    }
    const params = { ...(args as Record<string, unknown>) }
    this.markUsed(state, activationId)
    state.idle?.clear()
    state.idle = undefined
    let result: BrowserToolOutput
    // While the owner holds the browser the bot reads it, and acts, opens or loads nothing.
    const opens = name === 'browser_act' || name === 'browser_open' || (name === 'browser_tabs' && params.operation === 'new')
    if (opens && this.record(state)?.lifecycle === 'human-controlled') throw ownerHolds()
    try {
    if (name === 'browser_open') {
      if (Object.keys(params).some((key) => key !== 'url')) throw new BrowserAutomationError({ code: 'invalid_action', message: 'browser_open takes only a url' })
      const url = typeof params.url === 'string' ? params.url : undefined
      const opened = await this.ensureSession(state, context, url)
      let tabId: string | undefined
      // How the page went (a slow or failed page leaves the browser open).
      let navigation = opened.opened?.navigation
      if (opened.opened) tabId = opened.opened.observation?.tabId
      else if (url || !activation.current) ({ tabId, navigation } = await this.newTab(context, opened.sessionId, url))
      else tabId = activation.current
      if (tabId) this.useTab(state, activation, tabId)
      const observed = await this.invoke(context, 'browser_observe', { sessionId: opened.sessionId, ...(tabId ? { tabId } : {}) })
      const session = this.record(state)
      result = { ...observed, ...(session ? { session, capabilities: session.capabilities } : {}), ...(navigation ? { navigation } : {}) }
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
    } catch (error) {
      // A page the bot could not open (in a tab that closed again, too): its owner's view says so.
      const problem = error instanceof BrowserAutomationError ? error.details?.problem as BrowserProblem | undefined : undefined
      if (opens && problem) this.noteBotProblem(state, problem)
      throw error
    }
    const navigation = result.navigation ?? result.action?.navigation
    if (opens && navigation) this.noteBotProblem(state, navigation.problem)
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
        if (state.follow === params.tabId) this.followTab(state, activation.current)
      }
    } else if (operation !== 'list') throw new BrowserAutomationError({ code: 'invalid_action', message: 'Invalid browser operation' })
    // Every operation answers with this activation's own tabs.
    const listed = await this.invoke(context, 'browser_tabs', { sessionId, operation: 'list' })
    return { tabs: (listed.tabs ?? []).filter((tab: BrowserTab) => activation.tabs.has(tab.id)), ...(navigation ? { navigation } : {}) }
  }

  private useTab(state: BotBrowserState, activation: ActivationTabs, tabId: string): void {
    activation.tabs.add(tabId)
    activation.current = tabId
    this.followTab(state, tabId)
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
    state.sessionId = undefined
    state.follow = undefined
    state.behind = false
    for (const activation of state.activations.values()) {
      activation.tabs.clear()
      activation.current = undefined
    }
    if (!this.options.browser()) return
    await this.ownerCall(state, (context) => this.service().sessions.close(context, sessionId))
  }

  /** A picture for a view that asks each time (an older app): the worker answers from the tab's capture. */
  private async takeFrame(state: BotBrowserState): Promise<void> {
    const sessionId = this.liveSession(state)
    if (!sessionId) return
    const frame = await this.ownerCall(state, (context) => this.service().sessions.frame(context, { sessionId, ...(state.follow ? { tabId: state.follow } : {}), maxWidth: 960 }))
    state.frameAt = this.now()
    state.picture = { data: frame.data, width: frame.width, height: frame.height, viewport: frame.viewport, at: Date.parse(frame.capturedAt) || this.now() }
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
            this.stall(state, 'The browser closed.')
            return
          }
          await this.viewerFree(state, capture)
          if (!state.viewers.size || state.capture !== capture) return
          const tabId = state.follow
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
            failures += 1
            if (failures >= 2) this.stall(state, error instanceof Error ? error.message : String(error))
            await new Promise((resolve) => setTimeout(resolve, Math.min(5_000, 250 * 2 ** failures)))
            continue
          }
          failures = 0
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
    if (update.picture) state.picture = { ...update.picture, viewport: update.viewport }
    else if (state.picture) state.picture = { ...state.picture, viewport: update.viewport }
    state.tab = { url: update.url, title: update.title }
    state.cursor = update.cursor
    state.behind = update.behind
    state.loading = update.loading === true
    state.tabProblem = update.problem
    // The followed tab's own problem, else what the bot's last page ran into (a tab that closed again).
    state.problem = update.problem ?? state.botProblem
    const problem = JSON.stringify(state.problem ?? null)
    const cursor = update.cursor && agentCursorLive(update.cursor, now) ? update.cursor : null
    for (const viewer of state.viewers.values()) {
      const next: NonNullable<Viewer['slot']> = { ...viewer.slot }
      if (update.picture) next.frame = { data: update.picture.data, mimeType: 'image/jpeg', width: update.picture.width, height: update.picture.height, at: update.picture.at, ...(update.picture.sharp ? { sharp: true } : {}) }
      const viewport = JSON.stringify(update.viewport)
      if (viewer.sent.viewport !== viewport) next.viewport = update.viewport
      if (viewer.sent.tab !== JSON.stringify(state.tab)) next.tab = { ...state.tab }
      if ((viewer.sent.cursorAt ?? null) !== (cursor?.at ?? null)) next.cursor = cursor
      if (viewer.sent.behind !== update.behind) next.behind = update.behind
      if ((viewer.sent.loading ?? false) !== (update.loading === true)) next.loading = update.loading === true
      if ((viewer.sent.problem ?? 'null') !== problem) next.problem = state.problem ?? null
      if (viewer.sent.stalled) next.live = true
      viewer.slot = next
      this.deliver(state, viewer)
    }
  }

  /**
   * What the bot's last page ran into, or nothing once a page went well: shown to its owner even
   * when it was in a tab that closed again (a tab opened on an address nothing answers on).
   */
  private noteBotProblem(state: BotBrowserState, problem: BrowserProblem | undefined): void {
    state.botProblem = problem
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
    if (send.frame) viewer.lastPictureAt = now
    if (send.viewport) viewer.sent.viewport = JSON.stringify(send.viewport)
    if (send.tab) viewer.sent.tab = JSON.stringify(send.tab)
    if (send.cursor !== undefined) viewer.sent.cursorAt = send.cursor?.at ?? null
    if (send.behind !== undefined) viewer.sent.behind = send.behind
    if (send.loading !== undefined) viewer.sent.loading = send.loading
    if (send.problem !== undefined) viewer.sent.problem = JSON.stringify(send.problem)
    if (send.live) viewer.sent.stalled = false
    if (send.stalled) viewer.sent.stalled = true
    viewer.delivering = true
    void viewer.emit({ botId: state.botId, watchId: viewer.watchId, ...send })
      .then(() => {
        viewer.delivering = false
        this.deliver(state, viewer)
      }, () => {
        // Its connection is gone.
        viewer.delivering = false
        this.dropViewer(state, viewer.key)
      })
      .finally(() => state.capture?.wake?.())
  }

  /** Pictures stopped: each view hears it once, so it says it is not updating. */
  private stall(state: BotBrowserState, reason: string): void {
    for (const viewer of state.viewers.values()) {
      if (viewer.sent.stalled) continue
      viewer.slot = { ...viewer.slot, stalled: reason }
      delete viewer.slot.live
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
   * person's view (`source: 'gui'`), whose budget is retired after each call.
   */
  private async ownerCall<T>(state: BotBrowserState, call: (context: BrowserToolContext) => Promise<T>): Promise<T> {
    const policy = this.policy(1_000)
    const context: BrowserToolContext = {
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
      target: { backend: 'managed-chromium' }
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
      return this.options.browser()?.sessions.trustedSessionScope({ profileId: this.options.profileId, threadId: state.homeThreadId, sessionId: state.sessionId }).record
    } catch {
      return undefined
    }
  }

  private liveSession(state: BotBrowserState): string | undefined {
    const record = this.record(state)
    return record && LIVE_LIFECYCLES.has(record.lifecycle) ? record.id : undefined
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
    const state: BotBrowserState = { botId, homeThreadId, activations: new Map(), used: [], lastViewedAt: 0, viewers: new Map() }
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
