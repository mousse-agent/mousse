import type { MmsProfileServices } from '../MmsProfileServices'
import type { NetDomainComposition, NetRuntime, NetService } from '../net/NetService'
import type { Clock, SyncSession } from '../net/contracts'
import { systemClock } from '../net/clock'
import { NodeStreamAuthority } from '../net/sync/nodeAuthority'
import { NetError, type Roster, type PresenceMessage, type BotId } from '../../shared/net'
import { parseProtocolJson, canonicalJson } from '../net/sync/codec'
import { SpaceProfileService } from '../spaces/SpaceProfileService'
import {SpaceArchiveService} from '../spaces/archive/SpaceArchiveService'
import { SpaceCurrentIdentity } from '../spaces/SpaceCurrentIdentity'
import { BotProfileService, type NativeBotComposition } from '../bots/BotProfileService'
import { BridgeArtifacts } from './artifacts'
import { BridgeHub } from './hub'
import { validateHubParams } from './hub/validation'
import { MmsRemoteBackend, RemoteApi, ThreadStreamAdapter } from './remote'
import { MmsThreadSource } from './remote/MmsThreadSource'
import { DispatchService, mmsDispatchRuntime, type DispatchRuntime } from './dispatch'

/** Actual profile services own Bridge; no received DTO supplies a backend or path. */
export class BridgeProfileService {
  readonly spaces: SpaceProfileService
  readonly archives:SpaceArchiveService
  readonly bots: BotProfileService
  readonly currentIdentity: SpaceCurrentIdentity
  readonly threads: ThreadStreamAdapter
  readonly artifacts: BridgeArtifacts
  readonly hub: BridgeHub
  readonly dispatch: DispatchService
  private readonly remote: RemoteApi
  private readonly clock: Clock
  private readonly tasks = new Set<Promise<unknown>>()
  private readonly disposers = new Set<() => void | Promise<void>>()
  private readonly presenceJobs = new Map<string, { message: PresenceMessage; peer: SyncSession['peer']; bytes: number }>()
  private presenceBytes = 0
  private readonly domain: NetDomainComposition
  private stopped = false
  private activated = false
  private disableDrains: Promise<unknown>[] = []
  private closing?: Promise<void>

  constructor(readonly options: { services: MmsProfileServices; runtime: NetRuntime; net: NetService; clock?: Clock; dispatchRuntime?: DispatchRuntime;
    /** Trusted local immutable definitions and billing/containment evidence; never received over IPC or Sync. */
    nativeAdapters?: ReadonlyMap<string, NativeBotComposition> }) {
    const { services, runtime: rt, net } = options
    this.clock = options.clock ?? systemClock
    this.spaces = new SpaceProfileService({ runtime: rt, net, clock: this.clock,
      botAuthorization: {
        canWrite: (...args) => this.bots?.hostAuthorization.canWrite(...args) ?? false,
        canRegisterAccepted: (...args) => this.bots?.hostAuthorization.canRegisterAccepted(...args) ?? false,
        canRegisterPrivateAccepted: (...args) => this.bots?.hostAuthorization.canRegisterPrivateAccepted(...args) ?? false
      },
      canWriteBotRecord: (descriptor, envelope, peer) => this.bots?.canWriteBotRecord(descriptor, envelope, peer) ?? false,
      currentPrivateRoster: (space, user) => {
        if (!this.currentIdentity) throw new NetError('meta_stale')
        return this.currentIdentity.currentPrivateRoster(space, user)
      },
      verifyBotRecord: (...args) => { if (!this.bots) throw new NetError('forbidden'); this.bots.verifyHistory(...args) },
      canBotWrite: (...args) => this.bots?.canBotWrite(...args) ?? false,
      validateExecutionReferences: (...args) => this.bots?.validateExecutionReferences(...args) ?? false,
      verifyPrivateBotRecord: (...args) => { if (!this.bots) throw new NetError('forbidden'); this.bots.verifyHistory(...args) },
      onPrivateChanged: (...args) => this.bots?.onPrivateChanged(...args),
      // Authority publication and replica apply hooks both run only for ordinary
      // committed records. Snapshot validators verify history without admission.
      onStored: (record, descriptor) => rt.db.afterCommit(() => {
        if (!this.stopped && net.featureEnabled('netSpaces')) for (const task of this.bots?.receiveStored(record, descriptor) ?? []) void this.track(task).catch(() => {})
      }) })
    this.currentIdentity = new SpaceCurrentIdentity({ runtime: rt, store: this.spaces.store, meta: this.spaces.meta, host: this.spaces.host,
      session: space => this.spaces.session(space), retainHistoryRoster: signed => this.spaces.evidence.retain(signed) })
    this.bots = new BotProfileService({ isEnabled: () => net.featureEnabled('netSpaces'), profileId: services.profileId, profileHome: services.getProfileHomeDir(), installationHome: services.getHomeDir(),
      runtime: rt, threads: services.threads, projects: services.projects, nativeAdapters: options.nativeAdapters,
      prepareAdmission: input => this.currentIdentity.prepareAdmission(input),
      preparePrivateAudience: (space, participants) => this.currentIdentity.preparePrivateAudience(space, participants),
      verifyMentionAuthor: (...args) => this.currentIdentity.verifyMentionAuthor(...args),
      presenceIdentity: space => this.currentIdentity.presenceIdentity(space),
      presenceDisplayIdentity: space => this.currentIdentity.presenceDisplayIdentity(space),
      spaces: { store: this.spaces.store, meta: this.spaces.meta, private: this.spaces.private, host: this.spaces.host,
        historyIdentity: this.spaces.client.options.identity, session: space => this.spaces.session(space),
        appendSigned: entry => this.spaces.appendSigned(entry), flush: space => this.spaces.flush(space) },
      sendPresence: message => net.publishPresence(message) })
    this.threads = new ThreadStreamAdapter({ db: rt.db, store: this.spaces.store, generations: rt.streams, identity: rt.identity, keys: rt.keys, clock: this.clock,
      source: new MmsThreadSource(services), onRecord: (stream, record) => { void this.track(net.publish(stream, record)) },
      onError: (_thread, error, stream) => { void this.track(net.failStream(stream, error instanceof NetError ? error.code : 'internal')) } })
    this.remote = new RemoteApi(new MmsRemoteBackend(services), this.clock)
    for (const method of this.remote.methods()) rt.rpc.register({ ...method, authorize: (params, context) => { net.assertFeature('netBridge'); method.authorize?.(params, context) }, handle: (params, context) => this.track(method.handle(params, context)) })
    rt.rpc.register({ method: 'bridge.thread.open', capability: 'read', mutating: false,
      validate: value => validateHubParams('bridge.thread.open', value),
      authorize: () => net.assertFeature('netBridge'), handle: async value => { const descriptor = this.threads.activate((value as { threadId: string }).threadId); return { descriptor, head: this.threads.store.head(descriptor.id) } } })
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
      validate: value => validateHubParams('bridge.dispatch', value), authorize: () => net.assertFeature('netBridge'), handle: (value, context) => {
        if (!context.execution) throw new NetError('bad_request')
        return this.track(this.dispatch.run(value, context, context.execution))
      } })
    this.archives=new SpaceArchiveService({spaces:this.spaces,bots:this.bots,net,unscopedActive:()=>this.tasks.size+this.currentIdentity.activeCount()+this.hub.activeCount()})
    this.domain = this.spaces.composition(this.artifacts)

  }

  composition(): NetDomainComposition {
    const session = this.domain.session!
    return { ...this.domain, store: this.threads.store,
      session: { ...session,
        capabilities: [...new Set([...(session.capabilities ?? []), 'streams.v1' as const, 'blobs.v1' as const, 'rpc.v1' as const, 'presence.v1' as const])],
        spaceIdentity: this.currentIdentity.source,
        verifyPresence: (message, peer) => { this.preparePresence(message, peer); return false },
        retainRosterEvidence: (signed, peer) => {
          const self = this.options.runtime.identity.self(), roster = parseProtocolJson(Buffer.from(signed.payload, 'base64url')) as Roster
          if (self && roster.owner === self.user) {
            this.options.runtime.identity.verifySigned<Roster>(signed, this.options.runtime.identity.pinnedRootKey(self.user)!)
            this.spaces.evidence.retain(signed)
          } else session.retainRosterEvidence?.(signed, peer)
          this.currentIdentity.invalidate(roster.owner)
        },
        canReceive: (descriptor, peer) => !this.options.net.featureEnabled(descriptor.kind.startsWith('space.') ? 'netSpaces' : 'netBridge') ? false : descriptor.kind.startsWith('space.') ? session.canReceive!(descriptor, peer)
          : descriptor.kind === 'node.artifact' ? this.artifacts.canReceive(descriptor, peer) : this.hub.canReceive(descriptor, peer),
        verifyRecord: (record, descriptor, snapshot) => {
          if (descriptor.kind.startsWith('space.')) session.verifyRecord?.(record, descriptor, snapshot)
          else if (descriptor.kind === 'node.artifact') this.artifacts.verifyRecord(record, descriptor)
          else this.hub.verifyRecord(record, descriptor)
        } },
      onSessionOpened: (session: SyncSession) => {
        if (!this.stopped && this.options.net.featureEnabled('netBridge') && session.peer.user === this.options.runtime.identity.self()?.user) void this.track(this.hub.reconnect(session.peer.node))
      }, onActivated: () => {
        if(this.options.net.featureEnabled('netSpaces')){this.bots.activate();this.spaces.local.resume()}
        if(!this.activated&&this.options.net.featureEnabled('netBridge')){this.activated=true;void this.track(this.dispatch.recover())}
      }, beginDisable: () => this.beginDisable(), close: () => this.close(), activeCount: () => this.activeCount() }
  }

  onClose(dispose: () => void | Promise<void>): () => void {
    if (this.stopped) throw new NetError('cancelled')
    this.disposers.add(dispose); return () => this.disposers.delete(dispose)
  }
  activeCount(): number { return this.archives.activeCount()+this.tasks.size + this.hub.activeCount() + this.bots.activeCount() + this.currentIdentity.activeCount() + (this.domain.activeCount?.() ?? 0) }
  /** Trusted local connection producers retain profile ownership while draining. */
  ownDrain<T>(work: Promise<T>): Promise<T> { return this.track(work) }
  private track<T>(work: Promise<T>): Promise<T> {
    this.tasks.add(work); void work.then(() => this.tasks.delete(work), () => this.tasks.delete(work)); return work
  }
  beginDisable():void {
    if(this.stopped)return
    this.stopped=true
    this.remote.close();this.hub.close();this.threads.close()
    this.spaces.beginDisable()
    this.disableDrains=[this.archives.close(),this.bots.close()]
    for(const work of this.disableDrains)void work.catch(()=>{})
    this.currentIdentity.close()
  }
  close(): Promise<void> {
    if (this.closing) return this.closing
    this.beginDisable()
    const disposals = [...this.disposers].map(dispose => { try { return Promise.resolve(dispose()) } catch (error) { return Promise.reject(error) } })
    this.disposers.clear(); this.remote.close(); this.hub.close(); this.threads.close()
    this.closing = (async () => {
      await Promise.allSettled(disposals); await this.hub.drain()
      await Promise.all(this.disableDrains)
      this.currentIdentity.close()
      while (this.tasks.size) await Promise.allSettled([...this.tasks])
      await this.dispatch.drainCleanup(); await this.spaces.close()
    })()
    const closing = this.closing
    void closing.catch(() => { if (this.closing === closing) this.closing = undefined })
    return this.closing
  }

  private preparePresence(message: PresenceMessage, peer: SyncSession['peer']): void {
    if (this.stopped || !this.options.net.featureEnabled('netSpaces')) return
    const descriptor = this.spaces.store.getStream(message.stream)
    if (descriptor?.kind !== 'space.channel' || !descriptor.space) return
    const bytes = canonicalJson({ message, peer }).byteLength, key = `${message.stream}/${message.subject}`, old = this.presenceJobs.get(key)
    if (bytes > 8192 || this.presenceBytes - (old?.bytes ?? 0) + bytes > 64 * 1024 || !old && this.presenceJobs.size >= 32) return
    if (old && message.counter <= old.message.counter) return
    const captured = { message: structuredClone(message), peer: structuredClone(peer), bytes }
    this.presenceBytes += bytes - (old?.bytes ?? 0)
    if (old) { Object.assign(old, captured); return }
    this.presenceJobs.set(key, captured)
    const work = (async () => {
      await this.currentIdentity.preparePresence(descriptor.space!, message.subject as BotId)
      if (this.stopped) return
      // The receiver rechecks current membership, original subject signature,
      // actual source placement and counter only once after authority proof.
      const latest = captured.message, source = captured.peer
      if (this.bots.receivePresence(latest, source)) {
        this.currentIdentity.recordVerifiedPresence(latest)
        if (this.spaces.store.getStream(latest.stream)?.authority === this.options.runtime.identity.self()?.node
          && source.node !== this.options.runtime.identity.self()?.node) await this.options.net.publishPresence(latest, source.node)
      }
    })().finally(() => { if (this.presenceJobs.get(key) === captured) { this.presenceJobs.delete(key); this.presenceBytes -= captured.bytes } })
    void this.track(work).catch(() => {})
  }
}
