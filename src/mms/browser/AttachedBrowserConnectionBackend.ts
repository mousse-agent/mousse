import { isBrowserAttachedMutationMethod } from '../../shared/browser/connectionCommands'
import { validateBrowserWorkerRequest, validateBrowserWorkerResponse } from '../../shared/browser/envelope'
import type { BrowserErrorCode, BrowserWorkerRequest, BrowserWorkerResponse } from '../../shared/browser/types'
import { OwnedWorkBarrier } from '../execution/OwnedWorkBarrier'
import type {
  ConnectionCommandDispatchInput,
  ConnectionCommandDispatchResult
} from '../protocol/connectionCommands'
import type { BrowserBackendPort } from './BrowserBackendRouter'

export interface AttachedRegistrationRecord {
  readonly registrationId: string
  readonly registrationEpoch: number
  readonly uiTabId: string
  readonly connectionId: string
  readonly profileId: string
  readonly profileEpoch: number
  readonly selectedThreadId?: string
}

export interface AttachedSessionBinding {
  readonly sessionId: string
  readonly registrationId: string
  readonly registrationEpoch: number
  readonly connectionId: string
  readonly uiTabId: string
  readonly profileEpoch: number
}

export interface AttachedCommandDispatchPort {
  dispatch(input: ConnectionCommandDispatchInput): Promise<ConnectionCommandDispatchResult>
}

const IDENTIFIER = /^[a-zA-Z0-9:_-]{1,160}$/
const SESSION_LIFECYCLES = new Set(['ready', 'agent-controlled', 'human-controlled', 'waiting-approval'])

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
}

function isIdentifier(value: unknown): value is string {
  return typeof value === 'string' && IDENTIFIER.test(value)
}

/** BrowserBackendPort that forwards typed worker requests to one registered GUI connection. */
export class AttachedBrowserConnectionBackend implements BrowserBackendPort {
  private router: AttachedCommandDispatchPort | undefined
  private readonly sessions = new Map<string, AttachedSessionBinding>()
  private readonly work = new OwnedWorkBarrier()

  constructor(private readonly options: {
    profileId: string
    commandRouter?: AttachedCommandDispatchPort
    getRegistrationByUiTabId: (uiTabId: string) => AttachedRegistrationRecord | undefined
    getRegistration: (registrationId: string) => AttachedRegistrationRecord | undefined
  }) {
    this.router = options.commandRouter
  }

  setCommandRouter(router: AttachedCommandDispatchPort | undefined): void {
    this.router = router
  }

  beginShutdown(): void { this.work.beginShutdown() }
  getActiveCount(): number { return this.work.count }
  async shutdown(options: { timeoutMs?: number } = {}): Promise<void> {
    this.beginShutdown()
    await this.work.waitForIdle(options.timeoutMs)
  }

  bindingForSession(sessionId: string): AttachedSessionBinding | undefined {
    const binding = this.sessions.get(sessionId)
    return binding ? { ...binding } : undefined
  }

  forgetRegistration(registrationId: string): void {
    for (const [sessionId, binding] of this.sessions) {
      if (binding.registrationId === registrationId) this.sessions.delete(sessionId)
    }
  }

  forgetConnection(connectionId: string): void {
    for (const [sessionId, binding] of this.sessions) {
      if (binding.connectionId === connectionId) this.sessions.delete(sessionId)
    }
  }

  call(input: BrowserWorkerRequest, options: { timeoutMs?: number; signal?: AbortSignal } = {}): Promise<BrowserWorkerResponse> {
    return this.work.run('attached-browser-command', async () => {
      const request = structuredClone(validateBrowserWorkerRequest(input))
      if (request.profileId !== this.options.profileId) {
        return this.error(request, 'profile_mismatch', 'Attached browser belongs to another profile')
      }
      const target = this.resolveTarget(request)
      if ('error' in target) return target.error
      const router = this.router
      if (!router) return this.error(request, 'setup_required', 'Attached browser command router is not bound')
      // Pass the raw dispatch promise through. A wrapper timeout is not guest-close proof.
      const result = await router.dispatch({
        connectionId: target.registration.connectionId,
        registrationId: target.registration.registrationId,
        registrationEpoch: target.registration.registrationEpoch,
        expectedBinding: { profileId: target.registration.profileId, epoch: target.registration.profileEpoch },
        request,
        signal: options.signal,
        timeoutMs: options.timeoutMs
      })
      const response = this.mapResult(request, result)
      if (request.method === 'session.open' && response.ok) this.bindOpenedSession(request, response, target.registration)
      return response
    })
  }

  private resolveTarget(request: BrowserWorkerRequest):
    | { registration: AttachedRegistrationRecord }
    | { error: BrowserWorkerResponse } {
    if (request.method === 'session.open') {
      const uiTabId = request.params.uiTabId
      if (!isIdentifier(uiTabId)) return { error: this.error(request, 'invalid_action', 'An attached browser requires a selected in-app tab') }
      const live = this.options.getRegistrationByUiTabId(uiTabId)
      if (!live) return { error: this.error(request, 'setup_required', 'The selected in-app browser is not connected') }
      if (live.profileId !== request.profileId || live.profileEpoch < 1) {
        return { error: this.error(request, 'profile_mismatch', 'Attached registration profile does not match the command') }
      }
      const threadId = request.params.threadId
      if (live.selectedThreadId !== undefined && threadId !== undefined && live.selectedThreadId !== threadId) {
        return { error: this.error(request, 'invalid_action', 'The selected in-app tab is bound to another thread') }
      }
      if (live.selectedThreadId === undefined) {
        return { error: this.error(request, 'setup_required', 'Select the in-app tab for this thread before opening a session') }
      }
      return { registration: live }
    }
    const sessionId = request.params.sessionId
    if (!isIdentifier(sessionId)) return { error: this.error(request, 'session_closed', 'Browser session is not connected to its original backend') }
    const bound = this.sessions.get(sessionId)
    if (!bound) return { error: this.error(request, 'session_closed', 'Browser session is not connected to its original registration') }
    const live = this.options.getRegistration(bound.registrationId)
    if (!live
      || live.registrationEpoch !== bound.registrationEpoch
      || live.connectionId !== bound.connectionId
      || live.uiTabId !== bound.uiTabId
      || live.profileEpoch !== bound.profileEpoch
      || live.profileId !== request.profileId) {
      return { error: this.error(request, 'session_closed', 'Attached browser registration is no longer current; the session cannot be rerouted') }
    }
    return { registration: live }
  }

  private bindOpenedSession(request: BrowserWorkerRequest, response: BrowserWorkerResponse, registration: AttachedRegistrationRecord): void {
    const result = response.result
    const session = isObject(result) ? result.session : undefined
    if (!isObject(session) || !isIdentifier(session.id) || this.sessions.has(session.id)) return
    if (session.profileId !== request.profileId || session.backend !== 'electron-attached') return
    if (session.threadId !== request.params.threadId || session.runId !== request.params.runId) return
    if (!Number.isSafeInteger(session.generation) || Number(session.generation) < 1) return
    if (typeof session.lifecycle !== 'string' || !SESSION_LIFECYCLES.has(session.lifecycle)) return
    this.sessions.set(session.id, {
      sessionId: session.id,
      registrationId: registration.registrationId,
      registrationEpoch: registration.registrationEpoch,
      connectionId: registration.connectionId,
      uiTabId: registration.uiTabId,
      profileEpoch: registration.profileEpoch
    })
  }

  private mapResult(request: BrowserWorkerRequest, result: ConnectionCommandDispatchResult): BrowserWorkerResponse {
    if (result.status === 'completed') {
      try {
        const response = validateBrowserWorkerResponse(result.response)
        if (response.id !== request.id) return this.error(request, 'worker_disconnected', 'Attached browser response identity mismatch')
        return response
      } catch (error) {
        return this.error(request, 'worker_disconnected', error instanceof Error ? error.message : 'Attached browser returned an invalid response')
      }
    }
    if (result.status === 'unknown-effect') {
      if (request.method === 'act' || request.method === 'human.act') {
        return {
          version: 1,
          id: request.id,
          ok: true,
          result: {
            requestId: String(request.params.requestId ?? request.id),
            outcome: 'unknown-effect',
            dispatched: true,
            artifactIds: [],
            code: this.unknownEffectCode(result.code),
            message: result.message
          }
        }
      }
      return this.error(request, this.unknownEffectCode(result.code), `${result.message} Remote effect is uncertain; do not retry or replay.`)
    }
    if (result.status === 'rejected') return this.error(request, this.rejectedCode(result.code), result.message)
    if (result.status === 'cancelled') return this.error(request, 'cancelled', result.message)
    return this.error(request, 'worker_disconnected', result.message)
  }

  private rejectedCode(code: string): BrowserErrorCode {
    if (code === 'stale_binding' || code === 'profile_mismatch') return 'profile_mismatch'
    if (code === 'malformed_command' || code === 'command_too_large') return 'invalid_action'
    if (code === 'admission_closed') return 'cancelled'
    if (code === 'capability_required' || code === 'connection_not_found' || code === 'backpressure') return 'setup_required'
    return 'setup_required'
  }

  private unknownEffectCode(code: string): BrowserErrorCode {
    if (code === 'timeout') return 'timeout'
    if (code === 'cancelled') return 'cancelled'
    return 'worker_disconnected'
  }

  private error(request: BrowserWorkerRequest, code: BrowserErrorCode, message: string): BrowserWorkerResponse {
    return { version: 1, id: request.id, ok: false, error: { code, message } }
  }
}
