import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { spawn, spawnSync } from 'node:child_process'
import { build } from 'esbuild'
import { cleanup, profile } from './helpers'
import { newId, type NodeDelegation, type Roster } from '../../../src/shared/net'
import { portableRepository } from '../../../src/mms/bridge/dispatch'
import { git } from '../../../src/mms/bridge/dispatch/git'
import { validateChatParams } from '../../../src/mms/chats/registerMethods'
import { parseProtocolJson } from '../../../src/mms/net/sync/codec'
import type { DispatchResultBody } from '../../../src/mms/bridge/dispatch'
import type { ChatTaskSelectionInput } from '../../../src/shared/chatsNetwork'
import type { Mux } from '../../../src/mms/net/contracts'

afterEach(async()=>{for(const close of cleanup.splice(0).reverse())await close()})
let executable:string,readExecutable:string,buildRoot:string
beforeAll(async()=>{
  buildRoot=realpathSync(mkdtempSync(join(tmpdir(),'chats-device-build-')));symlinkSync(resolve('node_modules'),join(buildRoot,'node_modules'),'dir');executable=join(buildRoot,'child.mjs')
  const {getCliBuildOptions}=await import('../../../scripts/build-cli.mjs')
  await build({...getCliBuildOptions(process.cwd()),entryPoints:[fileURLToPath(new URL('./crash-child.ts',import.meta.url))],outfile:executable,sourcemap:false,logLevel:'silent'})
  readExecutable=join(buildRoot,'read-child.mjs')
  await build({...getCliBuildOptions(process.cwd()),entryPoints:[fileURLToPath(new URL('./tasks-read-child.ts',import.meta.url))],outfile:readExecutable,sourcemap:false,logLevel:'silent'})
})
afterAll(()=>rmSync(buildRoot,{recursive:true,force:true}))
async function linked(){
  const caller=await profile(),target=await profile({initialize:false})
  const invite=await caller.services.net.request('bridge.invite',{}) as {invite:string}
  await target.services.net.request('bridge.join',{invite:invite.invite})
  await target.services.net.request('net.protect',{passphrase:'chats-candidate-fixture-protection'})
  const node=target.services.net.runtime().identity.self()!.node
  await vi.waitFor(()=>expect(caller.services.net.session(node).state()).toBe('open'),{timeout:10000})
  const group=await caller.createGroup()
  caller.services.chatNetwork.publish({chatId:group.id,publicationId:'task-group'})
  const targetGroup=await target.createGroup(),agent=targetGroup.participants.find(value=>value.kind==='agent')!
  const repo=join(target.home,'task-repository');mkdirSync(repo)
  await git(repo,['init','--template=']);writeFileSync(join(repo,'base.txt'),'actual target repository')
  await git(repo,['add','.']);await git(repo,['-c','user.name=Fixture','-c','user.email=fixture@localhost','commit','-m','base'])
  const portable=await portableRepository(repo),baseCommit=await git(repo,['rev-parse','HEAD'])
  const selection:ChatTaskSelectionInput={chatId:group.id,taskId:newId('rpc'),deviceId:node,input:{repoId:portable.repoId,baseCommit,agent:agent.definitionId!,prompt:'CHAT BOUND TASK ONLY',limits:{maxTurns:2,maxToolCalls:1,maxElapsedMs:15000}}}
  return{caller,target,repo,group,selection}
}

it('rediscovers a SIGKILL-committed prepared task without input and never queries or dispatches it from read APIs',async()=>{
  const f=await linked();writeFileSync(join(f.caller.home,'chats-crash-task.json'),JSON.stringify(f.selection));await f.caller.services.stop()
  const killed=spawnSync(process.execPath,[executable,f.caller.home,f.caller.profileId,f.group.id,'chats.task.afterCommit'],{encoding:'utf8',timeout:20000,env:{...process.env,MOUSSE_HOME:f.caller.home}})
  if(process.platform==='win32'){
    expect(killed.signal,killed.stderr).toBeNull()
    expect(killed.status,killed.stderr).toEqual(expect.any(Number))
    expect(killed.status,killed.stderr).not.toBe(0)
  }else expect(killed.signal,killed.stderr).toBe('SIGKILL')
  const reopened=await profile({home:f.caller.home,profileId:f.caller.profileId}),rt=reopened.services.net.runtime()
  const before=rt.db.database.prepare('SELECT record FROM net_bridge_hub_requests WHERE id=?').get(f.selection.taskId)!.record
  const query=vi.spyOn(reopened.services.bridge.hub,'query'),submit=vi.spyOn(reopened.services.bridge.hub,'submit'),prepare=vi.spyOn(reopened.services.bridge.hub,'prepare')
  const page=reopened.services.chatNetwork.listTasks({chatId:f.group.id})
  expect(page.tasks).toHaveLength(1);expect(page.tasks[0]).toMatchObject({taskId:f.selection.taskId,status:{state:'prepared',original:f.selection.taskId},validation:'pendingTargetValidation'})
  expect(JSON.stringify(page)).not.toContain('CHAT BOUND TASK ONLY');expect(JSON.stringify(page)).not.toContain(f.repo)
  expect(await reopened.services.chatNetwork.getTask({chatId:f.group.id,taskId:f.selection.taskId,result:true})).toEqual({selection:page.tasks[0]})
  expect(query).not.toHaveBeenCalled();expect(submit).not.toHaveBeenCalled();expect(prepare).not.toHaveBeenCalled()
  expect(rt.db.database.prepare('SELECT record FROM net_bridge_hub_requests WHERE id=?').get(f.selection.taskId)!.record).toBe(before)
  expect(rt.db.database.prepare('SELECT count(*) AS n FROM net_bridge_hub_aliases').get()!.n).toBe(0)
  expect(f.target.services.net.runtime().db.database.prepare('SELECT count(*) AS n FROM net_rpc_aliases').get()!.n).toBe(0)
  expect(f.target.contexts).toHaveLength(0);expect(reopened.contexts).toHaveLength(0)
},30000)

it('lists stable task-ID pages and reads prepared or failed rows without inputs, effects, aliases, or mutation replay',async()=>{
  const f=await linked(),service=f.caller.services.chatNetwork,ids=[newId('rpc'),newId('rpc'),newId('rpc')].sort()
  for(const taskId of ids)service.selectTask({...f.selection,taskId})
  const before=f.caller.services.net.runtime().db.database.prepare('SELECT id,record FROM net_bridge_hub_requests ORDER BY id').all()
  const page=service.listTasks({chatId:f.group.id,limit:2})
  expect(page.tasks.map(task=>task.taskId)).toEqual(ids.slice(0,2));expect(page.nextAfter).toBe(ids[1])
  expect(service.listTasks({chatId:f.group.id,after:page.nextAfter,limit:2})).toMatchObject({tasks:[{taskId:ids[2]}]})
  expect(service.listTasks({chatId:f.group.id,after:ids[2]})).toEqual({tasks:[]})
  expect(JSON.stringify(page)).not.toContain(f.selection.input.prompt);expect(JSON.stringify(page)).not.toContain(f.selection.input.repoId)
  for(const taskId of ids)expect((await service.getTask({chatId:f.group.id,taskId,result:true})).selection.status.state).toBe('prepared')
  expect(f.caller.services.net.runtime().db.database.prepare('SELECT id,record FROM net_bridge_hub_requests ORDER BY id').all()).toEqual(before)
  // An authenticated target may return a terminal error. Inject only that wire
  // reply over real TLS; the read API must not repeat it on the failed original.
  const mux=(f.target.services.net.session(f.caller.services.net.runtime().identity.self()!.node) as unknown as {mux:Mux}).mux,send=mux.send.bind(mux)
  const errorReply=vi.spyOn(mux,'send').mockImplementation((lane,message,signal)=>message.header.t==='rpc.result'&&message.header.id===ids[0]?send(lane,{header:{t:'rpc.result',id:ids[0],error:{code:'bad_request',message:'Invalid request.',retryable:false}},parts:[]},signal):send(lane,message,signal))
  await expect(f.caller.services.bridge.hub.query(ids[0])).rejects.toMatchObject({code:'bad_request'});errorReply.mockRestore()
  const failed=f.caller.services.bridge.hub.status(ids[0]);expect(failed.state).toBe('failed')
  const query=vi.spyOn(f.caller.services.bridge.hub,'query'),submit=vi.spyOn(f.caller.services.bridge.hub,'submit')
  expect(await service.getTask({chatId:f.group.id,taskId:ids[0],result:true})).toMatchObject({selection:{validation:'rejected',status:failed}})
  expect(query).not.toHaveBeenCalled();expect(submit).not.toHaveBeenCalled()
  expect(f.target.services.net.runtime().db.database.prepare('SELECT count(*) AS n FROM net_rpc_aliases').get()!.n).toBe(0)
  expect(f.target.services.net.runtime().db.database.prepare('SELECT count(*) AS n FROM net_dispatches').get()!.n).toBe(0)
  expect(f.target.contexts).toHaveLength(0);expect(f.caller.contexts).toHaveLength(0)
},25000)

it('keeps frozen Chat status readable with current read-only target leases, and denies revoked targets and cross-Chat/profile IDs',async()=>{
  const f=await linked(),service=f.caller.services.chatNetwork,rt=f.caller.services.net.runtime(),binding=service.binding(f.group.id)!,input={chatId:f.group.id,taskId:f.selection.taskId}
  service.selectTask(f.selection)
  const other=await f.caller.services.platform.chats.create({kind:'group',name:'Other',agentIds:[f.group.participants.find(p=>p.kind==='agent')!.definitionId!]});service.publish({chatId:other.id,publicationId:'other-readable-chat'})
  await expect(service.getTask({...input,chatId:other.id})).rejects.toMatchObject({code:'forbidden'})
  expect(service.listTasks({chatId:other.id})).toEqual({tasks:[]})
  await expect(f.target.services.chatNetwork.getTask(input)).rejects.toMatchObject({code:'forbidden'})
  expect(()=>f.target.services.chatNetwork.listTasks({chatId:f.group.id})).toThrow(expect.objectContaining({code:'stream_unknown'}))
  f.caller.services.spaces.host.postMeta(binding.space,'space.frozen',{reason:'readable frozen status'})
  const root=rt.identity.pinnedRootKey(rt.identity.self()!.user)!,roster=rt.identity.verifySigned<Roster>(rt.identity.roster()!,root),delegation=roster.nodes.map(row=>rt.identity.verifySigned<NodeDelegation>(row,root)).find(row=>row.subject===f.selection.deviceId)!
  rt.identity.issueNodeDelegation({node:f.selection.deviceId,keys:delegation.keys,name:'Current read-only target',caps:['read']})
  expect(service.listTasks({chatId:f.group.id}).tasks[0].taskId).toBe(input.taskId)
  expect((await service.getTask({...input,result:true})).selection.status.state).toBe('prepared')
  await expect(service.dispatch(input)).rejects.toMatchObject({code:'space_frozen'})
  rt.identity.revoke(f.selection.deviceId)
  expect(()=>service.listTasks({chatId:f.group.id})).toThrow(expect.objectContaining({code:'revoked'}))
  await expect(service.getTask(input)).rejects.toMatchObject({code:'revoked'})
  expect(f.target.contexts).toHaveLength(0)
},25000)

it('queries the exact original after a lost actual TLS result and restart without dispatching or rerunning Native',async()=>{
  const f=await linked();f.selection.input.limits.maxElapsedMs=2500
  await f.target.services.bridge.dispatch.bindRepository(f.selection.input.repoId,f.repo)
  f.caller.services.chatNetwork.selectTask(f.selection)
  const mux=(f.target.services.net.session(f.caller.services.net.runtime().identity.self()!.node) as unknown as {mux:Mux}).mux,send=mux.send.bind(mux)
  let dropped=false
  const fault=vi.spyOn(mux,'send').mockImplementation((lane,message,signal)=>{
    if(!dropped&&message.header.t==='rpc.result'&&message.header.id===f.selection.taskId&&message.header.result){dropped=true;return Promise.resolve()}
    return send(lane,message,signal)
  })
  const input={chatId:f.group.id,taskId:f.selection.taskId}
  await expect(f.caller.services.chatNetwork.dispatch(input)).rejects.toMatchObject({code:'deadline_exceeded'})
  expect(dropped).toBe(true);fault.mockRestore();expect(f.target.contexts).toHaveLength(1)
  await f.caller.services.stop()
  // Recover the original without the prepared input in an actual independent
  // process, then SIGKILL between verified Hub result and Chat validation commit.
  const child=spawn(process.execPath,[readExecutable,f.caller.home,f.caller.profileId,f.group.id,f.selection.taskId],{stdio:['ignore','ignore','pipe'],env:{...process.env,MOUSSE_HOME:f.caller.home}})
  const killed=await new Promise<{code:number|null;signal:NodeJS.Signals|null;stderr:string}>((done,reject)=>{
    let stderr='';child.stderr.on('data',chunk=>{stderr+=String(chunk)})
    const timer=setTimeout(()=>child.kill('SIGTERM'),25000)
    child.once('error',error=>{clearTimeout(timer);reject(error)})
    child.once('close',(code,signal)=>{clearTimeout(timer);done({code,signal,stderr})})
  })
  if(process.platform==='win32'){
    expect(killed.signal,killed.stderr).toBeNull()
    expect(killed.code,killed.stderr).toEqual(expect.any(Number))
    expect(killed.code,killed.stderr).not.toBe(0)
  }else expect(killed.signal,killed.stderr).toBe('SIGKILL')
  expect(JSON.parse(readFileSync(join(f.caller.home,'chats-task-read-crash.json'),'utf8'))).toEqual({chatId:f.group.id,taskId:f.selection.taskId,original:f.selection.taskId,state:'completed'})
  const reopened=await profile({home:f.caller.home,profileId:f.caller.profileId})
  await vi.waitFor(()=>expect(reopened.services.net.session(f.selection.deviceId).state()).toBe('open'),{timeout:15000})
  const submit=vi.spyOn(reopened.services.bridge.hub,'submit'),prepare=vi.spyOn(reopened.services.bridge.hub,'prepare'),query=vi.spyOn(reopened.services.bridge.hub,'query')
  expect(reopened.services.chatNetwork.listTasks({chatId:f.group.id}).tasks[0]).toMatchObject({taskId:input.taskId,status:{state:'completed',original:input.taskId},validation:'pendingTargetValidation'})
  const cached=await reopened.services.chatNetwork.getTask(input);expect(cached.result).toBeUndefined();expect(query).not.toHaveBeenCalled()
  const result=await reopened.services.chatNetwork.getTask({...input,result:true})
  expect(result.selection).toMatchObject({validation:'authorized',status:{state:'completed'}})
  expect(result.result).toMatchObject({rpc:input.taskId,repoId:f.selection.input.repoId,baseCommit:f.selection.input.baseCommit,author:{node:f.selection.deviceId}})
  expect(query).toHaveBeenCalledWith(input.taskId);expect(submit).not.toHaveBeenCalled();expect(prepare).not.toHaveBeenCalled()
  expect(f.target.contexts).toHaveLength(1);expect(reopened.contexts).toHaveLength(0)
  expect(f.target.services.net.runtime().db.database.prepare('SELECT count(DISTINCT execution) AS n FROM net_rpc_aliases WHERE id=?').get(input.taskId)!.n).toBe(1)
},35000)

it('keeps a malicious independently signed result pending and exposes no result from read-only retrieval',async()=>{
  const f=await linked();await f.target.services.bridge.dispatch.bindRepository(f.selection.input.repoId,f.repo)
  const dispatch=f.target.services.bridge.dispatch,run=dispatch.run.bind(dispatch)
  vi.spyOn(dispatch,'run').mockImplementation(async(...args)=>{
    const signed=await run(...args),body=parseProtocolJson(Buffer.from(signed.payload,'base64url')) as DispatchResultBody
    return f.target.services.net.runtime().identity.signAsNode({...body,rpc:newId('rpc')})
  })
  f.caller.services.chatNetwork.selectTask(f.selection);const input={chatId:f.group.id,taskId:f.selection.taskId}
  await expect(f.caller.services.chatNetwork.dispatch(input)).rejects.toMatchObject({code:'forbidden'})
  const cached=await f.caller.services.chatNetwork.getTask(input);expect(cached).toMatchObject({selection:{validation:'pendingTargetValidation',status:{state:'completed'}}});expect(cached.result).toBeUndefined()
  await expect(f.caller.services.chatNetwork.getTask({...input,result:true})).rejects.toMatchObject({code:'forbidden'})
  expect(f.caller.services.net.runtime().db.database.prepare('SELECT validated_result_hash FROM net_chat_task_bindings WHERE task=?').get(input.taskId)!.validated_result_hash).toBeNull()
  expect(f.target.contexts).toHaveLength(1)
},25000)

it('reads completed metadata and verified results while frozen, but preserves write-cap gates on result retrieval',async()=>{
  const f=await linked();await f.target.services.bridge.dispatch.bindRepository(f.selection.input.repoId,f.repo)
  const service=f.caller.services.chatNetwork,rt=f.caller.services.net.runtime(),input={chatId:f.group.id,taskId:f.selection.taskId},binding=service.binding(f.group.id)!
  service.selectTask(f.selection);const original=await service.dispatch(input)
  f.caller.services.spaces.host.postMeta(binding.space,'space.frozen',{reason:'read-only completed task'})
  expect(service.listTasks({chatId:f.group.id}).tasks[0]).toEqual(original.selection)
  expect(await service.getTask({...input,result:true})).toEqual(original)
  const root=rt.identity.pinnedRootKey(rt.identity.self()!.user)!,roster=rt.identity.verifySigned<Roster>(rt.identity.roster()!,root),node=roster.nodes.map(row=>rt.identity.verifySigned<NodeDelegation>(row,root)).find(row=>row.subject===f.selection.deviceId)!
  rt.identity.issueNodeDelegation({node:f.selection.deviceId,keys:node.keys,name:'Read-only target',caps:['read']})
  expect((await service.getTask(input)).selection).toEqual(original.selection)
  const query=vi.spyOn(f.caller.services.bridge.hub,'query')
  await expect(service.getTask({...input,result:true})).rejects.toMatchObject({code:'forbidden'})
  expect(query).not.toHaveBeenCalled();expect(f.target.contexts).toHaveLength(1)
},25000)

it('rechecks the actual foreign Host read authorization after verified original result retrieval',async()=>{
  const f=await linked(),host=await profile(),space=host.services.spaces.host.create({name:'Foreign task scope'}).space,channel=host.services.spaces.host.createChannel(space,'Task channel')
  const join=f.caller.services.spaces.client.prepareJoin(host.services.spaces.host.invite(space).text)
  await f.caller.services.spaces.client.join(join);await f.caller.services.spaces.client.connect(space)
  const bound=await f.caller.services.chatNetwork.bind({bindingId:'task-read-foreign',space,channel}),selection={...f.selection,chatId:bound.id}
  await f.target.services.bridge.dispatch.bindRepository(selection.input.repoId,f.repo)
  const service=f.caller.services.chatNetwork,input={chatId:bound.id,taskId:selection.taskId}
  service.selectTask(selection);await service.dispatch(input);expect(f.target.contexts).toHaveLength(1)
  const hub=f.caller.services.bridge.hub,query=hub.query.bind(hub)
  vi.spyOn(hub,'query').mockImplementation(async(...args)=>{
    const result=await query(...args)
    host.services.spaces.host.postMeta(space,'member.removed',{user:f.caller.services.net.runtime().identity.self()!.user})
    return result
  })
  await expect(service.getTask({...input,result:true})).rejects.toThrow()
  expect(f.target.contexts).toHaveLength(1);expect(f.caller.contexts).toHaveLength(0)
},30000)
