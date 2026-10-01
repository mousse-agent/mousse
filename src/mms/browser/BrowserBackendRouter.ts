import type { BrowserSessionRecord, BrowserWorkerRequest, BrowserWorkerResponse } from '../../shared/browser/types'
import { validateBrowserWorkerRequest, validateBrowserWorkerResponse } from '../../shared/browser/envelope'
import { OwnedWorkBarrier } from '../execution/OwnedWorkBarrier'

/** Privileged backend port. Callers use BrowserSessionManager, never raw model input. */
export interface BrowserBackendPort {
  call(request: BrowserWorkerRequest, options?: { timeoutMs?: number; signal?: AbortSignal }): Promise<BrowserWorkerResponse>
}

interface Route {
  backend: BrowserSessionRecord['backend']
  port: BrowserBackendPort
  uiTabId?: string
}

/** Binds each admitted session to one backend for its entire lifetime. */
export class BrowserBackendRouter implements BrowserBackendPort {
  private readonly routes = new Map<string, Route>()
  private readonly work = new OwnedWorkBarrier()

  constructor(private readonly options: {
    profileId: string
    managed: BrowserBackendPort
    attached?: BrowserBackendPort
  }) {}

  beginShutdown(): void { this.work.beginShutdown() }
  getActiveCount(): number { return this.work.count }
  async shutdown(options: { timeoutMs?: number } = {}): Promise<void> {
    this.beginShutdown()
    await this.work.waitForIdle(options.timeoutMs)
  }

  call(input: BrowserWorkerRequest, options: { timeoutMs?: number; signal?: AbortSignal } = {}): Promise<BrowserWorkerResponse> {
    return this.work.run('browser-backend-command', async () => {
      const request = structuredClone(validateBrowserWorkerRequest(input))
      if (request.profileId !== this.options.profileId) return this.error(request, 'profile_mismatch', 'Browser backend belongs to another profile')
      const route = this.resolveRoute(request)
      if ('error' in route) return route.error
      const params = { ...request.params }
      delete params.backend
      const signal = options.signal ? AbortSignal.any([options.signal, this.work.signal]) : this.work.signal
      if (signal.aborted) return this.error(request, 'cancelled', 'Browser request was cancelled before dispatch')
      // Do not race this promise against a timeout and mistake wrapper completion
      // for backend completion. Each backend owns its raw commands and close proof.
      const response = validateBrowserWorkerResponse(await route.port.call({ ...request, params }, { ...options, signal }))
      if (response.id !== request.id) return this.error(request, 'worker_disconnected', 'Browser backend response identity mismatch')
      if (!response.ok) return response
      if (request.method === 'session.open') {
        const result = response.result
        const session = isObject(result) ? result.session : undefined
        const observation = isObject(result) ? result.observation : undefined
        if (!isValidOpenedSession(session, request, route.backend)
          || (observation !== undefined && !isMatchingOpenObservation(observation, session))
          || this.routes.has(session.id)) {
          return this.error(request, 'worker_disconnected', 'Browser backend returned an invalid or duplicate session identity')
        }
        if (this.work.stopping) {
          // Admission was valid, but shutdown began while the backend owned the
          // raw open. Do not publish a new route after the drain barrier closed.
          // Keep the compensating close inside this same owned operation.
          const closeRequest: BrowserWorkerRequest = {
            version: 1,
            id: `${request.id.slice(0, 140)}_shutdown_close`,
            profileId: request.profileId,
            method: 'session.close',
            params: { sessionId: session.id }
          }
          const closed = validateBrowserWorkerResponse(await route.port.call(closeRequest, { timeoutMs: options.timeoutMs }))
          if (closed.id !== closeRequest.id || !closed.ok) {
            return this.error(request, 'worker_disconnected', 'Browser backend did not close a session opened during shutdown')
          }
          return this.error(request, 'cancelled', 'Browser session opened after shutdown began and was closed')
        }
        this.routes.set(session.id, route)
      } else if (request.method === 'session.close') {
        this.routes.delete(String(request.params.sessionId))
      }
      return response
    })
  }

  private resolveRoute(request: BrowserWorkerRequest): Route | { error: BrowserWorkerResponse } {
    if (request.method === 'session.open') {
      const backend = request.params.backend
      if (backend !== 'managed-chromium' && backend !== 'electron-attached') {
        return { error: this.error(request, 'invalid_action', 'Select an explicit browser backend before opening a session') }
      }
      if (backend === 'electron-attached') {
        if (typeof request.params.uiTabId !== 'string' || !/^[a-zA-Z0-9:_-]{1,160}$/.test(request.params.uiTabId)) {
          return { error: this.error(request, 'invalid_action', 'An attached browser requires a selected in-app tab') }
        }
        if (request.params.persistent !== undefined || request.params.workspaceId !== undefined) {
          return { error: this.error(request, 'invalid_action', 'An attached tab keeps its existing browser storage') }
        }
        if (!this.options.attached) return { error: this.error(request, 'setup_required', 'The selected in-app browser is not connected') }
        return { backend, port: this.options.attached, uiTabId: request.params.uiTabId }
      }
      if (request.params.uiTabId !== undefined) return { error: this.error(request, 'invalid_action', 'A managed session cannot replace a selected in-app tab') }
      return { backend, port: this.options.managed }
    }
    const route = this.routes.get(String(request.params.sessionId ?? ''))
    if (!route) return { error: this.error(request, 'session_closed', 'Browser session is not connected to its original backend') }
    if (request.params.backend !== undefined || request.params.uiTabId !== undefined) {
      return { error: this.error(request, 'invalid_action', 'An existing browser session cannot change its backend or tab binding') }
    }
    return route
  }

  private error(request: BrowserWorkerRequest, code: NonNullable<BrowserWorkerResponse['error']>['code'], message: string): BrowserWorkerResponse {
    return { version: 1, id: request.id, ok: false, error: { code, message } }
  }
}

const SESSION_LIFECYCLES = new Set([
  'ready', 'agent-controlled', 'human-controlled', 'waiting-approval'
])

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
}

function isIdentifier(value: unknown): value is string {
  return typeof value === 'string' && /^[a-zA-Z0-9:_-]{1,160}$/.test(value)
}

function isOptionalIdentifier(value: unknown): value is string | undefined {
  return value === undefined || isIdentifier(value)
}

function isValidOpenedSession(
  value: unknown,
  request: BrowserWorkerRequest,
  backend: BrowserSessionRecord['backend']
): value is BrowserSessionRecord {
  if (!isObject(value)) return false
  return isIdentifier(value.id)
    && value.profileId === request.profileId
    && value.backend === backend
    && value.threadId === request.params.threadId
    && value.runId === request.params.runId
    && isOptionalIdentifier(value.threadId)
    && isOptionalIdentifier(value.runId)
    && isOptionalIdentifier(value.workspaceId)
    && typeof value.persistent === 'boolean'
    && typeof value.browserVersion === 'string' && value.browserVersion.length > 0 && value.browserVersion.length <= 256
    && Number.isSafeInteger(value.generation) && Number(value.generation) >= 1
    && typeof value.lifecycle === 'string' && SESSION_LIFECYCLES.has(value.lifecycle)
    && isOptionalIdentifier(value.controlLeaseId)
    && typeof value.createdAt === 'string' && value.createdAt.length <= 64 && Number.isFinite(Date.parse(value.createdAt))
    && typeof value.updatedAt === 'string' && value.updatedAt.length <= 64 && Number.isFinite(Date.parse(value.updatedAt))
}

function isMatchingOpenObservation(value: unknown, session: BrowserSessionRecord): boolean {
  if (!isObject(value)) return false
  return value.sessionId === session.id
    && value.generation === session.generation
    && isIdentifier(value.tabId)
    && isIdentifier(value.observationId)
    && isIdentifier(value.documentId)
}
