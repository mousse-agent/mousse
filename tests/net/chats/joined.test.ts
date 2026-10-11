import { afterEach, expect, it, vi } from 'vitest'
import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { cleanup, profile } from './helpers'
import { newId } from '../../../src/shared/net'

afterEach(async()=>{for(const close of cleanup.splice(0).reverse())await close()})
async function joined(){
  const owner=await profile(), member=await profile(), group=await owner.createGroup()
  const binding=owner.services.chatNetwork.publish({chatId:group.id,publicationId:'joined-owner'})
  const id=member.services.spaces.client.prepareJoin(owner.services.spaces.host.invite(binding.space).text)
  await member.services.spaces.client.join(id);await member.services.spaces.client.connect(binding.space)
  return {owner,member,group,binding}
}

it('binds a real authenticated joined channel as one SQL-only presentation without local agent/thread/resource fabrication',async()=>{
  const f=await joined(), request={bindingId:'member-binding',space:f.binding.space,channel:f.binding.channel}
  const threads=f.member.services.threads.listThreads().length
  const [one,two]=await Promise.all([f.member.services.chatNetwork.bind(request),f.member.services.chatNetwork.bind(request)])
  expect(two.id).toBe(one.id)
  expect(one).toMatchObject({presentation:'network',kind:'group',messages:[],binding:{space:request.space,channel:request.channel}})
  expect(one).not.toHaveProperty('threadId');expect(one).not.toHaveProperty('projectId')
  expect(one.participants.map(row=>row.id)).toEqual(expect.arrayContaining([f.owner.services.net.runtime().identity.self()!.user,f.member.services.net.runtime().identity.self()!.user]))
  expect(one.participants.every(row=>row.id.startsWith('usr_'))).toBe(true)
  expect(f.member.services.threads.listThreads()).toHaveLength(threads)
  expect(readdirSync(join(f.member.home,'chats'))).toEqual([])
  expect(()=>f.member.services.platform.chats.resourceBinding(one.id)).toThrow(expect.objectContaining({code:'chat_not_found'}))
  expect(()=>f.member.services.platform.chats.send({chatId:one.id,text:'local fallback'})).toThrow(expect.objectContaining({code:'chat_published'}))
  expect(f.member.services.chatNetwork.snapshot(f.member.services.platform.chats.snapshot()).chats).toContainEqual(expect.objectContaining({id:one.id,presentation:'network'}))
  const message=await f.member.services.chatNetwork.send({chatId:one.id,text:'joined person',clientMessageId:'joined-message'})
  expect(message.network?.delivery?.state).toBe('sent')
  await vi.waitFor(()=>expect(f.member.services.spaces.store.head(request.channel).seq).toBe(1))
  expect(f.member.services.chatNetwork.get(one.id).network?.records[0].envelope.author.user).toBe(f.member.services.net.runtime().identity.self()!.user)
  expect(f.owner.contexts).toHaveLength(0);expect(f.member.contexts).toHaveLength(0)
  await expect(f.member.services.chatNetwork.bind({...request,bindingId:'changed-key'})).rejects.toMatchObject({code:'conflict'})
  await expect(f.member.services.chatNetwork.bind({...request,channel:newId('stream')})).rejects.toMatchObject({code:'not_member'})
})

it('recovers the original joined UUID after a committed lost reply and actual profile restart',async()=>{
  const f=await joined(), request={bindingId:'lost-binding',space:f.binding.space,channel:f.binding.channel}, rt=f.member.services.net.runtime()
  const checkpoint=rt.db.checkpoint.bind(rt.db), fault=vi.spyOn(rt.db,'checkpoint').mockImplementation(point=>{if(point==='chats.binding.afterCommit')throw new Error('lost binding reply');checkpoint(point)})
  await expect(f.member.services.chatNetwork.bind(request)).rejects.toThrow('lost binding reply')
  const original=rt.db.database.prepare('SELECT chat FROM net_chat_publications WHERE publication_id=?').get(request.bindingId)!.chat
  fault.mockRestore();await f.member.services.stop()
  const reopened=await profile({home:f.member.home,profileId:f.member.profileId})
  const recovered=await reopened.services.chatNetwork.bind(request)
  expect(recovered.id).toBe(original);expect(recovered.presentation).toBe('network')
  expect(readdirSync(join(reopened.home,'chats'))).toEqual([])
  expect(()=>reopened.services.platform.chats.send({chatId:recovered.id,text:'restart fallback'})).toThrow(expect.objectContaining({code:'chat_published'}))
})

it('pages every exact signed event once with bounded cursors and denies stale or substituted pages',async()=>{
  const p=await profile(), group=await p.createGroup(), binding=p.services.chatNetwork.publish({chatId:group.id,publicationId:'paged'})
  const rt=p.services.net.runtime()
  rt.limits.configureRate({kind:'space',space:binding.space},`events/${rt.identity.self()!.user}`,1000,10000)
  const ids=Array.from({length:140},(_,i)=>p.services.spaces.client.post(binding.channel,`page ${i}`))
  for(let i=0;i<3;i++)await p.services.spaces.flush(binding.space)
  expect(p.services.spaces.store.head(binding.channel).seq).toBe(140)
  const one=p.services.chatNetwork.get(group.id,undefined,{limit:64}).network!
  expect(one.records).toHaveLength(64);expect(one.cursor).toEqual({epoch:1,seq:64});expect(one.nextAfter).toEqual(one.cursor)
  const two=p.services.chatNetwork.get(group.id,undefined,{after:one.nextAfter,limit:64}).network!
  const three=p.services.chatNetwork.get(group.id,undefined,{after:two.nextAfter,limit:64}).network!
  expect([...one.records,...two.records,...three.records].map(row=>row.envelope.id)).toEqual(ids)
  expect(three.records).toHaveLength(12);expect(three.cursor).toEqual({epoch:1,seq:140});expect(three.nextAfter).toBeUndefined()
  expect(p.services.chatNetwork.get(group.id,undefined,{after:three.cursor}).network?.records).toEqual([])
  expect(()=>p.services.chatNetwork.get(group.id,undefined,{after:{epoch:2,seq:0}})).toThrow(expect.objectContaining({code:'snapshot_required'}))
  expect(()=>p.services.chatNetwork.get(group.id,undefined,{after:{epoch:1,seq:141}})).toThrow(expect.objectContaining({code:'invalid_params'}))
  expect(()=>p.services.chatNetwork.get(group.id,undefined,{limit:129})).toThrow(expect.objectContaining({code:'invalid_params'}))
})
