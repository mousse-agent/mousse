import { NetError } from '../../shared/net/errors'
import type { NodeId, StreamId } from '../../shared/net'
import { EngineClient, type EngineClientPort } from './session/client'
import { EngineHost, type EngineHostPort } from './session/host'
import type { EngineConnection } from './session/transport'

export interface EngineSessionHooks {
  /** A client of this pairing answered `hello` and is the newest one: new calls use it. */
  onClientReady(node: NodeId): void
  /** The last open client of this pairing closed. */
  onClientClosed(node: NodeId): void
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
      connection.onClose(() => this.hosts.delete(host))
      return
    }
    const node = connection.peer
    const client = new EngineClient(connection, this.options.client)
    this.generations.set(client, ++this.generation)
    const held = this.clients.get(node) ?? new Set<EngineClient>()
    held.add(client)
    this.clients.set(node, held)
    connection.onClose(() => {
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
    // An older generation whose hello answered later does not take the slot from a newer one.
    const current = this.ready.get(node)
    if (
      current &&
      current.state() === 'open' &&
      this.generationOf(current) > this.generationOf(client)
    )
      return
    this.ready.set(node, client)
    this.options.hooks.onClientReady(node)
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
    for (const client of [...(this.clients.get(node) ?? [])]) client.connection.close(reason)
  }

  closeAll(reason: string): void {
    for (const host of [...this.hosts]) host.connection.close(reason)
    for (const held of this.clients.values())
      for (const client of [...held]) client.connection.close(reason)
  }
}
