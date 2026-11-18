import { NetError } from '../../shared/net/errors'
import type { NodeId, StreamId } from '../../shared/net'
import { engineLimits } from './limits'
import { EngineClient, type EngineClientPort } from './session/client'
import { EngineHost, type EngineHostPort } from './session/host'
import type { EngineConnection } from './session/transport'

export interface EngineSessionHooks {
  /** A client of this pairing answered `hello` and is the newest one: new calls use it. */
  onClientReady(node: NodeId): void
  /** The last open client of this pairing closed. */
  onClientClosed(node: NodeId): void
  /**
   * An outbound connection is the one in use and nothing waits on an older one any more: the helper is told
   * (`path.reopened`), which makes it current there and closes the older one with `PATH_REPLACED`.
   */
  onPathInUse?(connection: EngineConnection): void
  /** An inbound connection of this pairing came up or closed (whether it can reach this computer). */
  onServingChanged?(node: NodeId): void
}

/**
 * The open engine connections of one profile. Serving exists only on inbound connections and calling only on
 * outbound ones (§3.6). `client(node)` is the newest outbound connection that is open and handoff-ready; a
 * closing one clears the slot only while the slot still holds it.
 */
export class EngineSessions {
  private readonly ready = new Map<NodeId, EngineClient>()
  private readonly clients = new Map<NodeId, Set<EngineClient>>()
  private readonly hosts = new Set<EngineHost>()
  /** Each client's generation: the order its connection came up in, so the newest wins the slot. */
  private readonly generations = new WeakMap<EngineClient, number>()
  private generation = 0
  constructor(
    private readonly options: {
      host: EngineHostPort
      client: EngineClientPort
      name(): string
      hooks: EngineSessionHooks
    }
  ) {}

  /** Takes a connection the helper (or a test link) reports up. Resolves once an outbound one is ready. */
  async attach(connection: EngineConnection): Promise<void> {
    if (connection.direction === 'inbound') {
      const host = new EngineHost(connection, this.options.host)
      this.hosts.add(host)
      connection.onClose(() => {
        this.hosts.delete(host)
        this.options.hooks.onServingChanged?.(connection.peer)
      })
      this.options.hooks.onServingChanged?.(connection.peer)
      return
    }
    const node = connection.peer
    const client = new EngineClient(connection, this.options.client)
    this.generations.set(client, ++this.generation)
    const held = this.clients.get(node) ?? new Set<EngineClient>()
    held.add(client)
    this.clients.set(node, held)
    // The client's current connection closing (not an old path of a switch) ends it.
    client.onClosed(() => {
      held.delete(client)
      if (this.ready.get(node) !== client) return
      // The slot still holds this generation: hand it to the newest other open, handoff-ready one, if any.
      const next = [...held]
        .filter((other) => other.state() === 'open' && this.handoffReady.has(other))
        .sort((a, b) => this.generationOf(b) - this.generationOf(a))[0]
      if (next) this.ready.set(node, next)
      else {
        this.ready.delete(node)
        this.options.hooks.onClientClosed(node)
      }
    })
    await client.hello(this.options.name())
    if (client.state() !== 'open') throw new NetError('peer_offline')
    this.handoffReady.add(client)
    const current = this.ready.get(node)
    if (current && current !== client && current.state() === 'open') {
      // An older generation whose hello answered later does not take over from a newer one.
      if (this.generationOf(current) > this.generationOf(client)) return
      try {
        await this.switchPath(node, current, client)
      } catch (error) {
        held.delete(client)
        throw error
      }
      return
    }
    this.ready.set(node, client)
    this.options.hooks.onClientReady(node)
    this.options.hooks.onPathInUse?.(connection)
  }

  /**
   * The path switch (§3.6) onto a newer outbound connection of a pairing (a renewed path, or one a dial opened
   * while another was up; the helper keeps either waiting until the app says it moved): the client in use moves
   * there once every live subscription has its head on it, and the newer connection's own client is set aside, so
   * whoever holds the client in use keeps it. The old connection stays until the calls running on it are done
   * (or the drain bound passed); then the helper is told the new one is in use and closes the old one with
   * `PATH_REPLACED`. If the newer connection fails before the move, it is dropped and the old one stays.
   */
  private async switchPath(
    node: NodeId,
    current: EngineClient,
    candidate: EngineClient
  ): Promise<void> {
    const limits = engineLimits()
    const old = await current.switchTo(candidate.connection, limits.pathSwitchDeadlineMs)
    this.clients.get(node)?.delete(candidate)
    this.generations.set(current, this.generationOf(candidate))
    const next = candidate.connection
    void current.drained(old, limits.pathDrainMs).then(() => {
      if (next.isOpen()) this.options.hooks.onPathInUse?.(next)
    })
  }

  private readonly handoffReady = new WeakSet<EngineClient>()
  private generationOf(client: EngineClient): number {
    return this.generations.get(client) ?? 0
  }

  client(node: NodeId): EngineClient {
    const client = this.ready.get(node)
    if (!client || client.state() !== 'open') throw new NetError('peer_offline')
    return client
  }

  online(node: NodeId): boolean {
    return this.ready.get(node)?.state() === 'open'
  }

  /** Whether the other computer has a connection open to this one (it can reach this computer). */
  serving(node: NodeId): boolean {
    for (const host of this.hosts)
      if (host.connection.peer === node && host.connection.isOpen()) return true
    return false
  }

  /** A record was stored on `stream`: each subscription caught up on it sends it. */
  notify(stream: StreamId): void {
    for (const host of this.hosts) host.notify(stream)
  }
  publishDelta(stream: StreamId, data: unknown, key?: string): void {
    for (const host of this.hosts) host.publishDelta(stream, data, key)
  }
  fail(stream: StreamId, code: import('../../shared/net').NetErrorCode): void {
    for (const host of this.hosts) host.fail(stream, code)
  }
  isSubscribed(stream: StreamId, node?: NodeId): boolean {
    for (const host of this.hosts)
      if ((node === undefined || host.connection.peer === node) && host.serves(stream)) return true
    return false
  }
  /** Ends what a pairing's own connections served (its subscriptions here), as a block or a lost right does. */
  endServing(node: NodeId, filter?: (stream: StreamId) => boolean): void {
    for (const host of this.hosts) if (host.connection.peer === node) host.endSubscriptions(filter)
  }

  /** Closes every connection of a pairing (revocation or removal). */
  teardown(node: NodeId, reason: string): void {
    for (const host of [...this.hosts])
      if (host.connection.peer === node) {
        host.endSubscriptions()
        host.connection.close(reason)
      }
    for (const client of [...(this.clients.get(node) ?? [])]) client.close(reason)
  }

  closeAll(reason: string): void {
    for (const host of [...this.hosts]) host.connection.close(reason)
    for (const held of this.clients.values()) for (const client of [...held]) client.close(reason)
  }
}
