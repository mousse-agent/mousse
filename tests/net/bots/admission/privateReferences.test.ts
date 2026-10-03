import { createHash } from 'node:crypto'
import { afterEach, expect, it } from 'vitest'
import { BotOutbox, BotRecordAuthorization } from '../../../../src/mms/bots/admission'
import { PrivateSpaceService, privateContentAAD } from '../../../../src/mms/spaces/private/service'
import { SqlPrivateStreamKeys } from '../../../../src/mms/net/identity'
import { SpaceHostService } from '../../../../src/mms/spaces/host'
import { NetSyncSession } from '../../../../src/mms/net/sync/session'
import { canonicalJson, decodeEnvelope } from '../../../../src/mms/net/sync/codec'
import { newId } from '../../../../src/shared/net'
import { SqliteStreamStore } from '../../../../src/mms/net/store/streams'
import { SqliteOutbox } from '../../../../src/mms/net/store/outbox'
import { channels, cleanup, disposers, peer, profile, trust } from '../../spaces/host/helpers'
import { setup } from './helpers'
afterEach(cleanup)
it.each(['bot.run.completed','bot.permission.requested'])('rejects a genuinely node-signed sealed %s from a human over actual TLS',async(type)=>{
 const f=await privateFixture(),authority=new SpaceHostService({...f.p.host.options,privateAuthorization:f.privateService,botAuthorization:f.gate}),tls=await channels(f.p,f.p),server=new NetSyncSession({channel:tls.server,identity:f.p.identity,store:f.p.store,authority,clock:f.p.clock}),client=new NetSyncSession({channel:tls.client,identity:f.p.identity,store:f.p.store,clock:f.p.clock})
 disposers.push(()=>server.close(),()=>client.close());await Promise.all([server.opened,client.opened])
 const human=f.privateService.seal(f.created.descriptor.id,'message.posted',{text:'Real human target'})
 await client.append(f.created.descriptor.id,human.id,human.envelope,human.sig)
 const body=type==='bot.run.completed'?{text:'Forged completion'}:{kind:'runtimeAction',requester:f.me.user,bot:f.bot,trigger:human.id,summary:'Forged action request',expiresAt:f.p.clock.now()+86400000,binding:{stream:f.record.binding!.stream,compartment:f.record.binding!.compartment,visibilityEpoch:1},execution:f.record.id,actionHash:Buffer.alloc(32,1).toString('base64url'),profileDigest:f.record.binding!.profileDigest}
 const env={...decodeEnvelope(human.envelope).envelope,id:newId('event'),type,refs:{subject:human.id,replyTo:human.id,thread:f.created.descriptor.id,...(type.startsWith('bot.run.')?{execution:f.record.id}:{})}};delete env.sealed;env.sealed=f.privateKeys.seal(env.stream,canonicalJson(body),privateContentAAD(env));const bytes=canonicalJson(env),forged={envelope:bytes,sig:f.p.keys.signAsNode(bytes)};expect(f.p.identity.verifyAuthor(env.author,forged.envelope,forged.sig,env.ts,'newWork').kind).toBe('node')
 await expect(client.append(env.stream,env.id,forged.envelope,forged.sig)).rejects.toMatchObject({code:'forbidden'})
 expect(f.p.store.getById(env.stream,env.id)).toBeUndefined()
})
it('allows a prepared local private opening only with its exact durable parent bytes, signature and child descriptor',async()=>{
 const f=await setup(),me=peer(f.p),privateKeys=new SqlPrivateStreamKeys({database:f.p.db.database,keys:f.p.keys,node:me.node,user:me.user,spaceForStream:stream=>f.p.store.getStream(stream)!.space!,transaction:work=>f.p.db.transaction(work)}),service=new PrivateSpaceService({db:f.p.db,identity:f.p.identity,keys:f.p.keys,privateKeys,store:f.p.store,meta:f.p.projection,outbox:f.outbox,clock:f.p.clock}),created=service.prepareCreation(f.space.space,f.parent,[me.user,f.bot])
 expect(service.validatePreparedOpening(created.descriptor,created.parentEvent)).toBe(true)
 const parentRecord={...created.parentEvent,epoch:1,seq:1,recvTs:f.p.clock.now()}
 expect(service.validatePreparedControl(created.descriptor,created.event,parentRecord)).toBe(false)
 const position=f.p.store.appendAsAuthority(f.parent,{...created.parentEvent,recvTs:f.p.clock.now()}),indexedParent={...created.parentEvent,...position}
 expect(service.validatePreparedControl(created.descriptor,created.event,indexedParent)).toBe(true)
 expect(service.validatePreparedControl(created.descriptor,created.event,{...indexedParent,seq:indexedParent.seq+1})).toBe(false)
 const badControlSig=new Uint8Array(created.event.sig);badControlSig[0]^=1
 expect(service.validatePreparedControl(created.descriptor,{...created.event,sig:badControlSig},indexedParent)).toBe(false)
 expect(service.validatePreparedOpening({...created.descriptor,id:newId('stream')},created.parentEvent)).toBe(false)
 expect(service.validatePreparedOpening({...created.descriptor,controller:me.user} as typeof created.descriptor,created.parentEvent)).toBe(false)
 const changed={...decodeEnvelope(created.parentEvent.envelope).envelope,id:newId('event')},bytes=canonicalJson(changed)
 expect(service.validatePreparedOpening(created.descriptor,{envelope:bytes,sig:f.p.keys.signAsNode(bytes)})).toBe(false)
 const signature=new Uint8Array(created.parentEvent.sig);signature[0]^=1
 expect(service.validatePreparedOpening(created.descriptor,{envelope:created.parentEvent.envelope,sig:signature})).toBe(false)
 // Same JSON signed with alternate whitespace still fails the exact original-byte contract.
 const alternate=Buffer.from(JSON.stringify(decodeEnvelope(created.parentEvent.envelope).envelope,null,2))
 expect(service.validatePreparedOpening(created.descriptor,{envelope:alternate,sig:f.p.keys.signAsNode(alternate)})).toBe(false)
 f.outbox.markFailed(created.parentEvent.id,'forbidden');expect(service.validatePreparedOpening(created.descriptor,created.parentEvent)).toBe(false)
})
async function privateFixture(){
 const f=await setup(),me=peer(f.p),privateKeys=new SqlPrivateStreamKeys({database:f.p.db.database,keys:f.p.keys,node:me.node,user:me.user,spaceForStream:stream=>f.p.store.getStream(stream)!.space!,transaction:work=>f.p.db.transaction(work)}),service=new PrivateSpaceService({db:f.p.db,identity:f.p.identity,keys:f.p.keys,privateKeys,store:f.p.store,meta:f.p.projection,outbox:f.outbox,clock:f.p.clock}),created=service.prepareCreation(f.space.space,f.parent,[me.user,f.bot]),position=f.p.store.appendAsAuthority(created.descriptor.id,{...created.event,recvTs:f.p.clock.now()})
 service.applyStored(created.descriptor,{...created.event,...position},'live');f.p.host.postMeta(f.space.space,'bot.policyChanged',{bot:f.bot,policy:{steer:{kind:'everyone'},visibility:'private'}})
 const base=f.service.options.output as BotOutbox,output=new BotOutbox({...base.options,private:service,privateKeys,plan:mention=>({...base.plan(mention),stream:created.descriptor.id,compartment:f.compartments.privateId(f.bot,created.descriptor.id,1),visibilityEpoch:1,participantHash:createHash('sha256').update(canonicalJson(service.state(created.descriptor.id)!.control.participants)).digest('base64url')})})
 f.service.options.output=output;f.service.options.private=service
 const input=f.message(),record=f.service.admit(input).record,binding={space:f.space.space,stream:record.binding!.stream,parent:input.stream,bot:f.bot,trigger:decodeEnvelope(input.record.envelope).envelope.id,execution:record.id,visibilityEpoch:record.binding!.visibilityEpoch,participantHash:record.binding!.participantHash},gate=new BotRecordAuthorization({identity:f.p.identity,meta:f.p.projection,store:f.p.store,private:service,binding:(_space,execution)=>execution===binding.execution?binding:undefined})
 service.options.canBotWrite=(descriptor,envelope,caller)=>gate.canWrite(descriptor,envelope,caller)
 return{...f,me,privateKeys,privateService:service,created,record,output,binding,gate}
}
it('requires immutable execution proof for private cross-stream run references and preserves exact current audience over actual TLS',async()=>{
 const f=await privateFixture(),receipt=f.outbox.list(f.created.descriptor.id).find(e=>decodeEnvelope(e.envelope).envelope.type==='bot.run.accepted')!,env=decodeEnvelope(receipt.envelope).envelope
 expect(f.gate.canWrite(f.created.descriptor,env,f.me)).toBe(true)
 expect(f.privateService.authorizationAudience(f.created.descriptor)).toEqual({visibilityEpoch:f.binding.visibilityEpoch,participantHash:f.binding.participantHash})
 expect(f.gate.canRegisterPrivateAccepted(f.created.descriptor,receipt,f.me,f.binding)).toBe(true)
 expect(f.gate.canRegisterPrivateAccepted(f.created.descriptor,receipt,f.me,{...f.binding,visibilityEpoch:2})).toBe(false)
 expect(f.gate.canRegisterPrivateAccepted(f.created.descriptor,receipt,f.me,{...f.binding,participantHash:Buffer.alloc(32,7).toString('base64url')})).toBe(false)
 const forged=new Uint8Array(receipt.sig);forged[0]^=1
 expect(f.gate.canRegisterPrivateAccepted(f.created.descriptor,{...receipt,sig:forged},f.me,f.binding)).toBe(false)
 expect(f.privateService.canWrite(f.created.descriptor,env,f.me)).toBe(false)
 f.privateService.options.validateExecutionReferences=(descriptor,envelope,caller)=>f.gate.verifyExecutionReferences(descriptor,envelope,caller)
 expect(f.privateService.canWrite(f.created.descriptor,env,f.me)).toBe(true)
 const authority=new SpaceHostService({...f.p.host.options,privateAuthorization:f.privateService,botAuthorization:f.gate}),tls=await channels(f.p,f.p),server=new NetSyncSession({channel:tls.server,identity:f.p.identity,store:f.p.store,authority,clock:f.p.clock}),client=new NetSyncSession({channel:tls.client,identity:f.p.identity,store:f.p.store,clock:f.p.clock})
 disposers.push(()=>server.close(),()=>client.close());await Promise.all([server.opened,client.opened])
 expect(await client.append(env.stream,env.id,receipt.envelope,receipt.sig)).toMatchObject({epoch:1,seq:2})
 expect(f.privateService.open(env.stream,f.p.store.getById(env.stream,env.id)!)).toEqual({title:'Private bot run'})
 async function changed(overrides:Partial<typeof env>,code='forbidden'){const value={...env,type:'bot.run.progress',id:newId('event'),...overrides};delete value.sealed;value.sealed=f.privateKeys.seal(value.stream,canonicalJson({text:'Private progress'}),privateContentAAD(value));const bytes=canonicalJson(value);await expect(client.append(value.stream,value.id,bytes,f.p.keys.signAsBot(f.bot,bytes))).rejects.toMatchObject({code})}
 await changed({refs:{...env.refs,subject:newId('event')}})
 await changed({refs:{...env.refs,replyTo:newId('event')}})
 await changed({refs:{...env.refs,execution:newId('execution')}})
 await changed({auth:{metaEpoch:env.auth!.metaEpoch,metaSeq:env.auth!.metaSeq+1}},'meta_stale')
 expect(f.gate.canWrite(f.created.descriptor,env,f.me,{...f.binding,visibilityEpoch:2})).toBe(false)
 const grant={...env,type:'bot.permission.requested',refs:{...env.refs,subject:env.refs!.subject}}
 expect(f.gate.verifyExecutionReferences(f.created.descriptor,grant,f.me)).toBe(false)
 // A generic bot allow callback cannot make arbitrary references cross the boundary.
 f.privateService.options.canBotWrite=()=>true
 f.privateService.options.validateExecutionReferences=undefined
 expect(f.privateService.canWrite(f.created.descriptor,env,f.me)).toBe(false)
 f.privateService.options.canBotWrite=(descriptor,envelope,caller)=>f.gate.canWrite(descriptor,envelope,caller)
 f.privateService.options.validateExecutionReferences=(descriptor,envelope,caller)=>f.gate.verifyExecutionReferences(descriptor,envelope,caller)
 const control=f.privateService.rotate(f.created.descriptor.id,[f.me.user])
 await client.append(f.created.descriptor.id,control.id,control.envelope,control.sig)
 expect(f.privateService.state(f.created.descriptor.id)!.control.visibilityEpoch).toBe(2)
 expect(f.gate.canWrite(f.created.descriptor,env,f.me)).toBe(false)
 expect(f.privateService.canWrite(f.created.descriptor,env,f.me)).toBe(false)
 expect(()=>f.output.prepareTerminal(f.service.mentionForExecution(f.record.id),f.record.id,f.record.binding!,'bot.run.completed',{text:'Wrong audience'})).toThrow(expect.objectContaining({code:'forbidden'}))
})
it('expires a real sealed private human delivery on the original stream without making an output or reserving more spend',async()=>{
 const f=await privateFixture(),authority=new SpaceHostService({...f.p.host.options,privateAuthorization:f.privateService,botAuthorization:f.gate}),tls=await channels(f.p,f.p),server=new NetSyncSession({channel:tls.server,identity:f.p.identity,store:f.p.store,authority,clock:f.p.clock}),client=new NetSyncSession({channel:tls.client,identity:f.p.identity,store:f.p.store,clock:f.p.clock})
 disposers.push(()=>server.close(),()=>client.close());await Promise.all([server.opened,client.opened])
 const human=f.privateService.seal(f.created.descriptor.id,'message.posted',{text:'Private trigger secret'},{mentions:[f.bot],thread:f.created.descriptor.id})
 await client.append(f.created.descriptor.id,human.id,human.envelope,human.sig)
 f.p.clock.advance(30001);const before=f.budgets.remaining(f.bot,f.space.space,f.p.clock.now()),input={stream:f.created.descriptor.id,bot:f.bot,record:f.p.store.getById(f.created.descriptor.id,human.id)!,source:'delivery' as const},result=f.service.admit(input),marker=f.outbox.list(input.stream).find(e=>decodeEnvelope(e.envelope).envelope.type==='bot.run.expired')!
 expect(result.kind).toBe('expired');expect(result.record.binding).toBeUndefined();expect(f.budgets.remaining(f.bot,f.space.space,f.p.clock.now())).toBe(before)
 expect(await client.append(marker.stream,marker.id,marker.envelope,marker.sig)).toMatchObject({epoch:1,seq:3})
 const env=decodeEnvelope(marker.envelope).envelope;expect(env.body).toBeUndefined();expect(env.refs?.subject).toBe(human.id);expect(Buffer.from(marker.envelope).toString()).not.toContain('Private trigger secret');expect(f.privateService.open(marker.stream,f.p.store.getById(marker.stream,marker.id)!)).toEqual({})
 expect(f.service.admit(input).kind).toBe('duplicate')
})

async function snapshotReplica(f:Awaited<ReturnType<typeof privateFixture>>){
 const p=await profile(f.p.clock,'Opaque history replica');trust(p,f.p)
 p.store.createStream(f.p.store.getStream(f.space.meta)!,1)
 const metaReader=f.p.store.openSnapshot(f.space.meta),metaStage=p.store.beginSnapshot(f.space.meta,metaReader.target)
 try{metaStage.append(metaReader.next(1024*1024,64).records);metaStage.commit()}finally{metaReader.close()}
 p.store.createStream(f.p.store.getStream(f.parent)!,1)
 const trigger=f.p.store.getById(f.parent,f.binding.trigger)!;p.store.applyFromAuthority(f.parent,[trigger])
 p.store.createStream(f.created.descriptor,1)
 const self=peer(p),keys=new SqlPrivateStreamKeys({database:p.db.database,keys:p.keys,node:self.node,user:self.user,spaceForStream:stream=>p.store.getStream(stream)!.space!,transaction:work=>p.db.transaction(work)}),service=new PrivateSpaceService({db:p.db,identity:p.identity,keys:p.keys,privateKeys:keys,store:p.store,meta:p.projection,outbox:new SqliteOutbox(p.db),clock:p.clock})
 const state=p.projection.state(f.space.space)!,bot=state.bots.get(f.bot)!,auth={metaEpoch:state.applied.epoch,metaSeq:state.applied.seq}
 let binding:typeof f.binding|undefined=f.binding
 const gate=new BotRecordAuthorization({identity:p.identity,meta:p.projection,store:p.store,private:service,binding:()=>binding,historicalBot:(_space,id,at)=>id===f.bot&&at.metaEpoch===auth.metaEpoch&&at.metaSeq===auth.metaSeq?{owner:bot.owner,hostNode:bot.delegation.hostNode,keyEpoch:bot.delegation.keyEpoch}:undefined,historicalMember:(space,user,at)=>!!p.projection.memberAt(space,user,at),historicalCanSteer:(_space,id,user,at)=>id===f.bot&&at.metaEpoch===auth.metaEpoch&&at.metaSeq===auth.metaSeq&&state.members.has(user)&&bot.policy.steer.kind==='everyone'})
 const store=new SqliteStreamStore(p.db,service);disposers.push(()=>store.close())
 return{p,service,gate,store,setBinding(value:typeof binding){binding=value}}
}
it('validates immutable bot history against staged signed controls before atomic key/cursor adoption',async()=>{
 const f=await privateFixture(),r=await snapshotReplica(f),control=f.p.store.getById(f.created.descriptor.id,f.created.event.id)!,receipt=f.outbox.list(f.created.descriptor.id).find(e=>decodeEnvelope(e.envelope).envelope.type==='bot.run.accepted')!,accepted={...receipt,epoch:1,seq:2,recvTs:f.p.clock.now()},target={epoch:1,seq:2}
 function rejected(){const stage=r.store.beginSnapshot(f.created.descriptor.id,target);expect(()=>stage.append([control,accepted])).toThrow(expect.objectContaining({code:'forbidden'}));stage.abort();expect(r.service.state(f.created.descriptor.id)).toBeUndefined();expect(r.store.cursor(f.created.descriptor.id).seq).toBe(0)}
 rejected() // No composed bot-history verifier.
 let calls=0;r.service.options.verifyBotRecord=(record,descriptor,verified)=>{calls++;expect(r.service.state(descriptor.id)).toBeUndefined();expect(r.service.historyState(descriptor.id,1)).toBeUndefined();expect(verified.control.participants).toEqual(f.privateService.state(descriptor.id)!.control.participants);r.gate.verifyHistory(record,descriptor,verified)}
 r.setBinding(undefined);rejected()
 r.setBinding({...f.binding,visibilityEpoch:2});rejected()
 r.setBinding({...f.binding,participantHash:Buffer.alloc(32,9).toString('base64url')});rejected()
 r.setBinding(f.binding)
 const stage=r.store.beginSnapshot(f.created.descriptor.id,target);stage.append([control]);expect(r.service.state(f.created.descriptor.id)).toBeUndefined();stage.append([accepted]);expect(r.service.state(f.created.descriptor.id)).toBeUndefined();stage.commit()
 expect(calls).toBe(4);expect(r.store.cursor(f.created.descriptor.id).seq).toBe(2);expect(r.service.historyState(f.created.descriptor.id,1)?.control.visibilityEpoch).toBe(1)
 expect(()=>r.service.open(f.created.descriptor.id,accepted)).toThrow(expect.objectContaining({code:'forbidden'})) // A verified opaque replica has no participant content key.
 r.gate.verifyHistory(accepted,f.created.descriptor)
 r.setBinding(undefined);expect(()=>r.gate.verifyHistory(accepted,f.created.descriptor)).toThrow(expect.objectContaining({code:'forbidden'}))
})
it('rejects bot history sealed under a genuine later control that removed the bot from its audience',async()=>{
 const f=await privateFixture(),r=await snapshotReplica(f),control=f.p.store.getById(f.created.descriptor.id,f.created.event.id)!,receipt=f.outbox.list(f.created.descriptor.id).find(e=>decodeEnvelope(e.envelope).envelope.type==='bot.run.accepted')!,rotation=f.privateService.rotate(f.created.descriptor.id,[f.me.user]),position=f.p.store.appendAsAuthority(f.created.descriptor.id,{...rotation,recvTs:f.p.clock.now()}),removed={...rotation,...position};f.privateService.applyStored(f.created.descriptor,removed,'live')
 const env={...decodeEnvelope(receipt.envelope).envelope,id:newId('event')};delete env.sealed;env.sealed=f.privateKeys.seal(env.stream,canonicalJson({title:'Invalid old audience'}),privateContentAAD(env));const bytes=canonicalJson(env),forged={epoch:1,seq:3,recvTs:f.p.clock.now(),envelope:bytes,sig:f.p.keys.signAsBot(f.bot,bytes)}
 expect(f.p.identity.verifyAuthor(env.author,bytes,forged.sig,env.ts,'history').kind).toBe('bot');expect(env.sealed.keyEpoch).toBe(2)
 r.service.options.verifyBotRecord=(record,descriptor,verified)=>{expect(verified.control.participants).not.toContain(f.bot);r.gate.verifyHistory(record,descriptor,verified)}
 const stage=r.store.beginSnapshot(f.created.descriptor.id,{epoch:1,seq:3});expect(()=>stage.append([control,removed,forged])).toThrow(expect.objectContaining({code:'forbidden'}));stage.abort();expect(r.store.cursor(f.created.descriptor.id).seq).toBe(0);expect(r.service.state(f.created.descriptor.id)).toBeUndefined()
})
it('rejects a schema-valid human bot completion during actual private snapshot staging',async()=>{
 const f=await privateFixture(),r=await snapshotReplica(f),control=f.p.store.getById(f.created.descriptor.id,f.created.event.id)!,human=f.privateService.seal(f.created.descriptor.id,'message.posted',{text:'Human plaintext'})
 const env={...decodeEnvelope(human.envelope).envelope,id:newId('event'),type:'bot.run.completed',refs:{subject:f.binding.trigger,replyTo:f.binding.trigger,thread:f.created.descriptor.id,execution:f.record.id}};delete env.sealed;env.sealed=f.privateKeys.seal(env.stream,canonicalJson({text:'Forged completion'}),privateContentAAD(env));const bytes=canonicalJson(env),forged={epoch:1,seq:2,recvTs:f.p.clock.now(),envelope:bytes,sig:f.p.keys.signAsNode(bytes)}
 expect(decodeEnvelope(bytes).envelope.type).toBe('bot.run.completed');expect(f.p.identity.verifyAuthor(env.author,bytes,forged.sig,env.ts,'history').kind).toBe('node')
 const stage=r.store.beginSnapshot(env.stream,{epoch:1,seq:2});expect(()=>stage.append([control,forged])).toThrow(expect.objectContaining({code:'forbidden'}));stage.abort();expect(r.store.cursor(env.stream).seq).toBe(0);expect(r.service.state(env.stream)).toBeUndefined()
})
