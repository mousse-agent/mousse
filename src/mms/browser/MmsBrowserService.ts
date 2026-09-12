import { createHash, timingSafeEqual } from 'node:crypto'
import type { ExecutionContext } from '../../shared/execution/types'
import type { BrowserAccessState } from '../../shared/browser/access'
import { BrowserAccessController } from './BrowserAccessController'
import type { BrowserAutomationTool, BrowserToolContext, BrowserToolResult } from '../../shared/browser/automation'
import {
  MAX_BROWSER_ATTACHMENTS_PER_CONNECTION,
  MAX_BROWSER_ATTACHMENTS_PER_PROFILE,
  type BrowserAttachmentRegisterResult,
  type BrowserSelectedTarget,
  type BrowserSessionPublicRecord
} from '../../shared/browser/host'
import type { BrowserSessionRecord } from '../../shared/browser/types'
import { BrowserBroker } from './BrowserBroker'
import { BrowserBackendRouter, type BrowserBackendPort } from './BrowserBackendRouter'
import { BrowserArtifactService } from './BrowserArtifactService'
import { createAllowHttpPolicy } from './defaultPorts'
import { BrowserAutomationError, BrowserSessionManager } from './automation/BrowserSessionManager'
import { BrowserToolDispatcher } from './automation/BrowserToolDispatcher'
import { ManagedBrowserWorkflowAdapter } from './automation/BrowserWorkflowAdapter'
import {
  AttachedBrowserConnectionBackend,
  type AttachedCommandDispatchPort
} from './AttachedBrowserConnectionBackend'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const IDENTIFIER = /^[a-zA-Z0-9:_-]{1,160}$/
const CLOSURE_TOKEN = /^[A-Za-z0-9_-]{43}$/

export interface BrowserAttachmentOwner {
  readonly connectionId: string
  readonly profileId: string
  readonly profileEpoch: number
}

interface LiveAttachment {
  registrationId: string
  registrationEpoch: number
  uiTabId: string
  connectionId: string
  profileId: string
  profileEpoch: number
  threadId?: string
  selectedThreadId?: string
}

interface PendingGuestClosure {
  registrationEpoch: number
  connectionId: string
  profileId: string
  profileEpoch: number
  tokenHash: Buffer
  disconnected: boolean
}

export interface MmsBrowserServiceOptions {
  profileId: string
  profileRoot: string
  workerArtifactRoot: string
  artifacts: BrowserArtifactService
  installationBrowserRoot: string
  workerModulePath?: string
  threadExists: (threadId: string) => boolean
  commandRouter?: AttachedCommandDispatchPort
  createManagedBackend?: () => BrowserBackendPort
  admitManagedLaunch?: () => Promise<{ release(): void }>
}

function requireUuid(value: string, label: string): string {
  if (!UUID.test(value)) throw new BrowserAutomationError({ code: 'invalid_action', message: `Invalid ${label}` })
  return value
}

function requireIdentifier(value: string, label: string): string {
  if (!IDENTIFIER.test(value)) throw new BrowserAutomationError({ code: 'invalid_action', message: `Invalid ${label}` })
  return value
}

function requireEpoch(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new BrowserAutomationError({ code: 'invalid_action', message: `Invalid ${label}` })
  return value
}

function publicSession(record: BrowserSessionRecord): BrowserSessionPublicRecord {
  return {
    id: record.id,
    profileId: record.profileId,
    ...(record.threadId === undefined ? {} : { threadId: record.threadId }),
    ...(record.runId === undefined ? {} : { runId: record.runId }),
    ...(record.workspaceId === undefined ? {} : { workspaceId: record.workspaceId }),
    persistent: record.persistent,
    backend: record.backend,
    browserVersion: record.browserVersion,
    generation: record.generation,
    lifecycle: record.lifecycle,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt
  }
}

/** Profile-owned browser composition: attached GUI targets, managed broker, sessions, tools. */
export class MmsBrowserService {
  readonly access = new BrowserAccessController()
  readonly sessions: BrowserSessionManager
  readonly tools: BrowserToolDispatcher
  readonly workflow: ManagedBrowserWorkflowAdapter
  readonly artifacts: BrowserArtifactService
  readonly workerArtifactRoot: string
  readonly attached: AttachedBrowserConnectionBackend
  readonly router: BrowserBackendRouter
  private readonly live = new Map<string, LiveAttachment>()
  private readonly byUiTab = new Map<string, string>()
  private readonly byConnection = new Map<string, Set<string>>()
  private readonly selectedByThread = new Map<string, string>()
  private readonly unproven = new Map<string, PendingGuestClosure>()
  private readonly managed: LazyManagedBrowserBackend
  private disposed = false
  private readonly guiDispatches = new Set<Promise<BrowserToolResult>>()
  private accessRevocation?: Promise<void>

  constructor(private readonly options: MmsBrowserServiceOptions) {
    this.artifacts = options.artifacts
    this.workerArtifactRoot = options.workerArtifactRoot
    this.attached = new AttachedBrowserConnectionBackend({
      profileId: options.profileId,
      commandRouter: options.commandRouter,
      getRegistrationByUiTabId: (uiTabId) => this.liveByUiTab(uiTabId),
      getRegistration: (registrationId) => this.live.get(registrationId)
    })
    this.managed = new LazyManagedBrowserBackend(options.createManagedBackend ?? (() => this.createManagedBroker()), options.admitManagedLaunch)
    this.router = new BrowserBackendRouter({
      profileId: options.profileId,
      managed: this.managed,
      attached: this.attached
    })
    this.sessions = new BrowserSessionManager({
      profileId: options.profileId,
      profileRoot: options.profileRoot,
      broker: this.router,
      decorateObservation: (context, observation) => this.artifacts.decorateObservation(context, observation)
    })
    this.tools = new BrowserToolDispatcher({ sessions: this.sessions,
      requestHuman: ({ context, request }) => this.sessions.requestHuman(context, request) })
    // Workflow calls must pass through the same trusted target resolver as
    // native/GUI tool calls; direct dispatcher use could silently choose managed.
    this.workflow = new ManagedBrowserWorkflowAdapter({
      invoke: (name, args, context) => this.dispatch(context, name, args)
    } as BrowserToolDispatcher)
  }

  get managedBrokerStarted(): boolean { return this.managed.started }
  get managedDispatchAttempted(): boolean { return this.managed.attempted }
  getManagedActiveCount(): number { return this.managed.getActiveCount() }

  setCommandRouter(router: AttachedCommandDispatchPort | undefined): void {
    this.attached.setCommandRouter(router)
  }

  beginShutdown(): void {
    this.disposed = true
    this.access.dispose()
    this.router.beginShutdown()
    this.attached.beginShutdown()
  }

  getActiveCount(): number {
    return this.router.getActiveCount() + this.attached.getActiveCount() + this.unproven.size
  }

  async dispose(): Promise<void> {
    this.beginShutdown()
    await this.sessions.closeAll()
    const results = await Promise.allSettled([
      this.router.shutdown(),
      this.attached.shutdown(),
      this.managed.close()
    ])
    const errors = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected').map((result) => result.reason)
    if (this.unproven.size) {
      errors.push(Object.assign(new Error('Attached browser guests were not acknowledged closed'), {
        code: 'profile_busy',
        details: { unprovenRegistrations: this.unproven.size }
      }))
    }
    if (errors.length) throw new AggregateError(errors, 'Failed to dispose profile browser services')
  }

  /** Native/workflow tool hook. Context and policy are trusted host inputs. */
  async dispatch(context: BrowserToolContext, name: BrowserAutomationTool, args: unknown): Promise<BrowserToolResult> {
    this.assertActive()
    try {
      await this.requestAccess(context.execution, context.signal)
      const target = this.resolveTarget(context)
      const signal = context.execution.source === 'gui'
        ? AbortSignal.any([this.access.signal, ...(context.signal ? [context.signal] : [])])
        : context.signal
      const operation = this.tools.invoke(name, args, { ...context, target, signal })
      if (context.execution.source === 'gui') this.guiDispatches.add(operation)
      try { return await operation }
      finally { this.guiDispatches.delete(operation) }
    } catch (error) {
      if (error instanceof BrowserAutomationError) {
        return { ok: false, error: { code: error.code, message: error.message, ...(error.details ? { details: error.details } : {}) } }
      }
      throw error
    }
  }

  requestAccess(context: ExecutionContext, signal?: AbortSignal): Promise<'allowed' | 'already-allowed'> {
    this.assertActive()
    if (context.profileId !== this.options.profileId) throw new BrowserAutomationError({ code: 'profile_mismatch', message: 'Browser context belongs to another profile' })
    if (context.source !== 'gui') return Promise.resolve('already-allowed')
    return this.access.request(context.threadId, signal)
  }

  async setAccess(allowed: boolean, requestId?: string): Promise<BrowserAccessState> {
    // A second window cannot regrant access while old leases are still draining.
    if (this.accessRevocation) await this.accessRevocation
    this.assertActive()
    const wasAllowed = this.access.status().allowed
    const state = requestId === undefined ? this.access.set(allowed) : this.access.respond(requestId, allowed)
    if (!allowed && wasAllowed) {
      const revocation = (async () => {
        await Promise.allSettled([...this.guiDispatches])
        await this.sessions.closeAll('electron-attached')
        this.releaseUnusedSelections()
      })()
      this.accessRevocation = revocation
      try { await revocation }
      finally { if (this.accessRevocation === revocation) this.accessRevocation = undefined }
    }
    return state
  }

  releaseUnusedSelections(): void {
    for (const [threadId, uiTabId] of this.selectedByThread) {
      const active = this.sessions.listThreadSessions({ profileId: this.options.profileId, threadId })
        .some((session) => this.attached.bindingForSession(session.id)?.uiTabId === uiTabId && session.lifecycle !== 'disconnected')
      if (!active) {
        this.selectedByThread.delete(threadId)
        const live = this.liveByUiTab(uiTabId)
        if (live) { live.selectedThreadId = undefined; live.threadId = undefined }
      }
    }
  }

  resolveTarget(context: BrowserToolContext): NonNullable<BrowserToolContext['target']> {
    this.assertActive()
    if (context.execution.profileId !== this.options.profileId) {
      throw new BrowserAutomationError({ code: 'profile_mismatch', message: 'Browser context belongs to another profile' })
    }
    if (context.target) {
      if (context.execution.source === 'gui' && context.target.backend === 'electron-attached') {
        const selected = this.selectedTarget(context.execution.threadId)
        if (!selected || selected.uiTabId !== context.target.uiTabId) {
          throw new BrowserAutomationError({ code: 'setup_required', message: 'Host attached target does not match the selected in-app tab' })
        }
      }
      return context.target
    }
    if (context.execution.source === 'gui') {
      const selected = this.selectedTarget(context.execution.threadId)
      if (!selected) throw new BrowserAutomationError({ code: 'setup_required', message: 'Select an in-app browser tab or an explicit managed session before running browser tools' })
      return selected
    }
    return { backend: 'managed-chromium' }
  }

  selectedTarget(threadId: string): BrowserSelectedTarget | undefined {
    let uiTabId = this.selectedByThread.get(threadId)
    if (!uiTabId && this.access.status().allowed) {
      const available = [...this.live.values()].find((tab) => !tab.selectedThreadId || tab.selectedThreadId === threadId)
      if (available) {
        available.selectedThreadId = threadId
        this.selectedByThread.set(threadId, available.uiTabId)
        uiTabId = available.uiTabId
      }
    }
    if (!uiTabId) return undefined
    const live = this.liveByUiTab(uiTabId)
    if (!live || live.selectedThreadId !== threadId) {
      this.selectedByThread.delete(threadId)
      return undefined
    }
    return { backend: 'electron-attached', uiTabId }
  }

  listPublicSessions(threadId: string): BrowserSessionPublicRecord[] {
    this.assertActive()
    requireIdentifier(threadId, 'threadId')
    if (!this.options.threadExists(threadId)) throw new BrowserAutomationError({ code: 'invalid_action', message: 'Thread does not belong to this profile' })
    return this.sessions.listThreadSessions({ profileId: this.options.profileId, threadId }).map(publicSession)
  }

  registerAttachment(params: {
    registrationId: string
    registrationEpoch: number
    closureToken: string
    uiTabId: string
    threadId?: string
  }, owner: BrowserAttachmentOwner): BrowserAttachmentRegisterResult {
    this.assertActive()
    if (owner.profileId !== this.options.profileId) throw new BrowserAutomationError({ code: 'profile_mismatch', message: 'Attachment profile does not match the bound profile' })
    const registrationId = requireUuid(params.registrationId, 'registrationId')
    const registrationEpoch = requireEpoch(params.registrationEpoch, 'registrationEpoch')
    if (!CLOSURE_TOKEN.test(params.closureToken)) throw new BrowserAutomationError({ code: 'invalid_action', message: 'Invalid closureToken' })
    const uiTabId = requireIdentifier(params.uiTabId, 'uiTabId')
    const threadId = params.threadId === undefined ? undefined : requireIdentifier(params.threadId, 'threadId')
    if (threadId !== undefined && !this.options.threadExists(threadId)) throw new BrowserAutomationError({ code: 'invalid_action', message: 'Thread does not belong to this profile' })
    const existingTab = this.liveByUiTab(uiTabId)
    if (existingTab && existingTab.connectionId !== owner.connectionId) {
      throw new BrowserAutomationError({ code: 'policy_denied', message: 'This in-app tab is registered to another GUI connection' })
    }
    const existingId = this.live.get(registrationId)
    if (existingId && existingId.connectionId !== owner.connectionId) {
      throw new BrowserAutomationError({ code: 'policy_denied', message: 'This browser registration belongs to another GUI connection' })
    }
    const existingPending = this.unproven.get(registrationId)
    if (existingPending) {
      const exactReplay = existingId
        && existingId.registrationEpoch === registrationEpoch
        && existingId.uiTabId === uiTabId
        && existingId.threadId === threadId
        && existingId.connectionId === owner.connectionId
        && existingId.profileEpoch === owner.profileEpoch
        && safeTokenEqual(existingPending.tokenHash, params.closureToken)
      if (!exactReplay) {
        throw new BrowserAutomationError({ code: 'policy_denied', message: 'This browser registration identity is already awaiting closure proof' })
      }
      return {
        uiTabId,
        registrationId,
        registrationEpoch,
        profileId: owner.profileId,
        profileEpoch: owner.profileEpoch,
        closureToken: params.closureToken,
        artifactRoot: this.workerArtifactRoot
      }
    }
    const connectionIds = this.byConnection.get(owner.connectionId) ?? new Set<string>()
    const replacing = existingTab?.registrationId ?? existingId?.registrationId
    if (!replacing && connectionIds.size >= MAX_BROWSER_ATTACHMENTS_PER_CONNECTION) {
      throw new BrowserAutomationError({ code: 'invalid_action', message: 'Too many attached browser tabs on this window' })
    }
    if (!replacing && this.unproven.size >= MAX_BROWSER_ATTACHMENTS_PER_PROFILE) {
      throw new BrowserAutomationError({ code: 'invalid_action', message: 'Too many attached browser tabs on this profile' })
    }
    if (existingTab) this.replaceLive(existingTab)
    if (existingId && existingId.registrationId !== existingTab?.registrationId) this.replaceLive(existingId)
    const record: LiveAttachment = {
      registrationId,
      registrationEpoch,
      uiTabId,
      connectionId: owner.connectionId,
      profileId: owner.profileId,
      profileEpoch: owner.profileEpoch,
      ...(threadId === undefined ? {} : { threadId })
    }
    this.live.set(registrationId, record)
    this.byUiTab.set(uiTabId, registrationId)
    const owned = this.byConnection.get(owner.connectionId) ?? new Set<string>()
    owned.add(registrationId)
    this.byConnection.set(owner.connectionId, owned)
    this.unproven.set(registrationId, {
      registrationEpoch,
      connectionId: owner.connectionId,
      profileId: owner.profileId,
      profileEpoch: owner.profileEpoch,
      tokenHash: tokenHash(params.closureToken),
      disconnected: false
    })
    return {
      uiTabId,
      registrationId,
      registrationEpoch,
      profileId: owner.profileId,
      profileEpoch: owner.profileEpoch,
      closureToken: params.closureToken,
      artifactRoot: this.workerArtifactRoot
    }
  }

  unregisterAttachment(params: { registrationId: string; registrationEpoch: number }, owner: BrowserAttachmentOwner): { unregistered: true } {
    this.assertActive()
    const registrationId = requireUuid(params.registrationId, 'registrationId')
    const registrationEpoch = requireEpoch(params.registrationEpoch, 'registrationEpoch')
    const live = this.live.get(registrationId)
    if (live) {
      if (live.connectionId !== owner.connectionId || live.profileId !== owner.profileId || live.profileEpoch !== owner.profileEpoch) {
        throw new BrowserAutomationError({ code: 'policy_denied', message: 'Only the owning GUI connection can unregister this tab' })
      }
      if (live.registrationEpoch !== registrationEpoch) throw new BrowserAutomationError({ code: 'invalid_action', message: 'Attached registration epoch does not match' })
      this.revokeLive(live)
    } else {
      const pending = this.unproven.get(registrationId)
      if (!pending || pending.registrationEpoch !== registrationEpoch) {
        throw new BrowserAutomationError({ code: 'session_closed', message: 'Attached browser registration is not current' })
      }
      if (pending.connectionId !== owner.connectionId || pending.profileId !== owner.profileId || pending.profileEpoch !== owner.profileEpoch) {
        throw new BrowserAutomationError({ code: 'policy_denied', message: 'Only the owning GUI connection can unregister this tab' })
      }
    }
    this.unproven.delete(registrationId)
    return { unregistered: true }
  }

  selectAttachment(params: { uiTabId: string; threadId: string }, owner: BrowserAttachmentOwner): BrowserSelectedTarget {
    this.assertActive()
    const uiTabId = requireIdentifier(params.uiTabId, 'uiTabId')
    const threadId = requireIdentifier(params.threadId, 'threadId')
    if (!this.options.threadExists(threadId)) throw new BrowserAutomationError({ code: 'invalid_action', message: 'Thread does not belong to this profile' })
    const live = this.liveByUiTab(uiTabId)
    if (!live) throw new BrowserAutomationError({ code: 'setup_required', message: 'The selected in-app browser is not connected' })
    if (live.connectionId !== owner.connectionId || live.profileId !== owner.profileId || live.profileEpoch !== owner.profileEpoch) {
      throw new BrowserAutomationError({ code: 'policy_denied', message: 'This in-app tab is registered to another GUI connection' })
    }
    if (live.selectedThreadId !== undefined && live.selectedThreadId !== threadId) {
      throw new BrowserAutomationError({ code: 'invalid_action', message: 'This in-app tab is already bound to another thread' })
    }
    if (live.threadId !== undefined && live.threadId !== threadId) {
      throw new BrowserAutomationError({ code: 'invalid_action', message: 'This in-app tab is already bound to another thread' })
    }
    const current = this.selectedByThread.get(threadId)
    if (current && current !== uiTabId) this.selectedByThread.delete(threadId)
    const selected: LiveAttachment = { ...live, selectedThreadId: threadId }
    this.live.set(selected.registrationId, selected)
    this.selectedByThread.set(threadId, uiTabId)
    return { backend: 'electron-attached', uiTabId }
  }

  /** Connection close/rebind: revoke dispatch and selection. Guest-close proof stays with unregister/ack. */
  revokeConnection(connectionId: string): void {
    const owned = [...(this.byConnection.get(connectionId) ?? [])]
    for (const registrationId of owned) {
      const live = this.live.get(registrationId)
      if (live) this.revokeLive(live)
    }
    for (const pending of this.unproven.values()) {
      if (pending.connectionId === connectionId) pending.disconnected = true
    }
    this.attached.forgetConnection(connectionId)
    if (this.live.size === 0) this.access.dispose()
  }

  pendingAttachedGuestAcks(): ReadonlyArray<{ registrationId: string; registrationEpoch: number }> {
    return [...this.unproven.entries()].map(([registrationId, pending]) => ({ registrationId, registrationEpoch: pending.registrationEpoch }))
  }

  /**
   * Trusted host acknowledgement that Electron main actually closed the guest.
   * Empty transport counts are not this proof.
   */
  acknowledgeAttachedGuestClosed(
    input: { registrationId: string; registrationEpoch: number; closureToken: string },
    owner: BrowserAttachmentOwner
  ): { ok: true } {
    const registrationId = requireUuid(input.registrationId, 'registrationId')
    const registrationEpoch = requireEpoch(input.registrationEpoch, 'registrationEpoch')
    if (owner.profileId !== this.options.profileId) {
      throw new BrowserAutomationError({ code: 'profile_mismatch', message: 'Attachment profile does not match the bound profile' })
    }
    const pending = this.unproven.get(registrationId)
    if (!pending || pending.registrationEpoch !== registrationEpoch) {
      throw new BrowserAutomationError({ code: 'session_closed', message: 'Attached browser registration is not current' })
    }
    if (!pending.disconnected || (pending.connectionId === owner.connectionId && pending.profileEpoch === owner.profileEpoch)) {
      throw new BrowserAutomationError({ code: 'policy_denied', message: 'The original browser connection must be disconnected before closure acknowledgement' })
    }
    if (pending.profileId !== owner.profileId || !safeTokenEqual(pending.tokenHash, input.closureToken)) {
      throw new BrowserAutomationError({ code: 'policy_denied', message: 'Invalid attached browser closure proof' })
    }
    const live = this.live.get(registrationId)
    if (live) this.revokeLive(live)
    this.unproven.delete(registrationId)
    return { ok: true }
  }

  attachmentOwnerForSession(sessionId: string): { connectionId: string; uiTabId: string } | undefined {
    const binding = this.attached.bindingForSession(sessionId)
    if (!binding) return undefined
    const live = this.live.get(binding.registrationId)
    if (!live || live.registrationEpoch !== binding.registrationEpoch || live.connectionId !== binding.connectionId) return undefined
    return { connectionId: live.connectionId, uiTabId: live.uiTabId }
  }

  private liveByUiTab(uiTabId: string): LiveAttachment | undefined {
    const id = this.byUiTab.get(uiTabId)
    return id ? this.live.get(id) : undefined
  }

  private replaceLive(existing: LiveAttachment): void {
    this.revokeLive(existing)
  }

  private revokeLive(existing: LiveAttachment): void {
    this.live.delete(existing.registrationId)
    if (this.byUiTab.get(existing.uiTabId) === existing.registrationId) this.byUiTab.delete(existing.uiTabId)
    const owned = this.byConnection.get(existing.connectionId)
    if (owned) {
      owned.delete(existing.registrationId)
      if (!owned.size) this.byConnection.delete(existing.connectionId)
    }
    if (existing.selectedThreadId && this.selectedByThread.get(existing.selectedThreadId) === existing.uiTabId) {
      this.selectedByThread.delete(existing.selectedThreadId)
    }
    this.attached.forgetRegistration(existing.registrationId)
  }

  private createManagedBroker(): BrowserBroker {
    return new BrowserBroker({
      profileRoot: this.options.profileRoot,
      browserRoot: this.options.installationBrowserRoot,
      artifactRoot: this.options.workerArtifactRoot,
      policy: createAllowHttpPolicy(),
      ...(this.options.workerModulePath ? { workerModulePath: this.options.workerModulePath } : {})
    })
  }

  private assertActive(): void {
    if (this.disposed) throw new BrowserAutomationError({ code: 'session_closed', message: 'Profile browser services are stopped' })
  }
}

class LazyManagedBrowserBackend implements BrowserBackendPort {
  private broker: BrowserBackendPort | null = null
  attempted = false
  private closeOperation?: Promise<void>
  constructor(private readonly create: () => BrowserBackendPort, private readonly admitLaunch?: () => Promise<{ release(): void }>) {}
  get started(): boolean { return this.broker !== null }
  getActiveCount(): number {
    return this.broker && 'getActiveCount' in this.broker && typeof this.broker.getActiveCount === 'function'
      ? this.broker.getActiveCount() as number : 0
  }
  async call(request: Parameters<BrowserBackendPort['call']>[0], options?: Parameters<BrowserBackendPort['call']>[1]) {
    this.attempted = true
    const admission = request.method === 'session.open' ? await this.admitLaunch?.() : undefined
    try {
      if (options?.signal?.aborted) throw new BrowserAutomationError({ code: 'cancelled', message: 'Managed browser launch was cancelled' })
      if (!this.broker) this.broker = this.create()
      return await this.broker.call(request, options)
    } finally { admission?.release() }
  }
  async close(): Promise<void> {
    if (this.closeOperation) return this.closeOperation
    const broker = this.broker
    if (!broker || !('close' in broker) || typeof broker.close !== 'function') return
    const close = broker.close.bind(broker)
    const operation = (async () => {
      await close()
      if (this.broker === broker) this.broker = null
    })()
    this.closeOperation = operation
    try { await operation }
    finally { if (this.closeOperation === operation) this.closeOperation = undefined }
  }
}

function tokenHash(token: string): Buffer {
  return createHash('sha256').update(token, 'utf8').digest()
}

function safeTokenEqual(expectedHash: Buffer, token: string): boolean {
  const actual = tokenHash(token)
  return actual.byteLength === expectedHash.byteLength && timingSafeEqual(actual, expectedHash)
}
