import { rm } from 'node:fs/promises'
import { hostname } from 'node:os'
import type {
  BotBrowserAck,
  BotBrowserFrameEvent,
  BotBrowserHold,
  BotBrowserSent,
  BotBrowserView
} from '../../../shared/bots/personal/browser'
import type { WatchedBrowserView } from '../../../shared/browser/watched'
import { browserTakeoverMessage } from '../../../shared/browser/types'
import type { BotLane } from '../../../shared/bots/personal/definition'
import { BOT_BROWSER_TOOLS, MAX_BOT_ACTIVE_MS } from '../../../shared/bots/personal/manifest'
import type { BrowserAutomationTool, BrowserToolContext, BrowserToolOutput } from '../../../shared/browser/automation'
import type { BrowserRuntimePort } from '../../../shared/browser/runtime'
import type { BrowserSetupStatus } from '../../../shared/browser/setup'
import type { BrowserTab } from '../../../shared/browser/types'
import type { BrowserNavigation, BrowserProblem } from '../../../shared/browser/navigation'
import type { ExecutionContext, ExecutionPolicySnapshot } from '../../../shared/execution/types'
import { BrowserAutomationError, defineBrowserSessionKeeper } from '../../browser/automation/BrowserSessionManager'
import type { MmsBrowserService } from '../../browser/MmsBrowserService'
import { BROWSER_SIDE_CALL_MS, WatchedBrowser, actsOrLoads, legacyView, type PageInput } from '../../browser/viewer/WatchedBrowser'
import { BROWSER_TURN_HOLD_MS, BROWSER_TURN_WAIT_MS, BrowserTurns, MAX_BROWSER_WAITERS, OWNER_CUT_IN_MS, OWNER_KEEP_MS, type BrowserTurnsText } from '../../browser/viewer/BrowserTurns'
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
 *   The owner can take it over. Watching, holds and their input are the general viewer's
 *   (`WatchedBrowser`); this class gives it the bot's scope, turn and followed tab.
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

/** One view that watches a bot's browser, on one connection. */
export interface BotBrowserViewer {
  /** Sends one update; resolves once the connection has taken it. */
  emit(event: BotBrowserFrameEvent): Promise<void>
  /** Ends when the connection closes. */
  lifetime?: AbortSignal
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
   * The activation whose tab the view follows (`refollow`): its reply shows the preview. It changes only when it ends.
   * While the owner holds the browser the views follow the tab they took instead, which nothing a run does changes.
   */
  followed?: string
  idle?: { clear(): void }
  /** The owner's views of it: pictures, the followed tab, holds and their input (`WatchedBrowser`). */
  viewer: WatchedBrowser
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

/** Activations remembered per bot for its previews. */
const MAX_USED = 50
/** The limit on the owner's picture of a tab, and on closing an ended activation's tab: both are quick or broken. */
export { BROWSER_SIDE_CALL_MS }
/** One call at a time on a bot's browser (the general `BrowserTurns`), and its limits. */
export { BROWSER_TURN_HOLD_MS, BROWSER_TURN_WAIT_MS, BrowserTurns, MAX_BROWSER_WAITERS, OWNER_CUT_IN_MS, OWNER_KEEP_MS }

/** What a bot's browser turns say, in the bot's words. */
const BOT_TURN_TEXT: BrowserTurnsText = {
  busy: () => new BrowserAutomationError({ code: 'timeout', message: 'Your browser is busy with your other work right now. Try this again in a moment, or carry on without it.' }),
  ended: () => new BrowserAutomationError({ code: 'cancelled', message: 'This run of the bot has ended.' })
}

/** The line in the bot's chat when the browser comes back to it because the view that held it went away. */
export const HOLD_EXPIRED_NOTICE = 'I have my browser back: the window you took it over in went away.'

/** The bot's answer when it tries to act, open or load a page while its owner holds the browser. */
function ownerHolds(): BrowserAutomationError {
  return new BrowserAutomationError({ code: 'human_controlled', message: 'Your owner is using your browser now. Wait for them to give it back, or carry on without it.' })
}

/** The owner's input waited too long for the call under way. */
function ownerInputBusy(): BrowserAutomationError {
  return new BrowserAutomationError({ code: 'timeout', message: 'The bot\'s browser is busy finishing a step of its work. Try again in a moment.' })
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
  private readonly computer: string
  private notice: BotBrowserNotice | undefined

  constructor(private readonly options: BotBrowsersOptions) {
    this.now = options.now ?? Date.now
    this.idleMs = options.idleMs ?? 2 * 60_000
    this.setTimer = options.setTimer ?? defaultTimer
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
      capabilities: () => state.viewer.record()?.capabilities,
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
          state.viewer.tabClosed(tabId)
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
      state.viewer.dropViewers()
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
    return this.botView(state, await state.viewer.view(options))
  }

  /**
   * A view starts (or renews, or resizes) watching a bot's browser (`WatchedBrowser.watch`): its
   * pictures are pushed as `bots.browser.frame` events, which name the bot.
   */
  async watch(botId: string, watchId: string, input: { width: number; fps: number; connectionId: string; viewId?: string } & BotBrowserViewer): Promise<BotBrowserView> {
    const state = this.stateFor(botId)
    const { emit, ...watcher } = input
    return this.botView(state, await state.viewer.watch(watchId, { ...watcher, emit: (update) => emit({ botId, ...update }) }))
  }

  /** A view stops watching. When none is left, the worker stops the tab's screencast. */
  unwatch(botId: string, watchId: string, connectionId: string): void {
    this.bots.get(botId)?.viewer.unwatch(watchId, connectionId)
  }

  // -- the owner's hold

  /**
   * A view's hold of the browser (`bots.browser.hold`; `WatchedBrowser.holdRequest`). A hold that
   * runs out says so in the bot's chat, in one line (`HOLD_EXPIRED_NOTICE`).
   */
  async hold(botId: string, viewId: string, request: { op: 'take'; force?: boolean; platform?: 'mac' | 'other' } | { op: 'renew' | 'release'; holdId: string }, connectionId = 'local'): Promise<{ browser: BotBrowserView; hold?: BotBrowserHold }> {
    const state = this.stateFor(botId)
    const { browser, hold } = await state.viewer.holdRequest(viewId, request, connectionId)
    return { browser: this.botView(state, browser), ...(hold ? { hold } : {}) }
  }

  /** Numbered inputs of a view's hold (`bots.browser.send`; `WatchedBrowser.send`). */
  async send(botId: string, viewId: string, holdId: string, inputs: BotBrowserSent[], connectionId = 'local'): Promise<{ acks: BotBrowserAck[]; lastSeq: number }> {
    return this.stateFor(botId).viewer.send(viewId, holdId, inputs, connectionId)
  }

  /**
   * The files the person chose in this computer's own file dialog for the page's file picker
   * (`bots.browser.files`, called by the app's main process alone; `WatchedBrowser.chooseFiles`).
   */
  async chooseFiles(botId: string, viewId: string, holdId: string, paths: string[], connectionId = 'local'): Promise<{ token: string; count: number }> {
    return this.stateFor(botId).viewer.chooseFiles(viewId, holdId, paths, connectionId)
  }

  /** An older app's Take over (`owner`) or Give back (`bot`): a hold of that window's connection. */
  async control(botId: string, control: 'owner' | 'bot', connectionId = 'local'): Promise<BotBrowserView> {
    const state = this.stateFor(botId)
    return this.botView(state, await state.viewer.control(control, connectionId))
  }

  /** An older app's click, scroll, typing or navigation, while its window holds the browser (`control`). */
  async input(botId: string, input: PageInput, connectionId = 'local'): Promise<BotBrowserView> {
    const state = this.stateFor(botId)
    return this.botView(state, await state.viewer.input(input, connectionId))
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
    const hold = await state.viewer.open(viewId, connectionId, { platform: view.platform ?? 'other', ...(view.viewId ? {} : { legacy: true }), ...(url ? { url } : {}) },
      async (context) => (await this.ensureSession(state, context, undefined)).sessionId)
    state.viewer.markViewed()
    if (![...state.activations.values()].some((entry) => !entry.ended)) this.armIdle(state)
    state.viewer.startCapture()
    return { browser: this.botView(state, await state.viewer.viewAfterChange(viewId, connectionId)), ...(view.viewId ? { hold: state.viewer.holdAnswer(hold) } : {}) }
  }

  /** The viewer's state, with what only a bot's view shows: the runs that used it, the one it follows, and a first-use install. */
  private botView(state: BotBrowserState, view: WatchedBrowserView): BotBrowserView {
    // The preview sits on the reply of the activation whose tab it shows.
    const activationId = state.followed
    return {
      ...view,
      activations: [...state.used],
      ...(activationId ? { activationId } : {}),
      ...(this.installing && !view.open ? { setup: { ...this.installing } } : {})
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
    return state.turns.personInput((held) => this.ownerCall(state, call, held), { holds: ownerHolds, busy: ownerInputBusy, ...(tabId ? { tab: tabId } : {}) })
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
      state.viewer.dropViewers()
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
    if (opens && state.viewer.held) throw ownerHolds()
    // A page the bot could not open (in a tab that closed again, too): its owner's view says so.
    // Only the run the view follows: another run's page never shows over its tab.
    const noted = (error: unknown): never => {
      const problem = error instanceof BrowserAutomationError ? error.details?.problem as BrowserProblem | undefined : undefined
      if (opens && problem && this.isFollowed(state, activation)) state.viewer.noteProblem(problem)
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
    if (opens && state.viewer.held) throw ownerHolds()
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
        const record = state.viewer.record()
        return { ...observed, ...(record ? { session: record, capabilities: record.capabilities } : {}), ...(navigation ? { navigation } : {}) }
      }
      // The browser stopped by itself since its last use (nothing was done in it): it starts again, once.
      result = await open(opened).catch(async (error: unknown) => {
        if (!(error instanceof BrowserAutomationError && error.code === 'worker_disconnected') || !state.viewer.stopped()) throw error
        return open(await this.ensureSession(state, context, url))
      })
    } else {
      const sessionId = state.viewer.liveSession()
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
    if (opens && navigation && this.isFollowed(state, activation)) state.viewer.noteProblem(navigation.problem)
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
        state.viewer.tabClosed(params.tabId)
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

  /**
   * Sets the tab the owner's view follows. While the owner holds the browser nothing changes: it stays the tab they took.
   * Otherwise it is the current tab of one activation (`followed`), the newest that uses the browser when the one it
   * followed has ended; another activation's call never moves it, so the preview and the split view never jump
   * between runs.
   */
  private refollow(state: BotBrowserState): void {
    if (state.viewer.held) return
    let followed = state.followed ? state.activations.get(state.followed) : undefined
    if (!followed || followed.ended) {
      const next = [...state.used].reverse().find((id) => state.activations.get(id)?.ended === false)
      if (next) {
        state.followed = next
        followed = state.activations.get(next)
      }
    }
    if (followed?.current) state.viewer.followTab(followed.current)
  }

  /** The view follows this activation's tab, or none yet. */
  private isFollowed(state: BotBrowserState, activation: ActivationTabs): boolean {
    return !state.followed || state.activations.get(state.followed) === activation
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
    const live = state.viewer.liveSession()
    if (live) return { sessionId: live }
    if (state.opening) return { sessionId: (await state.opening).sessionId }
    const opening = (async (): Promise<OpenedSession> => {
      await this.ensureInstalled(context.signal)
      // A session left disconnected (a worker restart) is closed first: it would hold the profile.
      if (state.sessionId) await this.closeSession(state).catch(() => undefined)
      const opened = await this.invoke(context, 'browser_open', { ...(url ? { url } : {}), persistent: true, workspaceId: botBrowserWorkspace(state.botId) })
      if (!opened.session) throw new BrowserAutomationError({ code: 'worker_disconnected', message: 'The browser did not open' })
      state.sessionId = opened.session.id
      state.viewer.opened(opened.observation?.tabId)
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
    state.viewer.closed()
    state.sessionId = undefined
    for (const activation of state.activations.values()) {
      activation.tabs.clear()
      activation.current = undefined
    }
    if (!this.options.browser()) return
    await this.ownerCall(state, (context) => this.service().sessions.close(context, sessionId))
  }

  /** After the last activation, the browser closes once nobody has watched or held it for a while. */
  private armIdle(state: BotBrowserState): void {
    state.idle?.clear()
    state.idle = this.setTimer(() => {
      state.idle = undefined
      if ([...state.activations.values()].some((entry) => !entry.ended)) return
      const watched = state.viewer.watched()
      const held = state.viewer.record()?.lifecycle === 'human-controlled'
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

  private markUsed(state: BotBrowserState, activationId: string): void {
    if (state.used.includes(activationId)) return
    state.used.push(activationId)
    if (state.used.length > MAX_USED) state.used.splice(0, state.used.length - MAX_USED)
  }

  private state(botId: string, homeThreadId: string): BotBrowserState {
    const known = this.bots.get(botId)
    if (known && known.homeThreadId === homeThreadId) return known
    const state = { botId, homeThreadId, activations: new Map(), turns: new BrowserTurns(BOT_TURN_TEXT), used: [] } as Omit<BotBrowserState, 'viewer'> as BotBrowserState
    // The owner's views of it, through the bot's own scope (`ownerCall`) and turn (`ownerInput`).
    state.viewer = new WatchedBrowser({
      profileId: this.options.profileId,
      threadId: homeThreadId,
      sessionId: () => state.sessionId,
      keeper: BOT_BROWSER_KEEPER,
      browser: () => this.options.browser(),
      call: (call, signal) => this.ownerCall(state, call, signal),
      input: (call, tabId) => this.ownerInput(state, call, tabId),
      // The bot has its browser again: the view follows a run's tab again.
      givenBack: () => this.refollow(state),
      expired: () => this.notice?.(botId, HOLD_EXPIRED_NOTICE),
      text: { closed: 'The bot\'s browser is closed.', tooManyViews: 'Too many views are watching this bot\'s browser. Close one, then try again.' },
      log: { name: 'bot browser', fields: { botId } },
      now: this.now,
      ...(this.options.holdLeaseMs !== undefined ? { holdLeaseMs: this.options.holdLeaseMs } : {}),
      ...(this.options.leaseTimer ? { leaseTimer: this.options.leaseTimer } : {}),
      computer: this.computer
    })
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
