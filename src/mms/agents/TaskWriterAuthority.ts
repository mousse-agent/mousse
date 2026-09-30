import { AsyncLocalStorage } from 'node:async_hooks'
import type { ThreadLeaseHandle } from '../queue/ThreadExecutionLease'
import { assertHeldThreadLease } from '../actions/GitOperationCoordinator'
import type { AgentWorkspacePolicy } from '../../shared/agentEpisodes'

/** Process-local identity, never a serialized caller-supplied capability. */
export interface EpisodeWriterToken { readonly episodeId: string; readonly signal: AbortSignal }
interface Owner {
  token: EpisodeWriterToken
  parent?: Owner
  policy: AgentWorkspacePolicy
  abort: AbortController
  pending: Set<Promise<unknown>>
}
interface Waiter { owner: Owner; resolve: () => void; reject: (error: Error) => void; removeAbort: () => void }

/** One physical lease, one FIFO logical writer. Repository leases never live here. */
export class TaskWriterAuthority {
  private readonly owners = new Map<EpisodeWriterToken, Owner>()
  private readonly context = new AsyncLocalStorage<Owner>()
  private readonly queue: Waiter[] = []
  private current?: Owner
  private blocked?: Error
  constructor(readonly lease: ThreadLeaseHandle) { this.assertLease() }

  issue(episodeId: string, policy: AgentWorkspacePolicy, parentToken?: EpisodeWriterToken): EpisodeWriterToken {
    this.assertLease()
    const parent = parentToken ? this.require(parentToken) : undefined
    if (parent?.policy.access === 'read-only' && policy.access === 'write') throw new Error('Delegation cannot broaden writer authority')
    const abort = new AbortController()
    const token = Object.freeze({ episodeId, signal: abort.signal })
    this.owners.set(token, { token, parent, policy, abort, pending: new Set() })
    return token
  }

  assertWriter(token: EpisodeWriterToken): void {
    this.assertLease()
    const owner = this.require(token)
    if (owner.policy.access !== 'write' || owner !== this.current || this.context.getStore() !== owner) throw new Error('Episode does not own current task writer permission')
  }

  async runWriter<T>(token: EpisodeWriterToken, run: () => Promise<T>): Promise<T> {
    const owner = this.require(token)
    if (owner.policy.access !== 'write') return Promise.reject(new Error('Read-only episode cannot acquire write ownership'))
    if (this.current === owner && this.context.getStore() === owner) {
      this.assertWriter(token)
      return run()
    }
    const promise = this.runOwned(owner, run)
    owner.pending.add(promise)
    void promise.finally(() => owner.pending.delete(promise)).catch(() => undefined)
    return promise
  }

  /** Parent must explicitly yield its entire scope before waiting on shared children. */
  async delegate<T>(parentToken: EpisodeWriterToken, runChildren: () => Promise<T>): Promise<T> {
    this.assertWriter(parentToken)
    const parent = this.require(parentToken)
    this.current = undefined
    this.advance()
    try { return await this.context.run(undefined as never, runChildren) }
    finally {
      // Reclaim only after children and their owned callbacks have settled.
      await this.acquire(parent)
    }
  }

  /** Revocation blocks admission immediately; ownership transfers only after work actually ends. */
  async revokeAndDrain(token: EpisodeWriterToken): Promise<void> {
    const root = this.owners.get(token)
    if (!root) throw new Error('Unknown episode token')
    const affected = [...this.owners.values()].filter((owner) => {
      for (let item: Owner | undefined = owner; item; item = item.parent) if (item === root) return true
      return false
    })
    for (const owner of affected) owner.abort.abort()
    await Promise.allSettled(affected.flatMap((owner) => [...owner.pending]))
  }

  async drain(): Promise<void> {
    await Promise.allSettled([...this.owners.values()].flatMap((owner) => [...owner.pending]))
    this.assertLease()
  }

  private async runOwned<T>(owner: Owner, run: () => Promise<T>): Promise<T> {
    await this.acquire(owner)
    try { return await this.context.run(owner, run) }
    finally { if (this.current === owner) { this.current = undefined; this.advance() } }
  }
  private acquire(owner: Owner): Promise<void> {
    try { this.assertLease(); this.require(owner.token) } catch (error) { return Promise.reject(error) }
    return new Promise<void>((resolve, reject) => {
      const onAbort = (): void => {
        const index = this.queue.indexOf(waiter)
        if (index >= 0) { this.queue.splice(index, 1); reject(new Error('Episode writer revoked')) }
      }
      const waiter: Waiter = { owner, resolve, reject, removeAbort: () => owner.token.signal.removeEventListener('abort', onAbort) }
      owner.token.signal.addEventListener('abort', onAbort, { once: true })
      this.queue.push(waiter)
      this.advance()
    })
  }
  private advance(): void {
    if (this.current) return
    while (this.queue.length) {
      const waiter = this.queue.shift()!; waiter.removeAbort()
      try { this.assertLease(); this.require(waiter.owner.token) }
      catch (error) { waiter.reject(error as Error); continue }
      this.current = waiter.owner; waiter.resolve(); return
    }
  }
  private require(token: EpisodeWriterToken): Owner {
    const owner = this.owners.get(token)
    if (!owner || owner.token.signal.aborted) throw new Error('Episode writer token is absent or revoked')
    for (let parent = owner.parent; parent; parent = parent.parent) if (parent.token.signal.aborted) throw new Error('Parent episode writer revoked')
    if (this.blocked) throw this.blocked
    return owner
  }
  private assertLease(): void {
    if (this.blocked) throw this.blocked
    try { assertHeldThreadLease(this.lease.threadDir, this.lease) }
    catch (error) {
      this.blocked = error instanceof Error ? error : new Error(String(error))
      for (const owner of this.owners.values()) owner.abort.abort()
      throw this.blocked
    }
  }
}
