import { createHash } from 'node:crypto'
import type { BotRuntimeAdapter, Clock, ExecutionLedger, BudgetLedger, IdentityService, KeyStore, Outbox, SyncSession, PrivateStreamKeys } from '../net/contracts'
import type { BotId, SpaceId, StreamId, StoredRecord, StreamDescriptor, ExecutionId, EventId, PresenceMessage, UserId } from '../../shared/net'
import { NetError, newId, spaceMetaStream } from '../../shared/net'
import { NetDatabase, json } from '../net/store/database'
import { canonicalJson, decodeEnvelope } from '../net/sync/codec'
import { SqlPrivateStreamKeys } from '../net/identity'
import type { MetaProjection, SpaceHostService } from '../spaces/host'
import type { PrivateSpaceService, PrivateState } from '../spaces/private'
import type { StreamStore } from '../net/contracts'
import type { ThreadDataStore } from '../data/ThreadDataStore'
import type { ProjectManager } from '../data/ProjectManager'
import { BotAdmissionService, BotOutbox, BotRecordAuthorization, acceptedBotReceipt, type AdmissionInput, type AuthorizedMention, type ConfirmedMetaHead, type BotOutputBinding, type PlannedBotOutput } from './admission'
import { SqliteBotRegistry, type BotConfiguration } from './registry'
import { SqliteCompartmentStore } from './compartments'
import { BotExecutionService, MmsBotMaterializer, deniedBotApprovals } from './execution'
import { BotPermissionService } from './permissions'
import { BotPresenceService, BotPresenceReceiver } from './presence'
import { NativeBotRuntime, effectiveBotPolicyDigest, type NativeBotRuntimeOptions } from './runtime'
import type { BotAdmissionOptions } from './admission/service'
export interface BotSpacePort {
  store: StreamStore; meta: MetaProjection; private: PrivateSpaceService; host: Pick<SpaceHostService,'executionBinding'>
  /** Independently retained historical identity evidence; absent uses the actual profile identity and can only deny missing proof. */
  historyIdentity?: IdentityService
  session(space: SpaceId): SyncSession | undefined
  appendSigned(entry: {stream: StreamId; id: EventId; envelope: Uint8Array; sig: Uint8Array}): Promise<{epoch:number;seq:number;recvTs:number}>
  flush(space: SpaceId): Promise<void>
}
export type NativeBotComposition = Omit<NativeBotRuntimeOptions,'profileId'|'installationHome'|'compartments'|'executionBinding'|'assertCurrent'|'qualification'> & {qualification?:NativeBotRuntimeOptions['qualification']}
export interface BotProfileOptions {
  profileId: string; profileHome: string; installationHome: string
  runtime: {db: NetDatabase; identity: IdentityService; keys: KeyStore; executions: ExecutionLedger; budgets: BudgetLedger; outbox: Outbox}
  spaces: BotSpacePort; threads: ThreadDataStore; projects: ProjectManager
  native?: NativeBotComposition
  /** Trusted immutable published definitions, each with its own adapter key and qualification scope. */
  nativeAdapters?: ReadonlyMap<string,NativeBotComposition>
  /** Explicit local deterministic qualification fixtures. Never constructed from a remote DTO or enabled by default. */
  trustedQaAdapters?: ReadonlyMap<string,BotRuntimeAdapter>
  sendPresence?(message:PresenceMessage):Promise<void>
  presenceIdentity?(space:SpaceId):IdentityService
  /** Accepted heartbeat display evidence only; never used by receipt admission. */
  presenceDisplayIdentity?(space:SpaceId):IdentityService
  /** Actual authority query prepares a scoped current proof; synchronous checks
   * repeat inside admission and execution continuation. Never supplied by DTOs. */
  prepareAdmission?(input:AdmissionInput):Promise<void>
  /** Prepares current wrapping recipients for the exact private audience only. */
  preparePrivateAudience?(space:SpaceId,participants:Array<UserId|BotId>):Promise<void>
  verifyMentionAuthor?:BotAdmissionOptions['verifyMentionAuthor']
  maximumPending?:number; maximumParallel?:number
}
export interface BotQualificationDto {space:SpaceId;bot:BotId;definitionRevision:string;profileDigest:BotConfiguration['profileDigest']}
export interface BotSelectionDto {space:SpaceId;bot:BotId}
export interface BotGrantDto {stream:StreamId;request:EventId;approved:boolean}
type Pending = {input:AdmissionInput;bytes:number;resolve:(value:ExecutionId|undefined)=>void;reject:(error:unknown)=>void}
/** Profile-owned effects composition. Root supplies actual authority/client transport, never an acknowledgement simulator. */
export class BotProfileService {
  readonly compartments:SqliteCompartmentStore
  readonly registry:SqliteBotRegistry
  readonly output:BotOutbox
  readonly admission:BotAdmissionService
  readonly execution:BotExecutionService
  readonly permissions:BotPermissionService
  readonly presence:BotPresenceService
  readonly presenceReceiver:BotPresenceReceiver
  readonly hostAuthorization:BotRecordAuthorization
  readonly clientAuthorization:BotRecordAuthorization
  readonly nativeRuntimes=new Map<string,NativeBotRuntime>()
  private readonly nativeDefinitions=new Map<string,NativeBotComposition['definition']>()
  get native():NativeBotRuntime|undefined{return this.nativeRuntimes.get('mousse')}
  private readonly adapters=new Map<string,BotRuntimeAdapter>()
  private readonly privateKeys:PrivateStreamKeys
  private readonly clock:Clock
  private readonly confirmed=new Map<SpaceId,ConfirmedMetaHead>()
  private readonly queue:Pending[]=[]
  private readonly queued=new Map<string,Promise<ExecutionId|undefined>>()
  private readonly running=new Set<Promise<unknown>>()
  private readonly transport=new Set<Promise<unknown>>()
  private readonly waiting=new Set<ExecutionId>()
  private readonly starting=new Map<ExecutionId,Promise<void>>()
  private readonly dispose:Array<()=>void>=[]
  private queueBytes=0
  private stopped=false
  private archiveFences=new Set<SpaceId>()
  private closing?:Promise<void>
  private watchedPresence=new Map<string,{bot:BotId;stream:StreamId}>()
  constructor(readonly options:BotProfileOptions){
    const rt=options.runtime,spaces=options.spaces;this.clock=rt.db.clock
    if(!Number.isSafeInteger(options.maximumPending??256)||(options.maximumPending??256)<1||(options.maximumPending??256)>256||!Number.isSafeInteger(options.maximumParallel??4)||(options.maximumParallel??4)<1||(options.maximumParallel??4)>32)throw new NetError('bad_request')
    rt.db.transaction(()=>rt.db.database.exec(`
      CREATE TABLE IF NOT EXISTS net_bot_profile_plans(space TEXT NOT NULL,bot TEXT NOT NULL,trigger TEXT NOT NULL,kind TEXT NOT NULL,stream TEXT NOT NULL,PRIMARY KEY(space,bot,trigger,kind));
      CREATE TABLE IF NOT EXISTS net_bot_profile_bindings(space TEXT NOT NULL,execution TEXT NOT NULL,binding TEXT NOT NULL,PRIMARY KEY(space,execution));
      CREATE TABLE IF NOT EXISTS net_bot_client_bindings(space TEXT NOT NULL,execution TEXT NOT NULL,accepted TEXT NOT NULL,binding TEXT NOT NULL,PRIMARY KEY(space,execution),UNIQUE(space,accepted));
      CREATE UNIQUE INDEX IF NOT EXISTS net_bot_profile_mention ON net_bot_profile_bindings(space,json_extract(binding,'$.bot'),json_extract(binding,'$.trigger'));
      CREATE UNIQUE INDEX IF NOT EXISTS net_bot_client_mention ON net_bot_client_bindings(space,json_extract(binding,'$.bot'),json_extract(binding,'$.trigger'));
      CREATE TABLE IF NOT EXISTS net_bot_native_invalid(adapter TEXT PRIMARY KEY,code TEXT NOT NULL);
    `))
    this.compartments=new SqliteCompartmentStore(rt.db,options.profileId)
    for(const [id,adapter]of options.trustedQaAdapters??[])this.adapters.set(id,adapter)
    let implementation:SqlPrivateStreamKeys|undefined
    this.privateKeys=new Proxy({} as PrivateStreamKeys,{get:(_target,name:keyof PrivateStreamKeys)=>{
      if(!implementation){const self=rt.identity.self();if(!self)throw new NetError('not_enrolled');implementation=new SqlPrivateStreamKeys({database:rt.db.database,keys:rt.keys,node:self.node,user:self.user,spaceForStream:stream=>{const space=spaces.store.getStream(stream)?.space;if(!space)throw new NetError('stream_unknown');return space},transaction:work=>rt.db.transaction(work)})}
      const value=implementation[name];return typeof value==='function'?value.bind(implementation):value
    }})
    const nativeSpecs=new Map(options.nativeAdapters??[]);if(options.native){if(nativeSpecs.has('mousse'))throw new NetError('conflict');nativeSpecs.set('mousse',options.native)}
    for(const [id,spec]of nativeSpecs){
      if(this.adapters.has(id)||!id||id.length>128)throw new NetError('conflict')
      const definition=structuredClone(spec.definition);this.nativeDefinitions.set(id,definition)
      const runtime=new NativeBotRuntime({...spec,definition,profileId:options.profileId,installationHome:options.installationHome,compartments:this.compartments,executionBinding:execution=>rt.executions.get(execution)?.binding,assertCurrent:r=>{this.admission.assertExecutionCurrent(r.execution)},qualification:{active:profile=>!rt.db.database.prepare('SELECT 1 FROM net_bot_native_invalid WHERE adapter=?').get(id)&&spec.qualification?.active(profile)===true,invalidate:(code,evidence)=>{rt.db.transaction(()=>{rt.db.charge(1);rt.db.database.prepare('INSERT INTO net_bot_native_invalid VALUES(?,?) ON CONFLICT(adapter) DO UPDATE SET code=excluded.code').run(id,code);for(const bot of this.registry.list().filter(bot=>bot.adapter===id))this.registry.invalidate(bot.bot)});spec.qualification?.invalidate(code,evidence)}}})
      this.nativeRuntimes.set(id,runtime);this.adapters.set(id,runtime)
    }
    this.registry=new SqliteBotRegistry({db:rt.db,identity:rt.identity,keys:rt.keys,meta:spaces.meta,budgets:rt.budgets,adapters:this.adapters})
    const materializer=new MmsBotMaterializer({profileId:options.profileId,profileHome:options.profileHome,threads:options.threads,projects:options.projects})
    this.output=new BotOutbox({db:rt.db,identity:rt.identity,keys:rt.keys,meta:spaces.meta,private:spaces.private,privateKeys:this.privateKeys,store:spaces.store,outbox:rt.outbox,plan:mention=>this.plan(mention,materializer),stage:(mention,record)=>{
      const binding:BotOutputBinding={space:mention.bot.space,stream:record.binding!.stream,parent:mention.input.stream,bot:mention.bot.bot,trigger:mention.envelope.id,execution:record.id,...(record.binding!.visibilityEpoch===undefined?{}:{visibilityEpoch:record.binding!.visibilityEpoch,participantHash:record.binding!.participantHash})};this.saveBinding('net_bot_profile_bindings',binding)
    }})
    this.admission=new BotAdmissionService({profileId:options.profileId,db:rt.db,clock:this.clock,identity:rt.identity,store:spaces.store,meta:spaces.meta,registry:this.registry,executions:rt.executions,budgets:rt.budgets,compartments:this.compartments,private:spaces.private,verifyMentionAuthor:options.verifyMentionAuthor,confirmedMeta:space=>this.confirmed.get(space),clockEstimate:space=>this.localAuthority(space)?{offsetMs:0,rttMs:0,wallDeltaMs:0,measuredAtMonotonic:this.clock.monotonic()}:spaces.session(space)?.clockEstimate(),output:this.output})
    const common={identity:spaces.historyIdentity??rt.identity,meta:spaces.meta,store:spaces.store,private:spaces.private,historicalBot:(space:SpaceId,bot:BotId,auth:{metaEpoch:number;metaSeq:number})=>{const record=spaces.meta.botAt(space,bot,auth),member=record&&spaces.meta.memberAt(space,record.owner,auth);if(!record||!member)return;const delegated=rt.identity.verifySigned<import('../../shared/net').BotDelegation>(record.delegation,member.rootKey);return{owner:record.owner,hostNode:delegated.hostNode,keyEpoch:delegated.keyEpoch}},historicalMember:(space:SpaceId,user:UserId,auth:{metaEpoch:number;metaSeq:number})=>!!spaces.meta.memberAt(space,user,auth),historicalCanSteer:(space:SpaceId,bot:BotId,user:UserId,auth:{metaEpoch:number;metaSeq:number})=>spaces.meta.canSteerAt(space,bot,user,auth)}
    this.hostAuthorization=new BotRecordAuthorization({...common,identity:rt.identity,binding:(space,execution)=>spaces.host.executionBinding(space,execution)})
    this.clientAuthorization=new BotRecordAuthorization({...common,binding:(space,execution)=>this.binding(space,execution),verifyCurrentTrigger:options.verifyMentionAuthor?(record,descriptor,bot)=>options.verifyMentionAuthor!({stream:descriptor.id,bot,record,source:'replay'},descriptor,decodeEnvelope(record.envelope).envelope):undefined})
    this.permissions=new BotPermissionService({db:rt.db,identity:rt.identity,keys:rt.keys,privateKeys:this.privateKeys,private:spaces.private,store:spaces.store,outbox:rt.outbox,executions:rt.executions,admission:this.admission,verifyTrigger:options.verifyMentionAuthor,stream:execution=>this.permissionStream(execution),hostNow:execution=>this.hostNow(rt.executions.get(execution)!.scope as SpaceId)})
    this.execution=new BotExecutionService({db:rt.db,executions:rt.executions,budgets:rt.budgets,compartments:this.compartments,registry:this.registry,admission:this.admission,output:this.output,materializer,adapters:this.adapters,approvals:(record,mention,signal)=>mention.bot.profile==='chat'?deniedBotApprovals:this.permissions.port(record.id,signal),onState:record=>{this.flush(record.scope as SpaceId);this.publishPresence(record.scope as SpaceId,record.target as BotId,record.id)}})
    this.presence=new BotPresenceService({db:rt.db,store:spaces.store,identity:rt.identity,keys:rt.keys,registry:this.registry,executions:rt.executions,send:message=>{if(!options.sendPresence)throw new NetError('forbidden');return this.trackTransport(options.sendPresence(message))}})
    this.presenceReceiver=new BotPresenceReceiver({db:rt.db,identity:rt.identity,meta:spaces.meta,store:spaces.store,identityForSpace:options.presenceIdentity,viewIdentityForSpace:options.presenceDisplayIdentity})
    this.execution.recoverAfterRestart()
    this.dispose.push(rt.outbox.onChanged(entry=>{if(this.stopped)return;const env=decodeEnvelope(entry.envelope).envelope;if(entry.state==='pending'&&env.author.bot)this.flush(spaces.store.getStream(entry.stream)!.space!);if((entry.state==='sent'||entry.state==='failed')&&env.type==='bot.run.accepted'&&env.refs?.execution&&this.waiting.has(env.refs.execution))void this.startWhenAcknowledged(env.refs.execution).catch(()=>{})}))
    // Concrete identity implementations supply this subscription; injected root callbacks remain available too.
    const identity=rt.identity as IdentityService&{onRosterChanged?:(listener:(user:UserId)=>void)=>()=>void};if(identity.onRosterChanged)this.dispose.push(identity.onRosterChanged(user=>this.onRosterChanged(user)))
    this.dispose.push(this.registry.onChanged(()=>this.reconcilePresence()));this.reconcilePresence()
  }
  configure(input:BotConfiguration){this.assertSpaceOpen(input.space);const definition=this.nativeDefinitions.get(input.adapter);if(definition&&(input.definitionRevision!==definition.revision||input.profileDigest!==effectiveBotPolicyDigest(definition,input.profile)))throw new NetError('profile_unsupported');return this.registry.configure(input,Math.floor(this.hostNow(input.space)))}
  qualify(input:BotQualificationDto):void{this.assertSpaceOpen(input.space);this.registry.qualify(input.space,input.bot,input.definitionRevision,input.profileDigest)}
  /** Trusted owner lifecycle after routes and protected keys are ready. */
  onActivated():void{this.reconcilePresence()}
  stop(input:BotSelectionDto):Promise<void>{this.assertOpen();return this.execution.stop(input.space,input.bot)}
  resume(input:BotSelectionDto):void{this.assertSpaceOpen(input.space);this.registry.stop(input.space,input.bot,false)}
  list(){return this.registry.list().map(bot=>({...bot,runtimeSupported:this.adapters.get(bot.adapter)?.supports(bot.profile)===true}))}
  grant(input:BotGrantDto):Promise<EventId>{
    this.assertOpen();if(this.options.runtime.db.inTransaction)throw new NetError('bad_request')
    const {stream,request,approved}=input,space=this.options.spaces.store.getStream(stream)?.space
    if(!space)throw new NetError('forbidden');this.assertSpaceOpen(space)
    return this.trackTransport(Promise.resolve().then(async()=>{
      this.assertSpaceOpen(space)
      const preview=this.permissions.previewGrant(stream,request)
      this.assertSpaceOpen(preview.space);await this.refresh(preview.space);this.assertSpaceOpen(preview.space)
      if(this.options.prepareAdmission){await this.options.prepareAdmission(preview.input);this.assertSpaceOpen(preview.space)}
      if(this.options.preparePrivateAudience){await this.options.preparePrivateAudience(preview.space,preview.control.control.participants);this.assertSpaceOpen(preview.space)}
      const fresh=this.permissions.previewGrant(stream,request)
      if(fresh.space!==preview.space||fresh.hash!==preview.hash||json(fresh.body)!==json(preview.body)||json(fresh.control.control)!==json(preview.control.control))throw new NetError('forbidden')
      return this.permissions.grant(stream,request,approved)
    }))
  }
  receivePresence(message:PresenceMessage,peer:SyncSession['peer']):boolean{return this.presenceReceiver.receive(message,peer)}
  /** Root wires this to ordinary durable stores only; snapshot installation never invokes admission. */
  receiveStored(record:StoredRecord,descriptor:StreamDescriptor,source:'delivery'|'replay'='delivery'):Promise<ExecutionId|undefined>[] {
    if(this.stopped||!['delivery','replay'].includes(source))return[]
    const env=decodeEnvelope(record.envelope).envelope
    if(descriptor.kind==='space.meta'){this.onMetaChanged(descriptor.space!);return[]}
    if(descriptor.space&&this.archiveFences.has(descriptor.space))return[]
    if(env.type==='bot.permission.granted'||env.type==='bot.permission.denied'){try{this.permissions.receive(descriptor.id,record)}catch{/* Unrelated/malformed owner grants never become an approval. */}return[]}
    if(env.type!=='message.posted'||!env.author.user||env.author.bot)return[]
    return [...new Set(env.refs?.mentions??[])].filter(bot=>descriptor.space&&this.registry.get(descriptor.space,bot)).map(bot=>{const promise=this.enqueue({stream:descriptor.id,bot,record,source});void promise.catch(()=>{});return promise})
  }
  onMetaChanged(space:SpaceId):void{this.confirmed.delete(space);this.execution.onMetaChanged(space);this.reconcilePresence()}
  onRosterChanged(user:UserId):void{this.execution.onRosterChanged(user);this.reconcilePresence()}
  onPrivateChanged(_before:PrivateState|undefined,after:PrivateState):void{this.execution.onPrivateChanged(after.stream)}
  /** Client receipts acquire bindings only after actual signed historical actor/policy/audience proofs. */
  verifyHistory(record:StoredRecord,descriptor:StreamDescriptor,control?:PrivateState):void{
    const env=decodeEnvelope(record.envelope).envelope
    if(env.type==='bot.run.accepted'){this.verifyOpening(record,descriptor,control);const original=descriptor.space&&env.refs?.execution&&this.acceptanceId(descriptor.space,env.refs.execution);if(original&&original!==env.id)throw new NetError('conflict')}
    if(env.type==='bot.run.accepted'&&descriptor.space&&env.refs?.execution&&!this.binding(descriptor.space,env.refs.execution)){
      const binding:BotOutputBinding={space:descriptor.space,stream:descriptor.id,parent:descriptor.kind==='space.private'?this.triggerParent(descriptor.space,env.refs.subject!):descriptor.parent!,bot:env.author.bot!,trigger:env.refs.subject!,execution:env.refs.execution,...(descriptor.kind==='space.private'?this.historyAudience(descriptor,env.sealed?.keyEpoch,control):{})}
      const gate=new BotRecordAuthorization({...this.clientAuthorization.options,binding:()=>binding});gate.verifyHistory(record,descriptor,control)
      const commit=()=>{const existing=this.binding(binding.space,binding.execution);if(existing&&json(existing)!==json(binding))throw new NetError('conflict');this.saveBinding('net_bot_client_bindings',binding,env.id)}
      if(this.options.runtime.db.inTransaction)commit();else this.options.runtime.db.transaction(commit)
    }
    this.clientAuthorization.verifyHistory(record,descriptor,control)
  }
  canWriteBotRecord(descriptor:StreamDescriptor,envelope:import('../../shared/net').Envelope,peer:SyncSession['peer']):boolean{
    if(envelope.type!=='bot.run.accepted'&&envelope.type!=='bot.run.expired'&&envelope.refs?.execution){const execution=this.options.runtime.executions.get(envelope.refs.execution);if(execution?.binding)try{if(acceptedBotReceipt(this.options.runtime.outbox,execution).state!=='sent')return false}catch{return false}}
    return this.clientAuthorization.canWrite(descriptor,envelope,peer)
  }
  canBotWrite(descriptor:StreamDescriptor,envelope:import('../../shared/net').Envelope,peer:SyncSession['peer']):boolean{return descriptor.authority===this.options.runtime.identity.self()?.node?this.hostAuthorization.canWrite(descriptor,envelope,peer):this.canWriteBotRecord(descriptor,envelope,peer)}
  validateExecutionReferences(descriptor:StreamDescriptor,envelope:import('../../shared/net').Envelope,peer:SyncSession['peer']):boolean{return descriptor.authority===this.options.runtime.identity.self()?.node?this.hostAuthorization.verifyExecutionReferences(descriptor,envelope,peer):this.clientAuthorization.verifyExecutionReferences(descriptor,envelope,peer)&&this.canWriteBotRecord(descriptor,envelope,peer)}
  async refresh(space:SpaceId):Promise<void>{
    if(this.stopped)throw new NetError('cancelled')
    const {spaces}=this.options,head=this.localAuthority(space)?spaces.store.head(spaceMetaStream(space)):await this.remoteSession(space).metaHead(spaceMetaStream(space)),meta=spaces.meta.state(space)
    if(!meta||meta.frozen||meta.upgradeRequired||head.epoch!==meta.applied.epoch||head.seq>meta.applied.seq)throw new NetError('meta_stale')
    this.confirmed.set(space,{head:{epoch:head.epoch,seq:head.seq},confirmedAtMonotonic:this.clock.monotonic()});this.hostNow(space)
  }
  activeCount():number{return this.queue.length+this.running.size+this.transport.size+this.starting.size}
  async drain():Promise<void>{while(this.activeCount()){this.pump();await Promise.allSettled([...this.running,...this.transport,...this.starting.values()])}}
  close():Promise<void>{
    if(this.closing)return this.closing
    this.stopped=true
    const closing=Promise.resolve().then(async()=>{for(const dispose of this.dispose.splice(0))dispose();this.presence.close();for(const pending of this.queue.splice(0))pending.reject(new NetError('cancelled'));this.queueBytes=0;this.waiting.clear();await this.execution.close();await Promise.allSettled([...this.running,...this.transport,...this.starting.values()]);if(this.options.runtime.db.database.prepare("SELECT 1 FROM net_bot_admission_slots s JOIN net_executions e ON e.id=s.execution WHERE s.active=1 AND e.state='uncertain' LIMIT 1").get())throw new NetError('outcome_uncertain')})
    this.closing=closing
    const settled=()=>{if(this.closing===closing)this.closing=undefined};void closing.then(settled,settled)
    return closing
  }
  private assertOpen():void{if(this.stopped)throw new NetError('cancelled')}
  private assertSpaceOpen(space:SpaceId):void{this.assertOpen();if(this.archiveFences.has(space))throw new NetError('space_frozen')}
  /** Freeze reconciles actual executions. Unscoped in-flight ownership and live
   * effects explicitly deny; this method never invents provider terminal proof. */
  async quiesceForArchive(space:SpaceId,signal:AbortSignal):Promise<void>{
    this.fenceForArchive(space)
    for(let i=this.queue.length-1;i>=0;i--){const pending=this.queue[i];if(this.options.spaces.store.getStream(pending.input.stream)?.space===space){this.queue.splice(i,1);this.queueBytes-=pending.bytes;pending.reject(new NetError('space_frozen'))}}
    this.execution.onMetaChanged(space)
    if(signal.aborted)throw new NetError('cancelled')
    if(this.activeCount()||this.options.runtime.db.database.prepare("SELECT 1 FROM net_executions WHERE scope=? AND state IN ('accepted','running','waitingApproval') LIMIT 1").get(space)||this.options.runtime.db.database.prepare('SELECT 1 FROM net_bot_admission_slots s JOIN net_executions e ON e.id=s.execution WHERE e.scope=? AND s.active=1 LIMIT 1').get(space))throw new NetError('outcome_uncertain')
  }
  fenceForArchive(space:SpaceId):void{this.archiveFences.add(space)}
  resumeAfterArchive(space:SpaceId):void{const meta=this.options.spaces.meta.state(space);if(!meta||meta.frozen||meta.upgradeRequired)throw new NetError('space_frozen');this.archiveFences.delete(space)}
  private enqueue(input:AdmissionInput):Promise<ExecutionId|undefined>{
    const space=this.options.spaces.store.getStream(input.stream)?.space;if(!space)return Promise.reject(new NetError('forbidden'));try{this.assertSpaceOpen(space)}catch(error){return Promise.reject(error)}
    const key=`${input.stream}/${decodeEnvelope(input.record.envelope).envelope.id}/${input.bot}`,old=this.queued.get(key);if(old)return old
    const bytes=input.record.envelope.length+input.record.sig.length;if(this.queue.length>=(this.options.maximumPending??256)||this.queueBytes+bytes>8*1024*1024)return Promise.reject(new NetError('rate_limited'))
    input={...input,record:{...input.record,envelope:new Uint8Array(input.record.envelope),sig:new Uint8Array(input.record.sig)}}
    const promise=new Promise<ExecutionId|undefined>((resolve,reject)=>this.queue.push({input,bytes,resolve,reject})).finally(()=>this.queued.delete(key));this.queued.set(key,promise);this.queueBytes+=bytes;this.pump();return promise
  }
  private pump():void{while(!this.stopped&&this.queue.length&&this.running.size<(this.options.maximumParallel??4)){
    const pending=this.queue.shift()!;this.queueBytes-=pending.bytes
    const task=this.process(pending.input).then(pending.resolve,pending.reject).finally(()=>{this.running.delete(task);this.pump()});this.running.add(task)
  }}
  private async process(input:AdmissionInput):Promise<ExecutionId|undefined>{
    const descriptor=this.options.spaces.store.getStream(input.stream);if(!descriptor?.space)throw new NetError('forbidden')
    this.assertSpaceOpen(descriptor.space)
    await this.refresh(descriptor.space);this.assertSpaceOpen(descriptor.space);if(this.options.prepareAdmission)await this.options.prepareAdmission(input);this.assertSpaceOpen(descriptor.space);const mention=this.admission.preview(input)
    const age=this.hostNow(descriptor.space)-input.record.recvTs,delay=input.record.recvTs-mention.envelope.ts
    if(age>=0&&age<=30000&&delay>=0&&delay<=120000&&mention.descriptor.kind!=='space.private'&&mention.bot.policy.visibility==='private')await this.preparePrivate(mention,'output')
    if(this.stopped)throw new NetError('cancelled')
    this.assertSpaceOpen(descriptor.space)
    const result=this.admission.admit(input)
    if(result.kind==='expired'){await this.options.spaces.flush(descriptor.space);return result.record.id}
    if(result.record.state==='accepted'){this.waiting.add(result.record.id);await this.options.spaces.flush(descriptor.space);await this.startWhenAcknowledged(result.record.id)}
    return result.record.id
  }
  private startWhenAcknowledged(execution:ExecutionId):Promise<void>{const old=this.starting.get(execution);if(old)return old
    const task=(async()=>{if(this.stopped)return;const record=this.options.runtime.executions.get(execution);if(!record||record.state!=='accepted'){this.waiting.delete(execution);return}let acceptance;try{acceptance=acceptedBotReceipt(this.options.runtime.outbox,record)}catch(error){if(error instanceof NetError&&error.details&&typeof error.details==='object'&&(error.details as {acceptanceRejected?:boolean}).acceptanceRejected){this.waiting.delete(execution);await this.execution.start(execution);return}throw error}if(acceptance.state!=='sent')return
      await this.refresh(record.scope as SpaceId);this.assertSpaceOpen(record.scope as SpaceId);const mention=this.admission.mentionForExecution(execution);if(mention.bot.profile!=='chat')await this.preparePrivate(mention,'permission')
      if(this.stopped)return;this.assertSpaceOpen(record.scope as SpaceId);this.waiting.delete(execution);await this.execution.start(execution)
    })().finally(()=>this.starting.delete(execution));this.starting.set(execution,task);return task
  }
  private plan(mention:AuthorizedMention,materializer:MmsBotMaterializer):PlannedBotOutput{
    const ids=materializer.plannedIds(mention)
    if(mention.descriptor.kind==='space.private'||mention.bot.policy.visibility==='private'){
      const stream=mention.descriptor.kind==='space.private'?mention.input.stream:this.plannedStream(mention,'output'),state=this.options.spaces.private.state(stream)
      if(!state||state.blocked)throw new NetError('forbidden');return{...ids,stream,compartment:this.compartments.privateId(mention.bot.bot,stream,state.control.visibilityEpoch),visibilityEpoch:state.control.visibilityEpoch,participantHash:createHash('sha256').update(canonicalJson(state.control.participants)).digest('base64url')}
    }
    return{...ids,stream:newId('stream'),compartment:this.compartments.publicId(mention.bot.bot,mention.bot.space)}
  }
  private async preparePrivate(mention:AuthorizedMention,kind:'output'|'permission'):Promise<StreamId>{
    this.assertSpaceOpen(mention.bot.space)
    if(kind==='output'&&mention.descriptor.kind==='space.thread')throw new NetError('forbidden')
    const rt=this.options.runtime,spaces=this.options.spaces,audience=[...new Set([mention.bot.owner,mention.author,mention.bot.bot])].sort()
    if(this.options.preparePrivateAudience){
      await this.options.preparePrivateAudience(mention.bot.space,audience)
      if(this.stopped)throw new NetError('cancelled')
      this.assertSpaceOpen(mention.bot.space)
      mention=this.admission.preview(mention.input)
      if(json(audience)!==json([...new Set([mention.bot.owner,mention.author,mention.bot.bot])].sort()))throw new NetError('forbidden')
    }
    let stream=this.findPlan(mention,kind)
    if(!stream){rt.db.transaction(()=>{const created=spaces.private.prepareCreation(mention.bot.space,this.channelParent(mention),audience);stream=created.descriptor.id;rt.db.charge(1);rt.db.database.prepare('INSERT INTO net_bot_profile_plans VALUES(?,?,?,?,?)').run(mention.bot.space,mention.bot.bot,mention.envelope.id,kind,stream)})}
    if(!spaces.private.state(stream!))await spaces.private.publishCreation(stream!)
    const state=spaces.private.state(stream!);if(!state||state.blocked||json(state.control.participants)!==json(audience))throw new NetError('forbidden');return stream!
  }
  private channelParent(mention:AuthorizedMention):StreamId{let descriptor=mention.descriptor;for(let depth=0;depth<=32;depth++){
    if(descriptor.kind==='space.channel'&&this.options.spaces.meta.channel(mention.bot.space,descriptor.id)&&!this.options.spaces.meta.channel(mention.bot.space,descriptor.id)!.archived)return descriptor.id
    if(!descriptor.parent)break;const parent=this.options.spaces.store.getStream(descriptor.parent);if(!parent||parent.space!==mention.bot.space||parent.authority!==mention.descriptor.authority)break;descriptor=parent
  }throw new NetError('forbidden')}
  private findPlan(mention:AuthorizedMention,kind:string):StreamId|undefined{return this.options.runtime.db.database.prepare('SELECT stream FROM net_bot_profile_plans WHERE space=? AND bot=? AND trigger=? AND kind=?').get(mention.bot.space,mention.bot.bot,mention.envelope.id,kind)?.stream as StreamId|undefined}
  private plannedStream(mention:AuthorizedMention,kind:string):StreamId{return this.findPlan(mention,kind)??(()=>{throw new NetError('forbidden')})()}
  private permissionStream(execution:ExecutionId):StreamId{return this.plannedStream(this.admission.mentionForExecution(execution),'permission')}
  private binding(space:SpaceId,execution:ExecutionId):BotOutputBinding|undefined{for(const table of ['net_bot_profile_bindings','net_bot_client_bindings']){const row=this.options.runtime.db.database.prepare(`SELECT binding FROM ${table} WHERE space=? AND execution=?`).get(space,execution);if(row)return JSON.parse(row.binding as string)}return this.options.spaces.host.executionBinding(space,execution)}
  private saveBinding(table:'net_bot_profile_bindings'|'net_bot_client_bindings',binding:BotOutputBinding,accepted?:EventId):void{const text=json(binding),db=this.options.runtime.db;db.charge(1,Buffer.byteLength(text));if(table==='net_bot_profile_bindings')db.database.prepare('INSERT INTO net_bot_profile_bindings VALUES(?,?,?)').run(binding.space,binding.execution,text);else db.database.prepare('INSERT INTO net_bot_client_bindings VALUES(?,?,?,?)').run(binding.space,binding.execution,accepted!,text)}
  private acceptanceId(space:SpaceId,execution:ExecutionId):EventId|undefined{const local=this.options.runtime.executions.get(execution);if(local?.binding?.space===space)return acceptedBotReceipt(this.options.runtime.outbox,local).id;return this.options.runtime.db.database.prepare('SELECT accepted FROM net_bot_client_bindings WHERE space=? AND execution=?').get(space,execution)?.accepted as EventId|undefined}
  private verifyOpening(record:StoredRecord,descriptor:StreamDescriptor,control?:PrivateState):void{
    if(!descriptor.space||!descriptor.parent)throw new NetError('forbidden')
    const receipt=decodeEnvelope(record.envelope).envelope,meta=this.options.spaces.meta.state(descriptor.space)
    if(!meta||descriptor.kind==='space.thread'&&descriptor.createdAt!==receipt.ts)throw new NetError('forbidden')
    const records=this.options.runtime.db.database.prepare("SELECT envelope,sig FROM net_records r JOIN net_streams s ON s.active_generation=r.generation WHERE s.id=? AND json_extract(CAST(r.envelope AS TEXT),'$.type')='thread.opened' AND json_extract(CAST(r.envelope AS TEXT),'$.body.stream')=? LIMIT 2").all(descriptor.parent,descriptor.id)
    let matches=0
    for(const row of records){const envelope=decodeEnvelope(row.envelope as Uint8Array).envelope;if(envelope.type!=='thread.opened'||(envelope.body as {stream?:string})?.stream!==descriptor.id)continue
      const body=envelope.body as {private:boolean},identity=this.options.spaces.historyIdentity??this.options.runtime.identity,author=identity.verifyAuthor(envelope.author,row.envelope as Uint8Array,row.sig as Uint8Array,envelope.ts,'history')
      if(author.kind!=='node'||!envelope.auth||body.private!==(descriptor.kind==='space.private'))throw new NetError('forbidden')
      if(descriptor.kind==='space.thread'){if(author.node!==descriptor.authority||author.user!==meta.owner||envelope.refs?.replyTo!==receipt.refs?.subject||this.options.spaces.meta.memberAt(descriptor.space,author.user,envelope.auth)?.role!=='owner')throw new NetError('forbidden')}
      else{const state=control??(receipt.sealed&&this.options.spaces.private.historyState(descriptor.id,receipt.sealed.keyEpoch));if(!state||state.controller!==author.user||envelope.refs||!this.options.spaces.meta.memberAt(descriptor.space,author.user,envelope.auth))throw new NetError('forbidden')}
      if(++matches>1)throw new NetError('conflict')
    }
    if(matches!==1)throw new NetError('forbidden')
  }
  private triggerParent(space:SpaceId,id:EventId):StreamId{const rows=this.options.runtime.db.database.prepare("SELECT s.id FROM net_records r JOIN net_streams s ON s.active_generation=r.generation WHERE r.id=? AND s.space_id=? AND s.kind IN ('space.channel','space.private') LIMIT 2").all(id,space);if(rows.length!==1)throw new NetError('forbidden');return rows[0].id as StreamId}
  private historyAudience(descriptor:StreamDescriptor,keyEpoch:number|undefined,control?:PrivateState):{visibilityEpoch:number;participantHash:string}{const state=control??(keyEpoch&&this.options.spaces.private.historyState(descriptor.id,keyEpoch));if(!state||state.stream!==descriptor.id||state.space!==descriptor.space||state.control.keyEpoch!==keyEpoch||state.blocked)throw new NetError('forbidden');return{visibilityEpoch:state.control.visibilityEpoch,participantHash:createHash('sha256').update(canonicalJson(state.control.participants)).digest('base64url')}}
  private localAuthority(space:SpaceId):boolean{return this.options.spaces.meta.state(space)?.descriptor.hostNode===this.options.runtime.identity.self()?.node}
  private remoteSession(space:SpaceId):SyncSession{const session=this.options.spaces.session(space);if(!session||session.state()!=='open')throw new NetError('peer_offline');return session}
  private hostNow(space:SpaceId):number{if(this.localAuthority(space))return this.clock.now();const sample=this.remoteSession(space).clockEstimate(),now=this.clock.monotonic();if(!sample||!Object.values(sample).every(Number.isFinite)||now<sample.measuredAtMonotonic||now-sample.measuredAtMonotonic>30000||sample.rttMs<0||sample.rttMs>5000||Math.abs(sample.offsetMs)>60000||Math.abs(sample.wallDeltaMs)>1000)throw new NetError('clock_skew');return this.clock.now()+sample.offsetMs}
  private flush(space:SpaceId):void{if(!this.stopped)this.trackTransport(this.options.spaces.flush(space)).catch(()=>{})}
  private trackTransport<T>(promise:Promise<T>):Promise<T>{this.transport.add(promise);void promise.finally(()=>this.transport.delete(promise)).catch(()=>{});return promise}
  private reconcilePresence():void{
    if(this.stopped)return
    const desired=new Map<string,{bot:BotId;stream:StreamId}>(),spaces=this.options.spaces,identity=this.options.runtime.identity
    if(this.options.sendPresence)for(const record of this.registry.list())try{
      if(this.archiveFences.has(record.space))continue
      const current=this.registry.current(record.space,record.bot),meta=spaces.meta.state(record.space)
      if(!meta||meta.frozen||meta.upgradeRequired||identity.pinnedRootKey(current.owner)!==meta.members.get(current.owner)?.rootKey)continue
      const channel=spaces.store.listStreams({space:record.space,kind:'space.channel'}).find(stream=>stream.authority===meta.descriptor.hostNode&&meta.channels.get(stream.id)?.archived===false&&spaces.meta.canRead(record.space,stream,current.owner))
      if(channel)desired.set(`${record.space}/${record.bot}`,{bot:record.bot,stream:channel.id})
    }catch{/* Missing current qualification, member, roster or key evidence cannot start a heartbeat. */}
    for(const[key,old]of this.watchedPresence){const next=desired.get(key);if(!next||next.stream!==old.stream)this.presence.unwatch(old.bot,old.stream)}
    for(const[key,next]of desired){const old=this.watchedPresence.get(key);if(!old||old.stream!==next.stream)this.presence.watch(next.bot,next.stream)}
    this.watchedPresence=desired
  }
  private publishPresence(space:SpaceId,bot:BotId,execution?:ExecutionId):void{if(this.stopped||!this.options.sendPresence)return;const channel=this.options.spaces.store.listStreams({space,kind:'space.channel'}).find(stream=>!this.options.spaces.meta.channel(space,stream.id)?.archived);if(channel)this.trackTransport(this.presence.publish(bot,channel.id,execution)).catch(()=>{})}
}
