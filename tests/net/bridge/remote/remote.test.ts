import { afterEach,describe,expect,it,vi } from 'vitest'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { connect } from 'node:net'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import { mkdtempSync,realpathSync,rmSync,symlinkSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { MousseMainService } from '../../../../src/mms/MousseMainService'
import { FileKeyStore,NetIdentityService } from '../../../../src/mms/net/identity'
import { NetDatabase } from '../../../../src/mms/net/store/database'
import { SqliteStreamStore } from '../../../../src/mms/net/store/streams'
import { FileBlobStore } from '../../../../src/mms/net/store/blobs'
import { SqliteExecutionLedger } from '../../../../src/mms/net/store/executions'
import { DurableRpcDispatcher } from '../../../../src/mms/net/sync/rpcDispatcher'
import { NetSyncSession } from '../../../../src/mms/net/sync/session'
import { NodeStreamAuthority } from '../../../../src/mms/net/sync/nodeAuthority'
import { openSecureChannel } from '../../../../src/mms/net/link/secureChannel'
import { fingerprint } from '../../../../src/mms/net/link/selfSignedCert'
import { decodeEnvelope } from '../../../../src/mms/net/sync/codec'
import type { StreamStore } from '../../../../src/mms/net/contracts'
import { systemClock } from '../../../../src/mms/net/clock'
import { BRIDGE_REMOTE_METHODS,RemoteApi,MmsRemoteBackend,MmsThreadSource,ThreadStreamAdapter,ThreadDisplayProjection } from '../../../../src/mms/bridge/remote'
import { newId,type NodeDelegation,type RpcId,type StoredRecord,type Roster } from '../../../../src/shared/net'
import { memoryPair } from '../../harness/MemoryTransport'

const resources:Array<()=>void|Promise<void>>=[],paths:string[]=[]
afterEach(async()=>{for(const dispose of resources.splice(0).reverse())await dispose();for(const path of paths.splice(0))rmSync(path,{recursive:true,force:true})})
function temp(){const path=realpathSync(mkdtempSync(join(tmpdir(),'mousse-bridge-')));paths.push(path);return path}
async function setup(caps:NodeDelegation['caps']=['read','chat','write']){
  const home=temp(),mms=await MousseMainService.create({homeDir:home,headless:true,ownerKind:'test'});await mms.start();resources.push(()=>mms.stop())
  const aPath=mms.getProfileHomeDir(),bPath=temp(),aDb=new NetDatabase({profileDir:aPath}),bDb=new NetDatabase({profileDir:bPath});resources.push(()=>aDb.close(),()=>bDb.close())
  const aKeys=new FileKeyStore(aPath),bKeys=new FileKeyStore(bPath),aIdentity=new NetIdentityService({database:aDb.database,keys:aKeys,clock:systemClock,coordinator:aDb})
  await aIdentity.bootstrapAuthority('Bridge source');await bKeys.initialize({asAuthority:false})
  const node=newId('node'),user=aIdentity.self()!.user
  aIdentity.issueNodeDelegation({node,keys:bKeys.nodeKeys(),name:'Remote',caps})
  const bIdentity=new NetIdentityService({database:bDb.database,keys:bKeys,clock:systemClock,coordinator:bDb,self:{user,node}});bIdentity.pinUser(user,aKeys.rootKey()!);bIdentity.acceptRoster(aIdentity.roster()!,aKeys.rootKey()!)
  const aStore=new SqliteStreamStore(aDb),bStore=new SqliteStreamStore(bDb),aBlobs=new FileBlobStore(aDb);resources.push(()=>aStore.close(),()=>bStore.close(),()=>aBlobs.close())
  const executions=new SqliteExecutionLedger(aDb),dispatcher=new DurableRpcDispatcher({db:aDb,executions,identity:aIdentity,clock:systemClock}),backend=new MmsRemoteBackend(mms),api=new RemoteApi(backend,systemClock);api.register(dispatcher);resources.push(()=>api.close())
  const p={home,mms,aPath,bPath,aDb,bDb,aKeys,bKeys,aIdentity,bIdentity,aStore,bStore,aBlobs,executions,dispatcher,backend,api}
  async function connect(store:StreamStore=aStore){
    const transport=memoryPair(),[aChannel,bChannel]=await Promise.all([openSecureChannel(transport.b,{role:'server',credentials:aKeys.tlsCredentials(),deadlineMs:2000}),openSecureChannel(transport.a,{role:'client',credentials:bKeys.tlsCredentials(),expectedPeerFingerprint:fingerprint(Buffer.from(aKeys.nodeKeys().transport,'base64url')),deadlineMs:2000})])
    const authority=new NodeStreamAuthority(aIdentity,store,aBlobs,systemClock),a=new NetSyncSession({channel:aChannel,identity:aIdentity,store,authority,blobs:aBlobs,rpc:dispatcher}),b=new NetSyncSession({channel:bChannel,identity:bIdentity,store:bStore,capabilities:['streams.v1','rpc.v1','blobs.v1']})
    resources.push(()=>a.close(),()=>b.close(),()=>transport.cut());await Promise.all([a.opened,b.opened]);return {a,b,transport}
  }
  return {...p,connect}
}
function allRecords(adapter:ThreadStreamAdapter,stream:ReturnType<ThreadStreamAdapter['activate']>['id']):StoredRecord[]{
  const reader=adapter.store.openSnapshot(stream),records:StoredRecord[]=[];try{for(;;){const page=reader.next(512*1024);records.push(...page.records);if(page.done)return records}}finally{reader.close()}
}

describe('P3 real MMS remote Bridge',()=>{
  it('maps every exposed method, denies local/secret ingress, validates before admission, and deduplicates real thread creation',async()=>{
    const p=await setup(),{b}=await p.connect()
    expect(p.api.methods().map(method=>method.method).sort()).toEqual(Object.keys(BRIDGE_REMOTE_METHODS).sort())
    expect(await b.rpc('projects.list',{}, {id:newId('rpc'),deadlineMs:2000})).toEqual({projects:[]})
    const id=newId('rpc'),bad={name:'Invalid',profileId:'attacker',path:'/tmp/escape'}
    await expect(b.rpc('threads.create',bad,{id,idem:'create-one',deadlineMs:2000})).rejects.toMatchObject({code:'bad_request'})
    expect(p.mms.threads.listAllThreads()).toHaveLength(0);expect(p.aDb.database.prepare('SELECT count(*) AS n FROM net_rpc_aliases WHERE id=?').get(id)!.n).toBe(0)
    const result=await b.rpc('threads.create',{name:'Real remote thread'},{id,idem:'create-one',deadlineMs:2000}) as {thread:{id:string}}
    const again=await b.rpc('threads.create',{name:'Real remote thread'},{id:newId('rpc'),idem:'create-one',deadlineMs:2000})
    expect(again).toEqual(result);expect(p.mms.threads.listAllThreads()).toHaveLength(1)
    for(const method of ['providers.setApiKey','provider.login','settings.set','pty.create','files.write','service.stop','orchestrator.retry'])await expect(b.rpc(method,{},{id:newId('rpc'),idem:'denied-'+method,deadlineMs:2000})).rejects.toMatchObject({code:'forbidden'})
    await expect(b.rpc('threads.rename',{threadId:result.thread.id,name:'x',source:'gui'},{id:newId('rpc'),idem:'bad-rename',deadlineMs:2000})).rejects.toMatchObject({code:'bad_request'})
    await expect(b.rpc('threads.get',{threadId:'../../outside'},{id:newId('rpc'),deadlineMs:2000})).rejects.toMatchObject({code:'outcome_uncertain'})
    expect(p.mms.threads.listAllThreads()).toHaveLength(1)
  })
  it('enforces current read-only capability and closes an actual active TLS session on revoke',async()=>{
    const p=await setup(['read']),{a,b}=await p.connect()
    expect(await b.rpc('threads.list',{}, {id:newId('rpc'),deadlineMs:2000})).toEqual({threads:[]})
    for(const method of ['threads.create','orchestrator.send'])await expect(b.rpc(method,{name:'No',threadId:'x',content:'No'},{id:newId('rpc'),idem:'denied-'+method,deadlineMs:2000})).rejects.toMatchObject({code:'forbidden'})
    expect(p.mms.threads.listAllThreads()).toHaveLength(0)
    p.aIdentity.revoke(p.bIdentity.self()!.node)
    await vi.waitFor(()=>{expect(a.state()).toBe('closed');expect(b.state()).toBe('closed')})
    await expect(Promise.resolve().then(()=>b.rpc('threads.list',{},{id:newId('rpc'),deadlineMs:2000}))).rejects.toMatchObject({code:'revoked'})
  })
  it('rechecks changed current capabilities on retained results after a real reconnect',async()=>{
    const p=await setup(),first=await p.connect(),id=newId('rpc')
    expect(await first.b.rpc('projects.list',{},{id,deadlineMs:2000})).toEqual({projects:[]})
    p.aIdentity.issueNodeDelegation({node:p.bIdentity.self()!.node,keys:p.bKeys.nodeKeys(),name:'Reduced',caps:['chat']})
    await vi.waitFor(()=>expect(first.a.state()).toBe('closed'))
    p.bIdentity.acceptRoster(p.aIdentity.roster()!,p.aKeys.rootKey()!)
    const fresh=await p.connect()
    await expect(fresh.b.rpcResult(id,{deadlineMs:2000})).rejects.toMatchObject({code:'forbidden'})
    await expect(fresh.b.rpc('projects.list',{},{id:newId('rpc'),deadlineMs:2000})).rejects.toMatchObject({code:'forbidden'})
  })

  it('steers and cancels only the exact owned actual MMS run; stale cancellation cannot stop a later local turn',async()=>{
    const p=await setup(),thread=p.mms.threads.createThread('Owned turn'),calls:Array<{signal:AbortSignal;drainSteer:()=>string|undefined}>=[]
    const llm={
      getSelectedModelContextLimit:()=>({limit:128000,modelName:'fixture'}),
      getContextInputs:async()=>({systemPromptText:'',mcpToolsText:'',otherToolsText:'',signature:'fixture'}),
      generateTitle:async()=>'Owned turn',
      chat:async (_messages:unknown,_tools:unknown,options:{signal:AbortSignal;drainSteer:()=>string|undefined},_thinking:unknown,onText:(event:unknown)=>void)=>{
        calls.push(options);onText({phase:'start',content:'',contentIndex:0});onText({phase:'delta',content:'partial fixture output',contentIndex:0})
        if(!options.signal.aborted)await new Promise<void>(resolve=>options.signal.addEventListener('abort',()=>resolve(),{once:true}))
        return {text:'partial fixture output',aborted:true,usage:{input:1,output:1,cacheRead:0,cacheWrite:0},modelName:'fixture',totalResponseTimeMs:1,totalTokensUsed:2,contextInputs:{signature:'fixture'},toolEvents:[],nativeMessages:[]}
      }
    }
    ;(p.mms.orchestrator as unknown as {llm:unknown}).llm=llm
    const deltas:unknown[]=[],adapter=new ThreadStreamAdapter({db:p.aDb,store:p.aStore,generations:p.aStore,identity:p.aIdentity,keys:p.aKeys,clock:systemClock,source:new MmsThreadSource(p.mms),onDelta:(_stream,data)=>deltas.push(data)});resources.push(()=>adapter.close());adapter.activate(thread.id)
    const {b}=await p.connect(),id=newId('rpc'),pending=b.rpc('orchestrator.send',{threadId:thread.id,content:'Actual admitted prompt'},{id,idem:'owned-send',deadlineMs:4000}).catch(error=>error)
    await vi.waitFor(()=>expect(calls).toHaveLength(1))
    expect(deltas.length).toBeGreaterThan(0)
    expect(await b.rpc('orchestrator.steer',{threadId:thread.id,run:id,text:'Exact steer'},{id:newId('rpc'),idem:'steer-one',deadlineMs:2000})).toEqual({ok:true})
    expect(calls[0].drainSteer()).toContain('Exact steer')
    expect(await b.rpc('orchestrator.abort',{threadId:thread.id,run:id},{id:newId('rpc'),idem:'abort-one',deadlineMs:2000})).toEqual({ok:true})
    expect(await pending).toMatchObject({code:'outcome_uncertain'})
    expect(p.mms.orchestrator.getOrCreateSession(thread.id).turnAdmitted).toBe(false)
    const local=new AbortController(),later=p.backend.run(thread.id,'Later local prompt',{signal:local.signal,drainSteer:()=>undefined})
    await vi.waitFor(()=>expect(calls).toHaveLength(2))
    expect(await b.rpc('orchestrator.abort',{threadId:thread.id,run:id},{id:newId('rpc'),idem:'stale-abort',deadlineMs:2000})).toEqual({ok:false})
    expect(calls[1].signal.aborted).toBe(false);local.abort();await later
    expect(p.mms.threads.loadThreadData(thread.id).messages.some(message=>message.content==='Actual admitted prompt')).toBe(true)
    const expired=b.rpc('orchestrator.send',{threadId:thread.id,content:'Deadline prompt'},{id:newId('rpc'),idem:'deadline-send',deadlineMs:1000}).catch(error=>error)
    await vi.waitFor(()=>expect(calls).toHaveLength(3))
    expect(await expired).toMatchObject({code:'deadline_exceeded'})
    await vi.waitFor(()=>{expect(calls[2].signal.aborted).toBe(true);expect(p.mms.orchestrator.getOrCreateSession(thread.id).turnAdmitted).toBe(false)},{timeout:3000})
  })

  it('records an actual child SIGKILL after a real thread effect as uncertain and never recreates the thread',async()=>{
    const p=await setup();await p.mms.stop()
    const binary=join(p.home,'bridge-crash-child.mjs');symlinkSync(fileURLToPath(new URL('../../../../node_modules',import.meta.url)),join(p.home,'node_modules'))
    const {getCliBuildOptions}=await import(fileURLToPath(new URL('../../../../scripts/build-cli.mjs',import.meta.url)))
    await build({...getCliBuildOptions(fileURLToPath(new URL('../../../../',import.meta.url))),entryPoints:[fileURLToPath(new URL('./crash-child.ts',import.meta.url))],outfile:binary,sourcemap:false})
    const child=spawn(process.execPath,[binary,p.home],{stdio:['ignore','pipe','pipe']}),exited=once(child,'exit');let diagnostic='';child.stderr!.on('data',bytes=>{diagnostic+=bytes.toString()});resources.push(async()=>{child.kill('SIGKILL');await exited})
    const ready=await Promise.race([once(child.stdout!,'data'),exited.then(()=>{throw new Error('Crash child exited before listen: '+diagnostic)}),new Promise<never>((_,reject)=>{const timer=setTimeout(()=>reject(new Error('Crash child listener timeout.')),5000);timer.unref()})])
    const port=JSON.parse(Buffer.from(ready[0]).toString()).port,raw=connect(port,'127.0.0.1'),channel=await openSecureChannel(raw,{role:'client',credentials:p.bKeys.tlsCredentials(),expectedPeerFingerprint:fingerprint(Buffer.from(p.aKeys.nodeKeys().transport,'base64url')),deadlineMs:2000})
    const session=new NetSyncSession({channel,identity:p.bIdentity,store:p.bStore,capabilities:['streams.v1','rpc.v1']});resources.push(()=>session.close());await session.opened
    const id=newId('rpc'),params={name:'Effect before result'}
    await expect(session.rpc('threads.create',params,{id,idem:'crash-create',deadlineMs:3000})).rejects.toBeDefined()
    expect((await exited)[1]).toBe('SIGKILL')
    const reopened=await MousseMainService.create({homeDir:p.home,headless:true,ownerKind:'test'});await reopened.start();resources.push(()=>reopened.stop())
    expect(reopened.threads.listAllThreads()).toHaveLength(1)
    p.executions.recoverAfterRestart(Date.now())
    const backend=new MmsRemoteBackend(reopened),dispatcher=new DurableRpcDispatcher({db:p.aDb,executions:p.executions,identity:p.aIdentity,clock:systemClock});new RemoteApi(backend,systemClock).register(dispatcher)
    const roster=p.bIdentity.verifySigned<Roster>(p.bIdentity.roster()!,p.aKeys.rootKey()!),delegation=roster.nodes.map(row=>p.bIdentity.verifySigned<NodeDelegation>(row,p.aKeys.rootKey()!)).find(row=>row.subject===p.bIdentity.self()!.node)!
    const caller={node:p.bIdentity.self()!.node,user:p.bIdentity.self()!.user,delegation}
    await expect(dispatcher.dispatch('threads.create',params,'crash-create',{id:newId('rpc'),caller,signal:new AbortController().signal,deadlineAt:Date.now()+3000,progress(){}})).rejects.toMatchObject({code:'outcome_uncertain'})
    expect(reopened.threads.listAllThreads()).toHaveLength(1)
  },15000)

  it('publishes actual thread events and chunked large source snapshots, bounds its ring, and advances generations across restart',async()=>{
    const p=await setup(),thread=p.mms.threads.createThread('Display'),source=new MmsThreadSource(p.mms)
    const adapter=new ThreadStreamAdapter({db:p.aDb,store:p.aStore,generations:p.aStore,identity:p.aIdentity,keys:p.aKeys,clock:systemClock,source,maxRows:8,maxBytes:65536});resources.push(()=>adapter.close())
    const descriptor=adapter.activate(thread.id),firstHead=adapter.store.head(descriptor.id)
    expect(adapter.activate(thread.id)).toEqual(descriptor);expect(adapter.store.head(descriptor.id)).toEqual(firstHead)
    const projection=new ThreadDisplayProjection(thread.id),initial=allRecords(adapter,descriptor.id)
    let snapshot:unknown
    for(const record of initial){expect(record.envelope.length).toBeLessThanOrEqual(65536);p.aIdentity.verifyAuthor(decodeEnvelope(record.envelope).envelope.author,record.envelope,record.sig,Date.now(),'history');const update=projection.accept(decodeEnvelope(record.envelope).envelope);if(update?.kind==='snapshot')snapshot=update.value}
    expect(snapshot).toMatchObject({thread:{id:thread.id}})
    for(let i=0;i<24;i++)p.mms.orchestrator.enqueueForThread(thread.id,{content:'Queued '+i})
    expect(adapter.ringStats(descriptor.id).rows).toBeLessThanOrEqual(8);expect(adapter.ringStats(descriptor.id).bytes).toBeLessThanOrEqual(65536)
    expect(()=>adapter.store.read(descriptor.id,firstHead,adapter.store.head(descriptor.id).seq,1024)).toThrow(expect.objectContaining({code:'snapshot_required'}))
    const message={id:'large-source-message',role:'assistant' as const,content:'z'.repeat(160000),timestamp:new Date().toISOString()}
    p.mms.threads.mutateThreadData(thread.id,()=>({messages:[message]}));p.mms.orchestrator.getOrCreateSession(thread.id).messages=[message]
    const large=allRecords(adapter,descriptor.id);expect(large.filter(record=>decodeEnvelope(record.envelope).envelope.type==='thread.snapshot.chunk').length).toBeGreaterThan(4)
    projection.reset();for(const record of large){expect(record.envelope.length).toBeLessThanOrEqual(65536);const update=projection.accept(decodeEnvelope(record.envelope).envelope);if(update?.kind==='snapshot')snapshot=update.value}
    expect(snapshot).toMatchObject({messages:[{content:message.content}]})
    p.bStore.createStream(descriptor,1)
    const live=await p.connect(adapter.store),installed=new Promise<void>((resolve,reject)=>{live.b.subscribe(descriptor.id,{onRecord(){},onCaughtUp(){},onSnapshotInstalled(){resolve()},onError(code){reject(new Error(code))}})})
    await installed
    expect(p.bStore.cursor(descriptor.id).seq).toBe(adapter.store.head(descriptor.id).seq)
    const receivedReader=p.bStore.openSnapshot(descriptor.id);expect(receivedReader.target.epoch).toBe(1);receivedReader.close()
    const oldHead=adapter.store.head(descriptor.id);live.transport.cut();adapter.close()
    p.aStore.close();p.aDb.close()
    const restartedDb=new NetDatabase({profileDir:p.aPath}),restartedKeys=new FileKeyStore(p.aPath),restartedIdentity=new NetIdentityService({database:restartedDb.database,keys:restartedKeys,clock:systemClock,coordinator:restartedDb}),restartedStore=new SqliteStreamStore(restartedDb)
    resources.push(()=>restartedDb.close(),()=>restartedStore.close())
    const reopened=new ThreadStreamAdapter({db:restartedDb,store:restartedStore,generations:restartedStore,identity:restartedIdentity,keys:restartedKeys,clock:systemClock,source});resources.push(()=>reopened.close())
    const stable=reopened.activate(thread.id);expect(stable.id).toBe(descriptor.id);expect(reopened.store.head(stable.id).epoch).toBe(oldHead.epoch+1)
    expect(reopened.store.snapshotReason(stable.id,oldHead)).toBe('epochChanged');expect(p.mms.threads.listAllThreads()).toHaveLength(1)
    const bad=decodeEnvelope(large[1].envelope).envelope;expect(()=>new ThreadDisplayProjection(thread.id).accept(bad)).toThrow(expect.objectContaining({code:'bad_request'}))
  })
})
