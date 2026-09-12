import { randomUUID } from 'node:crypto'
import type { BrowserAccessState } from '../../shared/browser/access'
import { BrowserAutomationError } from './automation/BrowserSessionManager'

/** Session-only, profile-owned grants. A model can request, but never grant, access. */
export class BrowserAccessController {
  private allowed = false
  private grant = new AbortController()
  private readonly pending = new Map<string, { threadId: string; settle(allowed: boolean): void; cancel(): void }>()

  status(): BrowserAccessState {
    return { allowed: this.allowed, pending: [...this.pending].map(([requestId, request]) => ({ requestId, threadId: request.threadId })) }
  }

  get signal(): AbortSignal { return this.grant.signal }

  request(threadId: string, signal?: AbortSignal): Promise<'allowed' | 'already-allowed'> {
    if (signal?.aborted) return Promise.reject(new BrowserAutomationError({ code: 'cancelled', message: 'Browser access request was cancelled' }))
    if (this.allowed) return Promise.resolve('already-allowed')
    return new Promise((resolve, reject) => {
      const requestId = randomUUID()
      const cleanup = () => { this.pending.delete(requestId); signal?.removeEventListener('abort', cancel) }
      const cancel = () => { cleanup(); reject(new BrowserAutomationError({ code: 'cancelled', message: 'Browser access request was cancelled' })) }
      this.pending.set(requestId, { threadId, cancel, settle: (allowed) => {
        cleanup()
        if (allowed) resolve('allowed')
        else reject(new BrowserAutomationError({ code: 'policy_denied', message: 'The user selected Deny for agents browser access.', details: { userResponse: 'deny' } }))
      } })
      signal?.addEventListener('abort', cancel, { once: true })
    })
  }

  respond(requestId: string, allowed: boolean): BrowserAccessState {
    if (!this.pending.has(requestId)) throw new BrowserAutomationError({ code: 'invalid_action', message: 'Browser access request is no longer pending' })
    return this.set(allowed)
  }

  set(allowed: boolean): BrowserAccessState {
    if (!allowed) this.grant.abort()
    else if (!this.allowed) this.grant = new AbortController()
    this.allowed = allowed
    for (const request of [...this.pending.values()]) request.settle(allowed)
    return this.status()
  }

  cancelPending(): void {
    for (const request of [...this.pending.values()]) request.cancel()
  }

  dispose(): void { this.allowed = false; this.grant.abort(); this.cancelPending() }
}
