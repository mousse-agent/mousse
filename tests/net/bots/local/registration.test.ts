import { mkdtempSync,realpathSync,rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach,expect,it,vi } from 'vitest'
import { MousseMainService } from '../../../../src/mms/MousseMainService'
import { MmsProtocolServer } from '../../../../src/mms/protocol/server'
import { LocalMmsClient } from '../../../../src/mms/protocol/client'
import { newId,NetError } from '../../../../src/shared/net'
import { verifyBytes,verifyDocument } from '../../../../src/mms/net/identity/crypto'
import { decodeEnvelope } from '../../../../src/mms/net/sync/codec'
import type { BotDelegation,Roster } from '../../../../src/shared/net'

const closes:Array<()=>void|Promise<void>>=[]
afterEach(async()=>{for(const close of closes.splice(0).reverse())await close()})
async function profile(protect=true){
  const root=realpathSync(mkdtempSync(join(tmpdir(),'bot-add-'))),home=join(root,'home')
  closes.push(()=>rmSync(root,{recursive:true,force:true}))
  const main=await MousseMainService.create({homeDir:home,repoRoot:root,headless:true,requireOwnership:false})
  closes.push(()=>main.stop())
  const server=new MmsProtocolServer({mms:main,ownerToken:'task-owned-registration'}),endpoint=await server.start()
  closes.push(()=>server.stop())
  const client=new LocalMmsClient({homeDir:home,endpoint,ownerToken:'task-owned-registration',requestedCapabilities:['profiles-v1']})
  closes.push(()=>client.close());await client.connect();await client.request('profiles.bind',{profile:main.getInstallationHost()!.getDefaultProfileId()})
  await client.request('net.init',{listen:true,port:0});if(protect)await client.request('net.protect',{passphrase:'task-owned-registration-protection'})
  return {main,client,rt:main.net.runtime(),spaces:main.spaces}
}
const policy={steer:{kind:'owner' as const},visibility:'public' as const}
it('registers a real protected root-owned bot through IPC and observes the same signed original on identical retry',async()=>{
  const p=await profile(),space=p.spaces.host.create({name:'Owner registration'}),input={id:newId('rpc'),space:space.space,name:'Actual registered bot',profile:'chat',policy}
  const first=await p.client.request<any>('bots.add',input)
  expect(first).toMatchObject({id:input.id,space:input.space,state:'registered',delivery:{state:'sent',attempts:1}})
  const record=p.spaces.meta.bot(input.space,first.bot)!,root=p.rt.keys.rootKey()!,lease=verifyDocument<BotDelegation>(record.delegation,root,'botDelegation'),original=p.rt.outbox.get(first.delivery.id)!
  expect(lease).toMatchObject({subject:first.bot,owner:p.rt.identity.self()!.user,hostNode:p.rt.identity.self()!.node,name:input.name})
  verifyBytes(Buffer.from('Actual stored bot signer'),p.rt.keys.signAsBot(first.bot,Buffer.from('Actual stored bot signer')),lease.keys.sign)
  expect(decodeEnvelope(original.envelope).envelope).toMatchObject({type:'bot.added',body:{record:{bot:first.bot,profile:'chat',policy}}})
  expect(await p.client.request('bots.add',input)).toEqual(first)
  const roster=verifyDocument<Roster>(p.rt.identity.roster()!,root,'roster')
  expect(roster.bots).toHaveLength(1);expect(p.rt.db.database.prepare('SELECT count(*) AS n FROM net_bot_local_registration').get()!.n).toBe(1)
  await expect(p.client.request('bots.add',{...input,name:'Different bytes'})).rejects.toMatchObject({code:'conflict'})
  for(const extra of [{path:'/tmp'},{adapter:'mousse'},{qualified:true},{delegation:record.delegation},{bot:first.bot},{profileId:'other'}])await expect(p.client.request('bots.add',{...input,...extra})).rejects.toMatchObject({code:extra.profileId?'profile_mismatch':'bad_request'})
  expect(await p.client.request('bots.list',{})).toEqual({bots:[]}) // Registration grants no adapter activation or qualification.
  expect(p.rt.db.database.prepare('SELECT count(*) AS n FROM net_executions').get()!.n).toBe(0)
},20000)

it('denies plaintext registration and a follower without the actual root key before reserving any identity',async()=>{
  const plain=await profile(false),space=plain.spaces.host.create({name:'Plain profile'}),input={id:newId('rpc'),space:space.space,name:'Denied',profile:'reader',policy}
  await expect(plain.client.request('bots.add',input)).rejects.toMatchObject({code:'keystore_locked'})
  expect(plain.rt.db.database.prepare('SELECT count(*) AS n FROM net_bot_local_registration').get()!.n).toBe(0)
  const root=await profile(),follower=await profile(),owned=root.spaces.host.create({name:'Follower denied'})
  // Enrollment must begin on a blank identity, so use another blank real profile.
  const fid=follower.main.getInstallationHost()!.manager.create({displayName:'Follower',slug:'follower'}).id
  await follower.client.request('profiles.bind',{profile:fid})
  const invite=await root.client.request<any>('bridge.invite',{})
  await follower.client.request('bridge.join',{invite:invite.invite})
  await follower.client.request('net.protect',{passphrase:'task-owned-follower'})
  const services=await follower.main.getProfileServices(fid)
  expect(services.net.runtime().identity.self()).toMatchObject({user:root.rt.identity.self()!.user,isAuthority:false})
  expect(services.net.runtime().keys.rootKey()).toBeUndefined()
  await expect(follower.client.request('bots.add',{...input,id:newId('rpc'),space:owned.space})).rejects.toMatchObject({code:'forbidden'})
  expect(services.net.runtime().db.database.prepare('SELECT count(*) AS n FROM net_bot_local_registration').get()!.n).toBe(0)
},20000)

it('registers on a foreign Space over actual authenticated TLS and recovers a lost append ACK using its original only',async()=>{
  const host=await profile(),member=await profile(),space=host.spaces.host.create({name:'Foreign registration'})
  await member.spaces.client.join(member.spaces.client.prepareJoin(host.spaces.host.invite(space.space).text));await member.spaces.client.connect(space.space)
  const input={id:newId('rpc'),space:space.space,name:'Foreign actual bot',profile:'chat',policy}
  let original:Uint8Array|undefined,signature:Uint8Array|undefined
  const dispose=host.spaces.host.onAppend((stream,record)=>{
    if(stream!==space.meta||decodeEnvelope(record.envelope).envelope.type!=='bot.added')return
    original=record.envelope;signature=record.sig;member.spaces.session(space.space)?.close()
  })
  const first=await member.client.request<any>('bots.add',input);dispose()
  expect(original).toBeDefined();expect(first.state).toBe('unknown');expect(first.delivery.state).toBe('unknown')
  expect(host.spaces.meta.bot(space.space,first.bot)).toBeDefined()
  await member.spaces.client.connect(space.space)
  const retry=await member.client.request<any>('bots.add',input)
  expect(retry).toMatchObject({bot:first.bot,state:'registered',delivery:{id:first.delivery.id,state:'sent'}})
  const entry=member.rt.outbox.get(first.delivery.id)!
  expect(Buffer.from(entry.envelope)).toEqual(Buffer.from(original!));expect(Buffer.from(entry.sig)).toEqual(Buffer.from(signature!))
  expect(entry.attempts).toBe(1)
  const self=member.rt.identity.self()!,root=member.rt.keys.rootKey()!
  await vi.waitFor(()=>expect(verifyDocument<Roster>(host.rt.identity.roster(self.user)!,root,'roster').bots).toHaveLength(1))
  expect(verifyDocument<Roster>(member.rt.identity.roster()!,root,'roster').bots).toHaveLength(1)
  expect(member.rt.db.database.prepare('SELECT count(*) AS n FROM net_bot_local_registration').get()!.n).toBe(1)
},20000)

it('rolls back the actual identity singleton together with its leased journal and resumes only its reserved key',async()=>{
  const p=await profile(),space=p.spaces.host.create({name:'Atomic root lease'}),input={id:newId('rpc'),space:space.space,name:'Atomic bot',profile:'reader',policy},root=p.rt.keys.rootKey()!,before=p.rt.identity.roster()!
  Object.defineProperty(p.rt.db,'fault',{configurable:true,value:(point:string)=>{if(point==='bots.add.lease.beforeCommit')throw new NetError('internal')}})
  await expect(p.client.request('bots.add',input)).rejects.toMatchObject({code:'internal'})
  expect(p.rt.identity.roster()).toEqual(before)
  const reserved=JSON.parse(p.rt.db.database.prepare('SELECT value FROM net_bot_local_registration WHERE id=?').get(input.id)!.value as string),key=p.rt.keys.ensureBotKey(reserved.bot)
  expect(reserved.phase).toBe('reserved');expect(p.rt.outbox.get(reserved.event)).toBeUndefined()
  Object.defineProperty(p.rt.db,'fault',{value:undefined})
  const result=await p.client.request<any>('bots.add',input)
  expect(result).toMatchObject({bot:reserved.bot,state:'registered',delivery:{id:reserved.event}})
  const lease=verifyDocument<BotDelegation>(p.spaces.meta.bot(space.space,result.bot)!.delegation,root,'botDelegation')
  expect(lease.keys.sign).toBe(key);expect(lease.keyEpoch).toBe(1)
  expect(verifyDocument<Roster>(p.rt.identity.roster()!,root,'roster').bots).toHaveLength(1)
},20000)
