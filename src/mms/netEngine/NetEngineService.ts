import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { hostname } from 'node:os'
import { join } from 'node:path'
import { NetError } from '../../shared/net/errors'
import type { BlobId, NodeCapability, NodeId, StoredRecord, StreamId } from '../../shared/net'
import type { BridgeNodePolicy } from '../../shared/net/local'
import { ENGINE_OWNER_METHODS } from '../../shared/netEngine/allowlist'
import type { BridgeProfileService } from '../bridge/BridgeProfileService'
import type { EngineDirectoryPort, PeerRow } from '../bridge/peers'
import { checkNodePolicy } from '../net/checkNodePolicy'
import type { EngineCaller, RpcMethod } from '../net/contracts'
import type { NetRuntime, NetService } from '../net/NetService'
import type { NodePolicy, NodePolicyChange } from '../net/store/nodePolicy'
import { engineLimitProblems, engineLimits } from './limits'
import { EngineSessions } from './sessions'
import type { BridgeClient, EngineClient } from './session/client'
import type { EngineConnection } from './session/transport'
import { EnginePeerStore, type EnginePeerRow } from './store'

export const NON_KEEPER_MESSAGE =
  "This profile's network is managed by another computer. Turn its networking on, or Start over."

interface EngineSettings {
  enabled: boolean
  profile: string
}

interface Started {
  rt: NetRuntime
  peers: EnginePeerStore
  sessions: EngineSessions
  timer: ReturnType<typeof setInterval>
  /** Aborted at a pairing's revocation: its handlers stop, nothing else does. */
  revocations: Map<NodeId, AbortController>
}

const policyView = (policy: NodePolicy): BridgeNodePolicy => ({
  blocked: policy.blocked,
  maxPermissionMode: policy.maxPermissionMode,
  terminal: policy.terminal,
  editor: policy.editor,
  bots: policy.bots,
  agentReach: policy.agentReach,
  work: policy.work
})

/**
 * The engine side of one profile's networking (Phase 1a): its pairings, their sessions and the policy for their
 * calls. It runs on the profile's net runtime (`net.db`, the dispatcher, the stream store) without v1's transports,
 * so remote threads and terminals work with v1 networking off.
 */
export class NetEngineService implements EngineDirectoryPort {
  private started?: Started
  private starting?: Promise<void>
  constructor(
    private readonly options: {
      profileDir: string
      profileId: string
      net: NetService
      bridge(): BridgeProfileService | undefined
      /** The name this computer gives itself in `hello` and when it bootstraps an identity. */
      name?: () => string
    }
  ) {
    options.net.onSetAside((suffix) => this.setAside(suffix))
  }

  private get directory(): string {
    return join(this.options.profileDir, 'net-engine')
  }
  private get settingsPath(): string {
    return join(this.directory, 'settings.json')
  }
  private selfName(): string {
    return this.options.name?.() ?? hostname()
  }

  settings(): EngineSettings | undefined {
    try {
      const value = JSON.parse(readFileSync(this.settingsPath, 'utf8')) as Partial<EngineSettings>
      return value && typeof value.enabled === 'boolean' && typeof value.profile === 'string'
        ? { enabled: value.enabled, profile: value.profile }
        : undefined
    } catch {
      return undefined
    }
  }

  /** Whether the engine is on and serving for this profile now. */
  on(): boolean {
    return !!this.started
  }

  /** Turns the switch on and starts. */
  async enable(): Promise<void> {
    mkdirSync(this.directory, { recursive: true })
    writeFileSync(
      this.settingsPath,
      JSON.stringify({ enabled: true, profile: this.options.profileId } satisfies EngineSettings)
    )
    await this.start()
  }

  /**
   * Starts when the switch is on: builds the net runtime (no transport starts, `net.status` stays off),
   * bootstraps this profile's author if it has none, renews its delegation and activates Bridge.
   */
  start(): Promise<void> {
    if (this.started) return Promise.resolve()
    this.starting ??= this.startNow().finally(() => (this.starting = undefined))
    return this.starting
  }

  private async startNow(): Promise<void> {
    if (!this.settings()?.enabled) return
    // The limits are read once, here; a variable with a bad value keeps its default and is said so.
    for (const problem of engineLimitProblems()) console.warn(`network engine limit: ${problem}`)
    const { net } = this.options
    const rt = net.runtime()
    if (!rt.identity.self()) await rt.identity.bootstrapAuthority(this.selfName())
    if (rt.identity.isKeeper()) rt.identity.renewSelf(engineLimits().renewDueWithinMs)
    // A profile that joined another computer's network cannot renew its own delegation: v1 renews it through
    // that computer, so the engine runs only while v1 is on.
    else if (!net.featureEnabled('netBridge'))
      throw new NetError('forbidden', NON_KEEPER_MESSAGE, { details: { reason: 'not_keeper' } })
    const peers = new EnginePeerStore(rt.db)
    const revocations = new Map<NodeId, AbortController>()
    const sessions = new EngineSessions({
      name: () => this.selfName(),
      host: {
        rpc: rt.rpc,
        get store() {
          return bridge().threads.store
        },
        blobs: rt.blobs,
        now: () => Date.now(),
        caller: (connection) => this.callerOf(connection),
        revoked: (caller) => {
          let controller = revocations.get(caller.node)
          if (!controller) revocations.set(caller.node, (controller = new AbortController()))
          return controller.signal
        },
        assertReadable: (stream, caller) => this.assertReadable(stream, caller),
        canFetchBlob: (stream, blob, caller) => this.canFetchBlob(stream, blob, caller),
        artifacts: {
          acceptBlob: (...args) => bridge().artifacts.acceptBlob(...args),
          blobCommitted: (...args) => bridge().artifacts.blobCommitted(...args),
          append: (...args) => bridge().artifacts.append(...args)
        },
        name: () => this.selfName()
      },
      client: {
        get store() {
          return bridge().threads.store
        },
        verify: (stream, _record, _snapshot, client) => this.verifyIngest(stream, client)
      },
      hooks: {
        onClientReady: (node) => this.options.bridge()?.peerOnline(node),
        onClientClosed: (node) => this.options.bridge()?.peerOffline(node)
      }
    })
    const bridge = (): BridgeProfileService => {
      const service = this.options.bridge()
      if (!service) throw new NetError('disabled')
      return service
    }
    const timer = setInterval(() => {
      try {
        this.renew()
      } catch {
        // Tried again on the next tick; the host keeps serving on its current delegation until it lapses.
      }
    }, engineLimits().renewIntervalMs)
    timer.unref?.()
    this.started = { rt, peers, sessions, timer, revocations }
    net.setEngineAuthorizer((method, caller, capability) =>
      this.authorizeEngine(method, caller, capability)
    )
    bridge().activateBridge()
  }

  /** Renews this profile's own delegation when it is due (what the hourly timer runs). */
  renew(): void {
    const rt = this.require().rt
    if (rt.identity.isKeeper()) rt.identity.renewSelf(engineLimits().renewDueWithinMs)
  }

  async stop(): Promise<void> {
    await this.starting?.catch(() => undefined)
    const started = this.started
    if (!started) return
    this.started = undefined
    clearInterval(started.timer)
    this.options.net.setEngineAuthorizer(undefined)
    started.sessions.closeAll('stopped')
  }

  /** Start over: the engine stops and its folder goes aside with `net/` (its rows are in that `net.db`). */
  private async setAside(suffix: string): Promise<void> {
    await this.stop()
    if (existsSync(this.directory)) renameSync(this.directory, `${this.directory}.${suffix}`)
  }

  /**
   * The engine branch of the dispatcher's authorization: a live `owner` grant, a method on the allowlist, then
   * the same per-device policy v1 callers are held to.
   */
  authorizeEngine(method: RpcMethod, caller: EngineCaller, _capability: NodeCapability): void {
    const started = this.started
    if (!started) throw new NetError('forbidden')
    const row = started.peers.serving(caller.node)
    if (!row || row.grant !== caller.grant || caller.role !== 'owner')
      throw new NetError('forbidden')
    if (!ENGINE_OWNER_METHODS.has(method.method)) throw new NetError('forbidden')
    checkNodePolicy(method, caller.node, started.rt.policy, this.options.net.nodePolicyConfig())
  }

  /** `bridge.policy` for an engine pairing: what it may do here, kept in the same table as v1 devices'. */
  setPolicy(node: NodeId, change: NodePolicyChange): { policy: BridgeNodePolicy } {
    const started = this.require()
    if (!started.peers.serving(node)) throw new NetError('bad_request', 'Unknown device.')
    return { policy: policyView(started.rt.policy.set(node, change)) }
  }

  /** Saves a pairing (the end of the ceremony in later slices; tests pair directly). */
  pair(row: Omit<EnginePeerRow, 'localId' | 'pairedAt'> & { localId?: NodeId }): EnginePeerRow {
    return this.require().peers.add({ ...row, pairedAt: Date.now() })
  }

  /** A connection the helper reports up for one of this profile's pairings. */
  attach(connection: EngineConnection): Promise<void> {
    const started = this.require()
    if (!started.peers.serving(connection.peer)) {
      connection.close('unknown_peer')
      return Promise.reject(new NetError('forbidden'))
    }
    return started.sessions.attach(connection)
  }

  /**
   * Revocation or removal: within one turn the pairing's handlers are aborted, its subscriptions, blob reads and
   * staged writes end, the terminals it attached end, and its connections close. Idempotent.
   */
  teardown(node: NodeId): void {
    const started = this.started
    if (!started) return
    started.revocations.get(node)?.abort()
    started.revocations.delete(node)
    started.rt.rpc.abortCaller(node)
    started.sessions.teardown(node, 'grant_revoked')
    this.options.bridge()?.releaseNode(node)
  }

  // ---------------------------------------------------------------- the peer directory's engine half

  rows(): PeerRow[] {
    const started = this.started
    if (!started) return []
    return started.peers
      .all()
      .filter((row) => row.state !== 'removing' && row.state !== 'removed')
      .map((row) => ({
        node: row.localId,
        name: row.name,
        caps: ['read', 'chat', 'write', 'terminal', 'settings'],
        kind: 'computer',
        policy: policyView(started.rt.policy.get(row.localId)),
        self: false,
        keeper: false,
        connection: started.sessions.online(row.localId) ? 'connected' : 'disconnected',
        routeHeld: false,
        revoked: false,
        state: started.sessions.online(row.localId) ? 'open' : 'closed',
        source: 'engine'
      }))
  }
  isEngine(node: NodeId): boolean {
    return !!this.started?.peers.get(node)
  }
  serving(node: NodeId): boolean {
    return !!this.started?.peers.serving(node)
  }
  name(node: NodeId): string | undefined {
    return this.started?.peers.get(node)?.name
  }
  client(node: NodeId): BridgeClient {
    const started = this.started
    if (!started || !started.peers.serving(node)) throw new NetError('peer_offline')
    return started.sessions.client(node)
  }
  online(node: NodeId): boolean {
    const started = this.started
    return !!started && !!started.peers.serving(node) && started.sessions.online(node)
  }
  /** Binds a stream this computer reads to the pairing it reads it from (in the caller's transaction). */
  bind(stream: StreamId, node: NodeId): void {
    this.require().peers.bind(stream, node)
  }
  /** A stream read from a pairing reads only while it is bound to one that is still serving (§3.4, on reopen). */
  verifyStream(stream: StreamId): void {
    const started = this.started
    const node = started?.peers.binding(stream)
    if (!started || !node || !started.peers.serving(node)) throw new NetError('forbidden')
  }
  publish(stream: StreamId, _record: StoredRecord): void {
    this.started?.sessions.notify(stream)
  }
  publishDelta(stream: StreamId, data: unknown, key?: string): void {
    this.started?.sessions.publishDelta(stream, data, key)
  }
  failStream(stream: StreamId, code: import('../../shared/net').NetErrorCode): void {
    this.started?.sessions.fail(stream, code)
  }
  isSubscribed(stream: StreamId, node?: NodeId): boolean {
    return !!this.started?.sessions.isSubscribed(stream, node)
  }
  endServing(node: NodeId, filter?: (stream: StreamId) => boolean): void {
    this.started?.sessions.endServing(node, filter)
  }

  // ---------------------------------------------------------------- checks

  private require(): Started {
    if (!this.started) throw new NetError('disabled')
    return this.started
  }

  private callerOf(connection: EngineConnection): EngineCaller {
    const started = this.require()
    const row = started.peers.serving(connection.peer)
    const self = started.rt.identity.self()
    if (!row || !self || connection.direction !== 'inbound' || row.grant !== connection.grant)
      throw new NetError('forbidden')
    return {
      source: 'engine',
      node: row.localId,
      user: self.user,
      role: 'owner',
      grant: row.grant,
      endpoint: row.endpoint
    }
  }

  /**
   * §4.4: an engine caller reads only a routed private stream bound to it (open, its reader, its bound reader,
   * and allowed by current policy for the stream's kind) or a request artifact of its own.
   */
  private assertReadable(stream: StreamId, caller: EngineCaller): void {
    const started = this.require()
    const bridge = this.options.bridge()
    if (!bridge) throw new NetError('forbidden')
    const descriptor = bridge.threads.store.getStream(stream)
    if (!descriptor) throw new NetError('forbidden')
    if (descriptor.kind === 'node.artifact') {
      if (!bridge.artifacts.canRead(stream, caller)) throw new NetError('forbidden')
      return
    }
    const access = bridge.threads.privateAccess(stream)
    if (!access || !access.open || access.reader !== caller.node) throw new NetError('forbidden')
    const bound = bridge.threads.boundReader(stream)
    if (bound !== undefined && bound !== caller.node) throw new NetError('forbidden')
    const policy = started.rt.policy.get(caller.node)
    if (policy.blocked)
      throw new NetError('forbidden', undefined, { details: { reason: 'blocked' } })
    if (this.options.net.nodePolicyConfig().workOnThreads === false)
      throw new NetError('forbidden', undefined, { details: { reason: 'setting_off' } })
    if (access.kind === 'terminal' && !policy.terminal)
      throw new NetError('forbidden', undefined, { details: { reason: 'terminal_off' } })
  }

  private canFetchBlob(stream: StreamId, blob: BlobId, caller: EngineCaller): boolean {
    const bridge = this.options.bridge()
    if (!bridge) return false
    try {
      this.assertReadable(stream, caller)
    } catch {
      return false
    }
    return this.started!.rt.blobs.isReferenced(blob, stream)
  }

  /** The engine `verify` callback: the stream is bound to this client's pairing, which is serving and live. */
  private verifyIngest(stream: StreamId, client: EngineClient): void {
    const started = this.require()
    if (
      started.peers.binding(stream) !== client.node ||
      !started.peers.serving(client.node) ||
      client.state() !== 'open'
    )
      throw new NetError('forbidden')
  }
}
