import {mkdtempSync,realpathSync,rmSync} from 'node:fs'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import {expect,it,vi} from 'vitest'
import {createAssistantMessageEventStream,type Model,type Provider,type AssistantMessage,type Context,type StreamOptions} from '@earendil-works/pi-ai'
import {BotLocalService} from '../../../../src/mms/bots/BotLocalService'
import {MousseMainService} from '../../../../src/mms/MousseMainService'
import {effectiveBotPolicyDigest,modelDigest,nativeSdkVersion,type NativeBotDefinition} from '../../../../src/mms/bots/runtime'
import {readVerifiedSpaceArchive,writeSpaceArchive,type SpaceArchiveSource} from '../../../../src/mms/spaces/archive'
import {canonicalJson} from '../../../../src/mms/net/sync/codec'
import {signedDocument,decodeBase64} from '../../../../src/mms/net/identity/crypto'
import {newId,type StoredRecord,type StreamId,type Roster} from '../../../../src/shared/net'
import {decodeEnvelope} from '../../../../src/mms/net/sync/codec'

it.each(['public','private','private-trigger','foreign-public'] as const)('archives actual signed %s Native bot receipts and restores without executing history',async mode=>{
  const visibility=mode==='public'||mode==='foreign-public'?'public':'private'
  const root=realpathSync(mkdtempSync(join(tmpdir(),'archive-native-receipts-'))),contexts:Context[]=[],model:Model<'anthropic-messages'>={id:'archive-fixture',name:'Archive fixture',api:'anthropic-messages',provider:'archive-fixture',baseUrl:'https://invalid.test',reasoning:false,input:['text'],cost:{input:1,output:1,cacheRead:1,cacheWrite:1},contextWindow:10000,maxTokens:1000}
  let unknownCharge=false
  const stream=(_model:Model<'anthropic-messages'>,context:Context,_options:StreamOptions={})=>{
    contexts.push(structuredClone(context));const result=createAssistantMessageEventStream(),message:AssistantMessage={role:'assistant',api:model.api,provider:model.provider,model:model.id,content:[{type:'text',text:'Original actual Native archive answer'}],stopReason:'stop',timestamp:Date.now(),usage:{input:10,output:10,cacheRead:0,cacheWrite:0,totalTokens:20,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:unknownCharge?Number.NaN:10/1000000}}}
    queueMicrotask(()=>{result.push({type:'done',reason:'stop',message});result.end(message)});return result
  }
  const provider:Provider<'anthropic-messages'>={id:model.provider,name:'Archive fixture',auth:{apiKey:{name:'Archive fixture',resolve:async()=>({auth:{apiKey:'task-owned-deterministic-fixture'}})}},getModels:()=>[model],stream,streamSimple:stream}
  const definition:NativeBotDefinition={revision:'archive-native-v1',systemPrompt:'Immutable local archive fixture.',billing:{provider:model.provider,model:model.id,api:model.api,modelDigest:modelDigest(model),sdkVersion:nativeSdkVersion(),platform:process.platform,nodeVersion:process.versions.node,runtimeVersion:'mousse-net-native-v1',maximumUnits:60,maxOutputTokens:50,maxRequestBytes:65536,evidence:'Local deterministic charge10 fixture only. No paid-provider qualification.'},readerTools:[],approval:'always',maxModelCalls:2,maxToolCalls:1,maxElapsedMs:30000}
  const main=await MousseMainService.create({homeDir:join(root,'home'),repoRoot:root,headless:true,requireOwnership:false,nativeBotAdapters:({services})=>{services.providerAuth.models.setProvider(provider);return new Map([['mousse',{settings:services.settings,providerAuth:services.providerAuth,sdkVersion:nativeSdkVersion(),definition,qualification:{active:profile=>profile==='chat',invalidate:()=>{}}}]])}})
  let member:MousseMainService|undefined,signForeign:((bytes:Uint8Array)=>Uint8Array)|undefined
  try{
    await main.net.request('net.init',{listen:true,port:0});await main.net.request('net.protect',{passphrase:'task-owned-native-archive'})
    await main.providerAuth.credentials.modify(provider.id,async()=>({type:'api_key',key:'task-owned-deterministic-fixture'}))
    const rt=main.net.runtime(),spaces=main.spaces,space=spaces.host.create({name:'Actual Native receipt archive'}),channel=spaces.host.createChannel(space.space,'general'),added=await new BotLocalService(main.bots).request('bots.add',{id:newId('rpc'),space:space.space,name:'Archive fixture bot',profile:'chat',policy:{visibility,steer:{kind:'everyone'}}}) as {bot:import('../../../../src/shared/net').BotId;state:string}
    expect(added.state).toBe('registered')
    const config={space:space.space,bot:added.bot,adapter:'mousse',profile:'chat' as const,definitionRevision:definition.revision,profileDigest:effectiveBotPolicyDigest(definition,'chat'),dailyBudgetUnits:1000,runCeilingUnits:60,maxConcurrent:2,runsPerMemberHour:20};main.bots.configure(config);main.bots.qualify(config)
    let trigger:import('../../../../src/shared/net').EventId
    if(mode==='private-trigger'){const creation=spaces.private.prepareCreation(space.space,channel,[rt.identity.self()!.user,added.bot].sort());await spaces.private.publishCreation(creation.descriptor.id);const message=spaces.private.seal(creation.descriptor.id,'message.posted',{text:'Original actual sealed mention'},{mentions:[added.bot]});await spaces.append(creation.descriptor.id,message.id,message.envelope,message.sig);trigger=message.id}else if(mode==='foreign-public'){member=await MousseMainService.create({homeDir:join(root,'member'),repoRoot:root,headless:true,requireOwnership:false});await member.net.request('net.init',{listen:true,port:0});await member.net.request('net.protect',{passphrase:'task-owned-foreign-archive-trigger'});await member.spaces.client.join(member.spaces.client.prepareJoin(spaces.host.invite(space.space).text));await member.spaces.client.connect(space.space);trigger=member.spaces.client.post(channel,'Original actual foreign member mention',{mentions:[added.bot]});await member.spaces.flush(space.space)}else trigger=spaces.client.post(channel,'Original actual bot mention',{mentions:[added.bot]})
    await spaces.flush(space.space)
    await vi.waitFor(()=>expect(rt.executions.find({scope:space.space,target:added.bot,trigger})?.state).toBe('completed'),{timeout:10000});await main.bots.drain();await vi.waitFor(()=>expect(main.net.getActiveCount()).toBe(0))
    const execution=rt.executions.find({scope:space.space,target:added.bot,trigger})!,output=execution.binding!.stream,records=spaces.store.read(output,{epoch:1,seq:0},spaces.store.head(output).seq,1048576).records,receipts=records.filter(record=>!!decodeEnvelope(record.envelope).envelope.author.bot)
    expect(receipts.map(record=>decodeEnvelope(record.envelope).envelope.type)).toContain('bot.run.accepted');expect(receipts.map(record=>decodeEnvelope(record.envelope).envelope.type)).toContain('bot.run.completed');expect(contexts).toHaveLength(1)
    if(member){const keys=member.net.runtime().keys;signForeign=bytes=>keys.signAsNode(bytes);await member.stop();member=undefined;await vi.waitFor(()=>expect(main.net.getActiveCount()).toBe(0))}
    const oldCalls=rt.db.database.prepare('SELECT count(*) AS n FROM net_budget_calls').get()!.n,oldExecutions=rt.db.database.prepare('SELECT count(*) AS n FROM net_executions').get()!.n
    const archive=main.bridge.archives,path=join(root,'archive');await archive.request('spaces.archive.freeze',{space:space.space,reason:'Completed real Native receipt cut'});await archive.request('spaces.archive.export',{space:space.space,path})
    const trust={owner:{user:rt.identity.self()!.user,rootKey:rt.keys.rootKey()!}},verified=readVerifiedSpaceArchive(path,trust)
    try{
      const acceptance=receipts.find(record=>decodeEnvelope(record.envelope).envelope.type==='bot.run.accepted')!,completed=receipts.find(record=>decodeEnvelope(record.envelope).envelope.type==='bot.run.completed')!
      const signed=(record:StoredRecord,change:(envelope:ReturnType<typeof decodeEnvelope>['envelope'])=>void):StoredRecord=>{const envelope=structuredClone(decodeEnvelope(record.envelope).envelope);change(envelope);const bytes=canonicalJson(envelope);return{...record,envelope:bytes,sig:envelope.author.bot?rt.keys.signAsBot(envelope.author.bot,bytes):envelope.author.node===rt.identity.self()!.node?rt.keys.signAsNode(bytes):signForeign!(bytes)}}
      const negative=(name:string,modify:(stream:StreamId,records:StoredRecord[])=>StoredRecord[],audience=false,actor=true,code='forbidden')=>{
        const streams=[...verified.streams()].map(item=>({...item,descriptor:audience&&item.descriptor.id===output?{...item.descriptor,participants:[rt.identity.self()!.user]}:item.descriptor})),data=new Map(streams.map(item=>{const records=modify(item.descriptor.id,[...verified.records(item.descriptor.id)]);if(records.length)item.head={epoch:records.at(-1)!.epoch,seq:records.at(-1)!.seq};return[item.descriptor.id,records]}))
        const source:SpaceArchiveSource={space:verified.manifest.space,owner:verified.manifest.owner,exporter:verified.manifest.exporter,frozen:verified.manifest.frozen,streams:()=>streams,records:stream=>data.get(stream)!,rosters:()=>actor?verified.rosters():[...verified.rosters()].map(row=>{const roster=JSON.parse(decodeBase64(row.payload).toString()) as Roster;return roster.owner===rt.identity.self()!.user?signedDocument({...roster,bots:[]},bytes=>rt.keys.signAsRoot(bytes)):row}),refs:()=>verified.refs(),readBlob:(...args)=>verified.readBlob(...args),sign:manifest=>rt.identity.signAsNode(manifest),close:()=>{}}
        const directory=join(root,name);writeSpaceArchive(source,directory,rt.db.clock.now());expect(()=>readVerifiedSpaceArchive(directory,trust)).toThrow(expect.objectContaining({code}))
        // A caller callback cannot replace the mandatory builtin proof.
        expect(()=>readVerifiedSpaceArchive(directory,{...trust,verifyBotRecord:()=>{}})).toThrow(expect.objectContaining({code}))
      }
      negative('bad-receipt-signature',(stream,records)=>records.map(record=>stream===output&&decodeEnvelope(record.envelope).envelope.id===decodeEnvelope(completed.envelope).envelope.id?{...record,sig:new Uint8Array(record.sig.map((value,index)=>index===0?value^1:value))}:record),false,true,'bad_signature')
      negative('missing-opening',(_stream,records)=>records.map(record=>{const envelope=decodeEnvelope(record.envelope).envelope;return envelope.type==='thread.opened'&&(envelope.body as {stream:string}).stream===output?signed(record,next=>{next.type='message.posted';next.body={text:'Substituted opening'}}):record}))
      if(mode==='foreign-public')negative('wrong-historical-steering-policy',(_stream,records)=>records.map(record=>decodeEnvelope(record.envelope).envelope.type==='bot.added'?signed(record,envelope=>{(envelope.body as {record:{policy:{steer:unknown}}}).record.policy.steer={kind:'owner'}}):record))
      negative('duplicate-acceptance',(stream,records)=>stream!==output?records:[...records,{...signed(acceptance,envelope=>{envelope.id=newId('event')}),seq:records.at(-1)!.seq+1}],false,true,'conflict')
      negative('receipt-before-acceptance',(stream,records)=>stream!==output?records:records.map(record=>decodeEnvelope(record.envelope).envelope.id===decodeEnvelope(acceptance.envelope).envelope.id?{...record,seq:completed.seq}:decodeEnvelope(record.envelope).envelope.id===decodeEnvelope(completed.envelope).envelope.id?{...record,seq:acceptance.seq}:record).sort((a,b)=>a.seq-b.seq))
      negative('missing-acceptance',(stream,records)=>records.map(record=>stream===output&&decodeEnvelope(record.envelope).envelope.id===decodeEnvelope(acceptance.envelope).envelope.id?signed(record,envelope=>{envelope.type='bot.run.progress';if(!envelope.sealed)envelope.body={text:'Substituted acceptance'}}):record))
      negative('substituted-trigger',(stream,records)=>records.map(record=>stream===output&&decodeEnvelope(record.envelope).envelope.id===decodeEnvelope(completed.envelope).envelope.id?signed(record,envelope=>{envelope.refs!.subject=newId('event')}):record))
      negative('missing-mention',(_stream,records)=>records.map(record=>decodeEnvelope(record.envelope).envelope.id===trigger?signed(record,envelope=>{envelope.refs={mentions:[]}}):record))
      negative('missing-bot-actor',(_stream,records)=>records,false,false,'bad_delegation')
      if(visibility==='private')negative('unsupported-permission-history',(stream,records)=>records.map(record=>stream===output&&decodeEnvelope(record.envelope).envelope.id===decodeEnvelope(completed.envelope).envelope.id?signed(record,envelope=>{envelope.type='bot.permission.requested';if(!envelope.sealed)envelope.body={}}):record),false,true,'profile_unsupported')
      if(visibility==='private')negative('unsupported-original-owner-grant',(stream,records)=>records.map(record=>stream===output&&decodeEnvelope(record.envelope).envelope.id===decodeEnvelope(completed.envelope).envelope.id?signed(record,envelope=>{envelope.type='bot.permission.denied';envelope.author={user:rt.identity.self()!.user,node:rt.identity.self()!.node,keyEpoch:1}}):record),false,true,'profile_unsupported')
      if(visibility==='private')negative('wrong-receipt-writer',(stream,records)=>records.map(record=>stream===output&&decodeEnvelope(record.envelope).envelope.id===decodeEnvelope(completed.envelope).envelope.id?signed(record,envelope=>{const nonce=Buffer.from(envelope.sealed!.nonce,'base64url');nonce[0]^=1;envelope.sealed!.nonce=nonce.toString('base64url')}):record))
      if(mode==='private-trigger')negative('wrong-trigger-writer',(_stream,records)=>records.map(record=>decodeEnvelope(record.envelope).envelope.id===trigger?signed(record,envelope=>{const nonce=Buffer.from(envelope.sealed!.nonce,'base64url');nonce[0]^=1;envelope.sealed!.nonce=nonce.toString('base64url')}):record))
      if(visibility==='private')negative('wrong-private-audience',(stream,records)=>records.map(record=>stream===output&&decodeEnvelope(record.envelope).envelope.type==='participants.changed'?signed(record,envelope=>{(envelope.body as {participants:string[]}).participants=[rt.identity.self()!.user]}):record),true)
    }finally{verified.close()}
    await archive.request('spaces.archive.import',{path,mode:'restore'});expect(await archive.request('spaces.archive.activate',{space:space.space})).toMatchObject({state:'activeNew',epoch:2})
    for(const record of receipts)expect(spaces.store.getById(output,decodeEnvelope(record.envelope).envelope.id)).toEqual(record)
    expect(contexts).toHaveLength(1);expect(rt.db.database.prepare('SELECT count(*) AS n FROM net_budget_calls').get()!.n).toBe(oldCalls);expect(rt.db.database.prepare('SELECT count(*) AS n FROM net_executions').get()!.n).toBe(oldExecutions)
    if(visibility==='private')expect(spaces.private.state(output)!.control.keyEpoch).toBe(2)
    if(mode==='public'){
      // An actually dispatched Native call with missing charge evidence becomes
      // uncertain even though its transport/provider task has settled.
      unknownCharge=true;main.bots.qualify(config)
      const unknownTrigger=spaces.client.post(channel,'Actual unknown provider charge',{mentions:[added.bot]});await spaces.flush(space.space)
      await vi.waitFor(()=>expect(rt.executions.find({scope:space.space,target:added.bot,trigger:unknownTrigger})?.state).toBe('uncertain'),{timeout:10000});await main.bots.drain();await vi.waitFor(()=>expect(main.net.getActiveCount()).toBe(0))
      const unresolved=rt.executions.find({scope:space.space,target:added.bot,trigger:unknownTrigger})!
      expect(rt.db.database.prepare('SELECT active FROM net_bot_admission_slots WHERE execution=?').get(unresolved.id)!.active).toBe(0)
      await archive.request('spaces.archive.freeze',{space:space.space,reason:'Retain actual uncertain destination execution'})
      const generations=rt.db.database.prepare('SELECT count(*) AS n FROM net_generations').get()!.n,beforeJournal=archive.journal.forSpace(space.space),beforeRecord=rt.executions.get(unresolved.id),beforeStreams=spaces.store.listStreams({space:space.space}),beforeHeads=beforeStreams.map(stream=>spaces.store.head(stream.id)),beforeReference=rt.db.database.prepare('SELECT value FROM net_space_archive_local_refs WHERE space=?').get(space.space)
      await expect(archive.request('spaces.archive.import',{path,mode:'restore'})).rejects.toMatchObject({code:'outcome_uncertain'})
      expect(rt.db.database.prepare('SELECT value FROM net_space_archive_local_refs WHERE space=?').get(space.space)).toEqual(beforeReference);expect(rt.executions.get(unresolved.id)).toEqual(beforeRecord);expect(spaces.store.listStreams({space:space.space})).toEqual(beforeStreams);expect(beforeStreams.map(stream=>spaces.store.head(stream.id))).toEqual(beforeHeads);expect(archive.journal.forSpace(space.space)).toEqual(beforeJournal);expect(rt.db.database.prepare('SELECT count(*) AS n FROM net_generations').get()!.n).toBe(generations);expect(archive.journal.forSpace(space.space)?.state).toBe('frozen')
    }
  }finally{await member?.stop();await main.stop();rmSync(root,{recursive:true,force:true})}
},25000)
