import { rm } from 'node:fs/promises'
import type { BotBrowserFrame, BotBrowserInput, BotBrowserView } from '../../../shared/bots/personal/browser'
import type { BotLane } from '../../../shared/bots/personal/definition'
import { BOT_BROWSER_TOOLS, MAX_BOT_ACTIVE_MS } from '../../../shared/bots/personal/manifest'
import { agentCursorLive } from '../../../shared/browser/agentCursor'
import type { BrowserAutomationTool, BrowserToolContext, BrowserToolOutput } from '../../../shared/browser/automation'
import type { BrowserRuntimePort } from '../../../shared/browser/runtime'
import type { BrowserSetupStatus } from '../../../shared/browser/setup'
import type { BrowserSessionRecord, BrowserTab, BrowserViewerFrame } from '../../../shared/browser/types'
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
 * - The owner watches it through `view` (a frame and the agent cursor) and can take it over.
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
  lastFrame?: { frame: BrowserViewerFrame; at: number }
  lastViewedAt: number
  idle?: { clear(): void }
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

/** A frame asked for again within this long is the same frame. */
const FRAME_REUSE_MS = 300
/** The owner counts as watching for this long after their view last asked for a frame. */
const WATCHING_MS = 30_000
/** Activations remembered per bot for its previews. */
const MAX_USED = 50
const LIVE_LIFECYCLES: ReadonlySet<BrowserSessionRecord['lifecycle']> = new Set(['ready', 'agent-controlled', 'human-controlled', 'waiting-approval'])

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
          if (state.follow === tabId) state.follow = undefined
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
      await this.closeSession(state).catch(() => undefined)
      this.bots.delete(botId)
    }
    if (!purge) return
    const browser = this.options.browser()
    if (browser) await rm(browser.workspaceDataDir(botBrowserWorkspace(botId)), { recursive: true, force: true })
  }

  /** The owner's view of a bot's browser; `frame` takes a fresh picture of the followed tab. */
  async view(botId: string, options: { frame?: boolean } = {}): Promise<BotBrowserView> {
    const state = this.stateFor(botId)
    if (options.frame) state.lastViewedAt = this.now()
    const record = this.record(state)
    const open = Boolean(record && LIVE_LIFECYCLES.has(record.lifecycle))
    if (open && options.frame && (!state.lastFrame || this.now() - state.lastFrame.at > FRAME_REUSE_MS)) await this.takeFrame(state).catch(() => undefined)
    const last = state.lastFrame?.frame
    const live = [...state.activations.entries()].filter(([, entry]) => !entry.ended).map(([id]) => id)
    const activationId = live.reverse().find((id) => state.used.includes(id))
    const frame: BotBrowserFrame | undefined = last ? { data: last.data, mimeType: 'image/jpeg', width: last.width, height: last.height, viewport: last.viewport, at: state.lastFrame!.at } : undefined
    return {
      open,
      control: record?.lifecycle === 'human-controlled' ? 'owner' : 'bot',
      ...(last ? { tab: { url: last.url, title: last.title } } : {}),
      activations: [...state.used],
      ...(activationId ? { activationId } : {}),
      ...(frame && (options.frame || !open) ? { frame } : {}),
      ...(open && last?.cursor && agentCursorLive(last.cursor, this.now()) ? { cursor: last.cursor } : {}),
      ...(this.installing && !open ? { setup: { ...this.installing } } : {})
    }
  }

  /** The owner takes the browser over (`owner`: the bot's actions wait) or gives it back (`bot`). */
  async control(botId: string, control: 'owner' | 'bot'): Promise<BotBrowserView> {
    const state = this.stateFor(botId)
    const sessionId = this.requireLive(state)
    await this.ownerCall(state, (context) => this.service().sessions.control(context, sessionId, control === 'owner' ? 'human' : 'agent'))
    state.lastFrame = undefined
    return this.view(botId, { frame: true })
  }

  /** The owner's click, scroll, typing or navigation, while they hold the browser. */
  async input(botId: string, input: BotBrowserInput): Promise<BotBrowserView> {
    const state = this.stateFor(botId)
    const sessionId = this.requireLive(state)
    await this.ownerCall(state, (context) => this.service().sessions.humanInput(context, { sessionId, input, ...(state.follow ? { tabId: state.follow } : {}) }))
    state.lastFrame = undefined
    return this.view(botId, { frame: true })
  }

  /**
   * Opens the bot's browser for its owner, under their control: to sign in to a site for the bot.
   * An open browser is handed to the owner as it is, on `url` when one is given.
   */
  async open(botId: string, url?: string): Promise<BotBrowserView> {
    const state = this.stateFor(botId)
    await this.ownerCall(state, async (context) => {
      const opened = await this.ensureSession(state, context, url)
      if (this.record(state)?.lifecycle !== 'human-controlled') await this.service().sessions.control(context, opened.sessionId, 'human')
      if (url && !opened.opened) await this.service().sessions.humanInput(context, { sessionId: opened.sessionId, input: { kind: 'navigate', url }, ...(state.follow ? { tabId: state.follow } : {}) })
    })
    state.lastViewedAt = this.now()
    if (![...state.activations.values()].some((entry) => !entry.ended)) this.armIdle(state)
    state.lastFrame = undefined
    return this.view(botId, { frame: true })
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
    if (name === 'browser_open') {
      if (Object.keys(params).some((key) => key !== 'url')) throw new BrowserAutomationError({ code: 'invalid_action', message: 'browser_open takes only a url' })
      const url = typeof params.url === 'string' ? params.url : undefined
      const opened = await this.ensureSession(state, context, url)
      let tabId: string | undefined
      if (opened.opened) tabId = opened.opened.observation?.tabId
      else if (url || !activation.current) tabId = await this.newTab(context, opened.sessionId, url)
      else tabId = activation.current
      if (tabId) this.useTab(state, activation, tabId)
      const observed = await this.invoke(context, 'browser_observe', { sessionId: opened.sessionId, ...(tabId ? { tabId } : {}) })
      const session = this.record(state)
      result = { ...observed, ...(session ? { session, capabilities: session.capabilities } : {}) }
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
        if (name === 'browser_act' && this.record(state)?.lifecycle === 'human-controlled')
          throw new BrowserAutomationError({ code: 'human_controlled', message: 'Your owner is using your browser now. Wait for them to give it back, or carry on without it.' })
        result = await this.invoke(context, name, params)
      }
    }
    const tabId = result.observation?.tabId ?? result.action?.observation?.tabId
    if (tabId && activation.tabs.has(tabId)) this.useTab(state, activation, tabId)
    return result
  }

  private async tabs(state: BotBrowserState, activation: ActivationTabs, context: BrowserToolContext, sessionId: string, params: Record<string, unknown>): Promise<BrowserToolOutput> {
    const operation = params.operation ?? 'list'
    if (operation === 'new') {
      const tabId = await this.newTab(context, sessionId, typeof params.url === 'string' ? params.url : undefined)
      if (tabId) this.useTab(state, activation, tabId)
    } else if (operation === 'switch' || operation === 'close') {
      if (typeof params.tabId !== 'string' || !activation.tabs.has(params.tabId))
        throw new BrowserAutomationError({ code: 'profile_mismatch', message: 'That tab belongs to another of your runs.' })
      await this.invoke(context, 'browser_tabs', { sessionId, operation, tabId: params.tabId })
      if (operation === 'switch') this.useTab(state, activation, params.tabId)
      else {
        activation.tabs.delete(params.tabId)
        if (activation.current === params.tabId) activation.current = [...activation.tabs].pop()
        if (state.follow === params.tabId) state.follow = activation.current
      }
    } else if (operation !== 'list') throw new BrowserAutomationError({ code: 'invalid_action', message: 'Invalid browser operation' })
    // Every operation answers with this activation's own tabs.
    const listed = await this.invoke(context, 'browser_tabs', { sessionId, operation: 'list' })
    return { tabs: (listed.tabs ?? []).filter((tab: BrowserTab) => activation.tabs.has(tab.id)) }
  }

  private useTab(state: BotBrowserState, activation: ActivationTabs, tabId: string): void {
    activation.tabs.add(tabId)
    activation.current = tabId
    state.follow = tabId
  }

  /** A new tab in the bot's session; its id is the one the list did not have before. */
  private async newTab(context: BrowserToolContext, sessionId: string, url: string | undefined): Promise<string | undefined> {
    const before = new Set((await this.invoke(context, 'browser_tabs', { sessionId, operation: 'list' })).tabs?.map((tab) => tab.id) ?? [])
    await this.invoke(context, 'browser_tabs', { sessionId, operation: 'new', ...(url ? { url } : {}) })
    const after = (await this.invoke(context, 'browser_tabs', { sessionId, operation: 'list' })).tabs ?? []
    return after.find((tab) => !before.has(tab.id))?.id
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
      state.follow = opened.observation?.tabId
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
    for (const activation of state.activations.values()) {
      activation.tabs.clear()
      activation.current = undefined
    }
    if (!this.options.browser()) return
    await this.ownerCall(state, (context) => this.service().sessions.close(context, sessionId))
  }

  private async takeFrame(state: BotBrowserState): Promise<void> {
    const sessionId = this.liveSession(state)
    if (!sessionId) return
    const frame = await this.ownerCall(state, (context) => this.service().sessions.frame(context, { sessionId, ...(state.follow ? { tabId: state.follow } : {}), maxWidth: 960 }))
    state.lastFrame = { frame, at: this.now() }
  }

  /** After the last activation, the browser closes once nobody has watched or held it for a while. */
  private armIdle(state: BotBrowserState): void {
    state.idle?.clear()
    state.idle = this.setTimer(() => {
      state.idle = undefined
      if ([...state.activations.values()].some((entry) => !entry.ended)) return
      const watched = this.now() - state.lastViewedAt < WATCHING_MS
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
    const state: BotBrowserState = { botId, homeThreadId, activations: new Map(), used: [], lastViewedAt: 0 }
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
