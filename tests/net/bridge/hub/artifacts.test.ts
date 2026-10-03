import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { newId, type NodeDelegation, type Roster } from '../../../../src/shared/net'
import { canonicalJson } from '../../../../src/mms/net/sync/codec'
import { validateHubParams } from '../../../../src/mms/bridge/hub/validation'
import { fixture, cleanup } from './fixture'
import type { BridgeDispatchInput } from '../../../../src/shared/bridge'
afterEach(cleanup)
const digest=(value:unknown)=>createHash('sha256').update(canonicalJson(value)).digest('hex')
const input:BridgeDispatchInput={repoId:`repo_${'a'.repeat(64)}`,baseCommit:'a'.repeat(40),agent:'fixture',prompt:'Portable request',limits:{maxTurns:1,maxToolCalls:2,maxElapsedMs:1000}}

it('resolves a request-bound large source result over actual TLS with durable aliases and no mutation replay',async()=>{
  const f=await fixture();await f.connect();const thread=f.mms.threads.createThread('Large display source'),message={id:'large',role:'assistant' as const,content:'verified '.repeat(30000),timestamp:new Date().toISOString()};f.mms.threads.mutateThreadData(thread.id,()=>({messages:[message]}));f.mms.orchestrator.getOrCreateSession(thread.id).messages=[message]
  const id=newId('rpc'),alias=newId('rpc'),hub=f.hub();hub.prepare(f.targetNode,'thread.snapshot',{threadId:thread.id},{id,idem:'snapshot-key'});hub.prepare(f.targetNode,'thread.snapshot',{threadId:thread.id},{id:alias,idem:'snapshot-key'})
  expect(await hub.submit(alias)).toMatchObject({messages:[{content:message.content}]})
  const row=JSON.parse(String(f.callerDb().database.prepare('SELECT record FROM net_bridge_hub_requests WHERE id=?').get(id)!.record))
  expect(row.wireResult.kind).toBe('bridge.artifact.result.v1');expect(JSON.stringify(row).length).toBeLessThan(4096)
  await f.restartCaller();expect(await f.hub().query(alias)).toMatchObject({messages:[{content:message.content}]})
})

it('journals bundle identifiers before disk/network, uploads an actual Git bundle, and verifies the signed exact dispatch result',async()=>{
  const f=await fixture();const repo=join(f.callerPath,'repository');mkdirSync(repo);const git=(...args:string[])=>execFileSync('git',['-C',repo,...args],{encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();git('init','-b','main');git('config','user.name','Hub Fixture');git('config','user.email','hub-fixture@example.invalid');writeFileSync(join(repo,'file.txt'),'Bundle content\n');git('add','file.txt');git('commit','-m','Bundle fixture');const commit=git('rev-parse','HEAD'),bundleFile=join(f.callerPath,'input.bundle');git('bundle','create',bundleFile,'HEAD');const bytes=readFileSync(bundleFile),request={...input,baseCommit:commit},id=newId('rpc'),alias=newId('rpc');let effects=0
  f.targetRpc.register({method:'bridge.dispatch',capability:'write',mutating:true,uploadEnabled:true,validate:value=>validateHubParams('bridge.dispatch',value),handle:async(value,context)=>{
    const params=value as BridgeDispatchInput,received=f.targetArtifacts.input(params.inputBundle!,context,'bridge.dispatch');expect(Buffer.from(received)).toEqual(bytes)
    const verifyRepo=join(f.targetPath,'bundle-target');mkdirSync(verifyRepo,{recursive:true});execFileSync('git',['-C',verifyRepo,'init'],{stdio:'ignore'});const receivedPath=join(verifyRepo,'received.bundle');writeFileSync(receivedPath,received);execFileSync('git',['-C',verifyRepo,'bundle','verify',receivedPath],{stdio:'ignore'});effects++
    const publication=f.targetArtifacts.preparePublication(bytes,'application/x-git-bundle',context,'bridge.dispatch'),dispatch=newId('dispatch'),self=f.targetIdentity.self()!,root=f.targetKeys.rootKey()!,roster=f.targetIdentity.verifySigned<Roster>(f.targetIdentity.roster()!,root),delegation=roster.nodes.map(row=>f.targetIdentity.verifySigned<NodeDelegation>(row,root)).find(row=>row.subject===self.node)!
    context.onTerminalCommit!(()=>publication.commit())
    return f.targetIdentity.signAsNode({v:1,kind:'bridge.dispatch.result.v1',dispatch,execution:context.execution,rpc:context.id,requestHash:digest(params),author:{user:self.user,node:self.node,keyEpoch:delegation.keyEpoch},issuedAt:Date.now(),repoId:params.repoId,baseCommit:params.baseCommit,headCommit:commit,branch:`mousse/agent/${dispatch}`,ref:`refs/mousse/dispatch/${dispatch}`,bundleHash:createHash('sha256').update(bytes).digest('hex'),artifact:publication.ref,agent:{definitionId:'fixture',revision:'1',profileId:'fixture'},threadId:'verified-thread',errors:[]})
  }})
  const first=await f.connect();const hub=f.hub();expect(hub.prepareDispatchWithBundle(f.targetNode,request,bytes,{id,idem:'dispatch-bundle'})).toBe(id);expect(hub.prepareDispatchWithBundle(f.targetNode,request,bytes,{id:alias,idem:'dispatch-bundle'})).toBe(alias)
  expect(hub.canonicalRequest(alias,'bridge.dispatch',f.targetNode)).toBe(id);expect(f.targetStore.listStreams({kind:'node.artifact'})).toHaveLength(0);expect(effects).toBe(0)
  expect(()=>hub.prepareDispatchWithBundle(f.targetNode,{...request,prompt:'different'},bytes,{id:newId('rpc'),idem:'dispatch-bundle'})).toThrow(expect.objectContaining({code:'conflict'}))
  const dispatch=f.targetRpc.dispatch.bind(f.targetRpc);let drop=true;f.targetRpc.dispatch=async(...args)=>{const result=await dispatch(...args);if(args[0]==='bridge.dispatch'&&drop){drop=false;first.transport.cut()}return result}
  await expect(hub.resumeDispatchWithBundle(alias)).rejects.toBeDefined();expect(effects).toBe(1);expect(hub.status(id).state).toBe('unknown')
  await f.restartCaller();expect(await f.hub().resumeDispatchWithBundle(alias)).toMatchObject({kind:'bridge.dispatch.result.v1',rpc:id,baseCommit:commit,headCommit:commit});expect(effects).toBe(1);expect(await f.hub().query(alias)).toMatchObject({rpc:id});expect(effects).toBe(1)
  const plan=JSON.parse(String(f.callerDb().database.prepare('SELECT record FROM net_bridge_hub_inputs WHERE id=?').get(id)!.record));expect(plan).toMatchObject({phase:'published',event:expect.stringMatching(/^evt_/),open:expect.stringMatching(/^rpc_/)});expect(f.targetStore.getById(plan.descriptor.id,plan.event)).toBeDefined()
})

it('rejects a target-signed dispatch result for a different original request without replaying its effect',async()=>{
  const f=await fixture();let effects=0;f.targetRpc.register({method:'bridge.dispatch',capability:'write',mutating:true,uploadEnabled:true,validate:value=>validateHubParams('bridge.dispatch',value),handle:async(_value,context)=>{effects++;const self=f.targetIdentity.self()!,dispatch=newId('dispatch');return f.targetIdentity.signAsNode({v:1,kind:'bridge.dispatch.result.v1',dispatch,execution:context.execution,rpc:newId('rpc'),requestHash:digest(input),author:{user:self.user,node:self.node,keyEpoch:1},issuedAt:Date.now(),repoId:input.repoId,baseCommit:input.baseCommit,headCommit:input.baseCommit,branch:`mousse/agent/${dispatch}`,ref:`refs/mousse/dispatch/${dispatch}`,bundleHash:'a'.repeat(64),artifact:{stream:newId('stream'),event:newId('event'),blob:`blb_${'a'.repeat(64)}`},agent:{definitionId:'fixture',revision:'1',profileId:'fixture'},threadId:'thread',errors:[]})}});await f.connect();const id=f.hub().prepare(f.targetNode,'bridge.dispatch',input)
  await expect(f.hub().submit(id)).rejects.toMatchObject({code:'forbidden'});expect(effects).toBe(1);expect(f.hub().status(id).state).toBe('completed');await expect(f.hub().query(id)).rejects.toMatchObject({code:'forbidden'});expect(effects).toBe(1)
})

it('rolls back input preparation before filesystem/network effects and cancels a prepared dispatch by alias',async()=>{
  let fail=true;const f=await fixture(undefined,point=>{if(fail&&point==='bridge.hub.input.prepare.beforeCommit')throw new Error('input rollback')});await f.connect();const bytes=Buffer.from('prepared owned bytes'),id=newId('rpc'),alias=newId('rpc'),hub=f.hub()
  expect(()=>hub.prepareDispatchWithBundle(f.targetNode,input,bytes,{id,idem:'rollback'})).toThrow('input rollback')
  expect(f.callerDb().database.prepare('SELECT count(*) AS n FROM net_bridge_hub_inputs').get()!.n).toBe(0);expect(f.callerDb().database.prepare('SELECT count(*) AS n FROM net_bridge_hub_requests').get()!.n).toBe(0);expect(f.targetStore.listStreams({kind:'node.artifact'})).toHaveLength(0)
  fail=false;hub.prepareDispatchWithBundle(f.targetNode,input,bytes,{id,idem:'rollback'});hub.prepareDispatchWithBundle(f.targetNode,input,bytes,{id:alias,idem:'rollback'})
  expect(hub.status(alias)).toMatchObject({original:id,state:'prepared'});await expect(hub.query(alias)).rejects.toMatchObject({code:'outcome_uncertain'})
  expect(()=>hub.prepare(f.targetNode,'threads.create',{name:'borrowed'},{id})).toThrow(expect.objectContaining({code:'conflict'}))
  await hub.cancel(alias);await expect(hub.resumeDispatchWithBundle(id)).rejects.toMatchObject({code:'cancelled'});expect(f.targetStore.listStreams({kind:'node.artifact'})).toHaveLength(0)
})
