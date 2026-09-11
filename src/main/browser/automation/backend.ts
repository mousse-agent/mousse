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
import { TrustedGuestRegistry } from './registry'
import { AttachedPageSession } from './session'

export interface AttachedBackendConfig {
  readonly registry: TrustedGuestRegistry
  readonly policy: BrowserPolicyPort
  readonly journal: BrowserJournalPort
  readonly artifacts?: BrowserArtifactPort
  readonly browserVersion?: string
  readonly defaultTimeoutMs?: number
  readonly interceptCommand?: DebuggerTransportOptions['interceptCommand']
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
  private readonly operations = new Map<string, Promise<unknown>>()
  private readonly controlListeners = new Set<(state: AttachedControlState) => void>()
  private accepting = true
  private shutdownWork: Promise<void> | null = null
  private readonly stopRevoke: () => void

  constructor(private readonly config: AttachedBackendConfig) {
    if (!config.policy) throw new Error('ElectronAttachedBrowserBackend requires an injected policy port')
    if (!config.journal) throw new Error('ElectronAttachedBrowserBackend requires an injected journal port')
    if (!config.registry) throw new Error('ElectronAttachedBrowserBackend requires a trusted guest registry')
    this.stopRevoke = config.registry.onRevoked((record) => {
      for (const session of [...this.sessions.values()]) {
        if (session.uiTabId === record.uiTabId) session.markDisconnected('guest')
      }
    })
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
      for (const session of this.sessions.values()) {
        if (session.uiTabId === record.uiTabId) session.markDisconnected('epoch')
      }
    }
  }

  disconnectOwnerNativeId(nativeId: number): void {
    const dropped = this.config.registry.revokeOwnerNativeId(nativeId)
    for (const record of dropped) {
      for (const session of this.sessions.values()) {
        if (session.uiTabId === record.uiTabId) session.markDisconnected('gui')
      }
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
      onControlStateChange: (state) => this.emitControl(state)
    })
    try {
      const record = await session.start(url)
      if (signal?.aborted) {
        await session.close()
        fail('cancelled', 'Attached session open cancelled')
      }
      this.sessions.set(session.id, session)
      const observation = await session.observe({ tabId: session.listTabs()[0]?.id, includeScreenshot: false })
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
