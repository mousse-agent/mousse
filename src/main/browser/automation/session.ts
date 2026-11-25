import { randomUUID } from 'node:crypto'
import type { GuestKeyboardFocusScope } from './guestHandle'
import type {
  BrowserAction,
  BrowserActionRequest,
  BrowserActionResult,
  BrowserElement,
  BrowserLifecycle,
  BrowserObservation,
  BrowserSessionRecord,
  BrowserTab,
  BrowserTarget,
  BrowserWaitCondition,
  BrowserWorkerRequest
} from '../../../shared/browser/types'
import { browserTakeoverMessage } from '../../../shared/browser/types'
import { AGENT_CURSOR_GLIDE_MS, agentCursorFor, type BrowserAgentCursor } from '../../../shared/browser/agentCursor'
import { imagePointToViewport } from '../../../shared/browser/geometry'
import { browserNavigationUrl, validateBrowserActionRequest, validateBrowserWait } from '../../../shared/browser/validation'
import type { BrowserArtifactPort, BrowserJournalPort } from '../../../mms/browser/ports'
import { CdpDisconnectedError } from '../../../browser-worker/cdp/connection'
import type { CdpCommandOptions, CdpTransport } from '../../../browser-worker/cdp/transport'
import { BrowserWorkerError, fail, isBrowserWorkerError } from '../../../browser-worker/errors'
import { prepareActionableTarget, readControlValue, type ActionableTarget } from '../../../browser-worker/action/actionability'
import { dispatchAction, waitForLoad } from '../../../browser-worker/action/dispatch'
import { collectStructuredObservation, MAX_OBSERVATION_ELEMENTS } from '../../../browser-worker/observation/collect'
import { captureViewportScreenshot } from '../../../browser-worker/observation/screenshot'
import { BrowserReferenceStore, type ReferenceIdentity } from '../../../browser-worker/observation/ReferenceStore'
import { boundText, nowIso, optionalBoolean, optionalString, requiredId, sanitizeUrl, sleep } from '../../../browser-worker/util'
import type { AttachedControlState, AttachedUiTabId } from '../../../shared/browser/attached'
import { ElectronDebuggerTransport, type DebuggerTransportOptions } from './debuggerTransport'
import type { TrustedGuestRecord } from './registry'
import { TrustedGuestRegistry } from './registry'
import { TabActivity, type UserInputKind } from './tabActivity'

/** How long an agent waits, one step after another, for the person to finish with a tab (15.5 s in all). */
export const CONFLICT_BACKOFF_MS: readonly number[] = [500, 1_000, 2_000, 4_000, 8_000]

/** The agent gave way to the person and should stop trying for this tab. */
export const USER_CONFLICT_MESSAGE = 'The person is actively using this browser tab, so you gave way. Do not keep trying to use it: wrap up what you were about to do (say what you would have done in the browser) and end your turn.'
/** A second conflict in the same turn: no more waiting. */
export const USER_CONFLICT_REPEAT_MESSAGE = 'The person is still actively using this browser tab. Stop using the browser for the rest of this turn: tell them what you were about to do and end your turn.'

const PREEMPTED = 'preempted'

/**
 * A step the person's input stopped before any of its input or navigation reached the page. It is the one failure
 * `exclusive` runs again: anything else, and anything stopped after its input was sent, is never repeated.
 */
class PreemptedBeforeDispatch extends BrowserWorkerError {
  constructor() { super('cancelled', 'The person started using the tab before this step reached the page') }
}

/** The CDP input commands, by the kind of input event they raise in the page (`TabActivity.beginSynthetic`). */
function inputKindOf(method: string, params?: Record<string, unknown>): UserInputKind | undefined {
  if (method === 'Input.dispatchMouseEvent') return params?.type === 'mouseWheel' ? 'wheel' : 'pointer'
  if (method === 'Input.dispatchTouchEvent' || method === 'Input.emulateTouchFromMouseEvent') return 'pointer'
  if (method === 'Input.synthesizeScrollGesture') return 'wheel'
  if (method === 'Input.dispatchKeyEvent' || method === 'Input.insertText' || method === 'Input.imeSetComposition') return 'key'
  return undefined
}

/** The actions that type into the page: they take the window's keyboard focus while they run. */
const KEYBOARD_ACTIONS: ReadonlySet<string> = new Set(['fill', 'type', 'key'])

/**
 * The turns that gave way to the person (`USER_CONFLICT_MESSAGE`), kept apart from any one session: a session that
 * failed to open, or a step that worked in another tab, does not forget it. A new turn starts afresh.
 */
export class ConflictBreaker {
  private readonly turns = new Set<string>()
  constructor(private readonly limit = 512) {}
  gaveWay(turn: string): boolean { return this.turns.has(turn) }
  record(turn: string): void {
    this.turns.delete(turn)
    this.turns.add(turn)
    while (this.turns.size > this.limit) this.turns.delete(this.turns.values().next().value!)
  }
}

/** A tab's CDP that tells its activity which kind of input the agent sends while each input command runs. */
function syntheticInput(cdp: CdpTransport, activity: TabActivity): CdpTransport {
  return {
    get connected() { return cdp.connected },
    send: async <T = unknown>(method: string, params?: Record<string, unknown>, options?: CdpCommandOptions): Promise<T> => {
      const kind = inputKindOf(method, params)
      const release = kind ? activity.beginSynthetic(kind) : undefined
      try { return await cdp.send<T>(method, params, options) }
      finally { release?.() }
    },
    on: (event, listener) => cdp.on(event, listener),
    off: (event, listener) => cdp.off(event, listener)
  }
}

/**
 * What a session sees of its window's other tabs (`browser_tabs`). A thread's agent sees the tabs of its thread and the
 * tabs kept in every thread; never another thread's.
 */
export interface AttachedTabsPort {
  /** The uiTabIds this thread's agent may see; with `ownOnly`, only the thread's own tabs, never those kept in every thread. */
  visible(threadId: string, ownOnly?: boolean): AttachedUiTabId[]
  /** Binds a tab to the thread for automation and returns its trusted guest. Refuses another thread's tab or another session's. */
  claim(uiTabId: AttachedUiTabId, threadId: string, sessionId: string, ownOnly?: boolean): TrustedGuestRecord
  /** Whether another live session drives the tab (claimed it or is stepping in it); listing a tab never counts. */
  drivenByOther(uiTabId: AttachedUiTabId, sessionId: string): boolean
  /** Asks the window for a new tab of the thread; resolves once it is registered. */
  open(input: { threadId: string; activate: boolean }, signal?: AbortSignal): Promise<AttachedUiTabId>
  /** Whether an agent of the thread opened the tab (and it is still the thread's): only such a tab may be closed by one. */
  closable(uiTabId: AttachedUiTabId, threadId: string): boolean
  /** Whether the person is using another tab of the window (typing in it, its address bar or the picker): typing elsewhere would take their focus. */
  personBusyElsewhere(uiTabId: AttachedUiTabId): boolean
  /** Asks the window to close a tab. */
  close(uiTabId: AttachedUiTabId): void
  /** Commands for the session go through another tab from now on (its first tab is closing). */
  reanchor(sessionId: string, uiTabId: AttachedUiTabId): void
  /** Whether the person is using any tab of the window: a new agent tab then opens behind it. */
  anyUserActive(): boolean
}

export interface AttachedPageSessionConfig {
  profileId: string
  profileEpoch: string
  uiTabId: AttachedUiTabId
  threadId: string
  runId?: string
  journal: BrowserJournalPort
  artifacts?: BrowserArtifactPort
  browserVersion?: string
  clock?: () => Date
  interceptCommand?: DebuggerTransportOptions['interceptCommand']
  onControlStateChange?: (state: AttachedControlState) => void
  /**
   * Where the agent is about to act (`agentCursor.ts`): drawn over the tab by its window, never in
   * the page. True when a window shows it: only then does the cursor glide before the input.
   */
  onAgentCursor?: (event: { uiTabId: AttachedUiTabId; cursor: BrowserAgentCursor }) => boolean
  /** Who is using each tab (`TabActivity`). */
  activityFor?: (uiTabId: AttachedUiTabId) => TabActivity
  /** The window's other tabs; without it the session has its one tab. */
  tabs?: AttachedTabsPort
  /** A run without a person's tree grant (an editor try-run, an app-started workflow): its thread's own tabs only. */
  ownThreadOnly?: boolean
  /** The turns that gave way to the person, shared by the window's sessions. */
  conflicts?: ConflictBreaker
  /** The wait between tries while the person uses a tab (tests shorten it). */
  conflictBackoffMs?: readonly number[]
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>
}

interface TabState {
  publicId: string
  url: string
  title: string
  documentId: string
  loaderId: string
  frameId: string
}

/** One in-app tab the session knows: its guest, and the debugger attached to it once the session uses it. */
interface SessionTab {
  readonly uiTabId: AttachedUiTabId
  guest: TrustedGuestRecord
  readonly state: TabState
  readonly activity: TabActivity
  transport: ElectronDebuggerTransport | null
  stopNav: (() => void) | null
  attached: boolean
  /** The session drives this tab: its first tab, or one it switched to, opened, or named in a call. A listed tab is only known. */
  claimed: boolean
  /** Aborted when the session forgets the tab: a step waiting for it stops at once. */
  readonly gone: AbortController
}

/** Options a mutating call carries: the turn (for the conflict breaker) and its cancellation. */
export interface AttachedStepOptions {
  signal?: AbortSignal
  turn?: string
  /** The step types into the page, taking the window's keyboard focus. */
  keyboard?: boolean
}

const ATTACHED_CDP_SESSION = ''

export class AttachedPageSession {
  readonly id: string
  readonly profileId: string
  readonly threadId: string
  readonly runId?: string
  readonly persistent = false
  generation = 1
  lifecycle: BrowserLifecycle = 'starting'
  controlLeaseId: string
  controlOwner: 'agent' | 'human' = 'agent'
  createdAt: string
  updatedAt: string
  private refs: BrowserReferenceStore
  private readonly tabs = new Map<string, SessionTab>()
  private anchor: SessionTab
  private current: SessionTab
  private keyboardFocus: GuestKeyboardFocusScope | null = null
  private inFlight: { requestId: string; tab: SessionTab; actionType: BrowserAction['type']; dispatched: boolean; abort: AbortController } | null = null
  private readonly journal: BrowserJournalPort
  private readonly artifacts?: BrowserArtifactPort
  private readonly clock: () => Date
  private closed = false
  private disconnected = false
  private observations = new Map<string, {
    tabId: string
    generation: number
    documentId: string
    viewport: BrowserObservation['viewport']
    screenshot?: BrowserObservation['screenshot']
  }>()
  private lastActionFingerprint = ''
  private repeatedActionCount = 0
  /** The turns that gave way to the person (`USER_CONFLICT_REPEAT_MESSAGE`). */
  private readonly conflicts: ConflictBreaker
  /** Aborted when the session closes or disconnects: a waiting step stops at once. */
  private readonly ended = new AbortController()
  /** The tab this session handed to the person (`browser_request_human`): the only hold it may end. */
  private heldTab: SessionTab | null = null
  /** Tabs this session asked its window to close: never listed again, though the window may not have closed them yet. */
  private readonly closingTabs = new Set<AttachedUiTabId>()
  private readonly ownThreadOnly: boolean
  private readonly onControlStateChange?: (state: AttachedControlState) => void
  private readonly onAgentCursor?: AttachedPageSessionConfig['onAgentCursor']
  private readonly interceptCommand?: DebuggerTransportOptions['interceptCommand']
  private readonly activityFor: (uiTabId: AttachedUiTabId) => TabActivity
  private readonly port?: AttachedTabsPort
  private readonly backoff: readonly number[]
  private readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>
  private readonly browserVersion: string
  private readonly profileEpoch: string

  constructor(
    private readonly registry: TrustedGuestRegistry,
    guest: TrustedGuestRecord,
    config: AttachedPageSessionConfig
  ) {
    this.id = 'sess_' + randomUUID()
    this.profileId = config.profileId
    this.profileEpoch = config.profileEpoch
    this.threadId = config.threadId
    this.runId = config.runId
    this.controlLeaseId = 'lease_' + randomUUID()
    this.clock = config.clock ?? (() => new Date())
    this.createdAt = nowIso(this.clock)
    this.updatedAt = this.createdAt
    this.journal = config.journal
    this.artifacts = config.artifacts
    this.browserVersion = config.browserVersion ?? 'electron-attached'
    this.onControlStateChange = config.onControlStateChange
    this.onAgentCursor = config.onAgentCursor
    this.interceptCommand = config.interceptCommand
    const fallback = new Map<string, TabActivity>()
    this.activityFor = config.activityFor ?? ((uiTabId) => {
      let activity = fallback.get(uiTabId)
      if (!activity) { activity = new TabActivity(); fallback.set(uiTabId, activity) }
      return activity
    })
    this.port = config.tabs
    this.ownThreadOnly = config.ownThreadOnly === true
    this.conflicts = config.conflicts ?? new ConflictBreaker()
    this.backoff = config.conflictBackoffMs ?? CONFLICT_BACKOFF_MS
    this.sleep = config.sleep ?? sleep
    this.refs = new BrowserReferenceStore({ profileId: this.profileId, sessionId: this.id, generation: this.generation })
    this.anchor = this.addTab(config.uiTabId, guest)
    this.anchor.claimed = true
    this.current = this.anchor
  }

  /** The tab the session opened on: its commands are routed through it. */
  get uiTabId(): AttachedUiTabId { return this.anchor.uiTabId }

  hasTab(uiTabId: AttachedUiTabId): boolean {
    return [...this.tabs.values()].some((tab) => tab.uiTabId === uiTabId)
  }

  /** Whether the session drives a tab: one it claimed, or the one a step of it runs in. A tab it only listed is not. */
  drives(uiTabId: AttachedUiTabId): boolean {
    if (this.inFlight?.tab.uiTabId === uiTabId) return true
    return [...this.tabs.values()].some((tab) => tab.uiTabId === uiTabId && tab.claimed)
  }

  record(): BrowserSessionRecord {
    return {
      id: this.id,
      profileId: this.profileId,
      ...(this.runId ? { runId: this.runId } : {}),
      threadId: this.threadId,
      persistent: false,
      backend: 'electron-attached',
      browserVersion: this.browserVersion,
      generation: this.generation,
      lifecycle: this.lifecycle,
      controlLeaseId: this.controlLeaseId,
      createdAt: this.createdAt,
      updatedAt: this.updatedAt
    }
  }

  controlState(tab: SessionTab = this.current): AttachedControlState {
    return {
      sessionId: this.id,
      uiTabId: tab.uiTabId,
      profileId: this.profileId,
      owner: this.disconnected || this.closed ? 'disconnected' : this.controlOwner,
      controlLeaseId: this.controlLeaseId,
      generation: this.generation,
      lifecycle: this.lifecycle,
      activity: tab.activity.state()
    }
  }

  async start(initialUrl?: string, options: AttachedStepOptions = {}): Promise<BrowserSessionRecord> {
    await this.assertBinding(this.anchor)
    await this.attach(this.anchor)
    if (initialUrl) await this.exclusive(this.anchor, options, (fence) => this.navigate(this.anchor, initialUrl, fence, options.signal))
    this.lifecycle = 'agent-controlled'
    this.touch()
    this.emitControl()
    return this.record()
  }

  /** Opening the session again (its own tab or one of its other tabs) must not attach a second debugger. */
  async reopen(url?: string, uiTabId?: AttachedUiTabId, options: AttachedStepOptions = {}): Promise<BrowserSessionRecord> {
    const tab = uiTabId ? [...this.tabs.values()].find((candidate) => candidate.uiTabId === uiTabId) ?? this.current : this.current
    await this.assertBinding(tab)
    if (this.controlOwner !== 'agent') fail('human_controlled', 'You have control of this tab; resume the agent to continue')
    if (this.inFlight) fail('invalid_action', 'A browser action is still running; wait before opening this tab again')
    await this.attach(tab)
    this.current = tab
    if (url) await this.exclusive(tab, options, (fence) => this.navigate(tab, url, fence, options.signal))
    return this.record()
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    this.lifecycle = 'closed'
    this.ended.abort()
    this.fenceInFlight('cancelled')
    this.refs.clear()
    this.endHold()
    for (const tab of this.tabs.values()) {
      tab.stopNav?.()
      tab.stopNav = null
      try { await tab.transport?.close() } catch { /* already gone */ }
      tab.transport = null
    }
    this.touch()
    this.emitControl('all')
  }

  markDisconnected(reason: 'debugger' | 'guest' | 'owner' | 'epoch' | 'gui'): void {
    if (this.closed) return
    this.disconnected = true
    this.lifecycle = 'disconnected'
    this.ended.abort()
    this.fenceInFlight('cancelled')
    this.refs.clear()
    this.observations.clear()
    this.endHold()
    for (const tab of this.tabs.values()) {
      tab.stopNav?.()
      tab.stopNav = null
      if (reason !== 'debugger') {
        try { tab.transport?.releaseAttachment() } catch { /* already gone */ }
      }
      tab.transport = null
    }
    this.touch()
    this.emitControl('all')
  }

  /** A tab other than the session's first one is gone: the session goes on in its other tabs. */
  dropTab(uiTabId: AttachedUiTabId): void {
    const tab = [...this.tabs.values()].find((candidate) => candidate.uiTabId === uiTabId)
    if (!tab) return
    if (tab === this.anchor) { this.markDisconnected('guest'); return }
    // A tab handed to the person takes the handover with it: the agent goes on in its other tabs.
    if (tab === this.heldTab) {
      this.endHold()
      this.controlOwner = 'agent'
      this.lifecycle = 'agent-controlled'
    }
    this.forget(tab)
    this.touch()
    this.emitControl()
  }

  listTabs(): BrowserTab[] {
    this.refreshTabs()
    return [...this.tabs.values()].map((tab) => this.describe(tab))
  }

  async switchTab(tabId: string): Promise<BrowserTab & { tabs: BrowserTab[] }> {
    this.refreshTabs()
    const tab = this.tabs.get(tabId)
    if (!tab) fail('stale_ref', 'Unknown tab: list the tabs first, then switch to one of them')
    if (this.inFlight) fail('invalid_action', 'A browser action is still running; wait before switching tabs')
    this.claim(tab)
    await this.assertBinding(tab)
    await this.attach(tab)
    this.current = tab
    this.touch()
    this.emitControl(tab)
    return { ...this.describe(tab), tabs: this.listTabs() }
  }

  /**
   * A new tab of the thread, made by its window. It opens behind the tab the person uses, if they use one; the
   * session acts in it from now on.
   */
  async newTab(url: string | undefined, options: AttachedStepOptions = {}): Promise<BrowserTab & { tabs: BrowserTab[] }> {
    if (!this.port) fail('unsupported', 'This in-app browser cannot open tabs')
    // While the person holds a tab the agent handed them, it opens nothing new either.
    if (this.controlOwner !== 'agent') fail('human_controlled', 'The person has control of the browser; wait until they resume the agent')
    if (this.inFlight) fail('invalid_action', 'A browser action is still running; wait before opening a tab')
    const target = url === undefined ? undefined : browserNavigationUrl(url)
    const uiTabId = await this.port.open({ threadId: this.threadId, activate: !this.port.anyUserActive() }, options.signal)
    if (this.closed || this.disconnected) fail('session_closed', 'Attached browser session is closed')
    const guest = this.port.claim(uiTabId, this.threadId, this.id, this.ownThreadOnly)
    const tab = [...this.tabs.values()].find((candidate) => candidate.uiTabId === uiTabId) ?? this.addTab(uiTabId, guest)
    tab.guest = guest
    tab.claimed = true
    await this.assertBinding(tab)
    await this.attach(tab)
    this.current = tab
    if (target) await this.exclusive(tab, options, (fence) => this.navigate(tab, target, fence, options.signal))
    this.touch()
    this.emitControl(tab)
    return { ...this.describe(tab), tabs: this.listTabs() }
  }

  /**
   * Closes one of the session's tabs in its window: only one an agent of this thread opened, never one the person is
   * using, and never its last.
   */
  closeTab(tabId: string): { closed: string; tabs: BrowserTab[]; anchorUiTabId?: string } {
    if (!this.port) fail('unsupported', 'This in-app browser cannot close tabs')
    this.refreshTabs()
    const tab = this.tabs.get(tabId)
    if (!tab) fail('stale_ref', 'Unknown tab: list the tabs first')
    // The person's own tabs keep their pages: an agent closes only the tabs its thread's agents opened.
    if (!this.port.closable(tab.uiTabId, this.threadId)) fail('policy_denied', 'An agent closes only tabs its thread\'s agents opened; leave this one open.')
    if (tab.activity.userActive() || tab.activity.state() === 'waiting-human') fail('human_controlled', 'The person is using this tab; leave it open.')
    if (this.inFlight?.tab === tab) fail('invalid_action', 'A browser action is still running in this tab')
    if (this.port.drivenByOther(tab.uiTabId, this.id)) fail('invalid_action', 'Another agent is using this tab; leave it open.')
    const others = [...this.tabs.values()].filter((candidate) => candidate !== tab)
    if (!others.length) fail('invalid_action', 'This is the only tab of the session; open or switch to another tab first')
    let anchorUiTabId: string | undefined
    if (tab === this.anchor) {
      // The session's commands come through its first tab: they move to another tab before it closes.
      const next = others.includes(this.current) ? this.current : others[0]!
      next.guest = this.port.claim(next.uiTabId, this.threadId, this.id, this.ownThreadOnly)
      next.claimed = true
      this.port.reanchor(this.id, next.uiTabId)
      this.anchor = next
      anchorUiTabId = next.uiTabId
    }
    // The window closes the tab a moment later: until then it is still visible, but no longer the session's.
    this.closingTabs.add(tab.uiTabId)
    this.forget(tab)
    this.port.close(tab.uiTabId)
    this.touch()
    return { closed: tabId, tabs: this.listTabs(), ...(anchorUiTabId ? { anchorUiTabId } : {}) }
  }

  async observe(params: Record<string, unknown>): Promise<BrowserObservation> {
    const tab = await this.resolveTab(params.tabId)
    const state = tab.state
    const includeScreenshot = optionalBoolean(params.includeScreenshot) === true
    const requestedMax = Math.min(MAX_OBSERVATION_ELEMENTS, Math.max(1,
      Math.floor(typeof params.maxElements === 'number' ? params.maxElements : MAX_OBSERVATION_ELEMENTS)))
    const collected = await collectStructuredObservation(this.requireCdp(tab), ATTACHED_CDP_SESSION, {
      visibleOnly: optionalBoolean(params.visibleOnly),
      continuation: optionalString(params.continuation, 64),
      maxElements: requestedMax
    })
    state.url = collected.url
    state.title = collected.title
    state.documentId = collected.documentId
    state.loaderId = collected.loaderId
    state.frameId = collected.frameId
    const observationId = 'obs_' + randomUUID()
    const identity: ReferenceIdentity = {
      profileId: this.profileId,
      sessionId: this.id,
      generation: this.generation,
      tabId: state.publicId,
      documentId: collected.documentId,
      observationId
    }
    const refs = this.refs.observe(identity, collected.nodes)
    const elements: BrowserElement[] = collected.elements.map((element, index) => ({ ...element, ref: refs[index] }))
    let screenshot: BrowserObservation['screenshot']
    const warnings = [...collected.warnings]
    if (includeScreenshot) {
      if (!this.artifacts) {
        warnings.push('screenshot-unavailable')
      } else {
        const clip = params.clip && typeof params.clip === 'object' ? params.clip as { x: number; y: number; width: number; height: number } : undefined
        let captured
        try {
          captured = await captureViewportScreenshot(this.requireCdp(tab), ATTACHED_CDP_SESSION, collected.viewport, clip, { timeoutMs: 8_000 })
        } catch {
          try {
            captured = await captureViewportScreenshot(this.requireCdp(tab), ATTACHED_CDP_SESSION, collected.viewport, clip, { fromSurface: false, timeoutMs: 8_000 })
          } catch {
            warnings.push('screenshot-unavailable')
          }
        }
        if (captured) {
          const written = await this.artifacts.write({
            profileId: this.profileId,
            sessionId: this.id,
            mediaType: 'image/png',
            bytes: captured.bytes,
            displayName: 'screenshot.png'
          })
          screenshot = { artifactId: written.artifactId, ...captured.screenshot }
        }
      }
    }
    this.observations.set(observationId, {
      tabId: state.publicId,
      generation: this.generation,
      documentId: collected.documentId,
      viewport: collected.viewport,
      ...(screenshot ? { screenshot } : {})
    })
    this.touch()
    return {
      sessionId: this.id,
      tabId: state.publicId,
      generation: this.generation,
      observationId,
      documentId: collected.documentId,
      capturedAt: nowIso(this.clock),
      url: collected.url,
      title: boundText(collected.title, 512),
      viewport: collected.viewport,
      tabs: this.listTabs(),
      elements,
      ...(screenshot ? { screenshot } : {}),
      truncated: collected.truncated,
      ...(collected.continuation ? { continuation: collected.continuation } : {}),
      warnings: [...new Set([...warnings, 'oopif-unsupported'])],
      provenance: 'untrusted-page'
    }
  }

  async find(params: Record<string, unknown>): Promise<{ observationId: string; elements: BrowserElement[]; truncated: boolean }> {
    const observation = await this.observe({ ...params, includeScreenshot: false })
    const role = optionalString(params.role, 64)?.toLowerCase()
    const name = optionalString(params.name, 240)?.toLowerCase()
    const text = optionalString(params.text, 240)?.toLowerCase()
    const maxResults = Math.min(50, typeof params.maxResults === 'number' ? params.maxResults : 20)
    const elements = observation.elements.filter((element) => {
      if (role && (element.role ?? '').toLowerCase() !== role) return false
      if (name && !(element.name ?? '').toLowerCase().includes(name)) return false
      if (text && !(`${element.name ?? ''} ${element.text ?? ''}`).toLowerCase().includes(text)) return false
      return true
    }).slice(0, maxResults)
    return { observationId: observation.observationId, elements, truncated: elements.length === maxResults }
  }

  async extract(params: Record<string, unknown>): Promise<{ provenance: 'untrusted-page'; text: string; truncated: boolean }> {
    const observation = await this.observe({ ...params, includeScreenshot: false })
    const ref = optionalString(params.ref, 160)
    const selected = ref ? observation.elements.filter((element) => element.ref === ref) : observation.elements
    const text = boundText(selected.map((element) => [element.role, element.name, element.text].filter(Boolean).join(' ')).join('\n'), 8_000)
    return { provenance: 'untrusted-page', text, truncated: text.length >= 8_000 }
  }

  async wait(params: Record<string, unknown>, signal?: AbortSignal): Promise<BrowserObservation> {
    const condition = validateBrowserWait(params.condition ?? params)
    const timeoutMs = typeof params.timeoutMs === 'number' ? params.timeoutMs : 5_000
    const deadline = Date.now() + Math.min(timeoutMs, 30_000)
    let observation = await this.observe(params)
    while (Date.now() < deadline) {
      if (signal?.aborted) fail('cancelled', 'Wait cancelled')
      if (this.matchWait(observation, condition)) return observation
      await new Promise((resolve) => setTimeout(resolve, 100))
      observation = await this.observe(params)
    }
    fail('timeout', 'Wait condition was not met')
  }

  takeControl(owner: 'human' | 'agent'): { controlLeaseId: string; generation: number; lifecycle: BrowserLifecycle } {
    this.fenceInFlight('human_controlled')
    this.generation += 1
    this.refs = new BrowserReferenceStore({ profileId: this.profileId, sessionId: this.id, generation: this.generation })
    this.observations.clear()
    this.controlLeaseId = 'lease_' + randomUUID()
    this.controlOwner = owner
    this.lifecycle = owner === 'human' ? 'human-controlled' : 'agent-controlled'
    // A person asked to step in holds the tab the agent was in until they hand it back.
    if (owner === 'human') {
      if (this.heldTab !== this.current) this.endHold()
      this.heldTab = this.current
      this.current.activity.setHumanHold(true)
    } else this.endHold()
    this.touch()
    this.emitControl('all')
    return { controlLeaseId: this.controlLeaseId, generation: this.generation, lifecycle: this.lifecycle }
  }

  releaseControl(controlLeaseId: string): { ok: true; lifecycle: BrowserLifecycle; generation: number } {
    if (controlLeaseId !== this.controlLeaseId) fail('stale_generation', 'Control lease does not match')
    this.controlOwner = 'agent'
    this.lifecycle = 'agent-controlled'
    this.endHold()
    this.touch()
    this.emitControl('all')
    return { ok: true, lifecycle: this.lifecycle, generation: this.generation }
  }

  /**
   * One action. The tab is locked for the action alone: while the person uses it the agent waits, a step longer each
   * time (`CONFLICT_BACKOFF_MS`), and their input during the action preempts it. An action preempted before its input
   * was sent runs again once they finish; one preempted after is never repeated.
   */
  async act(params: Record<string, unknown>, signal?: AbortSignal, humanLease = false, turn?: string): Promise<BrowserActionResult> {
    await this.assertBinding(this.current)
    if (this.lifecycle === 'human-controlled' && !humanLease) fail('human_controlled', 'A human control lease is active')
    const tab = await this.resolveTab(params.tabId)
    if (humanLease) return this.actOnce(params, tab, signal, undefined, true)
    const type = (params.action as { type?: unknown } | null | undefined)?.type
    const keyboard = typeof type === 'string' && KEYBOARD_ACTIONS.has(type)
    return this.exclusive(tab, { signal, turn, keyboard }, (fence) => this.actOnce(params, tab, signal, fence, false))
  }

  async handle(method: BrowserWorkerRequest['method'], params: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
    if (method !== 'session.close') await this.assertBinding(this.anchor)
    const turn = optionalString(params.turn, 400)
    switch (method) {
      case 'session.close': return this.close()
      case 'tabs.list': return { tabs: this.listTabs(), activeTabId: this.current.state.publicId }
      case 'tabs.switch': return this.switchTab(requiredId(params.tabId))
      case 'tabs.new': return this.newTab(optionalString(params.url, 4096), { signal, turn })
      case 'tabs.close': return this.closeTab(requiredId(params.tabId ?? this.current.state.publicId))
      case 'observe': return this.observe(params)
      case 'find': return this.find(params)
      case 'extract': return this.extract(params)
      case 'wait': return this.wait(params, signal)
      case 'act': return this.act(params, signal, false, turn)
      case 'human.act':
        if (this.lifecycle !== 'human-controlled') fail('human_controlled', 'A human control lease is not active')
        return this.act(params, signal, true)
      case 'control.take': return this.takeControl(params.owner === 'human' ? 'human' : 'agent')
      case 'control.release':
        return this.releaseControl(requiredId(params.controlLeaseId))
      default:
        fail('unsupported', 'Unsupported method')
    }
  }

  /**
   * Runs one step that changes `tab`'s page with the tab locked (`agent-busy`), after the person has finished with it.
   * One step runs in a tab at a time: another step in it waits for this one to end. While the person uses the tab (or,
   * for a step that types, any tab of the window), the agent waits through `CONFLICT_BACKOFF_MS`; if they are still
   * using it after the last wait, the step is refused, and a second refusal in the same turn comes at once. After
   * every wait the tab must still be the session's and its thread's.
   */
  private async exclusive<T>(tab: SessionTab, options: AttachedStepOptions, run: (fence: AbortSignal) => Promise<T>): Promise<T> {
    const { signal, turn } = options
    // A wait ends at once when the call is stopped, the session ends or the tab leaves it.
    const stop = AbortSignal.any([tab.gone.signal, this.ended.signal, ...(signal ? [signal] : [])])
    let attempt = 0
    while (true) {
      this.assertStepAllowed(tab, signal)
      if (this.personUsing(tab, options)) {
        if (turn !== undefined && this.conflicts.gaveWay(turn)) fail('human_controlled', USER_CONFLICT_REPEAT_MESSAGE)
        if (attempt >= this.backoff.length) {
          if (turn !== undefined) this.conflicts.record(turn)
          fail('human_controlled', USER_CONFLICT_MESSAGE)
        }
        const stopWaiting = tab.activity.beginWaiting()
        try { await this.sleep(this.backoff[attempt++]!, stop) }
        catch {
          this.assertStepAllowed(tab, signal)
          fail('cancelled', 'Stopped while waiting for the person to finish with the tab')
        } finally { stopWaiting() }
        continue
      }
      let releaseStep: () => void
      try { releaseStep = await tab.activity.acquireStep(stop) }
      catch {
        this.assertStepAllowed(tab, signal)
        fail('cancelled', 'Stopped while waiting for another step in this tab')
      }
      try {
        // Another step may have run meanwhile, the person may have come back, or the tab may have left the thread.
        this.assertStepAllowed(tab, signal)
        await this.assertBinding(tab)
        if (this.personUsing(tab, options)) continue
        const release = tab.activity.beginAgent()
        const fence = new AbortController()
        const stopPreempt = tab.activity.onPreempt(() => fence.abort(PREEMPTED))
        try {
          return await run(fence.signal)
        } catch (error) {
          // Stopped by the person before anything reached the page: it is tried again once they are done. Only a step
          // that says so is; one stopped after dispatch (even while its outcome is being written) never is.
          if (error instanceof PreemptedBeforeDispatch && !signal?.aborted) continue
          throw error
        } finally {
          stopPreempt()
          release()
        }
      } finally {
        releaseStep()
      }
    }
  }

  /** Whether a step may run (or go on waiting) in `tab`: the call goes on, the session is open, and the tab is still its thread's. */
  private assertStepAllowed(tab: SessionTab, signal?: AbortSignal): void {
    if (signal?.aborted) fail('cancelled', 'Browser step cancelled')
    if (this.closed || this.disconnected) fail('session_closed', 'Attached browser session is closed')
    if (this.tabs.get(tab.state.publicId) !== tab) fail('stale_ref', 'This tab is no longer one of the session\'s tabs')
    if (this.port && tab !== this.anchor && !this.port.visible(this.threadId, this.ownThreadOnly).includes(tab.uiTabId)) {
      this.forget(tab)
      fail('stale_ref', 'This tab is no longer one of the thread\'s tabs')
    }
    if (tab.activity.state() === 'waiting-human') fail('human_controlled', 'The person holds this tab; wait until they resume the agent')
  }

  /** The person uses the tab, or, for a step that types (and would take the keyboard focus), another tab of the window. */
  private personUsing(tab: SessionTab, options: AttachedStepOptions): boolean {
    return tab.activity.userActive() || (options.keyboard === true && this.port?.personBusyElsewhere(tab.uiTabId) === true)
  }

  /**
   * Loads a URL the agent asked for (open, reopen, a new tab). It is the tab's in-flight step while it runs. Once
   * `Page.navigate` is sent it counts as dispatched: if the person cuts in after that, it is never sent again, and the
   * agent is told they took over. Stopping the call stops the wait for the page to load.
   */
  private async navigate(tab: SessionTab, url: string, fence: AbortSignal, signal?: AbortSignal): Promise<void> {
    const cdp = this.requireCdp(tab)
    const target = browserNavigationUrl(url)
    if (fence.aborted && fence.reason === PREEMPTED) throw new PreemptedBeforeDispatch()
    if (signal?.aborted) fail('cancelled', 'Browser step cancelled')
    if (this.inFlight) fail('not_actionable', 'Another action is already in flight for this session')
    const abort = new AbortController()
    const onFence = () => abort.abort(fence.reason)
    const onSignal = () => abort.abort(signal?.reason)
    fence.addEventListener('abort', onFence, { once: true })
    signal?.addEventListener('abort', onSignal, { once: true })
    const requestId = 'nav_' + randomUUID()
    // Dispatched from the moment it is sent: its own new document never fences it (`invalidateDocument`).
    this.inFlight = { requestId, tab, actionType: 'navigate', dispatched: true, abort }
    const endNavigation = tab.activity.beginOwnNavigation()
    try {
      await cdp.send('Page.navigate', { url: target }, { sessionId: ATTACHED_CDP_SESSION, signal: abort.signal })
      await waitForLoad(cdp, ATTACHED_CDP_SESSION, 15_000, abort.signal)
    } catch (error) {
      if (fence.aborted && fence.reason === PREEMPTED) fail('human_controlled', browserTakeoverMessage('unknown', 'The person'))
      if (signal?.aborted) fail('cancelled', 'Stopped while the page was loading; it may still be loading')
      throw error
    } finally {
      endNavigation()
      fence.removeEventListener('abort', onFence)
      signal?.removeEventListener('abort', onSignal)
      if (this.inFlight?.requestId === requestId) this.inFlight = null
      this.refs.invalidateTab(tab.state.publicId)
    }
  }

  private async actOnce(params: Record<string, unknown>, tab: SessionTab, signal: AbortSignal | undefined, fence: AbortSignal | undefined, humanLease: boolean): Promise<BrowserActionResult> {
    const request = validateBrowserActionRequest({
      requestId: params.requestId ?? 'req_' + randomUUID(),
      sessionId: params.sessionId ?? this.id,
      tabId: params.tabId ?? tab.state.publicId,
      generation: params.generation ?? this.generation,
      observationId: params.observationId,
      controlLeaseId: params.controlLeaseId ?? this.controlLeaseId,
      action: params.action,
      timeoutMs: params.timeoutMs ?? 8_000,
      ...(params.expected === undefined ? {} : { expected: params.expected })
    })
    if (request.sessionId !== this.id) fail('session_closed', 'Action session does not match')
    if (request.generation !== this.generation) fail('stale_generation', 'Action generation is stale')
    if (request.controlLeaseId !== this.controlLeaseId) fail('human_controlled', 'Control lease was replaced')
    if (this.inFlight) fail('not_actionable', 'Another action is already in flight for this session')
    this.rejectUnsupportedAction(request.action)
    const state = tab.state
    const abort = new AbortController()
    const onAbort = () => abort.abort(signal?.reason)
    const onFence = () => abort.abort(PREEMPTED)
    if (signal) {
      if (signal.aborted) fail('cancelled', 'Action cancelled before dispatch')
      signal.addEventListener('abort', onAbort, { once: true })
    }
    if (fence) {
      if (fence.aborted) fail('cancelled', 'Action cancelled before dispatch')
      fence.addEventListener('abort', onFence, { once: true })
    }
    this.inFlight = { requestId: request.requestId, tab, actionType: request.action.type, dispatched: false, abort }
    let dispatched = false
    const navigates = ['navigate', 'reload', 'back', 'forward'].includes(request.action.type)
    let endNavigation: (() => void) | undefined
    try {
      await this.journal.append({
        at: nowIso(this.clock),
        profileId: this.profileId,
        sessionId: this.id,
        requestId: request.requestId,
        generation: this.generation,
        phase: 'intent',
        actionType: request.action.type,
        dispatched: false
      })
      if (abort.signal.aborted) fail('cancelled', 'Action cancelled before dispatch')
      const target = await this.resolveActionTarget(request, tab)
      if (abort.signal.aborted) fail('cancelled', 'Action cancelled before dispatch')
      if (!humanLease) await this.glideCursor(request, tab, target, abort.signal)
      if (abort.signal.aborted) fail('cancelled', 'Action cancelled before dispatch')
      this.inFlight.dispatched = true
      dispatched = true
      await this.journal.append({
        at: nowIso(this.clock),
        profileId: this.profileId,
        sessionId: this.id,
        requestId: request.requestId,
        generation: this.generation,
        phase: 'dispatched',
        actionType: request.action.type,
        dispatched: true
      })
      const actionSessionId = target && 'from' in target
        ? target.from.cdpSessionId === target.to.cdpSessionId
          ? target.from.cdpSessionId
          : (fail('unsupported', 'Cross-frame drag is not certified'), ATTACHED_CDP_SESSION)
        : target?.cdpSessionId ?? ATTACHED_CDP_SESSION
      const cdp = this.requireCdp(tab)
      const transport = tab.transport!
      const keyboardInput = ['fill', 'type', 'key'].includes(request.action.type)
      let keyboardFocus: GuestKeyboardFocusScope | undefined
      // The page's input events of one kind are the agent's own only while it sends input of that kind: the person's
      // keys still count while the agent clicks, and their clicks while it types.
      const input = syntheticInput(cdp, tab.activity)
      try {
        if (keyboardInput) {
          keyboardFocus = await tab.guest.guest.acquireKeyboardFocus(abort.signal)
          await this.assertBinding(tab)
          if (abort.signal.aborted || request.controlLeaseId !== this.controlLeaseId) fail('cancelled', 'Keyboard ownership changed while awaiting focus')
          this.keyboardFocus = keyboardFocus
        }
        // DOM.focus selects an element but does not focus a hidden Linux guest's
        // renderer widget. Chromium otherwise acknowledges insertText without
        // inserting anything. Scope emulation to this one owned keyboard action.
        if (keyboardInput) await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true }, { sessionId: actionSessionId, signal: abort.signal })
        // The agent's own back, forward, reload or URL: the window must not take it for the person's navigation.
        if (navigates) endNavigation = tab.activity.beginOwnNavigation()
        await dispatchAction(input, actionSessionId, request.action, target, abort.signal)
      } finally {
        try {
          if (keyboardInput && cdp.connected) {
            try {
              // Cancellation still has to restore the human tab's real focus state.
              await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: false }, { sessionId: actionSessionId, timeoutMs: 1_000 })
            } catch (error) {
              transport.releaseAttachment() // Detach clears emulation; never destroy the human tab.
              throw error
            }
          }
        } finally {
          this.keyboardFocus = null
          await keyboardFocus?.release(request.controlLeaseId === this.controlLeaseId)
        }
      }
      if (request.action.type === 'navigate' || request.action.type === 'reload' || request.action.type === 'back' || request.action.type === 'forward') {
        await waitForLoad(this.requireCdp(tab), ATTACHED_CDP_SESSION, request.timeoutMs, abort.signal)
        this.refs.invalidateTab(state.publicId)
      }
      if (request.action.type === 'drag') await new Promise((resolve) => setTimeout(resolve, 100))
      if (request.action.type === 'fill' && target && !('from' in target) && !target.secret) {
        const value = await readControlValue(this.requireCdp(tab), target.cdpSessionId, target.objectId, abort.signal)
        if (value.value !== request.action.text) fail('not_actionable', 'Fill did not stick')
      }
      const observation = await this.observe({ tabId: state.publicId })
      const fingerprint = JSON.stringify({
        action: request.action.type,
        target: 'target' in request.action ? request.action.target : 'from' in request.action ? [request.action.from, request.action.to] : undefined
      })
      this.repeatedActionCount = fingerprint === this.lastActionFingerprint ? this.repeatedActionCount + 1 : 1
      this.lastActionFingerprint = fingerprint
      if (this.repeatedActionCount > 3 && !request.expected) fail('no_progress', 'Repeated browser action made no observable progress; refresh or request human takeover')
      if (request.expected && !this.matchWait(observation, request.expected)) {
        const result: BrowserActionResult = {
          requestId: request.requestId, outcome: 'unverified', dispatched: true, observation, artifactIds: [],
          code: 'timeout', message: 'Expected state was not observed'
        }
        await this.journal.append({
          at: nowIso(this.clock), profileId: this.profileId, sessionId: this.id, requestId: request.requestId,
          generation: this.generation, phase: 'outcome', actionType: request.action.type, dispatched: true, outcome: 'unverified'
        })
        return result
      }
      const result: BrowserActionResult = {
        requestId: request.requestId, outcome: 'verified', dispatched: true, observation,
        artifactIds: observation.screenshot ? [observation.screenshot.artifactId] : []
      }
      await this.journal.append({
        at: nowIso(this.clock), profileId: this.profileId, sessionId: this.id, requestId: request.requestId,
        generation: this.generation, phase: 'outcome', actionType: request.action.type, dispatched: true, outcome: 'verified'
      })
      return result
    } catch (caught) {
      const preempted = abort.signal.aborted && abort.signal.reason === PREEMPTED
      // Nothing reached the page: the step may run again once the person is done (`exclusive`), and only then.
      const error = preempted && !dispatched ? new PreemptedBeforeDispatch() : caught
      const outcome = preempted && dispatched ? 'unknown-effect' : this.classifyActError(error, dispatched)
      await this.journal.append({
        at: nowIso(this.clock), profileId: this.profileId, sessionId: this.id, requestId: request.requestId,
        generation: this.generation, phase: 'outcome', actionType: request.action.type, dispatched, outcome
      })
      // The person's input cut in after the agent's had reached the page: never sent again (a second Pay or Submit).
      if (preempted && dispatched) {
        return {
          requestId: request.requestId, outcome: 'unknown-effect', dispatched: true, takeover: 'unknown', artifactIds: [],
          code: 'human_controlled', message: browserTakeoverMessage('unknown', 'The person')
        }
      }
      if (outcome === 'unknown-effect') {
        return {
          requestId: request.requestId,
          outcome,
          dispatched: true,
          artifactIds: [],
          code: 'worker_disconnected',
          message: error instanceof Error ? error.message : String(error)
        }
      }
      throw error
    } finally {
      endNavigation?.()
      signal?.removeEventListener('abort', onAbort)
      fence?.removeEventListener('abort', onFence)
      if (this.inFlight?.requestId === request.requestId) this.inFlight = null
    }
  }

  private rejectUnsupportedAction(action: BrowserAction): void {
    if (action.type === 'upload') fail('unsupported', 'Attached backend does not certify file uploads')
  }

  private addTab(uiTabId: AttachedUiTabId, guest: TrustedGuestRecord): SessionTab {
    const tab: SessionTab = {
      uiTabId,
      guest,
      activity: this.activityFor(uiTabId),
      transport: null,
      stopNav: null,
      attached: false,
      claimed: false,
      gone: new AbortController(),
      state: {
        publicId: 'tab_' + randomUUID(),
        url: sanitizeUrl(guest.guest.getURL()),
        title: guest.guest.getTitle(),
        documentId: 'doc_' + randomUUID(),
        loaderId: '',
        frameId: ''
      }
    }
    this.tabs.set(tab.state.publicId, tab)
    return tab
  }

  /**
   * The session forgets a tab (closed, gone, or no longer the thread's): its debugger leaves the tab, so the next
   * agent to use it can attach, and a step waiting for it stops.
   */
  private forget(tab: SessionTab): void {
    if (this.inFlight?.tab === tab) this.fenceInFlight('cancelled')
    if (tab === this.heldTab) this.endHold()
    tab.stopNav?.()
    tab.stopNav = null
    const transport = tab.transport
    tab.transport = null
    try { transport?.releaseAttachment() } catch { /* already gone */ }
    tab.gone.abort()
    this.tabs.delete(tab.state.publicId)
    this.refs.invalidateTab(tab.state.publicId)
    if (this.current === tab) this.current = this.anchor
  }

  /** Learns the window's tabs this thread may see, and forgets those it no longer may. */
  private refreshTabs(): void {
    if (!this.port || this.closed || this.disconnected) return
    const visible = new Set(this.port.visible(this.threadId, this.ownThreadOnly))
    for (const uiTabId of [...this.closingTabs]) if (!visible.has(uiTabId)) this.closingTabs.delete(uiTabId)
    for (const tab of [...this.tabs.values()]) {
      if (tab !== this.anchor && !visible.has(tab.uiTabId)) this.forget(tab)
    }
    for (const uiTabId of visible) {
      if (this.hasTab(uiTabId) || this.closingTabs.has(uiTabId)) continue
      const guest = this.registry.lookup(uiTabId)
      if (guest && !guest.guest.isDestroyed()) this.addTab(uiTabId, guest)
    }
  }

  private describe(tab: SessionTab): BrowserTab {
    const live = !tab.guest.guest.isDestroyed()
    return {
      id: tab.state.publicId,
      title: live ? tab.guest.guest.getTitle() || tab.state.title : tab.state.title,
      url: live ? sanitizeUrl(tab.guest.guest.getURL()) : tab.state.url,
      active: tab === this.current,
      ...(tab.activity.userActive() ? { userActive: true } : {})
    }
  }

  private claim(tab: SessionTab): void {
    if (tab === this.anchor || !this.port) return
    tab.guest = this.port.claim(tab.uiTabId, this.threadId, this.id, this.ownThreadOnly)
    tab.claimed = true
  }

  /** The tab a call names (the current one when it names none). Reading never moves the session to another tab. */
  private async resolveTab(tabId: unknown): Promise<SessionTab> {
    let tab = this.current
    if (typeof tabId === 'string' && tabId !== this.current.state.publicId) {
      const named = this.tabs.get(tabId)
      if (!named) fail('stale_ref', 'Unknown attached tab')
      if (this.port && named !== this.anchor && !this.port.visible(this.threadId, this.ownThreadOnly).includes(named.uiTabId)) {
        this.forget(named)
        fail('stale_ref', 'This tab is no longer one of the thread\'s tabs')
      }
      this.claim(named)
      tab = named
    }
    await this.assertBinding(tab)
    await this.attach(tab)
    return tab
  }

  /** Attaches the debugger to a tab the session uses, once. */
  private async attach(tab: SessionTab): Promise<void> {
    if (tab.transport?.connected) return
    tab.stopNav?.()
    const transport = new ElectronDebuggerTransport(tab.guest.guest.debugger, {
      interceptCommand: this.interceptCommand,
      beforeKeyboardDispatch: async () => {
        if (!this.keyboardFocus) fail('invalid_action', 'Keyboard input requires an owned focus scope')
        await this.keyboardFocus.focus()
      }
    })
    transport.attach()
    tab.transport = transport
    tab.attached = true
    transport.on('disconnect', () => this.handleDisconnect(tab, transport))
    transport.on('Page.frameNavigated', (params) => this.handleFrameNavigated(tab, params))
    tab.stopNav = tab.guest.guest.onNavigated((url) => {
      tab.state.url = sanitizeUrl(url)
      this.invalidateDocument(tab)
    })
    const cdp = this.requireCdp(tab)
    await Promise.all([
      cdp.send('Page.enable', {}, { sessionId: ATTACHED_CDP_SESSION }),
      cdp.send('DOM.enable', {}, { sessionId: ATTACHED_CDP_SESSION }),
      cdp.send('Runtime.enable', {}, { sessionId: ATTACHED_CDP_SESSION }),
      cdp.send('Accessibility.enable', {}, { sessionId: ATTACHED_CDP_SESSION }),
      cdp.send('Page.setLifecycleEventsEnabled', { enabled: true }, { sessionId: ATTACHED_CDP_SESSION })
    ])
  }

  private async resolveActionTarget(request: BrowserActionRequest, tab: SessionTab): Promise<ActionableTarget | { from: ActionableTarget; to: ActionableTarget } | undefined> {
    const action = request.action
    if (action.type === 'drag') return { from: await this.resolveOneTarget(request, tab, action.from), to: await this.resolveOneTarget(request, tab, action.to) }
    const target = 'target' in action ? action.target : undefined
    if (!target) return undefined
    return this.resolveOneTarget(request, tab, target)
  }

  private async resolveOneTarget(request: BrowserActionRequest, tab: SessionTab, target: BrowserTarget): Promise<ActionableTarget> {
    const state = tab.state
    const cdp = this.requireCdp(tab)
    if (target.kind === 'image-point') {
      const observation = this.observations.get(request.observationId)
      if (!observation || !observation.screenshot || observation.tabId !== state.publicId || observation.generation !== this.generation || observation.documentId !== state.documentId) {
        fail('stale_observation', 'Image point geometry is stale')
      }
      const mapped = imagePointToViewport(target.point, observation.screenshot, observation.viewport)
      const located = await cdp.send<{ backendNodeId?: number }>('DOM.getNodeForLocation', {
        x: mapped.x, y: mapped.y, includeUserAgentShadowDOM: false
      }, { sessionId: ATTACHED_CDP_SESSION, signal: this.inFlight?.abort.signal })
      if (!located.backendNodeId) fail('not_actionable', 'No DOM target exists at the image point')
      const prepared = await prepareActionableTarget(cdp, ATTACHED_CDP_SESSION, {
        backendNodeId: located.backendNodeId, frameRef: 'frame_' + state.frameId, cdpSessionId: ATTACHED_CDP_SESSION, frameId: state.frameId, fingerprint: 'image-point'
      }, this.inFlight?.abort.signal)
      const hit = await cdp.send<{ result?: { value?: { ok?: boolean } } }>('Runtime.callFunctionOn', {
        objectId: prepared.objectId,
        functionDeclaration: 'function(x, y) { const hit = document.elementFromPoint(x, y); return { ok: this === hit || this.contains(hit) }; }',
        arguments: [{ value: mapped.x }, { value: mapped.y }],
        returnByValue: true
      }, { sessionId: ATTACHED_CDP_SESSION, signal: this.inFlight?.abort.signal })
      if (!hit.result?.value?.ok) fail('not_actionable', 'Image point is intercepted by an overlay')
      return { ...prepared, point: mapped }
    }
    if (!this.refs.hasObservation(request.observationId)) fail('stale_observation', 'Observation is not in the reference store')
    const identity: ReferenceIdentity = {
      profileId: this.profileId,
      sessionId: this.id,
      generation: this.generation,
      tabId: state.publicId,
      documentId: state.documentId,
      observationId: request.observationId
    }
    let stored
    try {
      stored = this.refs.resolve({ ...identity, documentId: state.documentId }, target.kind === 'ref' ? target.ref : '')
    } catch (error) {
      if (error instanceof Error && error.message === 'stale_observation') fail('stale_observation', 'Observation is not in the reference store')
      if (error instanceof Error && error.message === 'stale_ref') fail('stale_ref', 'Element reference is stale')
      throw error
    }
    if (stored.identity.documentId !== state.documentId) fail('stale_ref', 'Reference belongs to a previous document')
    return prepareActionableTarget(cdp, stored.cdpSessionId ?? ATTACHED_CDP_SESSION, stored, this.inFlight?.abort.signal)
  }

  /**
   * The agent cursor moves to the resolved target over the tab, and glides there for a moment
   * before the input is sent, so the person watching sees where the agent acts.
   */
  private async glideCursor(request: BrowserActionRequest, tab: SessionTab, target: ActionableTarget | { from: ActionableTarget; to: ActionableTarget } | undefined, signal: AbortSignal): Promise<void> {
    if (!this.onAgentCursor) return
    const point = target ? ('from' in target ? target.from.point : target.point) : undefined
    const viewport = this.observations.get(request.observationId)?.viewport
    if (!viewport) return
    const cursor = agentCursorFor(request.action, point, { width: viewport.cssWidth, height: viewport.cssHeight }, this.clock().getTime(), tab.state.publicId)
    if (!cursor) return
    let shown = false
    try { shown = this.onAgentCursor({ uiTabId: tab.uiTabId, cursor }) } catch { /* a view never fails an action */ }
    if (!shown) return
    try {
      await sleep(AGENT_CURSOR_GLIDE_MS, signal)
    } catch {
      fail('cancelled', 'Action cancelled before dispatch')
    }
    if (target && 'from' in target) {
      const dropped = { ...cursor, x: target.to.point.x, y: target.to.point.y }
      setTimeout(() => { try { this.onAgentCursor?.({ uiTabId: tab.uiTabId, cursor: { ...dropped, at: this.clock().getTime() } }) } catch { /* view only */ } }, 150)
    }
  }

  private matchWait(observation: BrowserObservation, condition: BrowserWaitCondition): boolean {
    switch (condition.type) {
      case 'url':
        if (condition.equals) return observation.url === condition.equals
        return observation.url.includes(condition.includes ?? '')
      case 'text': {
        const haystack = `${observation.title} ${observation.elements.map((element) => `${element.name ?? ''} ${element.text ?? ''}`).join(' ')}`
        return condition.present === haystack.includes(condition.text)
      }
      case 'element': {
        const element = observation.elements.find((entry) => entry.ref === condition.ref)
        if (!element) return condition.state === 'hidden'
        if (condition.state === 'visible') return element.states.includes('visible')
        if (condition.state === 'hidden') return element.states.includes('hidden')
        if (condition.state === 'enabled') return element.states.includes('enabled')
        return element.states.includes('disabled')
      }
      case 'document-ready':
        return true
    }
  }

  private classifyActError(error: unknown, dispatched: boolean): BrowserActionResult['outcome'] {
    if (error instanceof CdpDisconnectedError) return dispatched ? 'unknown-effect' : 'failed'
    if (isBrowserWorkerError(error) && error.code === 'cancelled') return dispatched ? 'unknown-effect' : 'failed'
    if (error && typeof error === 'object' && 'code' in error && (error as { code?: unknown }).code === 'cancelled') return dispatched ? 'unknown-effect' : 'failed'
    if (error && typeof error === 'object' && 'code' in error && (error as { code?: unknown }).code === 'timeout') return dispatched ? 'unknown-effect' : 'failed'
    if (isBrowserWorkerError(error) && error.code === 'human_controlled') return dispatched ? 'unknown-effect' : 'failed'
    return 'failed'
  }

  /** Ends the hold this session placed for the person (`takeControl`), and no other session's. */
  private endHold(): void {
    const held = this.heldTab
    this.heldTab = null
    held?.activity.setHumanHold(false)
  }

  private fenceInFlight(reason: 'cancelled' | 'human_controlled'): void {
    if (!this.inFlight) return
    this.inFlight.abort.abort(reason)
  }

  private handleDisconnect(tab: SessionTab, transport: ElectronDebuggerTransport): void {
    if (this.closed || tab.transport !== transport) return
    if (tab === this.anchor) { this.markDisconnected('debugger'); return }
    // Another tab's debugger went away: the session attaches it again when it next uses that tab.
    if (this.inFlight?.tab === tab) this.fenceInFlight('cancelled')
    tab.stopNav?.()
    tab.stopNav = null
    tab.transport = null
    this.refs.invalidateTab(tab.state.publicId)
  }

  private handleFrameNavigated(tab: SessionTab, params: unknown): void {
    const frame = (params as { frame?: { id?: string; parentId?: string; loaderId?: string; url?: string } })?.frame
    if (!frame || frame.parentId) return
    tab.state.loaderId = frame.loaderId ?? tab.state.loaderId
    tab.state.frameId = frame.id ?? tab.state.frameId
    tab.state.url = sanitizeUrl(frame.url ?? tab.state.url)
    this.invalidateDocument(tab)
  }

  /** A new document in a tab: its refs go, and a step in that tab that did not navigate it is fenced. */
  private invalidateDocument(tab: SessionTab): void {
    const inFlight = this.inFlight?.tab === tab ? this.inFlight : null
    const ownNavigation = inFlight?.dispatched === true &&
      ['navigate', 'reload', 'back', 'forward'].includes(inFlight.actionType)
    if (inFlight && !ownNavigation) this.fenceInFlight('cancelled')
    tab.state.documentId = 'doc_' + randomUUID()
    this.refs.invalidateTab(tab.state.publicId)
    // A page changing in a tab the session is not acting in leaves its current work alone.
    // A new document is a new generation; the control lease stays the same (only a change of control replaces it).
    if (tab === this.current) {
      this.generation += 1
      this.refs = new BrowserReferenceStore({ profileId: this.profileId, sessionId: this.id, generation: this.generation })
      this.observations.clear()
    }
    this.touch()
    this.emitControl(tab)
  }

  private async assertBinding(tab: SessionTab): Promise<void> {
    if (this.closed) fail('session_closed', 'Attached browser session is closed')
    if (this.disconnected || this.lifecycle === 'disconnected') fail('worker_disconnected', 'Attached debugger is disconnected')
    const record = await this.registry.assertDispatchAllowed({
      uiTabId: tab.uiTabId,
      profileId: this.profileId,
      profileEpoch: this.profileEpoch,
      threadId: this.threadId
    })
    tab.guest = record
  }

  private requireCdp(tab: SessionTab): CdpTransport {
    if (!tab.transport || this.closed) fail('session_closed', 'Attached browser session is closed')
    if (this.disconnected || !tab.transport.connected) fail('worker_disconnected', 'Attached debugger is disconnected')
    return tab.transport
  }

  private touch(): void {
    this.updatedAt = nowIso(this.clock)
  }

  /** The window hears each tab the session has used (`all`), or one tab. */
  private emitControl(which: SessionTab | 'all' = this.current): void {
    if (!this.onControlStateChange) return
    const tabs = which === 'all' ? [...this.tabs.values()].filter((tab) => tab.attached || tab === this.current) : [which]
    for (const tab of tabs) this.onControlStateChange(this.controlState(tab))
  }
}
