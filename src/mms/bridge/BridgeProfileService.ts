import type { MmsProfileServices } from '../MmsProfileServices'
import type { NetDomainComposition, NetRuntime, NetService } from '../net/NetService'
import type { Clock, SyncSession } from '../net/contracts'
import { systemClock } from '../net/clock'
import { NodeStreamAuthority } from '../net/sync/nodeAuthority'
import { NetError, type Roster } from '../../shared/net'
import { parseProtocolJson } from '../net/sync/codec'
import { SpaceProfileService } from '../spaces/SpaceProfileService'
import { BridgeArtifacts } from './artifacts'
import { BridgeHub } from './hub'
import { validateHubParams } from './hub/validation'
import { MmsRemoteBackend, RemoteApi, ThreadStreamAdapter } from './remote'
import { MmsThreadSource } from './remote/MmsThreadSource'
import { DispatchService, mmsDispatchRuntime, type DispatchRuntime } from './dispatch'

/** Actual profile services own Bridge; no received DTO supplies a backend or path. */
export class BridgeProfileService {
  readonly spaces: SpaceProfileService
  readonly threads: ThreadStreamAdapter
  readonly artifacts: BridgeArtifacts
  readonly hub: BridgeHub
  readonly dispatch: DispatchService
  private readonly remote: RemoteApi
  private readonly clock: Clock
  private readonly tasks = new Set<Promise<unknown>>()
  private readonly disposers = new Set<() => void | Promise<void>>()
  private readonly domain: NetDomainComposition
  private stopped = false
  private closing?: Promise<void>

  constructor(readonly options: { services: MmsProfileServices; runtime: NetRuntime; net: NetService; clock?: Clock; dispatchRuntime?: DispatchRuntime }) {
    const { services, runtime: rt, net } = options
    this.clock = options.clock ?? systemClock
    this.spaces = new SpaceProfileService({ runtime: rt, net, clock: this.clock })
    this.threads = new ThreadStreamAdapter({ db: rt.db, store: this.spaces.store, generations: rt.streams, identity: rt.identity, keys: rt.keys, clock: this.clock,
      source: new MmsThreadSource(services), onRecord: (stream, record) => { void this.track(net.publish(stream, record)) } })
    this.remote = new RemoteApi(new MmsRemoteBackend(services), this.clock)
    for (const method of this.remote.methods()) rt.rpc.register({ ...method, handle: (params, context) => this.track(method.handle(params, context)) })
    rt.rpc.register({ method: 'bridge.thread.open', capability: 'read', mutating: false,
      validate: value => validateHubParams('bridge.thread.open', value),
      handle: async value => { const descriptor = this.threads.activate((value as { threadId: string }).threadId); return { descriptor, head: this.threads.store.head(descriptor.id) } } })
    this.hub = new BridgeHub({ db: rt.db, identity: rt.identity, keys: rt.keys, store: this.threads.store, clock: this.clock,
      session: node => net.session(node), resolveResult: (...args) => this.artifacts.resolveResult(...args) })
    this.artifacts = new BridgeArtifacts({ db: rt.db, identity: rt.identity, keys: rt.keys, store: this.threads.store, blobs: rt.blobs, rpc: rt.rpc, clock: this.clock,
      fallback: new NodeStreamAuthority(rt.identity, this.threads.store, rt.blobs, this.clock),
      ownsRequest: (...args) => this.hub.ownsRequest(...args), canonicalRequest: (...args) => this.hub.canonicalRequest(...args),
      onPublished: (stream, record) => { void this.track(net.publish(stream, record)) } })
    const concrete = options.dispatchRuntime ?? mmsDispatchRuntime({ profileId: services.profileId, orchestrator: services.orchestrator,
      resolveAgent: async id => {
        const domain = await services.platform.agentDomain('agentDefinitions.publish', { id })
        const definition = domain.resolver.resolve({ definitionId: id })
        // There is no durable target-owner approval surface for Dispatch yet.
        // Reject that configuration before model/worktree effects.
        if (definition.settings.approval.policy === 'always' || definition.settings.context.selectedFiles.length) throw new NetError('profile_unsupported')
        return definition
      }, approveToolRequest: async () => { throw new NetError('profile_unsupported') } })
    this.dispatch = new DispatchService({ db: rt.db, identity: rt.identity, installationHome: services.getHomeDir(), profileId: services.profileId, threads: services.threads,
      runtime: { resolveAgent: agent => concrete.resolveAgent(agent), run: request => this.track(concrete.run(request)) },
      artifacts: { readInput: async (ref, context) => this.artifacts.input(ref, context, 'bridge.dispatch'),
        prepareResult: async (bytes, context) => this.artifacts.preparePublication(bytes, 'application/x-git-bundle', context, 'bridge.dispatch') } })
    rt.rpc.register({ method: 'bridge.dispatch', capability: 'write', mutating: true, uploadEnabled: true,
      validate: value => validateHubParams('bridge.dispatch', value), handle: (value, context) => {
        if (!context.execution) throw new NetError('bad_request')
        return this.track(this.dispatch.run(value, context, context.execution))
      } })
    this.domain = this.spaces.composition(this.artifacts)
    void this.track(this.dispatch.recover())
  }

  composition(): NetDomainComposition {
    const session = this.domain.session!
    return { ...this.domain, store: this.threads.store,
      session: { ...session,
        retainRosterEvidence: (signed, peer) => {
          const self = this.options.runtime.identity.self(), roster = parseProtocolJson(Buffer.from(signed.payload, 'base64url')) as Roster
          if (self && roster.owner === self.user) {
            this.options.runtime.identity.verifySigned<Roster>(signed, this.options.runtime.identity.pinnedRootKey(self.user)!)
            this.spaces.evidence.retain(signed)
          } else session.retainRosterEvidence?.(signed, peer)
        },
        canReceive: (descriptor, peer) => descriptor.kind.startsWith('space.') ? session.canReceive!(descriptor, peer)
          : descriptor.kind === 'node.artifact' ? this.artifacts.canReceive(descriptor, peer) : this.hub.canReceive(descriptor, peer),
        verifyRecord: (record, descriptor, snapshot) => {
          if (descriptor.kind.startsWith('space.')) session.verifyRecord?.(record, descriptor, snapshot)
          else if (descriptor.kind === 'node.artifact') this.artifacts.verifyRecord(record, descriptor)
          else this.hub.verifyRecord(record, descriptor)
        } },
      onSessionOpened: (session: SyncSession) => {
        if (!this.stopped && session.peer.user === this.options.runtime.identity.self()?.user) void this.track(this.hub.reconnect(session.peer.node))
      }, close: () => this.close(), activeCount: () => this.activeCount() }
  }

  onClose(dispose: () => void | Promise<void>): () => void {
    if (this.stopped) throw new NetError('cancelled')
    this.disposers.add(dispose); return () => this.disposers.delete(dispose)
  }
  activeCount(): number { return this.tasks.size + this.hub.activeCount() + (this.domain.activeCount?.() ?? 0) }
  /** Trusted local connection producers retain profile ownership while draining. */
  ownDrain<T>(work: Promise<T>): Promise<T> { return this.track(work) }
  private track<T>(work: Promise<T>): Promise<T> {
    this.tasks.add(work); void work.then(() => this.tasks.delete(work), () => this.tasks.delete(work)); return work
  }
  close(): Promise<void> {
    if (this.closing) return this.closing
    this.stopped = true
    const disposals = [...this.disposers].map(dispose => { try { return Promise.resolve(dispose()) } catch (error) { return Promise.reject(error) } })
    this.disposers.clear(); this.remote.close(); this.hub.close(); this.threads.close()
    this.closing = (async () => {
      await Promise.allSettled(disposals); await this.hub.drain()
      while (this.tasks.size) await Promise.allSettled([...this.tasks])
      await this.dispatch.drainCleanup(); await this.spaces.close()
    })()
    return this.closing
  }
}
