import { afterAll, afterEach, beforeAll, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { build } from 'esbuild'
import { cleanup, linkedTaskFixture, profile } from './helpers'
import { newId, type NodeDelegation, type Roster } from '../../../src/shared/net'
import { validateChatParams } from '../../../src/mms/chats/registerMethods'

afterEach(async()=>{for(const close of cleanup.splice(0).reverse())await close()})
let executable:string,buildRoot:string
beforeAll(async()=>{
  buildRoot=realpathSync(mkdtempSync(join(tmpdir(),'chats-device-build-')));symlinkSync(resolve('node_modules'),join(buildRoot,'node_modules'),'dir');executable=join(buildRoot,'child.mjs')
  const {getCliBuildOptions}=await import('../../../scripts/build-cli.mjs')
  await build({...getCliBuildOptions(process.cwd()),entryPoints:[fileURLToPath(new URL('./crash-child.ts',import.meta.url))],outfile:executable,sourcemap:false,logLevel:'silent'})
})
afterAll(()=>rmSync(buildRoot,{recursive:true,force:true}))

it('prepares a chat-bound device task then executes exactly once in the actual target Native thread/worktree over same-user TLS',async()=>{
  const f=await linkedTaskFixture();await f.target.services.bridge.dispatch.bindRepository(f.selection.input.repoId,f.repo)
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
  const f=await linkedTaskFixture()
  expect(f.caller.services.chatNetwork.selectTask(f.selection).validation).toBe('pendingTargetValidation')
  await expect(f.caller.services.chatNetwork.dispatch({chatId:f.group.id,taskId:f.selection.taskId})).rejects.toMatchObject({code:'outcome_uncertain'})
  expect(f.caller.services.chatNetwork.selectTask(f.selection)).toMatchObject({validation:'pendingTargetValidation',status:{state:'unknown'}})
  await expect(f.caller.services.chatNetwork.dispatch({chatId:f.group.id,taskId:f.selection.taskId})).rejects.toMatchObject({code:'outcome_uncertain'})
  expect(f.target.services.net.runtime().db.database.prepare('SELECT count(DISTINCT execution) AS n FROM net_rpc_aliases WHERE id=?').get(f.selection.taskId)!.n).toBe(1)
  expect(f.target.contexts).toHaveLength(0);expect(f.target.services.net.runtime().db.database.prepare('SELECT count(*) AS n FROM net_dispatches').get()!.n).toBe(0)
},20000)

it('rejects a guessed/foreign device and malformed received task before creating an original Bridge request',async()=>{
  const f=await linkedTaskFixture(),foreign=await profile()
  expect(()=>f.caller.services.chatNetwork.selectTask({...f.selection,deviceId:foreign.services.net.runtime().identity.self()!.node})).toThrow(expect.objectContaining({code:'bad_delegation'}))
  expect(()=>validateChatParams('chats.assignDevice',{...f.selection,input:{...f.selection.input,modulePath:'/received/module.js'}})).toThrow(expect.objectContaining({code:'invalid_params'}))
  expect(()=>f.caller.services.net.runtime().db.transaction(()=>f.caller.services.chatNetwork.selectTask(f.selection))).toThrow(expect.objectContaining({code:'forbidden'}))
  expect(f.caller.services.net.runtime().db.database.prepare('SELECT count(*) AS n FROM net_bridge_hub_requests').get()!.n).toBe(0)
  expect(f.target.contexts).toHaveLength(0)
},20000)

it('denies a chat-bound task after the actual Space is frozen before admitting target effects',async()=>{
  const f=await linkedTaskFixture(),binding=f.caller.services.chatNetwork.binding(f.group.id)!
  f.caller.services.spaces.host.postMeta(binding.space,'space.frozen',{reason:'actual owner freeze'})
  expect(()=>f.caller.services.chatNetwork.selectTask(f.selection)).toThrow(expect.objectContaining({code:'space_frozen'}))
  expect(f.caller.services.net.runtime().db.database.prepare('SELECT count(*) AS n FROM net_bridge_hub_requests').get()!.n).toBe(0)
  expect(f.target.contexts).toHaveLength(0)
},20000)

it('requires current target capability and exact Space bot placement without silently moving the bot',async()=>{
  const f=await linkedTaskFixture(),rt=f.caller.services.net.runtime(),binding=f.caller.services.chatNetwork.binding(f.group.id)!,self=rt.identity.self()!,bot=newId('bot')
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

it('recovers actual SIGKILL before commit with neither the chat/task binding nor the original Hub request persisted',async()=>{
  const point='chats.task.beforeCommit'
  const f=await linkedTaskFixture();writeFileSync(join(f.caller.home,'chats-crash-task.json'),JSON.stringify(f.selection));await f.caller.services.stop()
  const killed=spawnSync(process.execPath,[executable,f.caller.home,f.caller.profileId,f.group.id,point],{encoding:'utf8',timeout:20000,env:{...process.env,MOUSSE_HOME:f.caller.home}})
  expect(killed.signal,killed.stderr).toBe('SIGKILL')
  const observed=JSON.parse(readFileSync(join(f.caller.home,'chats-crash-public-identities.json'),'utf8'))
  expect(observed.task).toMatchObject({task:f.selection.taskId,target:f.selection.deviceId})
  const reopened=await profile({home:f.caller.home,profileId:f.caller.profileId}),db=reopened.services.net.runtime().db
  const task=db.database.prepare('SELECT * FROM net_chat_task_bindings WHERE task=?').get(f.selection.taskId),hub=db.database.prepare('SELECT * FROM net_bridge_hub_requests WHERE id=?').get(f.selection.taskId)
  expect(!!task).toBe(false);expect(!!hub).toBe(false)
  expect(reopened.services.chatNetwork.selectTask(f.selection)).toMatchObject({taskId:f.selection.taskId,validation:'pendingTargetValidation',status:{state:'prepared',original:f.selection.taskId}})
  expect(db.database.prepare('SELECT count(*) AS n FROM net_chat_task_bindings').get()!.n).toBe(1)
  expect(f.target.contexts).toHaveLength(0);expect(reopened.contexts).toHaveLength(0)
},30000)

it('requires actual current foreign Host authorization before a prepared joined-Chat task can start Native on another same-user node',async()=>{
  const f=await linkedTaskFixture(),host=await profile(),space=host.services.spaces.host.create({name:'Foreign task Group'}).space,channel=host.services.spaces.host.createChannel(space,'Foreign task channel')
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
