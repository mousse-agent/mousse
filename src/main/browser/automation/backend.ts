import type { BrowserAgentCursor } from '../../../shared/browser/agentCursor'
import { randomUUID } from 'node:crypto'
import { validateBrowserWorkerRequest, validateBrowserWorkerResponse } from '../../../shared/browser/envelope'
import type { BrowserWorkerRequest, BrowserWorkerResponse } from '../../../shared/browser/types'
import {
  ATTACHED_CAPABILITY_DEFAULT,
  type AttachedCapabilityReport,
  type AttachedControlState,
  type AttachedProfileEpoch
} from '../../../shared/browser/attached'
import type { BrowserArtifactPort, BrowserJournalPort, BrowserPolicyPort } from '../../../mms/browser/ports'
import { CdpDisconnectedError } from '../../../browser-worker/cdp/connection'
import { fail, isBrowserWorkerError } from '../../../browser-worker/errors'
import { optionalString, requiredId } from '../../../browser-worker/util'
import { browserNavigationUrl } from '../../../shared/browser/validation'
import type { DebuggerTransportOptions } from './debuggerTransport'
import { TrustedGuestRegistry, type TrustedGuestRecord } from './registry'
import { AttachedPageSession, ConflictBreaker, type AttachedTabsPort } from './session'
import { TabActivity, type ActivityClock } from './tabActivity'

export interface AttachedBackendConfig {
  readonly registry: TrustedGuestRegistry
  readonly policy: BrowserPolicyPort
  readonly journal: BrowserJournalPort
  readonly artifacts?: BrowserArtifactPort
  readonly browserVersion?: string
  readonly defaultTimeoutMs?: number
  readonly interceptCommand?: DebuggerTransportOptions['interceptCommand']
  /** Who is using each tab; without it each tab gets an untracked activity of this backend's (`activityFor`). */
  readonly activityFor?: (uiTabId: string) => TabActivity | undefined
  /** The window's tabs, for `browser_tabs`; without it a session has its one tab. */
  readonly tabs?: AttachedWindowTabs
  readonly activityClock?: ActivityClock
  readonly conflictBackoffMs?: readonly number[]
  readonly sleep?: (ms: number, signal?: AbortSignal) => Promise<void>
}

/** The window's side of `browser_tabs` (`AttachedBrowserHost`). */
export interface AttachedWindowTabs {
  /** The uiTabIds a thread's agent may see: the thread's own tabs and (unless `ownOnly`) those kept in every thread. */
  visible(threadId: string, ownOnly?: boolean): string[]
  /** Binds a visible tab to the thread for automation; refuses another thread's tab (and, with `ownOnly`, a shared one). */
  claim(uiTabId: string, threadId: string, ownOnly?: boolean): void
  open(input: { threadId: string; activate: boolean }, signal?: AbortSignal): Promise<string>
  /** Whether an agent of the thread opened the tab, and it is still the thread's. */
  closable(uiTabId: string, threadId: string): boolean
  /** Whether the person is using a tab of the window other than this one (its page, address bar or picker). */
  personBusyElsewhere(uiTabId: string): boolean
  close(uiTabId: string): void
  reanchor(sessionId: string, uiTabId: string): void
  /** Whether the person is using any tab of the window. */
  anyUserActive(): boolean
}

export interface AttachedCallOptions {
  signal?: AbortSignal
  timeoutMs?: number
}

/**
 * Electron main-process backend for existing in-app BrowserPanel tabs.
 * Root composes the authenticated bridge; this class never accepts native handles from the renderer.
 */
export class ElectronAttachedBrowserBackend {
  private readonly sessions = new Map<string, AttachedPageSession>()
  private readonly openingTabs = new Map<string, Promise<unknown>>()
  private readonly operations = new Map<string, Promise<unknown>>()
  private readonly controlListeners = new Set<(state: AttachedControlState) => void>()
  private readonly cursorListeners = new Set<(event: { uiTabId: string; cursor: BrowserAgentCursor }) => void>()
  private readonly activities = new Map<string, TabActivity>()
  /** The turns that gave way to the person, for every session of the window (a failed open keeps them too). */
  private readonly conflicts = new ConflictBreaker()
  private accepting = true
  private shutdownWork: Promise<void> | null = null
  private readonly stopRevoke: () => void

  constructor(private readonly config: AttachedBackendConfig) {
    if (!config.policy) throw new Error('ElectronAttachedBrowserBackend requires an injected policy port')
    if (!config.journal) throw new Error('ElectronAttachedBrowserBackend requires an injected journal port')
    if (!config.registry) throw new Error('ElectronAttachedBrowserBackend requires a trusted guest registry')
    this.stopRevoke = config.registry.onRevoked((record) => {
      for (const session of [...this.sessions.values()]) session.dropTab(record.uiTabId)
      this.activities.get(record.uiTabId)?.dispose()
      this.activities.delete(record.uiTabId)
    })
  }

  /** Who is using a tab: the window's tracked activity, or one of this backend's own. */
  activityFor(uiTabId: string): TabActivity {
    const tracked = this.config.activityFor?.(uiTabId)
    if (tracked) return tracked
    let activity = this.activities.get(uiTabId)
    if (!activity) {
      activity = new TabActivity(this.config.activityClock)
      this.activities.set(uiTabId, activity)
    }
    return activity
  }

  capabilities(): AttachedCapabilityReport {
    return {
      ...ATTACHED_CAPABILITY_DEFAULT,
      version: this.config.browserVersion,
      capabilities: {
        ...ATTACHED_CAPABILITY_DEFAULT.capabilities,
        screenshots: Boolean(this.config.artifacts)
      },
      message: this.config.artifacts
        ? ATTACHED_CAPABILITY_DEFAULT.message
        : ATTACHED_CAPABILITY_DEFAULT.message + ' Screenshot artifacts are unavailable until an artifact writer is injected.'
    }
  }

  onControlStateChange(listener: (state: AttachedControlState) => void): () => void {
    this.controlListeners.add(listener)
    return () => this.controlListeners.delete(listener)
  }

  beginShutdown(): void {
    this.accepting = false
  }

  getActiveCount(): number {
    return this.operations.size
  }

  async shutdown(options: { timeoutMs?: number } = {}): Promise<void> {
    if (options.timeoutMs !== undefined && (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 1)) {
      throw new Error('Invalid attached browser shutdown timeout')
    }
    this.beginShutdown()
    if (!this.shutdownWork) {
      this.shutdownWork = this.performShutdown()
    }
    if (options.timeoutMs === undefined) {
      await this.shutdownWork
      return
    }
    let timer: ReturnType<typeof setTimeout> | undefined
    const outcome = await Promise.race([
      this.shutdownWork.then(() => 'done' as const),
      new Promise<'timeout'>((resolve) => {
        timer = setTimeout(() => resolve('timeout'), options.timeoutMs)
      })
    ])
    if (timer) clearTimeout(timer)
    if (outcome === 'timeout') {
      throw Object.assign(
        new Error('Attached browser shutdown timed out; in-flight commands remain owned'),
        { code: 'timeout' }
      )
    }
  }

  revokeProfileEpoch(profileId: string, profileEpoch: AttachedProfileEpoch): void {
    const dropped = this.config.registry.revokeProfileEpoch(profileId, profileEpoch)
    for (const record of dropped) {
      for (const session of this.sessions.values()) session.dropTab(record.uiTabId)
    }
  }

  /**
   * The window moved a tab to another thread (`threadId`), or kept it in every thread (`null`). The sessions of other
   * threads lose it as when it closes (a session whose first tab it was ends), and their handover hold on it ends with
   * them (`dropTab`). A hold of the new owner thread's own agent stays.
   */
  tabOwnerChanged(uiTabId: string, threadId: string | null): void {
    if (threadId === null) return
    for (const session of this.sessions.values()) {
      if (session.threadId !== threadId) session.dropTab(uiTabId)
    }
  }

  disconnectOwnerNativeId(nativeId: number): void {
    const dropped = this.config.registry.revokeOwnerNativeId(nativeId)
    for (const record of dropped) {
      for (const session of this.sessions.values()) session.dropTab(record.uiTabId)
    }
  }

  async call(request: BrowserWorkerRequest, options: AttachedCallOptions = {}): Promise<BrowserWorkerResponse> {
    let validated: BrowserWorkerRequest
    try {
      validated = validateBrowserWorkerRequest(request)
    } catch (error) {
      return {
        version: 1,
        id: typeof request?.id === 'string' ? request.id : 'invalid',
        ok: false,
        error: { code: 'invalid_action', message: error instanceof Error ? error.message : String(error) }
      }
    }
    if (!this.accepting && validated.method !== 'session.close') {
      return {
        version: 1,
        id: validated.id,
        ok: false,
        error: { code: 'session_closed', message: 'Attached browser backend is shutting down' }
      }
    }
    const opId = validated.id + ':' + randomUUID()
    const controller = new AbortController()
    const onOuterAbort = () => controller.abort(options.signal?.reason)
    if (options.signal) {
      if (options.signal.aborted) {
        return { version: 1, id: validated.id, ok: false, error: { code: 'cancelled', message: 'Request cancelled' } }
      }
      options.signal.addEventListener('abort', onOuterAbort, { once: true })
    }
    const timeoutMs = options.timeoutMs ?? this.config.defaultTimeoutMs
    let timer: ReturnType<typeof setTimeout> | undefined
    if (timeoutMs !== undefined) {
      timer = setTimeout(() => controller.abort(Object.assign(new Error('timeout'), { code: 'timeout' })), timeoutMs)
    }
    const work = this.dispatch(validated, controller.signal)
    this.operations.set(opId, work)
    try {
      const response = await work
      return validateBrowserWorkerResponse(response)
    } finally {
      this.operations.delete(opId)
      if (timer) clearTimeout(timer)
      options.signal?.removeEventListener('abort', onOuterAbort)
    }
  }

  private async dispatch(request: BrowserWorkerRequest, signal: AbortSignal): Promise<BrowserWorkerResponse> {
    try {
      const decision = await this.config.policy.authorize({
        profileId: request.profileId,
        method: request.method,
        sessionId: typeof request.params.sessionId === 'string' ? request.params.sessionId : undefined,
        url: typeof request.params.url === 'string' ? request.params.url : undefined,
        action: request.method === 'act' || request.method === 'human.act' ? (request.params.action as never) : undefined
      })
      if (!decision.allowed) {
        return {
          version: 1,
          id: request.id,
          ok: false,
          error: { code: decision.code ?? 'policy_denied', message: decision.message ?? 'Policy denied this attached browser request' }
        }
      }
      const result = request.method === 'session.open'
        ? await this.open(request, signal)
        : await this.handleExisting(request, signal)
      return { version: 1, id: request.id, ok: true, result }
    } catch (error) {
      return {
        version: 1,
        id: request.id,
        ok: false,
        error: {
          code: isBrowserWorkerError(error)
            ? error.code
            : error instanceof CdpDisconnectedError
              ? 'worker_disconnected'
              : (error && typeof error === 'object' && 'code' in error && (error as { code?: unknown }).code === 'timeout')
                ? 'timeout'
                : (error && typeof error === 'object' && 'code' in error && (error as { code?: unknown }).code === 'cancelled')
                  ? 'cancelled'
                  : 'invalid_action',
          message: error instanceof Error ? error.message : String(error)
        }
      }
    }
  }

  private async open(request: BrowserWorkerRequest, signal?: AbortSignal): Promise<unknown> {
    const key = requiredId(request.params.uiTabId)
    const previous = this.openingTabs.get(key)
    const operation = (async () => {
      if (previous) await previous.catch(() => undefined)
      if (signal?.aborted) fail('cancelled', 'Attached session open cancelled')
      return this.openTab(request, signal)
    })()
    this.openingTabs.set(key, operation)
    try { return await operation }
    finally { if (this.openingTabs.get(key) === operation) this.openingTabs.delete(key) }
  }

  private async openTab(request: BrowserWorkerRequest, signal?: AbortSignal): Promise<unknown> {
    const uiTabId = requiredId(request.params.uiTabId)
    const threadId = optionalString(request.params.threadId, 160)
    const runId = optionalString(request.params.runId, 160)
    const profileEpoch = optionalString(request.params.profileEpoch, 160)
    let url: string | undefined
    if (request.params.url !== undefined) url = browserNavigationUrl(request.params.url)
    const guest = await this.config.registry.assertDispatchAllowed({
      uiTabId,
      profileId: request.profileId,
      ...(profileEpoch ? { profileEpoch } : {}),
      ...(threadId ? { threadId } : {})
    })
    if (guest.thread.kind !== 'thread') fail('policy_denied', 'Unbound or pinned tab requires trusted thread assignment')
    const boundThread = guest.thread.threadId
    const turn = optionalString(request.params.turn, 400)
    // A run without a person's tree grant uses its thread's own tabs only, for as long as its session lives.
    const ownTabsOnly = request.params.ownTabsOnly === true
    // A tab is driven by one session: the one that drives it (its first tab, or one it claimed) opens again. A session
    // that only listed the tab does not hold it.
    const existing = [...this.sessions.values()].find((candidate) => candidate.drives(uiTabId) && candidate.controlState().owner !== 'disconnected')
      ?? [...this.sessions.values()].find((candidate) => candidate.uiTabId === uiTabId)
    if (existing) {
      const record = existing.record()
      if (existing.controlState().owner === 'disconnected') {
        // A session that ended (its tab went to another thread, or its debugger left) gives the tab up.
        await existing.close()
        this.sessions.delete(existing.id)
      } else if (record.profileId !== request.profileId || record.threadId !== boundThread || record.runId !== runId) {
        fail('human_controlled', 'This browser tab is in use by another agent execution')
      } else {
        const session = await existing.reopen(url, uiTabId, { signal, turn })
        const observation = await existing.observe({ includeScreenshot: false })
        return { session, observation, capabilities: this.capabilities() }
      }
    }
    const session = new AttachedPageSession(this.config.registry, guest, {
      profileId: request.profileId,
      profileEpoch: guest.profileEpoch,
      uiTabId,
      threadId: boundThread,
      runId,
      journal: this.config.journal,
      artifacts: this.config.artifacts,
      browserVersion: this.config.browserVersion,
      interceptCommand: this.config.interceptCommand,
      onControlStateChange: (state) => this.emitControl(state),
      onAgentCursor: (event) => this.emitCursor(event),
      activityFor: (id) => this.activityFor(id),
      ...(this.config.tabs ? { tabs: this.sessionTabs(this.config.tabs) } : {}),
      ownThreadOnly: ownTabsOnly,
      conflicts: this.conflicts,
      ...(this.config.conflictBackoffMs ? { conflictBackoffMs: this.config.conflictBackoffMs } : {}),
      ...(this.config.sleep ? { sleep: this.config.sleep } : {})
    })
    try {
      const record = await session.start(url, { signal, turn })
      if (signal?.aborted) {
        await session.close()
        fail('cancelled', 'Attached session open cancelled')
      }
      this.sessions.set(session.id, session)
      const observation = await session.observe({ includeScreenshot: false })
      return { session: record, observation, capabilities: this.capabilities() }
    } catch (error) {
      await session.close().catch(() => undefined)
      throw error
    }
  }

  private async handleExisting(request: BrowserWorkerRequest, signal?: AbortSignal): Promise<unknown> {
    const sessionId = requiredId(request.params.sessionId)
    const session = this.sessions.get(sessionId)
    if (!session) fail('session_closed', 'Unknown attached browser session')
    if (session.profileId !== request.profileId) fail('profile_mismatch', 'Session is bound to a different profile')
    const result = await session.handle(request.method, request.params, signal)
    if (request.method === 'session.close') this.sessions.delete(sessionId)
    return result ?? { ok: true }
  }

  /** A session's view of the window's tabs: one driver per tab, and the trusted guest of each tab it claims. */
  private sessionTabs(window: AttachedWindowTabs): AttachedTabsPort {
    return {
      visible: (threadId, ownOnly) => window.visible(threadId, ownOnly).filter((uiTabId) => this.config.registry.lookup(uiTabId)),
      claim: (uiTabId, threadId, sessionId, ownOnly): TrustedGuestRecord => {
        if (this.drivenByOther(uiTabId, sessionId)) fail('invalid_action', 'Another agent is using this tab')
        if (!window.visible(threadId, ownOnly).includes(uiTabId)) fail('policy_denied', ownOnly ? 'This run uses only its thread\'s own tabs' : 'This tab belongs to another thread')
        window.claim(uiTabId, threadId, ownOnly)
        const guest = this.config.registry.lookup(uiTabId)
        if (!guest) fail('session_closed', 'In-app tab is not registered for attached automation')
        return guest
      },
      drivenByOther: (uiTabId, sessionId) => this.drivenByOther(uiTabId, sessionId),
      open: (input, signal) => window.open(input, signal),
      closable: (uiTabId, threadId) => window.closable(uiTabId, threadId),
      personBusyElsewhere: (uiTabId) => window.personBusyElsewhere(uiTabId),
      close: (uiTabId) => window.close(uiTabId),
      reanchor: (sessionId, uiTabId) => window.reanchor(sessionId, uiTabId),
      anyUserActive: () => window.anyUserActive()
    }
  }

  /** Whether a live session drives a tab: its first tab, one it claimed, or one a step of it runs in. */
  drivenByAny(uiTabId: string): boolean {
    return this.drivenByOther(uiTabId, '')
  }

  /** Whether a live session other than `sessionId` drives a tab: listing it is not driving it. */
  private drivenByOther(uiTabId: string, sessionId: string): boolean {
    return [...this.sessions.values()].some((session) => session.id !== sessionId && session.drives(uiTabId) && session.controlState().owner !== 'disconnected')
  }

  /** Where an agent acts in an attached tab, for the window that shows it (`agentCursor.ts`). */
  onAgentCursor(listener: (event: { uiTabId: string; cursor: BrowserAgentCursor }) => void): () => void {
    this.cursorListeners.add(listener)
    return () => this.cursorListeners.delete(listener)
  }

  /** True when a window was told: the cursor then glides before the input is sent. */
  private emitCursor(event: { uiTabId: string; cursor: BrowserAgentCursor }): boolean {
    for (const listener of this.cursorListeners) {
      try { listener(event) } catch { /* listener isolation */ }
    }
    return this.cursorListeners.size > 0
  }

  private emitControl(state: AttachedControlState): void {
    for (const listener of this.controlListeners) {
      try { listener(state) } catch { /* listener isolation */ }
    }
  }

  private async performShutdown(): Promise<void> {
    while (this.operations.size > 0) {
      await Promise.allSettled([...this.operations.values()])
    }
    const sessions = [...this.sessions.values()]
    this.sessions.clear()
    await Promise.all(sessions.map((session) => session.close().catch(() => undefined)))
    this.stopRevoke()
  }
}
