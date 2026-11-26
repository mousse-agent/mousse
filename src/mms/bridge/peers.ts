import { NetError } from '../../shared/net/errors'
import type { NodeDelegation, NodeId, Roster, StoredRecord, StreamId } from '../../shared/net'
import type { BridgeNodePolicy } from '../../shared/net/local'
import type { SelfUpdateReport } from '../../shared/updates'
import type { NetService } from '../net/NetService'
import { engineControl } from '../netEngine/limits'
import type { BridgeClient } from '../netEngine/session/client'
import { accountDevices } from './remote/botReach'
import type { ComputerRef } from './routed/computerErrors'
import { deviceNameOf } from './routed/deviceName'
import { isListedComputer } from './routed/listRows'

export type { BridgeClient }

/** One `bridge.nodes` row. v1 rows come from `NetService.nodesView()`; engine rows carry `source: 'engine'`. */
export interface PeerRow {
  node: NodeId
  name?: string
  caps: string[]
  kind: string
  policy: BridgeNodePolicy
  self: boolean
  keeper: boolean
  connection: string
  routeHeld: boolean
  revoked: boolean
  state: string
  source?: 'engine'
  /** What the computer last said of itself; absent until it did, and from one too old to say. */
  version?: string
  platform?: string
  arch?: string
  update?: SelfUpdateReport
  lastSeenAt?: number
  /** Its version is older or newer than this computer's; false when either is unknown. */
  olderThanThis?: boolean
  newerThanThis?: boolean
  /** It follows another update channel (nightly or stable), so neither is simply behind. */
  otherChannel?: boolean
}

/** The engine half of the directory (`NetEngineService`). */
export interface EngineDirectoryPort {
  on(): boolean
  /** The engine's switch is off, or it has started: what it lists is known. */
  settled(): boolean
  rows(): PeerRow[]
  /** Whether `node` is one of this profile's engine pairings (in any state). */
  isEngine(node: NodeId): boolean
  serving(node: NodeId): boolean
  name(node: NodeId): string | undefined
  client(node: NodeId): BridgeClient
  online(node: NodeId): boolean
  bind(stream: StreamId, node: NodeId): void
  verifyStream(stream: StreamId): void
  publish(stream: StreamId, record: StoredRecord): void
  publishDelta(stream: StreamId, data: unknown, key?: string): void
  failStream(stream: StreamId, code: import('../../shared/net').NetErrorCode): void
  isSubscribed(stream: StreamId, node?: NodeId): boolean
  endServing(node: NodeId, filter?: (stream: StreamId) => boolean): void
}

/**
 * The other computers Bridge can reach, from v1 (while its networking is on) and from engine pairings, behind one
 * port: who they are, a client for each, and the fan-out of what this computer serves them.
 */
export class PeerDirectory {
  private readonly listeners = new Set<() => void>()
  constructor(
    private readonly options: {
      net: Pick<
        NetService,
        | 'featureEnabled'
        | 'nodesView'
        | 'runtime'
        | 'session'
        | 'publish'
        | 'publishDelta'
        | 'discardDeltas'
        | 'failStream'
        | 'streamSubscribed'
      >
      engine(): EngineDirectoryPort | undefined
    }
  ) {}

  /** The engine is on for this profile. */
  engineOn(): boolean {
    return !!this.engine()
  }
  private v1On(): boolean {
    return this.options.net.featureEnabled('netBridge')
  }
  private engine(): EngineDirectoryPort | undefined {
    // The picker check's control: a directory that reads only the v1 roster.
    if (engineControl('roster-only-directory')) return undefined
    const engine = this.options.engine()
    return engine?.on() ? engine : undefined
  }

  /** Called when an engine pairing comes online, goes offline or is released. */
  onChange(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }
  changed(): void {
    for (const listener of [...this.listeners]) {
      try {
        listener()
      } catch {
        // One listener's failure does not keep the others from hearing.
      }
    }
  }

  /**
   * The owner's other devices: v1's roster (not revoked, not this one) and the engine pairings that are serving.
   * Undefined when v1 is the only source and its roster cannot be read.
   */
  accountDevices(): NodeId[] | undefined {
    // While the engine is still starting its pairings are not known yet: no device is taken as gone.
    if (!engineControl('roster-only-directory') && this.options.engine()?.settled() === false)
      return undefined
    const engine = this.engine()
    let v1: NodeId[] | undefined
    try {
      v1 = accountDevices(this.options.net.runtime().identity)
    } catch {
      v1 = undefined
    }
    if (!engine) return v1
    return [...(v1 ?? []), ...engine.rows().map((row) => row.node)]
  }

  /** Whether `node` is connected here: v1's connection table, or an open, ready engine client. */
  connected(node: NodeId): boolean {
    const engine = this.engine()
    if (engine?.isEngine(node)) return engine.online(node)
    try {
      return this.options.net.runtime().connections.connected(node)
    } catch {
      return false
    }
  }

  /** The `bridge.nodes` view: v1's rows while v1 is on, then the engine's pairings. */
  async nodes(): Promise<{ nodes: PeerRow[] }> {
    const engine = this.engine()
    if (!this.v1On() && !engine) throw new NetError('disabled')
    const v1 = this.v1On()
      ? ((await this.options.net.nodesView()) as { nodes: PeerRow[] }).nodes
      : []
    return { nodes: [...v1, ...(engine?.rows() ?? [])] }
  }

  /**
   * The other computers whose threads are listed: v1 devices of the roster that are not this one, not revoked,
   * connected here, not blocked and not phones; then the engine pairings that serve and are not blocked.
   * `undefined` when v1 is the only source and its roster cannot be read.
   */
  computers(): ComputerRef[] | undefined {
    const engine = this.engine()
    const v1 = this.v1On() ? v1Computers(this.options.net) : []
    if (!v1 && !engine) return undefined
    const rt = engine ? this.options.net.runtime() : undefined
    const paired = (engine?.rows() ?? [])
      .filter((row) => !rt!.policy.get(row.node).blocked)
      .map((row) => ({ node: row.node, name: row.name || 'the other computer' }))
    return [...(v1 ?? []), ...paired]
  }

  name(node: NodeId, fallback = 'the other computer'): string {
    const engine = this.options.engine()
    if (engine?.isEngine(node)) return engine.name(node) || fallback
    try {
      return deviceNameOf(this.options.net.runtime().identity, node, fallback)
    } catch {
      return fallback
    }
  }

  has(node: NodeId): boolean {
    return !!this.computers()?.some((row) => row.node === node)
  }

  /** Whether `node` is an engine pairing; the Hub's engine branch and `bridge.hub.*` read it. */
  isEngine(node: NodeId): boolean {
    return !!this.options.engine()?.isEngine(node)
  }

  /** A client for calls to `node`; `peer_offline` when none is open. */
  client(node: NodeId): BridgeClient {
    const engine = this.options.engine()
    if (engine?.isEngine(node)) {
      if (!engine.on()) throw new NetError('peer_offline')
      return engine.client(node)
    }
    return this.options.net.session(node)
  }

  online(node: NodeId): boolean {
    try {
      return this.client(node).state() === 'open'
    } catch {
      return false
    }
  }

  /** An engine pairing that is serving (not removing or removed). */
  serving(node: NodeId): boolean {
    return !!this.engine()?.serving(node)
  }

  bind(stream: StreamId, node: NodeId): void {
    const engine = this.engine()
    if (!engine) throw new NetError('peer_offline')
    engine.bind(stream, node)
  }

  /** §3.4 on reopen: a stream read from a pairing reads only while bound to one that is serving. */
  verifyStream(stream: StreamId): void {
    const engine = this.options.engine()
    if (!engine?.on()) throw new NetError('forbidden')
    engine.verifyStream(stream)
  }

  async publish(stream: StreamId, record: StoredRecord): Promise<void> {
    const engine = this.engine()
    engine?.publish(stream, record)
    try {
      await this.options.net.publish(stream, record)
    } catch (error) {
      // With v1 off the engine is the only path.
      if (!(engine && error instanceof NetError && error.code === 'disabled')) throw error
    }
  }
  publishDelta(stream: StreamId, data: unknown, key?: string): void {
    this.engine()?.publishDelta(stream, data, key)
    this.options.net.publishDelta(stream, data, key)
  }
  discardDeltas(stream: StreamId, matches: (key: string) => boolean): void {
    // Engine deltas are written as they come: there is no queue of unsent ones to drop.
    this.options.net.discardDeltas(stream, matches)
  }
  async failStream(stream: StreamId, code: import('../../shared/net').NetErrorCode): Promise<void> {
    this.engine()?.failStream(stream, code)
    await this.options.net.failStream(stream, code)
  }
  isSubscribed(stream: StreamId, node?: NodeId): boolean {
    return (
      this.options.net.streamSubscribed(stream, node) ||
      !!this.engine()?.isSubscribed(stream, node)
    )
  }
}

/** The v1 half of `computers()`, from the signed roster. */
function v1Computers(net: Pick<NetService, 'runtime'>): ComputerRef[] | undefined {
  try {
    const rt = net.runtime()
    const identity = rt.identity
    const self = identity.self()
    const root = self && identity.pinnedRootKey(self.user)
    const signed = self && identity.roster(self.user)
    if (!self || !root || !signed) return undefined
    const roster = identity.verifySigned<Roster>(signed, root)
    const latest = new Map<string, NodeDelegation>()
    for (const row of roster.nodes) {
      const found = identity.verifySigned<NodeDelegation>(row, root)
      const known = latest.get(found.subject)
      if (
        !known ||
        found.keyEpoch > known.keyEpoch ||
        (found.keyEpoch === known.keyEpoch && found.issuedAt > known.issuedAt)
      )
        latest.set(found.subject, found)
    }
    return [...latest.values()]
      .filter(
        (found) =>
          found.subject !== self.node &&
          !roster.revoked.some(
            (row) => row.subject === found.subject && row.throughKeyEpoch >= found.keyEpoch
          ) &&
          rt.connections.connected(found.subject as NodeId) &&
          !rt.policy.get(found.subject as NodeId).blocked &&
          isListedComputer(rt.enrollment.nodeKind(found.subject as NodeId), found.caps)
      )
      .map((found) => ({ node: found.subject as NodeId, name: found.name || 'the other computer' }))
  } catch {
    return undefined
  }
}
