import { afterEach, expect, it, vi } from 'vitest'
import { existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { cleanup, profile } from './helpers'
import { effectiveBotPolicyDigest } from '../../../src/mms/bots/runtime'
import { newId, type SpaceId } from '../../../src/shared/net'

afterEach(async()=>{for(const close of cleanup.splice(0).reverse())await close()})
async function addBot(p:Awaited<ReturnType<typeof profile>>,space:SpaceId,visibility:'public'|'private'){
  const rt=p.services.net.runtime(),bot=newId('bot'),key=rt.keys.createBotKey(bot),self=rt.identity.self()!,adapter=`qa-${visibility}`,definition=p.definitions.get(adapter)!
  const delegation=rt.identity.issueBotDelegation({bot,key,name:`Chats ${visibility}`,hostNode:self.node})
  p.services.spaces.host.postMeta(space,'bot.added',{record:{bot,owner:self.user,delegation,displayName:`Chats ${visibility}`,profile:'chat',policy:{visibility,steer:{kind:'everyone'}}}})
  const config={space,bot,adapter,profile:'chat' as const,definitionRevision:definition.revision,profileDigest:effectiveBotPolicyDigest(definition,'chat'),dailyBudgetUnits:1000,runCeilingUnits:60,maxConcurrent:2,runsPerMemberHour:20}
  p.services.bots.configure(config);p.services.bots.qualify(config)
  return bot
}
async function joinMember(owner:Awaited<ReturnType<typeof profile>>,member:Awaited<ReturnType<typeof profile>>,space:SpaceId){
  const id=member.services.spaces.client.prepareJoin(owner.services.spaces.host.invite(space).text)
  await member.services.spaces.client.join(id);await member.services.spaces.client.connect(space)
}

it('admits two exact Chats mentions into separate real backing threads/workspaces and projects private results only to the actual recipient',async()=>{
  const owner=await profile({native:true}),sender=await profile(),outsider=await profile(),group=await owner.createGroup()
  owner.services.platform.chats.send({chatId:group.id,text:'OLD GROUP TRANSCRIPT CANARY'})
  await owner.services.platform.chats.waitForIdle()
  const resource=owner.services.platform.chats.resourceBinding(group.id)
  writeFileSync(join(resource.workspaceRoot,'local-resource-canary.txt'),'OLD GROUP RESOURCE CANARY')
  const published=owner.services.chatNetwork.publish({chatId:group.id,publicationId:'two-mentioned'})
  const publicBot=await addBot(owner,published.space,'public'),privateBot=await addBot(owner,published.space,'private')
  await joinMember(owner,sender,published.space);await joinMember(owner,outsider,published.space)
  const sendChat=await sender.services.chatNetwork.bind({bindingId:'sender-group',space:published.space,channel:published.channel})
  const outsiderChat=await outsider.services.chatNetwork.bind({bindingId:'outsider-group',space:published.space,channel:published.channel})
  const result=await sender.services.chatNetwork.send({chatId:sendChat.id,text:'Two exact registered bots',clientMessageId:'two-original',mentions:[publicBot,privateBot]})
  expect(result.network?.delivery?.state).toBe('sent')
  const trigger=result.network!.delivery!.id,rt=owner.services.net.runtime()
  await vi.waitFor(()=>{expect(rt.executions.find({scope:published.space,target:publicBot,trigger})?.state).toBe('completed');expect(rt.executions.find({scope:published.space,target:privateBot,trigger})?.state).toBe('completed')},{timeout:10000})
  await owner.services.bots.drain()
  const executions=[publicBot,privateBot].map(target=>rt.executions.find({scope:published.space,target,trigger})!)
  expect(new Set(executions.map(row=>row.id)).size).toBe(2)
  expect(new Set(executions.map(row=>row.binding!.backingThreadId)).size).toBe(2)
  expect(new Set(executions.map(row=>row.binding!.workspaceId)).size).toBe(2)
  for(const execution of executions){
    expect(execution.binding!.backingThreadId).not.toBe(group.threadId)
    const threadRoot=owner.services.threads.getThreadDir(execution.binding!.backingThreadId)
    expect(existsSync(join(threadRoot,'bot-workspaces',execution.binding!.workspaceId,'.net-bot-workspace.json'))).toBe(true)
    expect(owner.services.spaces.host.executionBinding(published.space,execution.id)?.trigger).toBe(trigger)
  }
  expect(owner.contexts).toHaveLength(3);expect(sender.contexts).toHaveLength(0);expect(outsider.contexts).toHaveLength(0)
  expect(owner.contexts.slice(1).map(context=>context.systemPrompt).sort()).toEqual(['NET PRIVATE ONLY','NET PUBLIC ONLY'])
  expect(JSON.stringify(owner.contexts.slice(1))).not.toContain('OLD GROUP TRANSCRIPT CANARY')
  expect(JSON.stringify(owner.contexts.slice(1))).not.toContain('OLD GROUP RESOURCE CANARY')
  await vi.waitFor(()=>expect(sender.services.spaces.store.head(published.channel).seq).toBe(owner.services.spaces.store.head(published.channel).seq))
  const publicWork=await sender.services.chatNetwork.work({chatId:sendChat.id,stream:executions[0].binding!.stream})
  const privateWork=await sender.services.chatNetwork.work({chatId:sendChat.id,stream:executions[1].binding!.stream})
  expect(publicWork.private).toBe(false);expect(privateWork.private).toBe(true)
  expect(publicWork.records.find(row=>row.envelope.type==='bot.run.completed')?.envelope.body).toEqual({text:'LOCAL ONLY ANSWER'})
  expect(privateWork.records.find(row=>row.envelope.type==='bot.run.completed')?.privateBody).toEqual({text:'LOCAL ONLY ANSWER'})
  expect(privateWork.records.every(row=>row.envelope.type==='participants.changed'||row.envelope.sealed&&row.envelope.body===undefined)).toBe(true)
  await vi.waitFor(()=>expect(outsider.services.spaces.store.head(published.channel).seq).toBe(owner.services.spaces.store.head(published.channel).seq))
  await expect(outsider.services.chatNetwork.work({chatId:outsiderChat.id,stream:privateWork.descriptor.id})).rejects.toMatchObject({code:'forbidden'})
  await expect(sender.services.chatNetwork.work({chatId:sendChat.id,stream:newId('stream')})).rejects.toMatchObject({code:'forbidden'})
  const otherChannel=owner.services.spaces.host.createChannel(published.space,'other')
  await vi.waitFor(()=>expect(sender.services.spaces.meta.channel(published.space,otherChannel)).toBeDefined())
  const another=await sender.services.chatNetwork.bind({bindingId:'other-channel',space:published.space,channel:otherChannel})
  await expect(sender.services.chatNetwork.work({chatId:another.id,stream:publicWork.descriptor.id})).rejects.toMatchObject({code:'forbidden'})
  expect(JSON.stringify(sender.services.chatNetwork.get(sendChat.id).network)).not.toContain('LOCAL ONLY ANSWER')
  await sender.services.chatNetwork.send({chatId:sendChat.id,text:'Two exact registered bots',clientMessageId:'two-original',mentions:[publicBot,privateBot]})
  await owner.services.bots.drain()
  expect(owner.contexts).toHaveLength(3)
},30000)
