import { createHash } from 'node:crypto'
import type { Duplex } from 'node:stream'
import type {
  Clock,
  OpenSecureChannel,
  PeerRef,
  RouteHealth,
  RouteManager,
  SecureChannel,
  TlsCredentials,
  Transport
} from '../contracts'
import type { NodeId, Route, RoutesRecord } from '../../../shared/net'
import { NetError } from '../../../shared/net/errors'
import {
  BACKOFF_MAX_MS,
  BACKOFF_MIN_MS,
  BACKOFF_RESET_AFTER_SESSION_MS,
  DIAL_CONNECT_DEADLINE_MS,
  DIAL_RESOLVE_DEADLINE_MS,
  DIAL_TLS_DEADLINE_MS
} from '../../../shared/net/limits'
import { systemClock } from '../clock'
import { openSecureChannel } from './secureChannel'

type RouteState = RouteHealth & { failures: number; retryAt: number }
export interface RouteManagerOptions {
  node: NodeId
  transports: Transport[]
  credentials: TlsCredentials
  clock?: Clock
  openChannel?: OpenSecureChannel
  staggerMs?: number
  random?: () => number
  /** Seed from the profile's last published route version on restart. */
  routesVersion?: number
}

export class RouteManagerImpl implements RouteManager {
  private readonly clock: Clock
  private readonly transports: Map<string, Transport>
  private readonly states = new Map<NodeId, Map<string, RouteState>>()
  private readonly stable = new Map<
    SecureChannel,
    { state: RouteState; timer?: { cancel(): void } }
  >()
  private routesRecord?: RoutesRecord
  private routesVersion: number
  constructor(private readonly options: RouteManagerOptions) {
    this.clock = options.clock ?? systemClock
    this.transports = new Map(options.transports.map((transport) => [transport.id, transport]))
    if (this.transports.size !== options.transports.length)
      throw new NetError('bad_request', 'Duplicate transport registration.')
    this.routesVersion = options.routesVersion ?? 0
    if (
      !Number.isSafeInteger(this.routesVersion) ||
      this.routesVersion < 0 ||
      (options.staggerMs !== undefined &&
        (!Number.isFinite(options.staggerMs) || options.staggerMs < 0))
    )
      throw new NetError('bad_request', 'Invalid route manager options.')
  }
  private key(route: Route): string {
    return JSON.stringify([route.transport, route.address, route.priority])
  }
  private state(peer: NodeId, route: Route): RouteState {
    let states = this.states.get(peer)
    if (!states) {
      states = new Map()
      this.states.set(peer, states)
    }
    const key = this.key(route)
    let state = states.get(key)
    if (!state) {
      state = { route: { ...route }, state: 'unknown', failures: 0, retryAt: 0 }
      states.set(key, state)
    }
    return state
  }
  health(peer: NodeId): RouteHealth[] {
    return [...(this.states.get(peer)?.values() ?? [])].map(
      ({ route, state, lastError, lastOkAt }) => ({
        route: { ...route },
        state,
        ...(lastError ? { lastError } : {}),
        ...(lastOkAt !== undefined ? { lastOkAt } : {})
      })
    )
  }
  localRoutes(): RoutesRecord {
    const routes = [...this.transports.values()]
      .flatMap((transport) => transport.status().routes)
      .sort((a, b) => a.priority - b.priority || this.key(a).localeCompare(this.key(b)))
    if (routes.length > 32) throw new NetError('too_large', 'Too many local routes.')
    if (!this.routesRecord || JSON.stringify(routes) !== JSON.stringify(this.routesRecord.routes)) {
      if (this.routesVersion >= Number.MAX_SAFE_INTEGER)
        throw new NetError('conflict', 'Route versions exhausted.')
      this.routesRecord = {
        v: 1,
        node: this.options.node,
        routes: routes.map((route) => ({ ...route })),
        version: ++this.routesVersion,
        issuedAt: this.clock.now()
      }
    }
    return { ...this.routesRecord, routes: this.routesRecord.routes.map((route) => ({ ...route })) }
  }
  /** The session calls this only after authenticated hello, not merely TLS completion. */
  markSessionOpen(channel: SecureChannel): void {
    const entry = this.stable.get(channel)
    if (!entry || entry.timer) return
    entry.timer = this.clock.setTimeout(() => {
      entry.state.failures = 0
      entry.state.retryAt = 0
    }, BACKOFF_RESET_AFTER_SESSION_MS)
  }
  private failed(state: RouteState, error: NetError): void {
    state.state = 'failing'
    state.lastError = error.code
    state.failures++
    const base = Math.min(BACKOFF_MAX_MS, BACKOFF_MIN_MS * 2 ** Math.min(state.failures - 1, 16))
    const random = this.options.random?.() ?? Math.random()
    state.retryAt =
      this.clock.monotonic() +
      Math.min(
        BACKOFF_MAX_MS,
        Math.max(BACKOFF_MIN_MS, base * (0.75 + Math.min(1, Math.max(0, random)) * 0.5))
      )
  }
  private async phase<T>(
    run: (signal: AbortSignal) => Promise<T>,
    duration: number,
    parent: AbortSignal,
    dispose?: (value: T) => void
  ): Promise<T> {
    if (parent.aborted) throw new NetError('cancelled', undefined, { cause: parent.reason })
    const controller = new AbortController()
    return new Promise<T>((resolve, reject) => {
      let settled = false
      const clean = () => {
        timer.cancel()
        parent.removeEventListener('abort', aborted)
      }
      const finish = (error: NetError) => {
        if (settled) return
        settled = true
        clean()
        controller.abort(error)
        reject(error)
      }
      const aborted = () => finish(new NetError('cancelled', undefined, { cause: parent.reason }))
      const timer = this.clock.setTimeout(() => finish(new NetError('deadline_exceeded')), duration)
      parent.addEventListener('abort', aborted, { once: true })
      let promise: Promise<T>
      try {
        promise = run(controller.signal)
      } catch (cause) {
        promise = Promise.reject(cause)
      }
      void promise.then(
        (value) => {
          if (settled) {
            dispose?.(value)
            return
          }
          settled = true
          clean()
          resolve(value)
        },
        (cause) => {
          if (settled) return
          settled = true
          clean()
          reject(
            cause instanceof NetError
              ? cause
              : new NetError('route_unreachable', undefined, { cause })
          )
        }
      )
      if (parent.aborted) aborted()
    })
  }
  private wait(ms: number, signal: AbortSignal): Promise<void> {
    return this.phase(
      () =>
        new Promise((resolve) => {
          const timer = this.clock.setTimeout(resolve, ms)
          signal.addEventListener('abort', () => timer.cancel(), { once: true })
        }),
      ms + 1,
      signal
    )
  }
  connect(peer: PeerRef, signal: AbortSignal): Promise<{ channel: SecureChannel; route: Route }> {
    if (signal.aborted)
      return Promise.reject(new NetError('cancelled', undefined, { cause: signal.reason }))
    if (peer.routes.length === 0)
      return Promise.reject(new NetError('route_unreachable', 'Peer has no routes.'))
    if (peer.routes.length > 32)
      return Promise.reject(new NetError('too_large', 'Peer has too many routes.'))
    const routes = [...peer.routes].sort((a, b) => a.priority - b.priority)
    const currentKeys = new Set(routes.map((route) => this.key(route))),
      prior = this.states.get(peer.node)
    if (prior) for (const key of prior.keys()) if (!currentKeys.has(key)) prior.delete(key)
    const expectedPeerFingerprint = createHash('sha256')
      .update(Buffer.from(peer.transportKey, 'base64url'))
      .digest('base64url')
    return new Promise((resolve, reject) => {
      let finished = false,
        remaining = routes.length,
        lastError: NetError | undefined
      const controllers = new Set<AbortController>(),
        timers: Array<{ cancel(): void }> = []
      const clean = () => {
        signal.removeEventListener('abort', aborted)
        for (const timer of timers) timer.cancel()
        for (const controller of controllers) controller.abort()
      }
      const fail = (error: NetError) => {
        if (finished) return
        finished = true
        clean()
        reject(error)
      }
      const aborted = () => fail(new NetError('cancelled', undefined, { cause: signal.reason }))
      signal.addEventListener('abort', aborted, { once: true })
      const attempt = async (route: Route) => {
        if (finished) return
        const controller = new AbortController()
        controllers.add(controller)
        const state = this.state(peer.node, route)
        let raw: Duplex | undefined, channel: SecureChannel | undefined
        try {
          if (state.retryAt > this.clock.monotonic())
            await this.wait(state.retryAt - this.clock.monotonic(), controller.signal)
          const transport = this.transports.get(route.transport)
          if (!transport || transport.status().state !== 'ready')
            throw new NetError('route_unreachable', 'Transport is unavailable.')
          await this.phase(
            async (phaseSignal) => {
              if ('resolve' in transport && typeof transport.resolve === 'function')
                await (transport.resolve as (route: Route, signal: AbortSignal) => Promise<void>)(
                  route,
                  phaseSignal
                )
            },
            DIAL_RESOLVE_DEADLINE_MS,
            controller.signal
          )
          raw = await this.phase(
            (phaseSignal) => transport.dial(route, phaseSignal),
            DIAL_CONNECT_DEADLINE_MS,
            controller.signal,
            (stream) => stream.destroy()
          )
          channel = await this.phase(
            (phaseSignal) =>
              (this.options.openChannel ?? openSecureChannel)(raw!, {
                role: 'client',
                credentials: this.options.credentials,
                expectedPeerFingerprint,
                deadlineMs: DIAL_TLS_DEADLINE_MS,
                signal: phaseSignal
              }),
            DIAL_TLS_DEADLINE_MS,
            controller.signal,
            (late) => late.close()
          )
          // An injected opener must honor the same pin contract as the production TLS gate.
          if (channel.peerTransportKey !== peer.transportKey)
            throw new NetError('peer_key_mismatch')
          if (finished) {
            channel.close()
            return
          }
          finished = true
          controllers.delete(controller)
          clean()
          state.state = 'ok'
          state.lastError = undefined
          state.lastOkAt = this.clock.now()
          const opened = channel,
            entry = { state } as { state: RouteState; timer?: { cancel(): void } }
          this.stable.set(opened, entry)
          opened.stream.once('close', () => {
            entry.timer?.cancel()
            this.stable.delete(opened)
          })
          const cancelOpened = () => opened.close()
          signal.addEventListener('abort', cancelOpened, { once: true })
          opened.stream.once('close', () => signal.removeEventListener('abort', cancelOpened))
          resolve({ channel: opened, route })
        } catch (cause) {
          channel?.close()
          raw?.destroy()
          const error =
            cause instanceof NetError
              ? cause
              : new NetError('route_unreachable', undefined, { cause })
          if (finished) return
          if (error.code !== 'cancelled') this.failed(state, error)
          lastError = error
          if (
            !['route_unreachable', 'deadline_exceeded', 'peer_offline', 'rate_limited'].includes(
              error.code
            )
          ) {
            fail(error)
            return
          }
          if (--remaining === 0) fail(lastError)
        } finally {
          controllers.delete(controller)
        }
      }
      routes.forEach((route, index) => {
        if (index === 0) void attempt(route)
        else
          timers.push(
            this.clock.setTimeout(
              () => {
                void attempt(route)
              },
              (this.options.staggerMs ?? 250) * index
            )
          )
      })
      if (signal.aborted) aborted()
    })
  }
}
