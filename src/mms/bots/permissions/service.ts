import { createHash } from 'node:crypto'
import type { BotApprovalPort, ExecutionLedger, ExecutionRecord, IdentityService, KeyStore, Outbox, PrivateStreamKeys, StreamStore } from '../../net/contracts'
import type { BotPermissionRequest, BotPermissionGrant, Envelope, EventId, ExecutionId, StoredRecord, StreamId, NodeDelegation, Roster } from '../../../shared/net'
import { newId, NetError, validateEventBody } from '../../../shared/net'
import { NetDatabase, json, same } from '../../net/store/database'
import { canonicalJson, decodeEnvelope } from '../../net/sync/codec'
import type { PrivateSpaceService } from '../../spaces/private'
import { decodeBase64 } from '../../net/identity/crypto'
import { privateContentAAD } from '../../spaces/private/service'
import type { BotAdmissionService } from '../admission'
import { acceptedBotReceipt } from '../admission/outbox'
export interface BotPermissionOptions {
  db: NetDatabase; identity: IdentityService; keys: KeyStore; privateKeys: PrivateStreamKeys
  private: PrivateSpaceService; store: StreamStore; outbox: Outbox; executions: ExecutionLedger; admission: BotAdmissionService
  /** An already authenticated participant-control stream containing exactly owner/requester/bot. */
  stream(execution: ExecutionId): StreamId
  /** Qualified host clock; fails closed when measurement is stale. */
  hostNow(execution: ExecutionId): number
}
type Decision = Awaited<ReturnType<BotApprovalPort['requestAction']>>
interface PermissionRow { request: EventId; execution: ExecutionId; stream: StreamId; body: BotPermissionRequest; hash: string; phase: 'pending'|'granted'|'denied'|'consumed'|'expired'; grant?: EventId }
/** All grants are exact independently owner-signed private envelopes; host callbacks never grant effects. */
export class BotPermissionService {
  private waiters = new Map<EventId, (decision: Decision) => void>()
  constructor(readonly options: BotPermissionOptions) {
    options.db.transaction(()=>options.db.database.exec('CREATE TABLE IF NOT EXISTS net_bot_permissions(request TEXT PRIMARY KEY,execution TEXT NOT NULL,stream TEXT NOT NULL,row TEXT NOT NULL);CREATE TABLE IF NOT EXISTS net_bot_permission_issued(request TEXT PRIMARY KEY,event TEXT NOT NULL,approved INTEGER NOT NULL)'))
  }
  port(execution: ExecutionId, signal: AbortSignal): BotApprovalPort {
    return { requestAction: input => this.request(execution,input,signal),consume: async(grant,actionHash)=>this.consume(execution,grant,actionHash) }
  }
  async request(execution: ExecutionId, input: Parameters<BotApprovalPort['requestAction']>[0], signal: AbortSignal): Promise<Decision> {
    if(this.options.db.inTransaction)throw new NetError('bad_request');if(signal.aborted)throw new NetError('cancelled')
    decodeBase64(input.argumentDigest,32);decodeBase64(input.actionHash,32)
    const mention=this.options.admission.mentionForExecution(execution),record=this.options.executions.get(execution)!,binding=record.binding!
    this.options.admission.assertExecutionCurrent(execution)
    if(record.state!=='running'||!input.tool||input.tool.length>128||!validateEventBody('bot.permission.requested',{kind:'runtimeAction',requester:mention.author,bot:binding.bot,trigger:mention.envelope.id,summary:`Approve ${input.tool} action (${input.argumentDigest}).`,expiresAt:Math.floor(this.options.hostNow(execution))+86400000,binding:{stream:binding.stream,compartment:binding.compartment,...(binding.visibilityEpoch===undefined?{}:{visibilityEpoch:binding.visibilityEpoch})},execution,actionHash:input.actionHash,profileDigest:binding.profileDigest}))throw new NetError('forbidden')
    const permissionBinding={stream:binding.stream,compartment:binding.compartment,...(binding.visibilityEpoch===undefined?{}:{visibilityEpoch:binding.visibilityEpoch})},actionHash=this.hash(canonicalJson({execution,tool:input.tool,argumentDigest:input.argumentDigest,profileDigest:binding.profileDigest,binding:permissionBinding}))
    if(actionHash!==input.actionHash)throw new NetError('forbidden')
    const stream=this.options.stream(execution);this.audience(execution,stream)
    // The permission stream may be flushed before the output stream. Its host must first know the execution binding.
    if(acceptedBotReceipt(this.options.outbox,record).state!=='sent')await this.waitForAcceptance(record,signal)
    if(signal.aborted)throw new NetError('cancelled')
    this.options.admission.assertExecutionCurrent(execution);this.audience(execution,stream)
    const id=newId('event'),expiresAt=Math.floor(this.options.hostNow(execution))+86400000,body:BotPermissionRequest={kind:'runtimeAction',requester:mention.author,bot:binding.bot,trigger:mention.envelope.id,summary:`Approve ${input.tool} action (${input.argumentDigest}).`,expiresAt,binding:permissionBinding,execution,actionHash,profileDigest:binding.profileDigest},meta=this.options.admission.options.meta.state(binding.space)!,envelope:Envelope={v:1,minor:0,id,stream,type:'bot.permission.requested',crit:false,author:{bot:binding.bot,node:mention.bot.hostNode,keyEpoch:mention.bot.placementEpoch},ts:this.options.db.clock.now(),auth:{metaEpoch:meta.applied.epoch,metaSeq:meta.applied.seq},refs:{execution,thread:stream}}
    envelope.sealed=this.options.privateKeys.seal(stream,canonicalJson(body),privateContentAAD(envelope));const bytes=canonicalJson(envelope),signature=this.options.keys.signAsBot(binding.bot,bytes);decodeEnvelope(bytes)
    const row:PermissionRow={request:id,execution,stream,body,hash:this.hash(bytes),phase:'pending'}
    this.options.db.transaction(()=>{
      if(signal.aborted)throw new NetError('cancelled')
      this.options.admission.assertExecutionCurrent(execution);this.audience(execution,stream)
      const pending=Number(this.options.db.database.prepare("SELECT count(*) AS n FROM net_bot_permissions WHERE json_extract(row,'$.body.bot')=? AND json_extract(row,'$.phase')='pending' AND json_extract(row,'$.body.expiresAt')>?").get(binding.bot,this.options.hostNow(execution))!.n)
      if(pending>=20)throw new NetError('rate_limited')
      this.save(row);this.options.executions.transition(execution,'waitingApproval',this.options.db.clock.now());this.options.outbox.enqueue({id,stream,envelope:bytes,sig:signature})
    })
    return new Promise<Decision>((resolve,reject)=>{
      let timer:ReturnType<typeof this.options.db.clock.setTimeout>|undefined
      const cleanup=()=>{this.waiters.delete(id);signal.removeEventListener('abort',abort);timer?.cancel()}
      const finish=(decision:Decision)=>{cleanup();resolve(decision)},abort=()=>{cleanup();reject(new NetError('cancelled'))}
      this.waiters.set(id,finish);signal.addEventListener('abort',abort,{once:true});timer=this.options.db.clock.setTimeout(()=>{cleanup();this.options.db.transaction(()=>{const current=this.required(id);if(current.phase==='pending'){current.phase='expired';this.save(current)}});resolve({decision:'denied',request:id})},Math.max(0,expiresAt-this.options.hostNow(execution)))
      if(signal.aborted)abort()
      else {const committed=this.required(id);if(committed.grant&&(committed.phase==='granted'||committed.phase==='denied')){const grant=this.options.store.getById(stream,committed.grant);if(grant)try{this.receive(stream,grant)}catch(error){cleanup();reject(error)}}}
    })
  }
  /** After this exact signed owner grant/denial was durably stored in the private stream. */
  receive(stream:StreamId,record:StoredRecord):void {
    const envelope=decodeEnvelope(record.envelope).envelope
    if(envelope.type!=='bot.permission.granted'&&envelope.type!=='bot.permission.denied')return
    const indexed=this.options.store.getById(stream,envelope.id)
    if(!indexed||!Buffer.from(indexed.envelope).equals(record.envelope)||!Buffer.from(indexed.sig).equals(record.sig))throw new NetError('forbidden')
    const author=this.options.identity.verifyAuthor(envelope.author,record.envelope,record.sig,envelope.ts,'newWork'),body=this.options.private.open(stream,record)as BotPermissionGrant|{request:EventId},row=this.required(body.request),mention=this.options.admission.mentionForExecution(row.execution)
    if(author.kind!=='node'||author.user!==mention.bot.owner||envelope.refs?.subject!==row.request||row.stream!==stream)throw new NetError('forbidden')
    this.audience(row.execution,stream)
    const request=this.options.store.getById(stream,row.request)
    if(!request||this.hash(request.envelope)!==row.hash)throw new NetError('forbidden')
    this.options.identity.verifyAuthor(decodeEnvelope(request.envelope).envelope.author,request.envelope,request.sig,decodeEnvelope(request.envelope).envelope.ts,'newWork')
    const now=this.options.hostNow(row.execution)
    if(now>=row.body.expiresAt)throw new NetError('cancelled')
    if(envelope.type==='bot.permission.granted'){
      const grant=body as BotPermissionGrant
      if(grant.kind!=='runtimeAction'||row.body.kind!=='runtimeAction'||grant.requestHash!==row.hash||grant.execution!==row.execution||grant.actionHash!==row.body.actionHash||grant.profileDigest!==row.body.profileDigest||!same(grant.binding,row.body.binding)||grant.expiresAt>row.body.expiresAt||now>=grant.expiresAt)throw new NetError('forbidden')
    }
    this.options.db.transaction(()=>{
      this.options.admission.assertExecutionCurrent(row.execution);this.audience(row.execution,stream)
      const latest=this.required(row.request)
      if(latest.phase!=='pending'){if(latest.grant!==envelope.id)throw new NetError('conflict');if(latest.phase!=='granted'&&latest.phase!=='denied')return}
      else {latest.phase=envelope.type==='bot.permission.granted'?'granted':'denied';latest.grant=envelope.id;this.save(latest)}
      const decision:Decision=envelope.type==='bot.permission.granted'?{decision:'approved',approval:envelope.id,expiresAt:(body as BotPermissionGrant).expiresAt-(this.options.hostNow(row.execution)-this.options.db.clock.now())}:{decision:'denied',request:row.request}
      this.options.db.afterCommit(()=>this.waiters.get(row.request)?.(decision))
    })
  }
  /** Owner-local approval of a real signed request; returns only after the sealed outbox journal commits. */
  grant(stream: StreamId, requestId: EventId, approved: boolean): EventId {
    if(this.options.db.inTransaction)throw new NetError('bad_request')
    const request=this.options.store.getById(stream,requestId);if(!request)throw new NetError('forbidden')
    const envelope=decodeEnvelope(request.envelope).envelope,author=this.options.identity.verifyAuthor(envelope.author,request.envelope,request.sig,envelope.ts,'newWork'),body=this.options.private.open(stream,request)as BotPermissionRequest,descriptor=this.options.store.getStream(stream),self=this.options.identity.self(),meta=descriptor?.space&&this.options.admission.options.meta.state(descriptor.space)
    if(author.kind!=='bot'||envelope.type!=='bot.permission.requested'||body.kind!=='runtimeAction'||author.bot!==body.bot||!self||!meta||meta.frozen||meta.upgradeRequired||meta.bots.get(body.bot)?.owner!==self.user||author.user!==self.user||!meta.members.has(body.requester)||!this.options.admission.options.meta.canSteer(meta.space,body.bot,body.requester))throw new NetError('forbidden')
    const output=this.options.store.getStream(body.binding.stream),trigger=(output?.kind==='space.private'?this.options.store.getById(output.id,body.trigger):undefined)??(output?.parent?this.options.store.getById(output.parent,body.trigger):undefined)
    if(!output||output.space!==meta.space||!trigger)throw new NetError('forbidden')
    const message=decodeEnvelope(trigger.envelope).envelope,triggerAuthor=this.options.identity.verifyAuthor(message.author,trigger.envelope,trigger.sig,message.ts,'newWork')
    if(triggerAuthor.kind!=='node'||triggerAuthor.user!==body.requester||message.type!=='message.posted'||!message.refs?.mentions?.includes(body.bot))throw new NetError('forbidden')
    const state=this.options.private.state(stream)
    if(!state||state.blocked||!same(state.control.participants,[...new Set([self.user,body.requester,body.bot])].sort()))throw new NetError('forbidden')
    const now=this.options.hostNow(body.execution)
    if(now>=body.expiresAt||body.expiresAt>now+86400000)throw new NetError('cancelled')
    const grant:BotPermissionGrant={kind:'runtimeAction',request:requestId,requestHash:this.hash(request.envelope),expiresAt:body.expiresAt,execution:body.execution,actionHash:body.actionHash,profileDigest:body.profileDigest,binding:body.binding}
    const existing=this.options.db.database.prepare('SELECT event,approved FROM net_bot_permission_issued WHERE request=?').get(requestId)
    if(existing){if(existing.approved!==Number(approved))throw new NetError('conflict');return existing.event as EventId}
    const root=this.options.identity.pinnedRootKey(self.user)!,roster=this.options.identity.verifySigned<Roster>(this.options.identity.roster(self.user)!,root),node=roster.nodes.map(signed=>this.options.identity.verifySigned<NodeDelegation>(signed,root)).filter(row=>row.subject===self.node).sort((a,b)=>b.keyEpoch-a.keyEpoch||b.issuedAt-a.issuedAt)[0]
    if(!node)throw new NetError('bad_delegation')
    const eventId=newId('event'),grantEnvelope:Envelope={v:1,minor:0,id:eventId,stream,type:approved?'bot.permission.granted':'bot.permission.denied',crit:false,author:{user:self.user,node:self.node,keyEpoch:node.keyEpoch},ts:this.options.db.clock.now(),auth:{metaEpoch:meta.applied.epoch,metaSeq:meta.applied.seq},refs:{subject:requestId,thread:stream}}
    grantEnvelope.sealed=this.options.privateKeys.seal(stream,canonicalJson(approved?grant:{request:requestId}),privateContentAAD(grantEnvelope))
    const bytes=canonicalJson(grantEnvelope),signature=this.options.keys.signAsNode(bytes);decodeEnvelope(bytes)
    this.options.db.transaction(()=>{
      this.options.identity.verifyAuthor(grantEnvelope.author,bytes,signature,grantEnvelope.ts,'newWork')
      const control=this.options.private.state(stream);if(!control||control.blocked||!same(control.control,state.control)||this.options.hostNow(body.execution)>=body.expiresAt)throw new NetError('forbidden')
      this.options.outbox.enqueue({id:eventId,stream,envelope:bytes,sig:signature});this.options.db.charge(1);this.options.db.database.prepare('INSERT INTO net_bot_permission_issued VALUES(?,?,?)').run(requestId,eventId,Number(approved))
    })
    return eventId
  }
  consume(execution:ExecutionId,grant:EventId,actionHash:string):void {
    if(this.options.db.inTransaction)throw new NetError('bad_request', 'Effect authorization must commit before it escapes.')
    this.options.db.transaction(()=>{
      this.options.admission.assertExecutionCurrent(execution)
      if(acceptedBotReceipt(this.options.outbox,this.options.executions.get(execution)!).state!=='sent')throw new NetError('forbidden')
      const found=this.options.db.database.prepare("SELECT row FROM net_bot_permissions WHERE execution=? AND json_extract(row,'$.grant')=?").get(execution,grant)
      if(!found)throw new NetError('forbidden');const row=JSON.parse(found.row as string)as PermissionRow
      if(row.phase!=='granted'||row.body.kind!=='runtimeAction'||row.body.actionHash!==actionHash||this.options.hostNow(execution)>=row.body.expiresAt)throw new NetError('forbidden')
      const grantRecord=this.options.store.getById(row.stream,grant);if(!grantRecord)throw new NetError('forbidden')
      // Repeat the independent owner signature and exact grants at dispatch, including current key revocation.
      const env=decodeEnvelope(grantRecord.envelope).envelope,verified=this.options.identity.verifyAuthor(env.author,grantRecord.envelope,grantRecord.sig,env.ts,'newWork'),mention=this.options.admission.mentionForExecution(execution),body=this.options.private.open(row.stream,grantRecord)as BotPermissionGrant
      if(verified.kind!=='node'||verified.user!==mention.bot.owner||body.kind!=='runtimeAction'||body.request!==row.request||body.requestHash!==row.hash||body.execution!==execution||body.actionHash!==actionHash||body.profileDigest!==row.body.profileDigest||!same(body.binding,row.body.binding)||this.options.hostNow(execution)>=body.expiresAt)throw new NetError('forbidden')
      this.audience(execution,row.stream);row.phase='consumed';this.save(row);this.options.executions.transition(execution,'running',this.options.db.clock.now())
    })
  }
  private audience(execution:ExecutionId,stream:StreamId):void {const mention=this.options.admission.mentionForExecution(execution),state=this.options.private.state(stream);if(!state||state.blocked||!same(state.control.participants,[...new Set([mention.bot.owner,mention.author,mention.bot.bot])].sort()))throw new NetError('forbidden')}
  private waitForAcceptance(record:ExecutionRecord,signal:AbortSignal):Promise<void>{return new Promise((resolve,reject)=>{
    let stop:()=>void=()=>{},timer:ReturnType<typeof this.options.db.clock.setTimeout>|undefined,done=false
    const cleanup=()=>{done=true;stop();signal.removeEventListener('abort',abort);timer?.cancel()},abort=()=>{if(done)return;cleanup();reject(new NetError('cancelled'))},check=()=>{if(done)return;try{const receipt=acceptedBotReceipt(this.options.outbox,record);if(receipt.state==='sent'){cleanup();resolve()}}catch(error){cleanup();reject(error)}}
    stop=this.options.outbox.onChanged(()=>check());signal.addEventListener('abort',abort,{once:true});timer=this.options.db.clock.setTimeout(abort,30000);if(signal.aborted)abort();else check()
  })}
  private required(id:EventId):PermissionRow{const row=this.options.db.database.prepare('SELECT row FROM net_bot_permissions WHERE request=?').get(id);if(!row)throw new NetError('forbidden');return JSON.parse(row.row as string)}
  private save(row:PermissionRow):void{const text=json(row);this.options.db.charge(1,Buffer.byteLength(text));this.options.db.database.prepare('INSERT INTO net_bot_permissions VALUES(?,?,?,?) ON CONFLICT(request) DO UPDATE SET row=excluded.row').run(row.request,row.execution,row.stream,text)}
  private hash(bytes:Uint8Array):string{return createHash('sha256').update(bytes).digest('base64url')}
}
