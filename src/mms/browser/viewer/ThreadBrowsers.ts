import { hostname } from 'node:os'
import { BROWSER_AUTOMATION_TOOLS, type BrowserAutomationTool, type BrowserToolContext, type BrowserToolOutput, type BrowserToolResult } from '../../../shared/browser/automation'
import { MAX_BROWSER_VIEW_ASK_CHARS, type ThreadBrowserFrameEvent, type ThreadBrowserView } from '../../../shared/browser/threadView'
import type { WatchedBrowserAck, WatchedBrowserHold, WatchedBrowserHoldRequest, WatchedBrowserPageSize, WatchedBrowserSent, WatchedBrowserView } from '../../../shared/browser/watched'
import { browserTakeoverMessage, type BrowserSessionRecord } from '../../../shared/browser/types'
import type { BrowserProblem } from '../../../shared/browser/navigation'
import type { ExecutionPolicySnapshot } from '../../../shared/execution/types'
import { ExecutionPolicyService } from '../../execution/ExecutionPolicyService'
import { BrowserAutomationError } from '../automation/BrowserSessionManager'
import type { MmsBrowserService } from '../MmsBrowserService'
import { BrowserTurns } from './BrowserTurns'
import { WatchedBrowser, actsOrLoads } from './WatchedBrowser'

/**
 * A thread agent's browser without a window, as the person sees it from that thread (`browser.view.*`).
 *
 * A thread's agent drives a managed browser when its turn has no app window to use: a turn sent from
 * the command line, a custom agent run from the command line, another computer, a schedule or a phone
 * (`resolveTarget` in `MousseMainService`). Each `browser_open` opens a new session on the thread. The
 * view follows the newest open one (the agent's latest browser), stays on the one a person holds while they
 * hold it, and says when none is open.
 *
 * - Watching, holds and input are the general viewer's (`WatchedBrowser`), under the same rules as a
 *   bot's browser: a hold belongs to one window and its connection, lasts while the window says it is
 *   there, and ends two minutes after it stops.
 * - The agents' calls on the session go one at a time (`BrowserTurns`), and the person's input cuts in.
 *   While a person holds it, an agent's call that acts, opens or loads is refused in plain words, and an
 *   action Take over cut short says whether it took effect.
 * - Only sessions a thread's agent opened through the thread's browser (`MmsBrowserService.dispatch`) are
 *   shown: never a bot's (kept apart), nor a group chat's, which opens its own.
 * - Nothing is captured while nobody watches; the agent's browser works the same whether or not anyone
 *   watches.
 */

export type ThreadBrowserService = Pick<MmsBrowserService, 'sessions'>

export interface ThreadBrowsersOptions {
  profileId: string
  /** The profile's browser composition; undefined while it shuts down. */
  browser(): ThreadBrowserService | undefined
  threadExists(threadId: string): boolean
  now?(): number
  /** How long a view's hold lasts without its heartbeat (tests). */
  holdLeaseMs?: number
  /** The timer of a hold's lease (tests). */
  leaseTimer?(fn: () => void, ms: number): { clear(): void }
  /** The computer's name for "Not reaching …" (default its network name). */
  computerName?: string
}

/** One view that watches a thread's browser, on one connection. */
export interface ThreadBrowserViewer {
  emit(event: ThreadBrowserFrameEvent): Promise<void>
  lifetime?: AbortSignal
}

interface ThreadBrowserState {
  threadId: string
  /** The session the view follows; undefined when the thread has none open. */
  sessionId?: string
  /** The tab the agent used last in it: the view follows it while nobody holds the browser. */
  tab?: string
  turns: BrowserTurns
  viewer: WatchedBrowser
}

const LIVE: ReadonlySet<BrowserSessionRecord['lifecycle']> = new Set(['ready', 'agent-controlled', 'human-controlled', 'waiting-approval'])

/** What an agent hears when it tries to act, open or load a page while the person holds the browser. */
function userHolds(): BrowserAutomationError {
  return new BrowserAutomationError({ code: 'human_controlled', message: 'The user is using this browser now. Wait for them to give it back, or carry on without it.' })
}

/** The person's input waited too long for the agent's call under way. */
function inputBusy(): BrowserAutomationError {
  return new BrowserAutomationError({ code: 'timeout', message: 'The agent\'s browser is busy finishing a step. Try again in a moment.' })
}

const AGENT_TEXT = {
  busy: () => new BrowserAutomationError({ code: 'timeout', message: 'The browser is busy with other work on this thread right now. Try this again in a moment, or carry on without it.' }),
  ended: () => new BrowserAutomationError({ code: 'cancelled', message: 'This turn has ended.' })
}

function failure(error: unknown): BrowserToolResult {
  if (error instanceof BrowserAutomationError) return { ok: false, error: { code: error.code, message: error.message, ...(error.details ? { details: error.details } : {}) } }
  throw error
}

export class ThreadBrowsers {
  private readonly threads = new Map<string, ThreadBrowserState>()
  /** Sessions a thread's agent opened through the thread's browser, by session: the only ones a view shows. */
  private readonly opened = new Map<string, string>()
  private readonly policies = new ExecutionPolicyService()
  private readonly now: () => number
  private readonly computer: string

  constructor(private readonly options: ThreadBrowsersOptions) {
    this.now = options.now ?? Date.now
    this.computer = options.computerName ?? (hostname().replace(/\.local\.?$/i, '').trim() || 'this computer')
  }

  // -- the person's view (`browser.view.*`)

  async view(threadId: string, options: { viewId?: string; connectionId?: string } = {}): Promise<ThreadBrowserView> {
    const state = this.stateFor(threadId)
    const view = this.threadView(state, await state.viewer.view(options))
    this.prune(state)
    return view
  }

  async watch(threadId: string, watchId: string, input: { width: number; fps: number; connectionId: string; viewId?: string; page?: WatchedBrowserPageSize } & ThreadBrowserViewer): Promise<ThreadBrowserView> {
    const state = this.stateFor(threadId)
    const { emit, ...watcher } = input
    return this.threadView(state, await state.viewer.watch(watchId, { ...watcher, emit: (update) => emit({ threadId, ...update }) }))
  }

  unwatch(threadId: string, watchId: string, connectionId: string): void {
    const state = this.threads.get(threadId)
    if (!state) return
    state.viewer.unwatch(watchId, connectionId)
    this.prune(state)
  }

  async hold(threadId: string, viewId: string, request: WatchedBrowserHoldRequest, connectionId: string): Promise<{ browser: ThreadBrowserView; hold?: WatchedBrowserHold }> {
    const state = this.stateFor(threadId)
    const { browser, hold } = await state.viewer.holdRequest(viewId, request, connectionId)
    return { browser: this.threadView(state, browser), ...(hold ? { hold } : {}) }
  }

  async send(threadId: string, viewId: string, holdId: string, inputs: WatchedBrowserSent[], connectionId: string): Promise<{ acks: WatchedBrowserAck[]; lastSeq: number }> {
    return this.stateFor(threadId).viewer.send(viewId, holdId, inputs, connectionId)
  }

  async chooseFiles(threadId: string, viewId: string, holdId: string, paths: string[], connectionId: string): Promise<{ token: string; count: number }> {
    return this.stateFor(threadId).viewer.chooseFiles(viewId, holdId, paths, connectionId)
  }

  /** Every view stops watching and every hold ends with the browser (the profile is stopping). */
  dispose(): void {
    for (const state of this.threads.values()) {
      state.viewer.dropViewers()
      state.viewer.closed()
    }
    this.threads.clear()
    this.opened.clear()
  }

  // -- the thread agents' calls

  /**
   * A thread agent's call on the managed browser (`MmsBrowserService.dispatch`; never a bot's, which
   * carries its keeper). A call on the session the view follows goes in its turn. While a person holds
   * the thread's browser, a call that acts, opens or loads a page, or asks for a person, is refused in
   * plain words; reads go on. The view then follows the tab the agent used, and an action Take over cut
   * short tells the agent whether it took effect.
   */
  async agentCall(context: BrowserToolContext, name: BrowserAutomationTool, args: unknown, invoke: (held?: AbortSignal) => Promise<BrowserToolResult>): Promise<BrowserToolResult> {
    const threadId = context.execution.threadId
    if (context.keeper || !this.options.threadExists(threadId)) return invoke()
    const params = args && typeof args === 'object' && !Array.isArray(args) ? args as Record<string, unknown> : {}
    const known = this.threads.get(threadId)
    if (known) this.sync(known)
    const sessionId = typeof params.sessionId === 'string' ? params.sessionId : undefined
    const followed = Boolean(known?.sessionId && sessionId === known.sessionId)
    if (known?.viewer.held && ((name === 'browser_open') || (followed && (actsOrLoads(name, params) || name === 'browser_request_human')))) return failure(userHolds())
    let result: BrowserToolResult
    try {
      result = known && followed
        ? await known.turns.run((held) => invoke(held), {
          ...(context.signal ? { signal: context.signal } : {}),
          yields: true,
          ...(typeof params.tabId === 'string' ? { tab: params.tabId } : {})
        })
        : await invoke()
    } catch (error) {
      return failure(error)
    }
    return this.after(threadId, name, params, result)
  }

  /** The view follows what the agent's call did; an action Take over cut short says so in the person's terms. */
  private after(threadId: string, name: BrowserAutomationTool, params: Record<string, unknown>, result: BrowserToolResult): BrowserToolResult {
    if (!result.ok) {
      const problem = result.error.details?.problem as BrowserProblem | undefined
      const state = this.threads.get(threadId)
      if (problem && state && actsOrLoads(name, params) && (name === 'browser_open' || params.sessionId === state.sessionId)) state.viewer.noteProblem(problem)
      return result
    }
    const output = result.value
    // A session the agent opened here: the view shows it, the newest open one first.
    if (name === 'browser_open' && output.session?.backend === 'managed-chromium' && output.session.threadId === threadId) this.opened.set(output.session.id, threadId)
    const state = this.threads.get(threadId) ?? (name === 'browser_open' && output.session ? this.state(threadId) : undefined)
    if (!state) return result
    this.sync(state)
    const sessionId = name === 'browser_open' ? output.session?.id : typeof params.sessionId === 'string' ? params.sessionId : undefined
    if (!sessionId || sessionId !== state.sessionId) return result
    if (name === 'browser_tabs' && params.operation === 'close' && typeof params.tabId === 'string') {
      state.viewer.tabClosed(params.tabId)
      if (state.tab === params.tabId) state.tab = undefined
      return result
    }
    const tabId = output.observation?.tabId ?? output.action?.observation?.tabId ?? output.tab?.id ?? (name === 'browser_tabs' && params.operation === 'switch' && typeof params.tabId === 'string' ? params.tabId : undefined)
    if (tabId) {
      state.tab = tabId
      // While the person holds the browser the view stays on the tab they took.
      if (!state.viewer.held) state.viewer.followTab(tabId)
    }
    const navigation = output.navigation ?? output.action?.navigation
    if (actsOrLoads(name, params) && navigation) state.viewer.noteProblem(navigation.problem)
    // The person took the browser over while this ran: the agent hears it in the person's terms, and whether it took effect.
    if (output.action?.takeover) return { ok: true, value: { ...output, action: { ...output.action, message: browserTakeoverMessage(output.action.takeover, 'The user') + ' Wait for them to give the browser back, or carry on without it.' } } }
    return result
  }

  // -- the session the view follows

  /**
   * The thread's open session the view follows: the one the person holds while they hold it, else the
   * newest one a thread agent opened that is open (sessions stay open across turns, and the agent uses
   * its latest).
   */
  private sync(state: ThreadBrowserState): void {
    const browser = this.options.browser()
    if (!browser) return
    const listed = browser.sessions.listThreadSessions({ profileId: this.options.profileId, threadId: state.threadId })
    // A session that closed is forgotten.
    for (const [sessionId, threadId] of this.opened) if (threadId === state.threadId && !listed.some((record) => record.id === sessionId)) this.opened.delete(sessionId)
    const open = listed.filter((record) => record.backend === 'managed-chromium' && LIVE.has(record.lifecycle) && this.opened.get(record.id) === state.threadId)
    const held = state.viewer.held && state.sessionId && open.some((record) => record.id === state.sessionId) ? state.sessionId : undefined
    const next = held ?? open.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id))[0]?.id
    if (next === state.sessionId) return
    if (state.sessionId) state.viewer.closed()
    state.sessionId = next
    state.tab = undefined
    if (next) state.viewer.opened(undefined)
  }

  /** What the person is told of the thread's browser: the general view, and whether the agent asks for them. */
  private threadView(state: ThreadBrowserState, view: WatchedBrowserView): ThreadBrowserView {
    const record = state.viewer.record()
    const handoff = record?.humanHandoff
    const asks = view.open && !state.viewer.held && record?.lifecycle === 'human-controlled' && handoff?.state === 'waiting-human' ? handoff.reason.slice(0, MAX_BROWSER_VIEW_ASK_CHARS) : undefined
    return { ...view, ...(asks !== undefined ? { asks } : {}) }
  }

  // -- scopes

  private policy(): ExecutionPolicySnapshot {
    return this.policies.snapshot(this.options.profileId, {
      allowedTools: [...BROWSER_AUTOMATION_TOOLS],
      allowedCapabilities: ['browser.session', 'browser.observe', 'browser.action'],
      allowedEffects: ['read', 'external'],
      maxToolCalls: 1_000,
      maxElapsedMs: 30 * 60_000,
      maxArtifactBytes: 16 * 1024 * 1024
    })
  }

  /**
   * One call in the person's scope over the thread's session: the session's own thread and run, as a
   * person's view (`source: 'gui'`), whose budget is retired after each call. `signal` ends it early.
   */
  private async personCall<T>(state: ThreadBrowserState, call: (context: BrowserToolContext) => Promise<T>, signal?: AbortSignal): Promise<T> {
    const browser = this.options.browser()
    const sessionId = state.sessionId
    if (!browser || !sessionId) throw new BrowserAutomationError({ code: 'session_closed', message: 'No browser is open for this thread.' })
    const scope = browser.sessions.trustedSessionScope({ profileId: this.options.profileId, threadId: state.threadId, sessionId })
    const policy = this.policy()
    const context: BrowserToolContext = {
      signal: signal ?? new AbortController().signal,
      execution: {
        profileId: this.options.profileId,
        threadId: scope.threadId,
        ...(scope.runId === undefined ? {} : { runId: scope.runId }),
        turnId: `viewer-${state.threadId}`,
        actor: { kind: 'main' },
        policySnapshotId: policy.id,
        source: 'gui',
        cancellationId: `viewer-${state.threadId}`
      },
      policy,
      target: { backend: 'managed-chromium' }
    }
    try {
      return await call(context)
    } finally {
      browser.sessions.retireViewerBudget(context)
    }
  }

  private stateFor(threadId: string): ThreadBrowserState {
    if (!this.options.threadExists(threadId)) throw new BrowserAutomationError({ code: 'invalid_action', message: 'Thread does not belong to this profile' })
    const state = this.state(threadId)
    this.sync(state)
    return state
  }

  private state(threadId: string): ThreadBrowserState {
    const known = this.threads.get(threadId)
    if (known) return known
    const state = { threadId, turns: new BrowserTurns(AGENT_TEXT) } as Omit<ThreadBrowserState, 'viewer'> as ThreadBrowserState
    state.viewer = new WatchedBrowser({
      profileId: this.options.profileId,
      threadId,
      sessionId: () => state.sessionId,
      browser: () => this.options.browser(),
      call: (call, signal) => this.personCall(state, call, signal),
      input: (call, tabId) => state.turns.personInput((held) => this.personCall(state, call, held), { holds: userHolds, busy: inputBusy, ...(tabId ? { tab: tabId } : {}) }),
      // The view's size: in the person's turn, after the agent's call under way (never stopping it).
      resize: (call) => state.turns.personCall((held) => this.personCall(state, call, held), { busy: inputBusy }),
      // The agent has its browser again: the view follows the tab it used last.
      givenBack: () => state.viewer.followTab(state.tab),
      text: { closed: 'No browser is open for this thread.', tooManyViews: 'Too many windows are watching this browser. Close one, then try again.' },
      log: { name: 'thread browser', fields: { threadId } },
      now: this.now,
      ...(this.options.holdLeaseMs !== undefined ? { holdLeaseMs: this.options.holdLeaseMs } : {}),
      ...(this.options.leaseTimer ? { leaseTimer: this.options.leaseTimer } : {}),
      computer: this.computer
    })
    this.threads.set(threadId, state)
    return state
  }

  /** A thread with no open session, no view and no hold keeps nothing here. */
  private prune(state: ThreadBrowserState): void {
    if (state.sessionId || state.viewer.held || state.viewer.watched()) return
    this.threads.delete(state.threadId)
  }
}
