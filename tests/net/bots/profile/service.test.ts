import { afterEach, expect, it, vi } from 'vitest'
import { join } from 'node:path'
import { existsSync } from 'node:fs'
import { createAssistantMessageEventStream, type Model, type Provider, type AssistantMessage, type Context, type StreamOptions } from '@earendil-works/pi-ai'
import { BotProfileService } from '../../../../src/mms/bots/BotProfileService'
import { NativeBotRuntime, effectiveBotPolicyDigest, nativeSdkVersion, modelDigest, type NativeBotDefinition } from '../../../../src/mms/bots/runtime'
import { ProviderAuthService } from '../../../../src/mms/providers/ProviderAuthService'
import { SettingsStore } from '../../../../src/mms/settings/SettingsStore'
import { MousseConfigStore } from '../../../../src/mms/config/MousseConfigStore'
import { ProjectManager } from '../../../../src/mms/data/ProjectManager'
import { ThreadDataStore } from '../../../../src/mms/data/ThreadDataStore'
import { PrivateSpaceService } from '../../../../src/mms/spaces/private'
import { SqlPrivateStreamKeys } from '../../../../src/mms/net/identity'
import { NetSyncSession } from '../../../../src/mms/net/sync/session'
import { SpaceHostService } from '../../../../src/mms/spaces/host'
import { decodeEnvelope } from '../../../../src/mms/net/sync/codec'
import { setup } from '../admission/helpers'
import { profile, channels, cleanup, disposers, peer, trust } from '../../spaces/host/helpers'
import { SqliteExecutionLedger } from '../../../../src/mms/net/store/executions'
import { SqliteBudgetLedger } from '../../../../src/mms/net/store/budgets'
import { SqliteOutbox } from '../../../../src/mms/net/store/outbox'
import { NetError, newId, type StoredRecord } from '../../../../src/shared/net'
import { canonicalJson } from '../../../../src/mms/net/sync/codec'
afterEach(cleanup)
async function fixture(options:{qualification?:boolean;blocked?:boolean;private?:boolean;paused?:boolean;ignoreAbort?:boolean}={}){
 const paused=options.paused;const f=await setup(),p=f.p,auth=new ProviderAuthService(join(p.path,'profile-bot-auth.json'));disposers.push(()=>auth.stop())
 const contexts:Context[]=[],signals:AbortSignal[]=[],model:Model<'anthropic-messages'>={id:'fixture',name:'Fixture',api:'anthropic-messages',provider:'profile-bot-fixture',baseUrl:'https://invalid.test',reasoning:false,input:['text'],cost:{input:1,output:1,cacheRead:1,cacheWrite:1},contextWindow:10000,maxTokens:1000};let release:()=>void=()=>{}
 const ignoreAbort=options.ignoreAbort;const stream=(_model:Model<'anthropic-messages'>,context:Context,options:StreamOptions={})=>{contexts.push(structuredClone(context));signals.push(options.signal!);const result=createAssistantMessageEventStream(),message:AssistantMessage={role:'assistant',api:model.api,provider:model.provider,model:model.id,content:[{type:'text',text:'Exact profile answer'}],stopReason:'stop',timestamp:Date.now(),usage:{input:10,output:10,cacheRead:0,cacheWrite:0,totalTokens:20,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:10/1000000}}};release=()=>{result.push({type:'done',reason:'stop',message});result.end(message)};if(options.signal&&!ignoreAbort)options.signal.addEventListener('abort',release,{once:true});if(!paused)queueMicrotask(release);return result}
 const provider:Provider<'anthropic-messages'>={id:model.provider,name:'Fixture',auth:{apiKey:{name:'Fixture',resolve:async()=>({auth:{apiKey:'deterministic-profile-fixture'}})}},getModels:()=>[model],stream,streamSimple:stream};auth.models.setProvider(provider);await auth.credentials.modify(provider.id,async()=>({type:'api_key',key:'deterministic-profile-fixture'}))
 const definition:NativeBotDefinition={revision:'native-v1',systemPrompt:'Only the exact bot compartment.',billing:{provider:model.provider,model:model.id,api:model.api,modelDigest:modelDigest(model),sdkVersion:nativeSdkVersion(),platform:process.platform,nodeVersion:process.versions.node,runtimeVersion:'mousse-net-native-v1',maximumUnits:60,maxOutputTokens:50,maxRequestBytes:65536,evidence:'Local deterministic charge10 fixture. No paid provider qualification.'},readerTools:[],approval:'always',maxModelCalls:2,maxToolCalls:1,maxElapsedMs:30000},projects=new ProjectManager(p.path),threads=new ThreadDataStore(projects,p.path,{profileId:'profile-a',allowLegacyProjectData:false});projects.setThreadStore(threads)
 let bots!:BotProfileService;const self=peer(p),privateKeys=new SqlPrivateStreamKeys({database:p.db.database,keys:p.keys,node:self.node,user:self.user,spaceForStream:stream=>p.store.getStream(stream)!.space!,transaction:work=>p.db.transaction(work)})
 const privateService=new PrivateSpaceService({db:p.db,identity:p.identity,keys:p.keys,privateKeys,store:p.store,meta:p.projection,botAt:(...args)=>p.projection.botAt(...args),outbox:f.outbox,clock:p.clock,canBotWrite:(...args)=>bots?.canBotWrite(...args)??false,validateExecutionReferences:(...args)=>bots?.validateExecutionReferences(...args)??false,verifyBotRecord:(...args)=>bots.verifyHistory(...args),onControlChanged:(...args)=>bots?.onPrivateChanged(...args)})
 const authority=new SpaceHostService({...p.host.options,outbox:f.outbox,privateAuthorization:privateService,botAuthorization:{canWrite:(...args)=>bots?.hostAuthorization.canWrite(...args)??false,canRegisterAccepted:(...args)=>bots?.hostAuthorization.canRegisterAccepted(...args)??false,canRegisterPrivateAccepted:(...args)=>bots?.hostAuthorization.canRegisterPrivateAccepted(...args)??false}})
 const tls=await channels(p,p),server=new NetSyncSession({channel:tls.server,identity:p.identity,store:p.store,authority,clock:p.clock}),client=new NetSyncSession({channel:tls.client,identity:p.identity,store:p.store,clock:p.clock});disposers.push(()=>server.close(),()=>client.close());await Promise.all([server.opened,client.opened])
 const appendSigned=(entry:{stream:typeof f.parent;id:import('../../../../src/shared/net').EventId;envelope:Uint8Array;sig:Uint8Array})=>client.append(entry.stream,entry.id,entry.envelope,entry.sig)
 privateService.options.publishParentOpen=appendSigned;privateService.options.publishCreation=(_descriptor,entry)=>appendSigned({...entry,stream:decodeEnvelope(entry.envelope).envelope.stream})
 let blocked=options.blocked??false,pending:Promise<void>|undefined
 const flush=()=>{if(blocked)return Promise.resolve();if(pending)return pending;pending=(async()=>{for(let count=0;count<64;count++){let sent=false;for(const descriptor of p.store.listStreams({space:f.space.space})){const entry=f.outbox.due(descriptor.id).find(entry=>!privateService.isPrepared(entry.id));if(!entry)continue;f.outbox.markAttempt(entry.id);try{const position=await appendSigned(entry);f.outbox.markSent(entry.id,position);sent=true}catch(error){if(error instanceof NetError&&['forbidden','not_member','conflict','meta_stale'].includes(error.code))f.outbox.markFailed(entry.id,error.code);throw error}}if(!sent)break}})().finally(()=>{pending=undefined});return pending}
 const port={store:p.store,meta:p.projection,private:privateService,host:authority,session:()=>undefined,appendSigned,flush},native={settings:new SettingsStore(MousseConfigStore.load(p.path)),providerAuth:auth,sdkVersion:nativeSdkVersion(),definition,...(options.qualification?{qualification:{active:()=>true,invalidate:()=>{}}}:{})}
 bots=new BotProfileService({profileId:'profile-a',profileHome:p.path,installationHome:p.path,runtime:{db:p.db,identity:p.identity,keys:p.keys,executions:f.executions,budgets:f.budgets,outbox:f.outbox},spaces:port,threads,projects,native});disposers.push(()=>bots.close())
 if(options.private)p.host.postMeta(f.space.space,'bot.policyChanged',{bot:f.bot,policy:{visibility:'private',steer:{kind:'everyone'}}})
 const configuration={...f.registry.get(f.space.space,f.bot)!,adapter:'mousse',definitionRevision:definition.revision,profileDigest:effectiveBotPolicyDigest(definition,'chat')};bots.configure(configuration)
 if(options.qualification)bots.qualify({space:f.space.space,bot:f.bot,definitionRevision:configuration.definitionRevision,profileDigest:configuration.profileDigest})
 return{...f,bots,port,authority,privateService,contexts,signals,threads,native,projects,client,setBlocked(value:boolean){blocked=value},release:()=>release()}
}
it('keeps actual native production qualification inactive and rejects snapshots before all effects',async()=>{
 const f=await fixture();expect(f.bots.native).toBeInstanceOf(NativeBotRuntime);expect(f.bots.native!.supports('chat')).toBe(false)
 expect(()=>f.bots.qualify({space:f.space.space,bot:f.bot,definitionRevision:f.native.definition.revision,profileDigest:effectiveBotPolicyDigest(f.native.definition,'chat')})).toThrow(expect.objectContaining({code:'profile_unsupported'}))
 const input=f.message();expect(f.bots.receiveStored(input.record,f.p.store.getStream(input.stream)!,'snapshot' as any)).toEqual([])
 const delivery=f.bots.receiveStored(input.record,f.p.store.getStream(input.stream)!)[0];await expect(delivery).rejects.toMatchObject({code:'profile_unsupported'})
 expect(f.contexts).toHaveLength(0);expect(f.p.db.database.prepare('SELECT count(*) AS n FROM net_executions').get()!.n).toBe(0)
})
it('runs the actual native model only after real TLS acceptance, with isolated actual MMS workspace and durable spend',async()=>{
 const f=await fixture({qualification:true}),input=f.message(),id=await f.bots.receiveStored(input.record,f.p.store.getStream(input.stream)!)[0];await f.bots.drain()
 const record=f.executions.get(id!)!,accepted=f.outbox.list(record.binding!.stream).find(entry=>decodeEnvelope(entry.envelope).envelope.type==='bot.run.accepted')!
 expect(record.state).toBe('completed');expect(accepted.state).toBe('sent');expect(f.authority.executionBinding(f.space.space,id!)?.trigger).toBe(input.record.id)
 expect(f.contexts).toHaveLength(1);expect(f.contexts[0].tools).toBeUndefined();expect(f.contexts[0].systemPrompt).toBe(f.native.definition.systemPrompt);expect(f.budgets.remaining(f.bot,f.space.space,f.p.clock.now())).toBe(990)
 expect(existsSync(join(f.threads.getThreadDir(record.binding!.backingThreadId),'bot-workspaces',record.binding!.workspaceId,'.net-bot-workspace.json'))).toBe(true)
 expect(f.bots.compartments.history(record.binding!.compartment,10).map(turn=>turn.text)).toEqual(['Public mention','Exact profile answer'])
 await f.bots.receiveStored(input.record,f.p.store.getStream(input.stream)!)[0];expect(f.contexts).toHaveLength(1)
})
it('retains unknown acceptance without model calls and denies real private progress until authority commits acceptance',async()=>{
 const f=await fixture({qualification:true,blocked:true,private:true});expect(f.bots.activeCount()).toBe(0)
 const input=f.message(),delivery=f.bots.receiveStored(input.record,f.p.store.getStream(input.stream)!)[0];expect(f.bots.activeCount()).toBeGreaterThan(0)
 const id=await delivery,record=f.executions.get(id!)!;await f.bots.drain();expect(f.bots.activeCount()).toBe(0)
 expect(record.state).toBe('accepted');expect(f.contexts).toHaveLength(0);expect(f.budgets.remaining(f.bot,f.space.space,f.p.clock.now())).toBe(940);expect(f.authority.executionBinding(f.space.space,id!)).toBeUndefined()
 const progress=f.bots.output.prepareTerminal(f.bots.admission.mentionForExecution(id!),id!,record.binding!,'bot.run.progress',{text:'Cannot precede authority acceptance'})
 await expect(f.client.append(progress.stream,progress.id,progress.envelope,progress.sig)).rejects.toMatchObject({code:'forbidden'});expect(f.p.store.getById(progress.stream,progress.id)).toBeUndefined()
 f.setBlocked(false);await f.port.flush();await f.bots.drain();expect(f.bots.activeCount()).toBe(0);expect(f.executions.get(id!)?.state).toBe('completed');expect(f.contexts).toHaveLength(1)
 expect(f.authority.executionBinding(f.space.space,id!)?.stream).toBe(record.binding!.stream)
})
it('cancels the exact running provider on current roster revocation and drains known charges without later publication',async()=>{
 const f=await fixture({qualification:true,paused:true}),input=f.message(),delivery=f.bots.receiveStored(input.record,f.p.store.getStream(input.stream)!)[0];await vi.waitFor(()=>expect(f.contexts).toHaveLength(1));expect(f.bots.activeCount()).toBeGreaterThan(0)
 f.p.identity.revoke(f.bot);await delivery;await f.bots.drain();expect(f.bots.activeCount()).toBe(0);expect(f.signals[0].aborted).toBe(true)
 const record=f.executions.find({scope:f.space.space,target:f.bot,trigger:input.record.id})!;expect(record.state).toBe('cancelled');expect(f.p.db.database.prepare('SELECT spent FROM net_budget_calls WHERE execution=?').get(record.id)!.spent).toBe(10)
 expect(f.outbox.list(record.binding!.stream).some(entry=>decodeEnvelope(entry.envelope).envelope.type==='bot.run.completed')).toBe(false)
})
it('adopts client bindings only from genuine bot history plus the indexed owner opening, with atomic rollback and immutable acceptance identity',async()=>{
 const f=await fixture({qualification:true}),reader=await profile(f.p.clock,'History reader');trust(f.p,reader);trust(reader,f.p)
 f.p.host.postMeta(f.space.space,'member.joined',{member:{user:peer(reader).user,rootKey:reader.keys.rootKey()!,role:'member',displayName:'History reader'}})
 const input=f.message(),id=await f.bots.receiveStored(input.record,f.p.store.getStream(input.stream)!)[0];await f.bots.drain()
 const execution=f.executions.get(id!)!,descriptor=f.p.store.getStream(execution.binding!.stream)!,acceptedEntry=f.outbox.list(descriptor.id).find(entry=>decodeEnvelope(entry.envelope).envelope.type==='bot.run.accepted')!,accepted=f.p.store.getById(descriptor.id,acceptedEntry.id)!
 reader.store.createStream(f.p.store.getStream(f.space.meta)!,1);const snapshot=f.p.store.openSnapshot(f.space.meta),stage=reader.store.beginSnapshot(f.space.meta,snapshot.target);stage.append(snapshot.next(1024*1024,64).records);snapshot.close();stage.commit()
 reader.store.createStream(f.p.store.getStream(f.parent)!,1);reader.store.applyFromAuthority(f.parent,[input.record]);reader.store.createStream(descriptor,1)
 const outbox=new SqliteOutbox(reader.db),executions=new SqliteExecutionLedger(reader.db),budgets=new SqliteBudgetLedger(reader.db),self=peer(reader),privateKeys=new SqlPrivateStreamKeys({database:reader.db.database,keys:reader.keys,node:self.node,user:self.user,spaceForStream:stream=>reader.store.getStream(stream)!.space!,transaction:work=>reader.db.transaction(work)})
 const privateService=new PrivateSpaceService({db:reader.db,identity:reader.identity,keys:reader.keys,privateKeys,store:reader.store,meta:reader.projection,outbox,clock:reader.clock}),projects=new ProjectManager(reader.path),threads=new ThreadDataStore(projects,reader.path,{profileId:'reader',allowLegacyProjectData:false});projects.setThreadStore(threads)
 const bots=new BotProfileService({profileId:'reader',profileHome:reader.path,installationHome:reader.path,runtime:{db:reader.db,identity:reader.identity,keys:reader.keys,outbox,executions,budgets},spaces:{store:reader.store,meta:reader.projection,private:privateService,host:reader.host,session:()=>undefined,appendSigned:async()=>{throw new NetError('peer_offline')},flush:async()=>{}},threads,projects});disposers.push(()=>bots.close())
 const count=()=>reader.db.database.prepare('SELECT count(*) AS n FROM net_bot_client_bindings').get()!.n
 expect(()=>bots.verifyHistory(accepted,descriptor)).toThrow(expect.objectContaining({code:'forbidden'}));expect(count()).toBe(0)
 const parentRecords=f.p.store.read(f.parent,{epoch:1,seq:input.record.seq},f.p.store.head(f.parent).seq,1024*1024).records;reader.store.applyFromAuthority(f.parent,parentRecords)
 const badSig=new Uint8Array(accepted.sig);badSig[0]^=1;expect(()=>bots.verifyHistory({...accepted,sig:badSig},descriptor)).toThrow(expect.objectContaining({code:'bad_signature'}));expect(count()).toBe(0)
 expect(()=>reader.db.transaction(()=>{bots.verifyHistory(accepted,descriptor);expect(count()).toBe(1);throw new Error('rollback')})).toThrow('rollback');expect(count()).toBe(0)
 bots.verifyHistory(accepted,descriptor);bots.verifyHistory(accepted,descriptor);expect(count()).toBe(1)
 const original=decodeEnvelope(accepted.envelope).envelope,substitute=canonicalJson({...original,id:newId('event')}),replacement:StoredRecord={...accepted,envelope:substitute,sig:f.p.keys.signAsBot(f.bot,substitute)}
 expect(()=>bots.verifyHistory(replacement,descriptor)).toThrow(expect.objectContaining({code:'conflict'}));expect(count()).toBe(1)
 const completed=f.p.store.read(descriptor.id,{epoch:accepted.epoch,seq:accepted.seq},f.p.store.head(descriptor.id).seq,1024*1024).records.find(record=>decodeEnvelope(record.envelope).envelope.type==='bot.run.completed')!;bots.verifyHistory(completed,descriptor)
 expect(reader.host.executionBinding(f.space.space,id!)).toBeUndefined();expect(reader.db.database.prepare('SELECT count(*) AS n FROM net_executions').get()!.n).toBe(0)
 f.p.host.postMeta(f.space.space,'bot.removed',{bot:f.bot});const updates=f.p.store.read(f.space.meta,reader.store.cursor(f.space.meta),f.p.store.head(f.space.meta).seq,1024*1024).records;reader.db.transaction(()=>{reader.store.applyFromAuthority(f.space.meta,updates);for(const record of updates)reader.projection.apply(f.space.space,record)})
 bots.verifyHistory(completed,descriptor);expect(bots.clientAuthorization.canWrite(descriptor,decodeEnvelope(completed.envelope).envelope,peer(f.p))).toBe(false)
})
it('reconciles an admitted but unacknowledged facade restart without repeating models or accepting a late acknowledgement as execution permission',async()=>{
 const f=await fixture({qualification:true,blocked:true}),input=f.message(),id=await f.bots.receiveStored(input.record,f.p.store.getStream(input.stream)!)[0];await f.bots.drain();expect(f.executions.get(id!)?.state).toBe('accepted');expect(f.contexts).toHaveLength(0)
 await f.bots.close();const restarted=new BotProfileService(f.bots.options);disposers.push(()=>restarted.close())
 expect(f.executions.get(id!)?.state).toBe('failed');expect(f.executions.get(id!)?.error?.code).toBe('not_started');expect(f.budgets.remaining(f.bot,f.space.space,f.p.clock.now())).toBe(1000)
 f.setBlocked(false);await f.port.flush();await restarted.drain();expect(f.contexts).toHaveLength(0)
 await restarted.receiveStored(input.record,f.p.store.getStream(input.stream)!,'replay')[0];await restarted.drain();expect(f.contexts).toHaveLength(0);expect(f.executions.get(id!)?.state).toBe('failed');expect(restarted.activeCount()).toBe(0)
})
it('holds concurrent and repeated close calls behind the real provider drain and uncertainty fence',async()=>{
 const f=await fixture({qualification:true,paused:true,ignoreAbort:true}),input=f.message(),delivery=f.bots.receiveStored(input.record,f.p.store.getStream(input.stream)!)[0];await vi.waitFor(()=>expect(f.contexts).toHaveLength(1))
 const first=f.bots.close().then(()=>undefined,error=>error);let secondSettled=false;const second=f.bots.close().then(()=>{secondSettled=true;return undefined},error=>{secondSettled=true;return error})
 await new Promise<void>(resolve=>setImmediate(resolve));const escapedBeforeDrain=secondSettled,firstResult=await first,secondResult=await second,thirdResult=await f.bots.close().then(()=>undefined,error=>error);await delivery
 const record=f.executions.find({scope:f.space.space,target:f.bot,trigger:input.record.id})!
 expect(record.state).toBe('uncertain');expect(f.p.db.database.prepare('SELECT active FROM net_bot_admission_slots WHERE execution=?').get(record.id)!.active).toBe(1);expect(f.p.db.database.prepare('SELECT spent FROM net_budget_calls WHERE execution=?').get(record.id)!.spent).toBeNull()
 // A late real terminal response proves usage; facade startup reconciles the durable held slot without executing again.
 f.release();await vi.waitFor(()=>expect(f.p.db.database.prepare('SELECT spent FROM net_budget_calls WHERE execution=?').get(record.id)!.spent).toBe(10));const restarted=new BotProfileService(f.bots.options);disposers.push(()=>restarted.close());await restarted.close()
 expect(escapedBeforeDrain).toBe(false);expect(firstResult).toMatchObject({code:'outcome_uncertain'});expect(secondResult).toMatchObject({code:'outcome_uncertain'});expect(thirdResult).toMatchObject({code:'outcome_uncertain'});expect(f.contexts).toHaveLength(1)
},15000)
