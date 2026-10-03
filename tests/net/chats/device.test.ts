import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { build } from 'esbuild'
import { cleanup, profile } from './helpers'
import { newId, type NodeDelegation, type Roster } from '../../../src/shared/net'
import { portableRepository } from '../../../src/mms/bridge/dispatch'
import { git } from '../../../src/mms/bridge/dispatch/git'
import { validateChatParams } from '../../../src/mms/chats/registerMethods'
import type { ChatTaskSelectionInput } from '../../../src/shared/chatsNetwork'
import { parseProtocolJson } from '../../../src/mms/net/sync/codec'
import type { DispatchResultBody } from '../../../src/mms/bridge/dispatch'
import type { Mux } from '../../../src/mms/net/contracts'

afterEach(async()=>{for(const close of cleanup.splice(0).reverse())await close()})
let executable:string,buildRoot:string
beforeAll(async()=>{
  buildRoot=realpathSync(mkdtempSync(join(tmpdir(),'chats-device-build-')));symlinkSync(resolve('node_modules'),join(buildRoot,'node_modules'),'dir');executable=join(buildRoot,'child.mjs')
  const {getCliBuildOptions}=await import('../../../scripts/build-cli.mjs')
  await build({...getCliBuildOptions(process.cwd()),entryPoints:[fileURLToPath(new URL('./crash-child.ts',import.meta.url))],outfile:executable,sourcemap:false,logLevel:'silent'})
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

it('prepares a chat-bound device task then executes exactly once in the actual target Native thread/worktree over same-user TLS',async()=>{
  const f=await linked();await f.target.services.bridge.dispatch.bindRepository(f.selection.input.repoId,f.repo)
  const [a,b]=await Promise.all([Promise.resolve().then(()=>f.caller.services.chatNetwork.selectTask(f.selection)),Promise.resolve().then(()=>f.caller.services.chatNetwork.selectTask(f.selection))])
  expect(a).toEqual(b);expect(a).toMatchObject({kind:'bridge-task',target:f.selection.deviceId,validation:'pendingTargetValidation',status:{state:'prepared'}})
  expect(f.target.contexts).toHaveLength(0);expect(f.caller.contexts).toHaveLength(0)
  const request={chatId:f.group.id,taskId:f.selection.taskId}
  const [one,two]=await Promise.all([f.caller.services.chatNetwork.dispatch(request),f.caller.services.chatNetwork.dispatch(request)])
  expect(two).toEqual(one);expect(one.selection).toMatchObject({validation:'authorized',status:{state:'completed'}})
  expect(one.result).toMatchObject({repoId:f.selection.input.repoId,baseCommit:f.selection.input.baseCommit,agent:{definitionId:f.selection.input.agent,profileId:f.target.profileId}})
  expect(f.target.contexts).toHaveLength(1);expect(f.caller.contexts).toHaveLength(0)
  expect(JSON.stringify(f.target.contexts)).toContain('CHAT BOUND TASK ONLY')
  const row=f.target.services.net.runtime().db.database.prepare('SELECT record FROM net_dispatches').get()!
  const record=JSON.parse(String(row.record))
  expect(record.threadId).not.toBe(f.group.threadId);expect(record.worktree.path).not.toBe(f.caller.services.platform.chats.resourceBinding(f.group.id).workspaceRoot)
  expect(record).toMatchObject({state:'completed',request:{agent:f.selection.input.agent}})
  expect(f.target.services.threads.loadThreadData(record.threadId).messages.map(value=>value.content).join('\n')).toContain('LOCAL ONLY ANSWER')
  await f.target.services.bridge.dispatch.drainCleanup()
  expect(JSON.parse(String(f.target.services.net.runtime().db.database.prepare('SELECT record FROM net_dispatches').get()!.record)).phase).toBe('complete')
  expect(await f.caller.services.chatNetwork.dispatch(request)).toEqual(one)
  expect(f.target.contexts).toHaveLength(1)
  expect(()=>f.caller.services.chatNetwork.selectTask({...f.selection,input:{...f.selection.input,prompt:'substitution'}})).toThrow(expect.objectContaining({code:'conflict'}))
  const other=await f.caller.services.platform.chats.create({kind:'group',name:'Other published Group',agentIds:[f.group.participants.find(value=>value.kind==='agent')!.definitionId!]});f.caller.services.chatNetwork.publish({chatId:other.id,publicationId:'other-task-group'})
  await expect(f.caller.services.chatNetwork.dispatch({chatId:other.id,taskId:f.selection.taskId})).rejects.toMatchObject({code:'forbidden'})
},30000)

it('does not certify target repository or policy at selection, and rejects actual unbound repository before Native effects',async()=>{
  const f=await linked()
  expect(f.caller.services.chatNetwork.selectTask(f.selection).validation).toBe('pendingTargetValidation')
  await expect(f.caller.services.chatNetwork.dispatch({chatId:f.group.id,taskId:f.selection.taskId})).rejects.toMatchObject({code:'outcome_uncertain'})
  expect(f.caller.services.chatNetwork.selectTask(f.selection)).toMatchObject({validation:'pendingTargetValidation',status:{state:'unknown'}})
  await expect(f.caller.services.chatNetwork.dispatch({chatId:f.group.id,taskId:f.selection.taskId})).rejects.toMatchObject({code:'outcome_uncertain'})
  expect(f.target.services.net.runtime().db.database.prepare('SELECT count(DISTINCT execution) AS n FROM net_rpc_aliases WHERE id=?').get(f.selection.taskId)!.n).toBe(1)
  expect(f.target.contexts).toHaveLength(0);expect(f.target.services.net.runtime().db.database.prepare('SELECT count(*) AS n FROM net_dispatches').get()!.n).toBe(0)
},20000)

it('rejects a guessed/foreign device and malformed received task before creating an original Bridge request',async()=>{
  const f=await linked(),foreign=await profile()
  expect(()=>f.caller.services.chatNetwork.selectTask({...f.selection,deviceId:foreign.services.net.runtime().identity.self()!.node})).toThrow(expect.objectContaining({code:'bad_delegation'}))
  expect(()=>validateChatParams('chats.assignDevice',{...f.selection,input:{...f.selection.input,modulePath:'/received/module.js'}})).toThrow(expect.objectContaining({code:'invalid_params'}))
  expect(()=>f.caller.services.net.runtime().db.transaction(()=>f.caller.services.chatNetwork.selectTask(f.selection))).toThrow(expect.objectContaining({code:'forbidden'}))
  expect(f.caller.services.net.runtime().db.database.prepare('SELECT count(*) AS n FROM net_bridge_hub_requests').get()!.n).toBe(0)
  expect(f.target.contexts).toHaveLength(0)
},20000)

it('does not certify a completed target RPC whose independently signed result names a different request',async()=>{
  const f=await linked();await f.target.services.bridge.dispatch.bindRepository(f.selection.input.repoId,f.repo)
  const dispatch=f.target.services.bridge.dispatch,run=dispatch.run.bind(dispatch)
  vi.spyOn(dispatch,'run').mockImplementation(async(...args)=>{
    const signed=await run(...args),body=parseProtocolJson(Buffer.from(signed.payload,'base64url')) as DispatchResultBody
    return f.target.services.net.runtime().identity.signAsNode({...body,rpc:newId('rpc')})
  })
  f.caller.services.chatNetwork.selectTask(f.selection)
  await expect(f.caller.services.chatNetwork.dispatch({chatId:f.group.id,taskId:f.selection.taskId})).rejects.toMatchObject({code:'forbidden'})
  expect(f.caller.services.bridge.hub.status(f.selection.taskId).state).toBe('completed')
  expect(f.caller.services.chatNetwork.selectTask(f.selection).validation).toBe('pendingTargetValidation')
  expect(f.target.contexts).toHaveLength(1)
},25000)

it('denies a chat-bound task after the actual Space is frozen before admitting target effects',async()=>{
  const f=await linked(),binding=f.caller.services.chatNetwork.binding(f.group.id)!
  f.caller.services.spaces.host.postMeta(binding.space,'space.frozen',{reason:'actual owner freeze'})
  expect(()=>f.caller.services.chatNetwork.selectTask(f.selection)).toThrow(expect.objectContaining({code:'space_frozen'}))
  expect(f.caller.services.net.runtime().db.database.prepare('SELECT count(*) AS n FROM net_bridge_hub_requests').get()!.n).toBe(0)
  expect(f.target.contexts).toHaveLength(0)
},20000)

it('keeps the original task unknown across an actual lost TLS result and profile restart, then queries without rerunning Native',async()=>{
  const f=await linked();f.selection.input.limits.maxElapsedMs=2500
  await f.target.services.bridge.dispatch.bindRepository(f.selection.input.repoId,f.repo)
  f.caller.services.chatNetwork.selectTask(f.selection)
  const source=f.caller.services.net.runtime().identity.self()!.node
  const mux=(f.target.services.net.session(source) as unknown as {mux:Mux}).mux,send=mux.send.bind(mux)
  let dropped=false
  const fault=vi.spyOn(mux,'send').mockImplementation((lane,message,signal)=>{
    if(!dropped&&message.header.t==='rpc.result'&&message.header.id===f.selection.taskId&&message.header.result){dropped=true;return Promise.resolve()}
    return send(lane,message,signal)
  })
  await expect(f.caller.services.chatNetwork.dispatch({chatId:f.group.id,taskId:f.selection.taskId})).rejects.toMatchObject({code:'deadline_exceeded'})
  expect(dropped).toBe(true);fault.mockRestore()
  expect(f.caller.services.net.session(f.selection.deviceId).state()).toBe('open')
  expect(f.caller.services.chatNetwork.selectTask(f.selection)).toMatchObject({validation:'pendingTargetValidation',status:{state:'unknown'}})
  expect(f.target.contexts).toHaveLength(1)
  await f.caller.services.stop()
  const reopened=await profile({home:f.caller.home,profileId:f.caller.profileId})
  await vi.waitFor(()=>expect(reopened.services.net.session(f.selection.deviceId).state()).toBe('open'),{timeout:15000})
  expect(reopened.services.chatNetwork.selectTask(f.selection)).toMatchObject({status:{original:f.selection.taskId,state:'unknown'}})
  const result=await reopened.services.chatNetwork.dispatch({chatId:f.group.id,taskId:f.selection.taskId})
  expect(result.selection).toMatchObject({validation:'authorized',status:{state:'completed'}})
  expect(f.target.contexts).toHaveLength(1);expect(reopened.contexts).toHaveLength(0)
  expect(f.target.services.net.runtime().db.database.prepare('SELECT count(DISTINCT execution) AS n FROM net_rpc_aliases WHERE id=?').get(f.selection.taskId)!.n).toBe(1)
},35000)

it('requires current target capability and exact Space bot placement without silently moving the bot',async()=>{
  const f=await linked(),rt=f.caller.services.net.runtime(),binding=f.caller.services.chatNetwork.binding(f.group.id)!,self=rt.identity.self()!,bot=newId('bot')
  const delegation=rt.identity.issueBotDelegation({bot,key:rt.keys.createBotKey(bot),name:'Placed bot',hostNode:self.node})
  f.caller.services.spaces.host.postMeta(binding.space,'bot.added',{record:{bot,owner:self.user,delegation,displayName:'Placed bot',profile:'chat',policy:{visibility:'public',steer:{kind:'everyone'}}}})
  expect(()=>f.caller.services.chatNetwork.selectTask({...f.selection,bot})).toThrow(expect.objectContaining({code:'forbidden'}))
  const root=rt.identity.pinnedRootKey(self.user)!,roster=rt.identity.verifySigned<Roster>(rt.identity.roster()!,root),node=roster.nodes.map(row=>rt.identity.verifySigned<NodeDelegation>(row,root)).find(row=>row.subject===f.selection.deviceId)!
  rt.identity.issueNodeDelegation({node:f.selection.deviceId,keys:node.keys,name:'Read-only target',caps:['read']})
  expect(()=>f.caller.services.chatNetwork.selectTask(f.selection)).toThrow(expect.objectContaining({code:'forbidden'}))
  rt.identity.revoke(f.selection.deviceId)
  expect(()=>f.caller.services.chatNetwork.selectTask(f.selection)).toThrow(expect.objectContaining({code:'revoked'}))
  expect(rt.db.database.prepare('SELECT count(*) AS n FROM net_bridge_hub_requests').get()!.n).toBe(0)
  expect(f.target.contexts).toHaveLength(0);expect(f.caller.contexts).toHaveLength(0)
},20000)

it.each(['chats.task.beforeCommit','chats.task.afterCommit'])('recovers actual SIGKILL at %s with the exact chat/task and original Hub request atomic',async point=>{
  const f=await linked();writeFileSync(join(f.caller.home,'chats-crash-task.json'),JSON.stringify(f.selection));await f.caller.services.stop()
  const killed=spawnSync(process.execPath,[executable,f.caller.home,f.caller.profileId,f.group.id,point],{encoding:'utf8',timeout:20000,env:{...process.env,MOUSSE_HOME:f.caller.home}})
  expect(killed.signal,killed.stderr).toBe('SIGKILL')
  const observed=JSON.parse(readFileSync(join(f.caller.home,'chats-crash-public-identities.json'),'utf8'))
  expect(observed.task).toMatchObject({task:f.selection.taskId,target:f.selection.deviceId})
  const reopened=await profile({home:f.caller.home,profileId:f.caller.profileId}),db=reopened.services.net.runtime().db
  const task=db.database.prepare('SELECT * FROM net_chat_task_bindings WHERE task=?').get(f.selection.taskId),hub=db.database.prepare('SELECT * FROM net_bridge_hub_requests WHERE id=?').get(f.selection.taskId)
  expect(!!task).toBe(point.endsWith('afterCommit'));expect(!!hub).toBe(!!task)
  expect(reopened.services.chatNetwork.selectTask(f.selection)).toMatchObject({taskId:f.selection.taskId,validation:'pendingTargetValidation',status:{state:'prepared',original:f.selection.taskId}})
  expect(db.database.prepare('SELECT count(*) AS n FROM net_chat_task_bindings').get()!.n).toBe(1)
  expect(f.target.contexts).toHaveLength(0);expect(reopened.contexts).toHaveLength(0)
},30000)

it('requires actual current foreign Host authorization before a prepared joined-Chat task can start Native on another same-user node',async()=>{
  const f=await linked(),host=await profile(),space=host.services.spaces.host.create({name:'Foreign task Group'}).space,channel=host.services.spaces.host.createChannel(space,'Foreign task channel')
  const join=f.caller.services.spaces.client.prepareJoin(host.services.spaces.host.invite(space).text)
  await f.caller.services.spaces.client.join(join);await f.caller.services.spaces.client.connect(space)
  const joined=await f.caller.services.chatNetwork.bind({bindingId:'foreign-task-chat',space,channel})
  const task={...f.selection,chatId:joined.id}
  await f.target.services.bridge.dispatch.bindRepository(task.input.repoId,f.repo)
  f.caller.services.chatNetwork.selectTask(task)
  expect((await f.caller.services.chatNetwork.dispatch({chatId:joined.id,taskId:task.taskId})).selection.validation).toBe('authorized')
  expect(f.target.contexts).toHaveLength(1)
  const removedTask={...task,taskId:newId('rpc')};f.caller.services.chatNetwork.selectTask(removedTask)
  host.services.spaces.host.postMeta(space,'member.removed',{user:f.caller.services.net.runtime().identity.self()!.user})
  // The old local display can still retain the prior member. It cannot be a
  // current authority proof for a new Native effect on a different carrier.
  await expect(f.caller.services.chatNetwork.dispatch({chatId:joined.id,taskId:removedTask.taskId})).rejects.toThrow()
  expect(f.target.contexts).toHaveLength(1)
  expect(f.caller.services.bridge.hub.status(removedTask.taskId).state).toBe('prepared')
},25000)
