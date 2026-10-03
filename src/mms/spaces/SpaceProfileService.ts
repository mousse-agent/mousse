import type { Clock, OutboxEntry, PeerRef, PrivateStreamKeys, StreamAuthority, SyncSession } from '../net/contracts'
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
import { spaceHistoryAuthor, spaceHistoryIdentity } from './historyIdentity'
import { SpaceLocalService } from './SpaceLocalService'
import {SpaceStreamDiscoveryService} from './discovery/service'
import type {SyncSessionOptions,SessionIdentityPort} from '../net/sync/session'
import { settleArchiveWork } from './archive/lifecycle'

export interface SpaceProfileOptions {
  runtime: NetRuntime
  net: Pick<NetService,
    'status' | 'signedRoutes' | 'connectChannel' | 'connectDomainSession' | 'publish' | 'assertFeature' | 'featureEnabled'> & {
    quiesceSpaceStreams?(space:SpaceId,streams:readonly StreamId[],signal:AbortSignal):Promise<void>
    resumeSpaceStreams?(space:SpaceId):void
  }
  clock?: Clock
  botAuthorization?: BotSpaceAuthorization
  /** Executor/verified-replica proof is separate from the authority's accepted-run ledger. */
  canWriteBotRecord?: SpaceClientOptions['canWriteBotRecord']
  verifyBotRecord?: SpaceClientOptions['verifyBotRecord']
  canBotWrite?: PrivateServiceOptions['canBotWrite']
  validateExecutionReferences?: PrivateServiceOptions['validateExecutionReferences']
  verifyPrivateBotRecord?: PrivateServiceOptions['verifyBotRecord']
  onStored?(record: StoredRecord, descriptor: StreamDescriptor): void
  onChanged?(space: SpaceId): void
  onPrivateChanged?: PrivateServiceOptions['onControlChanged']
  currentPrivateRoster?: PrivateServiceOptions['currentRoster']
  spaceIdentity?:SessionIdentityPort
}

/** Profile-owned composition. Construction does not create an identity or open a listener. */
export class SpaceProfileService {
  readonly store: SqliteStreamStore
  readonly meta: MetaProjection
  readonly evidence: RosterEvidence
  readonly private: PrivateSpaceService
  readonly host: SpaceHostService
  readonly client: SpaceClientService
  readonly local: SpaceLocalService
  readonly discovery:SpaceStreamDiscoveryService
  private readonly clock: Clock
  private readonly sessions = new Map<SpaceId, SyncSupervisor>()
  private readonly tasks = new Set<Promise<unknown>>()
  private readonly taskSpaces = new Map<Promise<unknown>,SpaceId>()
  private readonly archiveFences = new Set<SpaceId>()
  private readonly flushing = new Map<SpaceId, Promise<void>>()
  private readonly flushAgain = new Set<SpaceId>()
  private privateKeys?: SqlPrivateStreamKeys
  private stopped = false
  private localClosing?: Promise<void>
  private closing?: Promise<void>
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
      verifyBootstrapAuthor:(descriptor,record)=>spaceHistoryAuthor(rt.identity,this.meta,this.evidence,descriptor,record),
      rosterAt:(_space,user,at,root)=>this.evidence.at(user,at,root,
        rt.identity.pinnedRootKey(user)===root && rt.identity.rosterState(user)==='ok' ? rt.identity.roster(user) : undefined),currentRoster:options.currentPrivateRoster,
      memberAt:(space,user,auth)=>this.meta.memberAt(space,user,auth),
      botAt:(space,bot,auth)=>this.meta.botAt(space,bot,auth),
      publishParentOpen:entry=>this.append(entry.stream,entry.id,entry.envelope,entry.sig),
      publishCreation:(descriptor,entry)=>this.append(descriptor.id,entry.id,entry.envelope,entry.sig),
      canBotWrite:options.canBotWrite,validateExecutionReferences:options.validateExecutionReferences,
      verifyBotRecord:options.verifyPrivateBotRecord,onControlChanged:options.onPrivateChanged})
    this.host = new SpaceHostService({db:rt.db,identity:rt.identity,keys:rt.keys,store:this.store,projection:this.meta,limits:rt.limits,blobs:rt.blobs,clock:this.clock,
      routes:()=>options.net.signedRoutes(),privateAuthorization:this.private,botAuthorization:options.botAuthorization,outbox:rt.outbox})
    this.discovery=new SpaceStreamDiscoveryService({db:rt.db,identity:rt.identity,historyIdentity,keys:rt.keys,store:this.store,meta:this.meta,private:this.private,host:this.host})
    this.client = new SpaceClientService({db:rt.db,identity:historyIdentity,keys:rt.keys,store:this.store,outbox:rt.outbox,meta:this.meta,private:this.private,clock:this.clock,
      atomicStoreHooks:true,localRoutes:()=>options.net.signedRoutes(),metaStream:d=>spaceMetaStream(d.space),
      connectJoin:(descriptor,signal,evidence)=>options.net.connectChannel(this.peer(descriptor,evidence),signal),
      connectSpace:(descriptor,signal)=>this.connect(descriptor,signal),threadBinding:stream=>this.host.threadBinding(stream),verifyBotRecord:options.verifyBotRecord,
      canWriteBotRecord:options.canWriteBotRecord})
    this.local = new SpaceLocalService(this)
    this.dispose.push(this.host.onAppend((stream,record)=>{
      options.onStored?.(record,this.store.getStream(stream)!)
      this.track(options.net.publish(stream,record),this.store.getStream(stream)?.space)
    }),this.client.onChanged(space=>{
      options.onChanged?.(space)
      if (this.client.binding(space)?.state === 'active'&&this.canStartSpaceWork(space)) this.track(this.client.flush(space),space)
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
    if(!this.canStartSpaceWork(descriptor.space))throw new NetError('space_frozen')
    const supervisor=new SyncSupervisor({identity:this.options.runtime.identity,clock:this.clock,
      connect:retrySignal=>this.options.net.connectDomainSession(this.peer(descriptor),retrySignal)})
    this.sessions.get(descriptor.space)?.close();this.sessions.set(descriptor.space,supervisor)
    const abort=()=>{supervisor.close();if(this.sessions.get(descriptor.space)===supervisor)this.sessions.delete(descriptor.space)}
    signal.addEventListener('abort',abort,{once:true});if(signal.aborted)abort()
    try{await supervisor.opened;return supervisor}catch(error){abort();throw error}
  }

  private append(stream: StreamId, ...args: Parameters<SyncSession['append']> extends [StreamId,...infer Rest] ? Rest : never): ReturnType<SyncSession['append']> {
    if(this.stopped)throw new NetError('cancelled')
    const descriptor=this.store.getStream(stream), space=descriptor?.space
    if(!space)throw new NetError('stream_unknown')
    if(this.archiveFences.has(space))throw new NetError('space_frozen')
    if(descriptor.authority===this.options.runtime.identity.self()?.node)return Promise.resolve(this.host.appendLocal(stream,args[0],args[1],args[2]))
    const session=this.sessions.get(space)
    if(!session)throw new NetError('peer_offline')
    return session.append(stream,...args)
  }

  /** Trusted local composition port: send only the durable original, with an actual authority acknowledgement. */
  appendSigned(entry: Pick<OutboxEntry, 'id' | 'stream' | 'envelope' | 'sig'>): ReturnType<SyncSession['append']> {
    if(this.stopped)throw new NetError('cancelled')
    const original=this.options.runtime.outbox.get(entry.id)
    if(!original || original.stream!==entry.stream || !Buffer.from(original.envelope).equals(entry.envelope) || !Buffer.from(original.sig).equals(entry.sig))throw new NetError('conflict')
    if(original.state==='failed')throw new NetError(original.error ?? 'conflict')
    return this.append(entry.stream,entry.id,entry.envelope,entry.sig)
  }

  /** Owner-host originals use the real authority; foreign originals use the authenticated client. */
  flush(space: SpaceId): Promise<void> {
    if(this.stopped)return Promise.reject(new NetError('cancelled'))
    if(this.archiveFences.has(space))return Promise.reject(new NetError('space_frozen'))
    const existing=this.flushing.get(space)
    if(existing){
      if(this.store.getStream(spaceMetaStream(space))?.authority===this.options.runtime.identity.self()?.node)this.flushAgain.add(space)
      return existing
    }
    return this.startFlush(space,new Set(),{remaining:64})
  }
  private startFlush(space:SpaceId,blocked:Set<StreamId>,budget:{remaining:number}):Promise<void>{
    const work=(async()=>{
      do{
        this.flushAgain.delete(space)
        await this.flushNow(space,blocked,budget)
      }while(!this.stopped&&!this.archiveFences.has(space)&&budget.remaining>0&&this.flushAgain.has(space))
    })()
    const pending=work.finally(()=>{
      if(this.flushing.get(space)!==pending)return
      this.flushing.delete(space)
      if(!this.stopped&&!this.archiveFences.has(space)&&this.flushAgain.has(space)){
        // Keep uncertainty fences across the whole coalesced wave. A fresh
        // explicit flush after it drains may reconcile its original receipt.
        const next=this.startFlush(space,blocked,budget.remaining>0?budget:{remaining:64})
        if(budget.remaining>0)return next
      }
    })
    this.flushing.set(space,pending);this.track(pending,space)
    return pending
  }

  private async flushNow(space: SpaceId,blocked:Set<StreamId>,budget:{remaining:number}): Promise<void> {
    const rt=this.options.runtime,self=rt.identity.self(),state=this.meta.position(space)
    const root=state?.owner && rt.identity.pinnedRootKey(state.owner)
    const descriptor=state?.descriptor && root ? verifyDocument<SpaceDescriptor>(state.descriptor,root,'spaceDescriptor') : undefined
    if(!self || !descriptor || descriptor.hostNode!==self.node){await this.client.flush(space);return}
    // Only IDs are paged, and each signed document is loaded individually. Unknown
    // receipts remain ahead of later receipts in their own stream.
    let after=0,afterCreated=-1
    while(budget.remaining>0&&!this.stopped&&!this.archiveFences.has(space)){
      budget.remaining--
      const rows=rt.db.database.prepare("SELECT rowid AS receipt,created_at,id,stream FROM net_outbox WHERE space_id=? AND state IN ('pending','unknown') AND (created_at>? OR (created_at=? AND rowid>?)) ORDER BY created_at,rowid LIMIT 64").all(space,afterCreated,afterCreated,after)
      if(!rows.length)return
      for(const row of rows){
        after=Number(row.receipt);afterCreated=Number(row.created_at)
        const stream=row.stream as StreamId
        if(blocked.has(stream))continue
        const entry=rt.outbox.get(row.id as OutboxEntry['id'])
        if(!entry || !['pending','unknown'].includes(entry.state))continue
        if(this.private.isPrepared(entry.id)){blocked.add(stream);continue}
        rt.outbox.markAttempt(entry.id)
        try{
          const position=await this.appendSigned(entry)
          rt.outbox.markSent(entry.id,position)
        }catch(error){
          if(error instanceof NetError && !error.retryable && !['cancelled','internal','outcome_uncertain'].includes(error.code))rt.outbox.markFailed(entry.id,error.code)
          blocked.add(stream)
        }
      }
    }
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
    const session:NonNullable<NetDomainComposition['session']>&Pick<SyncSessionOptions,'discovery'|'spaceIdentity'>={
      capabilities:['streams.v1','blobs.v1','rpc.v1','space.discovery.v1'],discovery:this.discovery,spaceIdentity:this.options.spaceIdentity,
      canReceive:(descriptor,peer)=>descriptor.kind.startsWith('space.')?this.client.canReceive(descriptor,peer):descriptor.kind==='node.thread' && peer.user===this.options.runtime.identity.self()?.user && descriptor.authority===peer.node,
      verifyRecord:(record,descriptor,snapshot)=>{if(descriptor.kind.startsWith('space.'))this.client.verifyRecord(record,descriptor,snapshot)},
      retainRosterEvidence:(signed,peer)=>this.retainRosterEvidence(signed,peer)}
    return {store:this.store,spaceJoin:this.host,authority:{
      canRead:(...args)=>owner(args[0]).canRead(...args),append:(...args)=>owner(args[0]).append(...args),
      canFetchBlob:(...args)=>owner(args[0]).canFetchBlob(...args),acceptBlob:(...args)=>owner(args[0]).acceptBlob(...args),
      blobCommitted:(...args)=>owner(args[0]).blobCommitted?.(...args)},
      session,close:()=>this.close(),activeCount:()=>this.tasks.size+this.local.activeCount()}
  }
  /** The caller first obtains this child ID from its authenticated committed parent history. */
  discover(space:SpaceId,stream:StreamId,options?:{signal?:AbortSignal}):Promise<StreamDescriptor>{
    const operation=this.discoverNow(space,stream,options);this.track(operation,space);return operation
  }
  private async discoverNow(space:SpaceId,stream:StreamId,options?:{signal?:AbortSignal}):Promise<StreamDescriptor>{
    if(this.stopped)throw new NetError('cancelled')
    if(options?.signal?.aborted)throw new NetError('cancelled')
    if(!this.canStartSpaceWork(space))throw new NetError('space_frozen')
    const session=this.sessions.get(space),state=this.meta.state(space)
    if(!session||session.state()!=='open')throw new NetError('peer_offline')
    if(!state||state.frozen||state.upgradeRequired)throw new NetError('meta_stale')
    const head=await session.metaHead(spaceMetaStream(space));if(head.epoch!==state.applied.epoch||head.seq!==state.applied.seq)throw new NetError('meta_stale')
    if(this.stopped||options?.signal?.aborted)throw new NetError('cancelled')
    if(!this.canStartSpaceWork(space))throw new NetError('space_frozen')
    const proof=await session.discoverSpaceStream(space,stream,head,options)
    if(this.stopped||options?.signal?.aborted)throw new NetError('cancelled')
    if(!this.canStartSpaceWork(space))throw new NetError('space_frozen')
    this.discovery.accept(proof,session.peer);return proof.descriptor
  }
  session(space:SpaceId): SyncSession | undefined { return this.sessions.get(space) }
  private track(operation:Promise<unknown>,space?:SpaceId):void {this.tasks.add(operation);if(space)this.taskSpaces.set(operation,space);void operation.catch(()=>{}).finally(()=>{this.tasks.delete(operation);this.taskSpaces.delete(operation)})}
  canStartSpaceWork(space: SpaceId): boolean {
    return this.options.net.featureEnabled('netSpaces') && !this.stopped && !this.archiveFences.has(space)
      && this.host.options.archiveAccess?.(space, 'write') !== false && this.meta.position(space)?.status !== 'frozen'
  }
  /** Synchronous restart fence, before listeners or saved jobs can start. */
  fenceForArchive(space:SpaceId):void{this.archiveFences.add(space);this.flushAgain.delete(space);this.local.fenceForArchive(space)}
  /** Trusted archive lifecycle; never flush an unknown original to manufacture quiescence. */
  async quiesceForArchive(space:SpaceId,signal:AbortSignal):Promise<void>{
    this.fenceForArchive(space)
    const rt=this.options.runtime,streams=this.store.listStreams({space}).map(s=>s.id)
    if(!streams.length)streams.push(spaceMetaStream(space))
    if(streams.length>128)throw new NetError('too_large')
    if(!this.options.net.quiesceSpaceStreams)throw new NetError('profile_unsupported')
    // Publications are owned by both Net and this profile. Abort the actual
    // transport job before waiting for its enclosing Space task to settle.
    await this.options.net.quiesceSpaceStreams(space,streams,signal)
    await this.local.quiesceForArchive(space,signal)
    this.client.disconnect(space);this.sessions.get(space)?.close();this.sessions.delete(space)
    const scoped=[...this.tasks].filter(task=>this.taskSpaces.get(task)===space)
    if([...this.tasks].some(task=>!this.taskSpaces.has(task)))throw new NetError('outcome_uncertain')
    await settleArchiveWork(scoped,signal)
    await Promise.resolve()
    if([...this.taskSpaces.values()].includes(space))throw new NetError('outcome_uncertain')
    if(signal.aborted)throw new NetError('cancelled')
    // A committed exact original can supply its real lost acknowledgement.
    // No network mutation is retried as an archive side effect.
    let after=0
    for(;;){
      const rows=rt.db.database.prepare("SELECT rowid,id,stream FROM net_outbox WHERE space_id=? AND state IN ('pending','unknown') AND rowid>? ORDER BY rowid LIMIT 64").all(space,after)
      if(!rows.length)break
      for(const row of rows){
        if(signal.aborted)throw new NetError('cancelled')
        after=Number(row.rowid);const entry=rt.outbox.get(row.id as OutboxEntry['id'])!,stored=this.store.getById(row.stream as StreamId,entry.id)
        if(!stored||!Buffer.from(stored.envelope).equals(entry.envelope)||!Buffer.from(stored.sig).equals(entry.sig))throw new NetError('outcome_uncertain')
        rt.outbox.markSent(entry.id,stored)
      }
    }
    if(rt.db.database.prepare('SELECT 1 FROM net_space_private_prepared WHERE space_id=? LIMIT 1').get(space))throw new NetError('outcome_uncertain')
  }
  /** Called only after committed archive activation; source freeze still gates writes. */
  resumeAfterArchive(space:SpaceId):void{
    const state=this.meta.position(space)
    if(!state||state.status!=='active'||this.host.options.archiveAccess?.(space,'write')===false)throw new NetError('space_frozen')
    this.archiveFences.delete(space);this.options.net.resumeSpaceStreams?.(space);this.local.resumeAfterArchive(space)
  }
  beginDisable(): void {
    if (this.stopped) return
    this.stopped = true
    this.localClosing = this.local.close()
    for (const dispose of this.dispose) dispose()
    this.client.close()
    for (const session of this.sessions.values()) session.close()
    this.sessions.clear()
  }
  close(): Promise<void> {
    if (this.closing) return this.closing
    this.beginDisable()
    this.closing = (async () => {
      await this.localClosing
      await Promise.allSettled(this.tasks)
      this.store.close()
    })()
    return this.closing
  }
}
