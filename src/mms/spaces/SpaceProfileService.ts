import type { Clock, PeerRef, PrivateStreamKeys, StreamAuthority, SyncSession } from '../net/contracts'
import type { NetDomainComposition, NetRuntime, NetService } from '../net/NetService'
import { systemClock } from '../net/clock'
import { SqlPrivateStreamKeys } from '../net/identity'
import { decodeBase64, verifyDocument } from '../net/identity/crypto'
import { SqliteStreamStore, type MetaSnapshotValidator } from '../net/store/streams'
import { SyncSupervisor } from '../net/sync/supervisor'
import { NetError, spaceMetaStream, type NodeDelegation, type Roster, type RoutesRecord, type Signed, type SpaceDescriptor, type SpaceId, type StoredRecord, type StreamDescriptor, type StreamId } from '../../shared/net'
import { MetaProjection, SpaceHostService, type BotSpaceAuthorization } from './host'
import { PrivateSpaceService, type PrivateServiceOptions } from './private'
import { SpaceClientService, type SpaceClientOptions } from './client'
import { RosterEvidence } from './RosterEvidence'
import { spaceHistoryIdentity } from './historyIdentity'

export interface SpaceProfileOptions {
  runtime: NetRuntime
  net: Pick<NetService, 'signedRoutes' | 'connectChannel' | 'connectDomainSession' | 'publish'>
  clock?: Clock
  botAuthorization?: BotSpaceAuthorization
  verifyBotRecord?: SpaceClientOptions['verifyBotRecord']
  canBotWrite?: PrivateServiceOptions['canBotWrite']
  onStored?(record: StoredRecord, descriptor: StreamDescriptor): void
  onChanged?(space: SpaceId): void
  onPrivateChanged?: PrivateServiceOptions['onControlChanged']
}

/** Profile-owned composition. Construction does not create an identity or open a listener. */
export class SpaceProfileService {
  readonly store: SqliteStreamStore
  readonly meta: MetaProjection
  readonly evidence: RosterEvidence
  readonly private: PrivateSpaceService
  readonly host: SpaceHostService
  readonly client: SpaceClientService
  private readonly clock: Clock
  private readonly sessions = new Map<SpaceId, SyncSupervisor>()
  private readonly tasks = new Set<Promise<unknown>>()
  private privateKeys?: SqlPrivateStreamKeys
  private stopped = false
  private readonly dispose: Array<() => void> = []

  constructor(readonly options: SpaceProfileOptions) {
    const rt = options.runtime
    this.clock = options.clock ?? systemClock
    this.evidence = new RosterEvidence(rt.db)
    const snapshots: MetaSnapshotValidator = {
      maxRecordsPerAppend: 64,
      supports: descriptor => descriptor.kind === 'space.meta' || descriptor.kind === 'space.private',
      append: (records, descriptor, target, carry) => descriptor.kind === 'space.private'
        ? this.private.append(records, descriptor, target, carry) : this.meta.append(records, descriptor, target, carry),
      finish: (carry, descriptor, target) => descriptor.kind === 'space.private'
        ? this.private.finish(carry, descriptor, target) : this.meta.finish(carry, descriptor, target)
    }
    this.store = new SqliteStreamStore(rt.db, snapshots, (record, descriptor) => {
      this.client.afterStored(record, descriptor)
      options.onStored?.(record, descriptor)
    })
    this.meta = new MetaProjection({db:rt.db,identity:rt.identity,store:this.store,
      historyRoster:(author,at,root)=>this.evidence.forAuthor(author,at,root),
      activatePins:roots=>rt.identity.pinUsers(roots)})
    const historyIdentity=spaceHistoryIdentity(rt.identity,this.store,this.meta,this.evidence)
    const keys = new Proxy({} as PrivateStreamKeys, {get: (_target, name: keyof PrivateStreamKeys) => {
      const implementation = this.keys()
      const value = implementation[name]
      return typeof value === 'function' ? value.bind(implementation) : value
    }})
    this.private = new PrivateSpaceService({db:rt.db,identity:historyIdentity,keys:rt.keys,privateKeys:keys,store:this.store,meta:this.meta,outbox:rt.outbox,clock:this.clock,
      rosterAt:(_space,user,at,root)=>this.evidence.at(user,at,root) ?? rt.identity.roster(user),
      memberAt:(space,user,auth)=>this.meta.memberAt(space,user,auth),
      publishParentOpen:entry=>this.append(entry.stream,entry.id,entry.envelope,entry.sig),
      publishCreation:(descriptor,entry)=>this.append(descriptor.id,entry.id,entry.envelope,entry.sig),
      canBotWrite:options.canBotWrite,onControlChanged:options.onPrivateChanged})
    this.host = new SpaceHostService({db:rt.db,identity:rt.identity,keys:rt.keys,store:this.store,projection:this.meta,limits:rt.limits,blobs:rt.blobs,clock:this.clock,
      routes:()=>options.net.signedRoutes(),privateAuthorization:this.private,botAuthorization:options.botAuthorization})
    this.client = new SpaceClientService({db:rt.db,identity:historyIdentity,keys:rt.keys,store:this.store,outbox:rt.outbox,meta:this.meta,private:this.private,clock:this.clock,
      atomicStoreHooks:true,localRoutes:()=>options.net.signedRoutes(),metaStream:d=>spaceMetaStream(d.space),
      connectJoin:(descriptor,signal,evidence)=>options.net.connectChannel(this.peer(descriptor,evidence),signal),
      connectSpace:(descriptor,signal)=>this.connect(descriptor,signal),threadBinding:stream=>this.host.threadBinding(stream),verifyBotRecord:options.verifyBotRecord})
    this.dispose.push(this.host.onAppend((stream,record)=>{
      options.onStored?.(record,this.store.getStream(stream)!)
      this.track(options.net.publish(stream,record))
    }),this.client.onChanged(space=>{
      options.onChanged?.(space)
      if (this.client.binding(space)?.state === 'active') this.track(this.client.flush(space))
    }))
  }

  private keys(): SqlPrivateStreamKeys {
    if (!this.privateKeys) {
      const rt = this.options.runtime, self = rt.identity.self()
      if (!self) throw new NetError('not_enrolled')
      this.privateKeys = new SqlPrivateStreamKeys({database:rt.db.database,keys:rt.keys,node:self.node,user:self.user,
        spaceForStream:stream=>{const space=this.store.getStream(stream)?.space;if(!space)throw new NetError('stream_unknown');return space},
        transaction:operation=>rt.db.transaction(operation)})
    }
    return this.privateKeys
  }

  private peer(descriptor: SpaceDescriptor, bootstrap?: {ownerRootKey:string;ownerRoster:Signed}): PeerRef {
    const identity=this.options.runtime.identity, pin=identity.pinnedRootKey(descriptor.owner)
    if(pin && bootstrap && pin!==bootstrap.ownerRootKey)throw new NetError('conflict')
    const root=pin ?? bootstrap?.ownerRootKey, signed=identity.roster(descriptor.owner) ?? bootstrap?.ownerRoster
    if (!root || !signed || pin && identity.rosterState(descriptor.owner) !== 'ok') throw new NetError('bad_delegation')
    const roster=verifyDocument<Roster>(signed,root,'roster'), node=roster.nodes.map(s=>verifyDocument<NodeDelegation>(s,root,'nodeDelegation'))
      .filter(n=>n.subject===descriptor.hostNode).sort((a,b)=>b.keyEpoch-a.keyEpoch || b.issuedAt-a.issuedAt)[0]
    if (roster.owner!==descriptor.owner || roster.rootKey!==root || !node || node.owner!==descriptor.owner || node.keys.transport!==descriptor.hostTransportKey || node.issuedAt>this.clock.now() || node.expiresAt<=this.clock.now() || roster.revoked.some(r=>r.subject===node.subject && r.throughKeyEpoch>=node.keyEpoch)) throw new NetError('bad_delegation')
    let routes=verifyDocument<RoutesRecord>(descriptor.routes,node.keys.sign,'routes')
    const row=this.options.runtime.db.database.prepare('SELECT signed FROM net_peer_routes WHERE node=?').get(node.subject)
    if(row){const stored=verifyDocument<RoutesRecord>(JSON.parse(row.signed as string),node.keys.sign,'routes');if(stored.version>routes.version)routes=stored}
    if(routes.node!==node.subject || routes.issuedAt>this.clock.now())throw new NetError('bad_signature')
    return {node:node.subject,user:node.owner,transportKey:node.keys.transport,routes:routes.routes}
  }

  private async connect(descriptor: SpaceDescriptor, signal: AbortSignal): Promise<SyncSession> {
    if(this.stopped)throw new NetError('cancelled')
    const supervisor=new SyncSupervisor({identity:this.options.runtime.identity,clock:this.clock,
      connect:retrySignal=>this.options.net.connectDomainSession(this.peer(descriptor),retrySignal)})
    this.sessions.get(descriptor.space)?.close();this.sessions.set(descriptor.space,supervisor)
    const abort=()=>{supervisor.close();if(this.sessions.get(descriptor.space)===supervisor)this.sessions.delete(descriptor.space)}
    signal.addEventListener('abort',abort,{once:true});if(signal.aborted)abort()
    try{await supervisor.opened;return supervisor}catch(error){abort();throw error}
  }

  private append(stream: StreamId, ...args: Parameters<SyncSession['append']> extends [StreamId,...infer Rest] ? Rest : never): ReturnType<SyncSession['append']> {
    const descriptor=this.store.getStream(stream), space=descriptor?.space
    if(!space)throw new NetError('stream_unknown')
    const session=this.sessions.get(space)
    if(!session)throw new NetError('peer_offline')
    return session.append(stream,...args)
  }

  /** Unknown roots remain retained evidence until signed meta proves membership. */
  retainRosterEvidence(signed: Signed, peer: SyncSession['peer']): void {
    const roster=JSON.parse(decodeBase64(signed.payload).toString()) as Roster
    const expectedHost=this.client.list().some(binding=>{
      const descriptor=verifyDocument<SpaceDescriptor>(binding.descriptor,binding.ownerRootKey,'spaceDescriptor')
      return descriptor.owner===peer.user && descriptor.hostNode===peer.node && descriptor.hostTransportKey===peer.delegation.keys.transport
    })
    const memberOwnRoster=roster.owner===peer.user && this.store.listStreams({kind:'space.meta'}).some(stream=>stream.space && this.meta.member(stream.space,peer.user))
    if(!expectedHost && !memberOwnRoster)throw new NetError('forbidden')
    this.evidence.retain(signed)
  }

  composition(fallback: StreamAuthority): NetDomainComposition {
    const owner=(stream:StreamId)=>{const descriptor=this.store.getStream(stream);return !descriptor || descriptor.kind.startsWith('space.')?this.host:fallback}
    return {store:this.store,spaceJoin:this.host,authority:{
      canRead:(...args)=>owner(args[0]).canRead(...args),append:(...args)=>owner(args[0]).append(...args),
      canFetchBlob:(...args)=>owner(args[0]).canFetchBlob(...args),acceptBlob:(...args)=>owner(args[0]).acceptBlob(...args),
      blobCommitted:(...args)=>owner(args[0]).blobCommitted?.(...args)},
      session:{canReceive:(descriptor,peer)=>descriptor.kind.startsWith('space.')?this.client.canReceive(descriptor,peer):descriptor.kind==='node.thread' && peer.user===this.options.runtime.identity.self()?.user && descriptor.authority===peer.node,
        verifyRecord:(record,descriptor,snapshot)=>{if(descriptor.kind.startsWith('space.'))this.client.verifyRecord(record,descriptor,snapshot)},
        retainRosterEvidence:(signed,peer)=>this.retainRosterEvidence(signed,peer)},close:()=>this.close(),activeCount:()=>this.tasks.size}
  }
  session(space:SpaceId): SyncSession | undefined { return this.sessions.get(space) }
  private track(operation:Promise<unknown>):void {this.tasks.add(operation);void operation.catch(()=>{}).finally(()=>this.tasks.delete(operation))}
  async close():Promise<void>{if(this.stopped)return;this.stopped=true;for(const dispose of this.dispose)dispose();this.client.close();for(const session of this.sessions.values())session.close();this.sessions.clear();await Promise.allSettled(this.tasks);this.store.close()}
}
