import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import type { ExecutionContext, ExecutionPolicySnapshot } from '../../../shared/execution/types'
import type {
  BrowserAction,
  BrowserActionResult,
  BrowserObservation,
  BrowserSessionRecord,
  BrowserTab,
  BrowserWaitCondition,
  BrowserWorkerResponse
} from '../../../shared/browser/types'
import { browserNavigationUrl } from '../../../shared/browser/validation'
import type { BrowserAutomationTool, BrowserToolContext, BrowserToolError, BrowserToolOutput } from '../../../shared/browser/automation'
import type { BrowserBroker } from '../BrowserBroker'
import { atomicWriteJsonSync } from '../../data/AtomicFs'
import { assertOwnedPath, assertProfileId } from '../../profiles/pathSafety'

export interface BrowserAutomationCancellation {
  resolve(profileId: string, cancellationId: string): AbortSignal
}

export interface BrowserAutomationPolicy {
  authorize(input: {
    context: ExecutionContext
    policy: ExecutionPolicySnapshot
    tool?: BrowserAutomationTool
    capability: string
    effect: 'read' | 'write' | 'external'
    request?: unknown
  }): void | BrowserToolError
}

export interface BrowserSessionManagerOptions {
  profileId: string
  profileRoot: string
  broker: Pick<BrowserBroker, 'call'>
  cancellation?: BrowserAutomationCancellation
  policy?: BrowserAutomationPolicy
}

interface StoredSession {
  record: BrowserSessionRecord
  owner: { threadId?: string; runId?: string }
}

interface BudgetState { calls: number; startedAt: number }

export class BrowserAutomationError extends Error {
  readonly code: string
  readonly details?: Record<string, unknown>
  constructor(error: BrowserToolError) {
    super(error.message)
    this.name = 'BrowserAutomationError'
    this.code = error.code
    this.details = error.details
  }
}

export class BrowserSessionManager {
  private readonly sessions = new Map<string, StoredSession>()
  private readonly budgets = new Map<string, BudgetState>()
  private readonly stateFile: string

  constructor(private readonly options: BrowserSessionManagerOptions) {
    if (!options.profileId || !isAbsolute(options.profileRoot)) throw new Error('BrowserSessionManager requires profile identity and absolute profileRoot')
    assertProfileId(options.profileId)
    this.stateFile = assertOwnedPath(options.profileRoot, join(options.profileRoot, 'browser', 'automation-sessions.json'), 'browser automation inventory')
    this.load()
  }

  list(context: BrowserToolContext): BrowserSessionRecord[] {
    this.authorize(context, undefined, 'browser.session', 'read')
    return [...this.sessions.values()]
      .filter((entry) => this.ownedBy(entry.record, context.execution))
      .map((entry) => ({ ...entry.record }))
  }

  async open(context: BrowserToolContext, input: { url?: string; persistent?: boolean; workspaceId?: string }): Promise<BrowserToolOutput> {
    this.authorize(context, 'browser_open', 'browser.session', 'external', input)
    if (input.url !== undefined) browserNavigationUrl(input.url)
    if (input.persistent !== undefined && typeof input.persistent !== 'boolean') throw new BrowserAutomationError({ code: 'invalid_action', message: 'persistent must be a boolean' })
    if (input.workspaceId !== undefined && !/^[a-zA-Z0-9:_-]{1,160}$/.test(input.workspaceId)) throw new BrowserAutomationError({ code: 'invalid_action', message: 'workspaceId must be an identifier' })
    const execution = context.execution
    const target = resolveBrowserTarget(context)
    if (target.backend === 'electron-attached' && (input.persistent !== undefined || input.workspaceId !== undefined)) throw new BrowserAutomationError({ code: 'invalid_action', message: 'The selected in-app tab retains its existing browser storage' })
    const signal = this.signal(context)
    const params: Record<string, unknown> = {
      backend: target.backend,
      ...(target.backend === 'electron-attached' ? { uiTabId: target.uiTabId } : {}),
      ...(input.url === undefined ? {} : { url: input.url }),
      ...(input.persistent === undefined ? {} : { persistent: input.persistent }),
      ...(input.workspaceId === undefined ? {} : { workspaceId: input.workspaceId }),
      ...(execution.runId === undefined ? {} : { runId: execution.runId }),
      threadId: execution.threadId
    }
    const result = await this.call(execution.profileId, 'session.open', params, signal)
    const payload = result as { session?: BrowserSessionRecord; observation?: BrowserObservation }
    if (!payload.session || payload.session.profileId !== this.options.profileId || payload.session.threadId !== execution.threadId || payload.session.runId !== execution.runId || payload.session.backend !== target.backend) {
      throw new BrowserAutomationError({ code: 'invalid_action', message: 'Worker returned an invalid session identity' })
    }
    const session = { ...payload.session }
    this.sessions.set(session.id, {
      record: session,
      owner: { threadId: execution.threadId, runId: execution.runId }
    })
    this.persist()
    return { session: { ...session }, ...(payload.observation ? { observation: payload.observation } : {}) }
  }

  async close(context: BrowserToolContext, sessionId: string): Promise<BrowserToolOutput> {
    this.authorize(context, undefined, 'browser.session', 'external', { sessionId })
    const entry = this.requireOwned(sessionId, context.execution)
    await this.call(context.execution.profileId, 'session.close', { sessionId }, this.signal(context))
    entry.record = { ...entry.record, lifecycle: 'closed', updatedAt: new Date().toISOString() }
    this.persist()
    return { session: { ...entry.record } }
  }

  async tabs(context: BrowserToolContext, sessionId: string, input: { operation?: 'list' | 'new' | 'switch' | 'close'; tabId?: string; url?: string }): Promise<BrowserToolOutput> {
    this.authorize(context, 'browser_tabs', 'browser.session', 'external', { sessionId, ...input })
    this.requireOwned(sessionId, context.execution)
    const operation = input.operation ?? 'list'
    const method = operation === 'list' ? 'tabs.list' : `tabs.${operation}`
    const result = await this.call(context.execution.profileId, method as Parameters<BrowserBroker['call']>[0]['method'], { sessionId, ...(input.tabId ? { tabId: input.tabId } : {}), ...(input.url ? { url: input.url } : {}) }, this.signal(context))
    const payload = result as { tabs?: BrowserTab[] }
    return { tabs: payload.tabs ?? (Array.isArray(result) ? result as BrowserTab[] : []) }
  }

  async observe(context: BrowserToolContext, input: { sessionId: string; tabId?: string; ref?: string; includeScreenshot?: boolean; maxElements?: number }): Promise<BrowserToolOutput> {
    this.authorize(context, 'browser_observe', 'browser.observe', 'read', input)
    this.requireOwned(input.sessionId, context.execution)
    const result = await this.call(context.execution.profileId, 'observe', {
      sessionId: input.sessionId,
      ...(input.tabId ? { tabId: input.tabId } : {}),
      ...(input.ref ? { ref: input.ref } : {}),
      ...(input.includeScreenshot === undefined ? {} : { includeScreenshot: input.includeScreenshot }),
      ...(input.maxElements === undefined ? {} : { maxElements: Math.min(1000, Math.max(1, Math.floor(input.maxElements))) })
    }, this.signal(context))
    return { observation: result as BrowserObservation }
  }

  async find(context: BrowserToolContext, input: { sessionId: string; tabId: string; query: string; role?: string; ref?: string }): Promise<BrowserToolOutput> {
    this.authorize(context, 'browser_find', 'browser.observe', 'read', input)
    this.requireOwned(input.sessionId, context.execution)
    const result = await this.call(context.execution.profileId, 'find', { sessionId: input.sessionId, tabId: input.tabId, text: input.query, ...(input.role ? { role: input.role } : {}), ...(input.ref ? { ref: input.ref } : {}) }, this.signal(context))
    const payload = result as { observationId?: string; elements?: unknown[] }
    return { observationId: payload.observationId, matches: payload.elements ?? [] }
  }

  async act(context: BrowserToolContext, input: { sessionId: string; tabId: string; generation: number; observationId: string; controlLeaseId: string; action: BrowserAction; timeoutMs?: number; expected?: BrowserWaitCondition }): Promise<BrowserToolOutput> {
    this.authorize(context, 'browser_act', 'browser.action', 'external', input)
    this.requireOwned(input.sessionId, context.execution)
    const requestId = `${context.execution.runId ?? context.execution.threadId}_${randomUUID()}`
    const result = await this.call(context.execution.profileId, 'act', {
      requestId, sessionId: input.sessionId, tabId: input.tabId, generation: input.generation,
      observationId: input.observationId, controlLeaseId: input.controlLeaseId, action: input.action,
      timeoutMs: input.timeoutMs ?? 30_000, ...(input.expected ? { expected: input.expected } : {})
    }, this.signal(context))
    return { action: result as BrowserActionResult }
  }

  /** Execute one generation-fenced action while an explicit human lease is active. */
  async humanAct(context: BrowserToolContext, input: { sessionId: string; tabId: string; generation: number; observationId: string; action: BrowserAction; timeoutMs?: number; expected?: BrowserWaitCondition }): Promise<BrowserToolOutput> {
    this.authorize(context, undefined, 'browser.action', 'external', input)
    const entry = this.requireOwned(input.sessionId, context.execution)
    if (entry.record.lifecycle !== 'human-controlled' || !entry.record.controlLeaseId) throw new BrowserAutomationError({ code: 'human_controlled', message: 'A human control lease is not active' })
    const requestId = `${context.execution.runId ?? context.execution.threadId}_human_${randomUUID()}`
    const result = await this.call(context.execution.profileId, 'human.act', {
      requestId, sessionId: input.sessionId, tabId: input.tabId, generation: input.generation,
      observationId: input.observationId, controlLeaseId: entry.record.controlLeaseId, action: input.action,
      timeoutMs: input.timeoutMs ?? 30_000, ...(input.expected ? { expected: input.expected } : {})
    }, this.signal(context))
    return { action: result as BrowserActionResult }
  }

  async wait(context: BrowserToolContext, input: { sessionId: string; tabId: string; condition: BrowserWaitCondition; timeoutMs?: number }): Promise<BrowserToolOutput> {
    this.authorize(context, 'browser_wait', 'browser.observe', 'read', input)
    this.requireOwned(input.sessionId, context.execution)
    const result = await this.call(context.execution.profileId, 'wait', { sessionId: input.sessionId, tabId: input.tabId, condition: input.condition, timeoutMs: input.timeoutMs ?? 30_000 }, this.signal(context))
    return { observation: result as BrowserObservation }
  }

  async extract(context: BrowserToolContext, input: { sessionId: string; tabId: string; ref?: string; schema?: unknown }): Promise<BrowserToolOutput> {
    this.authorize(context, 'browser_extract', 'browser.extract', 'read', input)
    this.requireOwned(input.sessionId, context.execution)
    const result = await this.call(context.execution.profileId, 'extract', { sessionId: input.sessionId, tabId: input.tabId, ...(input.ref ? { ref: input.ref } : {}) }, this.signal(context))
    return { extraction: result }
  }

  async control(context: BrowserToolContext, sessionId: string, owner: 'agent' | 'human'): Promise<BrowserToolOutput> {
    this.authorize(context, undefined, 'browser.session', 'external', { sessionId, owner })
    const entry = this.requireOwned(sessionId, context.execution)
    const result = await this.call(context.execution.profileId, 'control.take', { sessionId, owner }, this.signal(context)) as { controlLeaseId?: string; generation?: number; lifecycle?: BrowserSessionRecord['lifecycle'] }
    entry.record = { ...entry.record, controlLeaseId: result.controlLeaseId, generation: result.generation ?? entry.record.generation, lifecycle: result.lifecycle ?? entry.record.lifecycle, updatedAt: new Date().toISOString() }
    this.persist()
    return { session: { ...entry.record } }
  }

  async releaseControl(context: BrowserToolContext, sessionId: string, controlLeaseId: string): Promise<BrowserToolOutput> {
    this.authorize(context, undefined, 'browser.session', 'external', { sessionId, controlLeaseId })
    const entry = this.requireOwned(sessionId, context.execution)
    await this.call(context.execution.profileId, 'control.release', { sessionId, controlLeaseId }, this.signal(context))
    entry.record = { ...entry.record, controlLeaseId: undefined, lifecycle: 'ready', updatedAt: new Date().toISOString() }
    this.persist()
    return { session: { ...entry.record } }
  }

  assertHumanHandoffOwned(context: BrowserToolContext, request: { sessionId: string; reason: string; operation?: string }): void {
    this.authorize(context, 'browser_request_human', 'browser.task', 'external', request)
    this.requireOwned(request.sessionId, context.execution)
  }

  async closeAll(): Promise<void> {
    await Promise.all([...this.sessions.values()].map(async (entry) => {
      if (entry.record.lifecycle === 'closed') return
      try {
        await this.call(this.options.profileId, 'session.close', { sessionId: entry.record.id }, AbortSignal.timeout(5_000))
        entry.record = { ...entry.record, lifecycle: 'closed', updatedAt: new Date().toISOString() }
      } catch {
        entry.record = { ...entry.record, lifecycle: 'disconnected', updatedAt: new Date().toISOString() }
      }
    }))
    this.persist()
  }

  private authorize(context: BrowserToolContext, tool: BrowserAutomationTool | undefined, capability: string, effect: 'read' | 'write' | 'external', request?: unknown): void {
    if (context.execution.profileId !== this.options.profileId || context.policy.profileId !== this.options.profileId) throw new BrowserAutomationError({ code: 'profile_mismatch', message: 'Browser context belongs to another profile' })
    if (context.execution.policySnapshotId !== context.policy.id) throw new BrowserAutomationError({ code: 'policy_denied', message: 'Browser policy snapshot mismatch' })
    if (tool && !context.policy.allowedTools.includes(tool)) throw new BrowserAutomationError({ code: 'policy_denied', message: `Browser tool denied: ${tool}` })
    if (!context.policy.allowedCapabilities.includes(capability)) throw new BrowserAutomationError({ code: 'policy_denied', message: `Browser capability denied: ${capability}` })
    if (!context.policy.allowedEffects.includes(effect)) throw new BrowserAutomationError({ code: 'policy_denied', message: `Browser effect denied: ${effect}` })
    const custom = this.options.policy?.authorize({ context: context.execution, policy: context.policy, tool, capability, effect, request })
    if (custom) throw new BrowserAutomationError(custom)
    if (context.policy.approvalEffects.includes(effect) && !this.options.policy) throw new BrowserAutomationError({ code: 'approval_required', message: `Browser ${effect} effect requires host approval` })
    const key = this.budgetKey(context.execution)
    const state = this.budgets.get(key) ?? { calls: 0, startedAt: Date.now() }
    state.calls += 1
    if (state.calls > context.policy.maxToolCalls) throw new BrowserAutomationError({ code: 'policy_denied', message: 'Browser tool-call budget exceeded' })
    if (Date.now() - state.startedAt > context.policy.maxElapsedMs) throw new BrowserAutomationError({ code: 'timeout', message: 'Browser execution budget exceeded' })
    this.budgets.set(key, state)
  }

  private signal(context: BrowserToolContext): AbortSignal | undefined {
    const cancellation = context.signal ?? (this.options.cancellation ? this.options.cancellation.resolve(context.execution.profileId, context.execution.cancellationId) : undefined)
    const state = this.budgets.get(this.budgetKey(context.execution))
    const elapsed = state ? Date.now() - state.startedAt : 0
    const deadline = AbortSignal.timeout(Math.min(2_147_483_647, Math.max(1, context.policy.maxElapsedMs - elapsed)))
    return cancellation ? AbortSignal.any([cancellation, deadline]) : deadline
  }

  private budgetKey(context: ExecutionContext): string {
    return `${context.runId ?? context.threadId}\u0000${context.turnId}`
  }

  private ownedBy(record: BrowserSessionRecord, context: ExecutionContext): boolean {
    return record.profileId === context.profileId
      && record.threadId === context.threadId
      && (record.runId === undefined ? context.runId === undefined : record.runId === context.runId)
  }

  private requireOwned(sessionId: string, context: ExecutionContext): StoredSession {
    const entry = this.sessions.get(sessionId)
    if (!entry || entry.record.lifecycle === 'closed') throw new BrowserAutomationError({ code: 'session_closed', message: 'Browser session is unavailable' })
    if (!this.ownedBy(entry.record, context) || entry.owner.threadId !== context.threadId || (!!entry.owner.runId && entry.owner.runId !== context.runId)) throw new BrowserAutomationError({ code: 'profile_mismatch', message: 'Browser session is owned by another execution context' })
    return entry
  }

  private async call(profileId: string, method: Parameters<BrowserBroker['call']>[0]['method'], params: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
    try {
      const response = await this.options.broker.call({ version: 1, id: `mms_${randomUUID()}`, profileId, method, params }, { signal }) as BrowserWorkerResponse
      if (!response.ok) throw new BrowserAutomationError(response.error ?? { code: 'worker_disconnected', message: 'Browser worker request failed' })
      return response.result
    } catch (error) {
      const sessionId = typeof params.sessionId === 'string' ? params.sessionId : undefined
      const errorCode = String((error as { code?: unknown })?.code ?? '')
      const workerDisconnected = !(error instanceof BrowserAutomationError) || errorCode === 'worker_disconnected'
      if (sessionId && workerDisconnected) {
        const entry = this.sessions.get(sessionId)
        if (entry && entry.record.lifecycle !== 'closed') {
          entry.record = { ...entry.record, lifecycle: 'disconnected', updatedAt: new Date().toISOString() }
          this.persist()
        }
      }
      if (error instanceof BrowserAutomationError) throw error
      throw new BrowserAutomationError({ code: String((error as { code?: unknown })?.code ?? 'worker_disconnected'), message: error instanceof Error ? error.message : String(error) })
    }
  }

  private load(): void {
    const stateFile = assertOwnedPath(this.options.profileRoot, this.stateFile, 'browser automation inventory')
    if (!existsSync(stateFile)) return
    let raw: unknown
    try {
      raw = JSON.parse(readFileSync(stateFile, 'utf8')) as unknown
    } catch { throw new Error(`Browser automation inventory is corrupt: ${stateFile}`) }
    if (!Array.isArray(raw)) throw new Error(`Browser automation inventory is corrupt: ${stateFile}`)
    for (const item of raw) {
      if (!isStoredSession(item, this.options.profileId)) throw new Error(`Browser automation inventory is corrupt: ${stateFile}`)
      if (this.sessions.has(item.record.id)) throw new Error(`Browser automation inventory is corrupt: ${stateFile}`)
      this.sessions.set(item.record.id, { record: { ...item.record, lifecycle: item.record.lifecycle === 'closed' ? 'closed' : 'disconnected' }, owner: { ...item.owner } })
    }
  }

  private persist(): void {
    const stateFile = assertOwnedPath(this.options.profileRoot, this.stateFile, 'browser automation inventory')
    atomicWriteJsonSync(stateFile, [...this.sessions.values()], { mode: 0o600 })
  }
}

function resolveBrowserTarget(context: BrowserToolContext): NonNullable<BrowserToolContext['target']> {
  const target = context.target
  if (!target) {
    if (context.execution.source === 'gui') throw new BrowserAutomationError({ code: 'setup_required', message: 'Select an in-app browser tab or an explicit managed session before running browser tools' })
    return { backend: 'managed-chromium' }
  }
  if (!target || typeof target !== 'object' || Array.isArray(target)
    || (Object.getPrototypeOf(target) !== Object.prototype && Object.getPrototypeOf(target) !== null)) {
    throw new BrowserAutomationError({ code: 'invalid_action', message: 'Host browser target is invalid' })
  }
  const keys = Object.keys(target)
  if (target.backend === 'managed-chromium') {
    if (keys.some((key) => key !== 'backend')) throw new BrowserAutomationError({ code: 'invalid_action', message: 'Host managed-browser target is invalid' })
    return { backend: 'managed-chromium' }
  }
  if (target.backend !== 'electron-attached' || keys.some((key) => key !== 'backend' && key !== 'uiTabId')
    || typeof target.uiTabId !== 'string' || !/^[a-zA-Z0-9:_-]{1,160}$/.test(target.uiTabId)) {
    throw new BrowserAutomationError({ code: 'invalid_action', message: 'Host attached-browser target is invalid' })
  }
  if (context.execution.source !== 'gui') {
    throw new BrowserAutomationError({ code: 'invalid_action', message: 'Unattended browser execution requires managed Chromium' })
  }
  return { backend: 'electron-attached', uiTabId: target.uiTabId }
}

function isStoredSession(value: unknown, profileId: string): value is StoredSession {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const item = value as Partial<StoredSession>
  const record = item.record
  const owner = item.owner
  if (!record || typeof record !== 'object' || Array.isArray(record)
    || !owner || typeof owner !== 'object' || Array.isArray(owner)) return false
  if (typeof record.id !== 'string' || !/^[a-zA-Z0-9:_-]{1,160}$/.test(record.id) || record.profileId !== profileId) return false
  if (record.backend !== 'managed-chromium' && record.backend !== 'electron-attached') return false
  if (record.threadId !== undefined && (typeof record.threadId !== 'string' || !record.threadId)) return false
  if (record.runId !== undefined && (typeof record.runId !== 'string' || !record.runId)) return false
  if (record.workspaceId !== undefined && (typeof record.workspaceId !== 'string' || !/^[a-zA-Z0-9:_-]{1,160}$/.test(record.workspaceId))) return false
  if (typeof record.persistent !== 'boolean' || typeof record.browserVersion !== 'string' || !record.browserVersion || record.browserVersion.length > 256) return false
  if (!Number.isSafeInteger(record.generation) || record.generation < 1) return false
  if (record.controlLeaseId !== undefined && (typeof record.controlLeaseId !== 'string' || !/^[a-zA-Z0-9:_-]{1,160}$/.test(record.controlLeaseId))) return false
  if (typeof record.createdAt !== 'string' || !Number.isFinite(Date.parse(record.createdAt))
    || typeof record.updatedAt !== 'string' || !Number.isFinite(Date.parse(record.updatedAt))) return false
  if (owner.threadId !== record.threadId || owner.runId !== record.runId) return false
  return ['starting', 'ready', 'agent-controlled', 'human-controlled', 'waiting-approval', 'disconnected', 'recovering', 'closed'].includes(record.lifecycle)
}
