import type { BlobId, EventId, RpcId, StreamId, WireMessage } from '../../../shared/net'
import { NetError, type NetErrorCode } from '../../../shared/net/errors'
import { SESSION_MAX_SUBSCRIPTIONS } from '../../../shared/net/limits'
import type { Clock, IdentityService, QualifiedClockEstimate, SessionState, SubscriptionHandlers, SyncSession } from '../contracts'
import { systemClock } from '../clock'

/** Reconnects authenticated sessions and reattaches reads from their durable cursors.
 * Mutations are never blindly replayed; callers retain their outbox/RPC journals.
 */
export class SyncSupervisor implements SyncSession {
  private readonly clock: Clock
  private active?: SyncSession
  private lastPeer?: SyncSession['peer']
  private stopped = false
  private connecting = false
  private blocked = false
  private attempt?: AbortController
  private retry?: { cancel(): void }
  private renewal?: { cancel(): void }
  private closeConnection?: () => void
  private rosterListener?: () => void
  private failures = 0
  private openedAt = 0
  private subscriptions = new Map<StreamId, { handlers: SubscriptionHandlers; detach?: () => void }>()
  private closed = new Set<(error?: Error) => void>()
  private ephemeral = new Set<(message: Extract<WireMessage, { t: 'presence' | 'ephemeral' }>) => void>()
  private detachEphemeral?: () => void
  private firstResolve!: () => void
  private firstReject!: (error: unknown) => void
  readonly opened: Promise<void>
  constructor(private readonly options: {
    /** Resolves only after both authentication/hello gates; must honor cancellation. */
    connect(signal: AbortSignal): Promise<SyncSession>
    identity: IdentityService
    clock?: Clock
    random?: () => number
  }) {
    this.clock = options.clock ?? systemClock
    this.opened = new Promise((resolve, reject) => { this.firstResolve = resolve; this.firstReject = reject })
    void this.opened.catch(() => {})
    this.rosterListener = options.identity.onRosterChanged(() => {
      if (this.blocked && !this.stopped) { this.blocked = false; this.failures = 0; void this.connect() }
    })
    this.scheduleRenewal()
    void this.connect()
  }
  get peer(): SyncSession['peer'] { if (!this.lastPeer) throw new NetError('not_enrolled'); return this.lastPeer }
  state(): SessionState { return this.stopped || this.blocked ? 'closed' : this.active ? this.active.state() : 'connecting' }
  clockOffsetMs(): number { return this.active?.clockOffsetMs() ?? 0 }
  clockEstimate(): QualifiedClockEstimate | undefined { return this.active?.clockEstimate() }
  subscribe(stream: StreamId, handlers: SubscriptionHandlers): { close(): void } {
    if (this.stopped) throw new NetError('peer_offline')
    if (this.subscriptions.has(stream)) throw new NetError('conflict')
    if (this.subscriptions.size >= SESSION_MAX_SUBSCRIPTIONS) throw new NetError('rate_limited')
    const subscription: { handlers: SubscriptionHandlers; detach?: () => void } = { handlers }
    this.subscriptions.set(stream, subscription)
    if (this.active) this.attach(stream, subscription)
    return { close: () => { if (this.subscriptions.get(stream) !== subscription) return; subscription.detach?.(); this.subscriptions.delete(stream) } }
  }
  append(stream: StreamId, id: EventId, bytes: Uint8Array, sig: Uint8Array): ReturnType<SyncSession['append']> { return this.session().append(stream, id, bytes, sig) }
  metaHead(stream: StreamId): ReturnType<SyncSession['metaHead']> { return this.session().metaHead(stream) }
  putBlob(stream: StreamId, blob: BlobId, bytes: Uint8Array, sealed: boolean): Promise<void> { return this.session().putBlob(stream, blob, bytes, sealed) }
  getBlob(stream: StreamId, blob: BlobId): Promise<Uint8Array> { return this.session().getBlob(stream, blob) }
  rpc(method: string, params: unknown, options: Parameters<SyncSession['rpc']>[2]): Promise<unknown> { return this.session().rpc(method, params, options) }
  rpcResult(id: RpcId, options: Parameters<SyncSession['rpcResult']>[1]): Promise<unknown> { return this.session().rpcResult(id, options) }
  rpcCancel(id: RpcId): Promise<void> { return this.session().rpcCancel(id) }
  sendEphemeral(message: Parameters<SyncSession['sendEphemeral']>[0]): void { this.session().sendEphemeral(message) }
  onEphemeral(listener: Parameters<SyncSession['onEphemeral']>[0]): () => void { this.ephemeral.add(listener); return () => this.ephemeral.delete(listener) }
  onClosed(listener: (error?: Error) => void): () => void { this.closed.add(listener); return () => this.closed.delete(listener) }
  /** Explicit credential/route/protocol change; fatal identity errors never spin. */
  retryAfterStateChange(): void { if (this.stopped) return; this.blocked = false; this.failures = 0; void this.connect() }
  close(code: NetErrorCode = 'cancelled'): void {
    if (this.stopped) return
    this.stopped = true; this.retry?.cancel(); this.renewal?.cancel(); this.rosterListener?.(); this.attempt?.abort()
    this.closeConnection?.(); this.detachEphemeral?.()
    for (const sub of this.subscriptions.values()) sub.detach?.()
    this.subscriptions.clear(); this.active?.close(code); this.active = undefined
    this.firstReject(new NetError(code)); this.notifyClosed(new NetError(code))
    this.closed.clear(); this.ephemeral.clear()
  }
  private session(): SyncSession { if (!this.active || this.active.state() !== 'open') throw new NetError('peer_offline'); return this.active }
  private async connect(): Promise<void> {
    if (this.stopped || this.connecting || this.active || this.blocked) return
    this.retry?.cancel(); this.connecting = true
    const attempt = new AbortController(); this.attempt = attempt
    try {
      const session = await this.options.connect(attempt.signal)
      if (this.stopped || attempt.signal.aborted) { session.close(); return }
      if (session.state() !== 'open') { session.close(); throw new NetError('peer_offline') }
      this.active = session; this.lastPeer = session.peer; this.openedAt = this.clock.monotonic()
      this.closeConnection = session.onClosed(error => {
        if (this.active !== session) return
        this.active = undefined; this.closeConnection?.(); this.detachEphemeral?.()
        for (const sub of this.subscriptions.values()) sub.detach = undefined
        if (this.clock.monotonic() - this.openedAt >= 30_000) this.failures = 0
        this.notifyClosed(error)
        if (!this.stopped) this.scheduleRetry(error)
      })
      this.detachEphemeral = session.onEphemeral(message => { for (const listener of this.ephemeral) listener(message) })
      for (const [stream, sub] of this.subscriptions) this.attach(stream, sub)
      this.firstResolve()
    } catch (error) { if (!this.stopped) this.scheduleRetry(error) }
    finally { this.connecting = false; if (this.attempt === attempt) this.attempt = undefined }
  }
  private attach(stream: StreamId, sub: { handlers: SubscriptionHandlers; detach?: () => void }): void {
    try { sub.detach = this.session().subscribe(stream, sub.handlers).close }
    catch (error) { sub.handlers.onError(error instanceof NetError ? error.code : 'internal') }
  }
  private scheduleRetry(error: unknown): void {
    const retryable = error instanceof NetError && ['route_unreachable', 'peer_offline', 'deadline_exceeded'].includes(error.code)
    if (!retryable) { this.blocked = true; this.firstReject(error); return }
    const maximum = Math.min(60_000, 1_000 * 2 ** Math.min(this.failures++, 6))
    const random = this.options.random?.() ?? Math.random()
    const delay = Math.max(1_000, Math.min(60_000, maximum * (0.5 + Math.max(0, Math.min(1, random)) * 0.5)))
    this.retry = this.clock.setTimeout(() => { void this.connect() }, delay)
  }
  private scheduleRenewal(): void {
    this.renewal = this.clock.setTimeout(() => {
      if (this.stopped) return
      try { this.options.identity.renewExpiring(this.clock.now()) } catch { /* A locked/follower/conflicted identity cannot renew itself. */ }
      this.scheduleRenewal()
    }, 60 * 60 * 1_000)
  }
  private notifyClosed(error?: Error): void { for (const listener of this.closed) { try { listener(error) } catch { /* Lifecycle notification cannot retain sockets. */ } } }
}
