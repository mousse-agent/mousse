import { afterEach, expect, it, vi } from 'vitest'
import { mkdtempSync,realpathSync,rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { NetService } from '../../../src/mms/net/NetService'
import { NodeStreamAuthority } from '../../../src/mms/net/sync/nodeAuthority'
import { SpaceProfileService } from '../../../src/mms/spaces/SpaceProfileService'
import { registerSpaceMethods,validateSpacesLocal } from '../../../src/mms/spaces/registerMethods'
import { SPACES_LOCAL_METHODS } from '../../../src/shared/spaces/local'
import { DomainHandlerRegistry } from '../../../src/mms/protocol/domainRegistry'
import { newId } from '../../../src/shared/net'
const close:Array<()=>void|Promise<void>>=[]
afterEach(async()=>{for(const dispose of close.splice(0).reverse())await dispose()})
async function profile(name:string){
  const path=realpathSync(mkdtempSync(join(tmpdir(),'spaces-local-')));close.push(()=>rmSync(path,{recursive:true,force:true}))
  let spaces!:SpaceProfileService
  const net=new NetService({profileDir:path,composeRuntime:runtime=>{
    spaces=new SpaceProfileService({runtime,net})
    return {...spaces.composition(new NodeStreamAuthority(runtime.identity,runtime.streams,runtime.blobs)),onActivated:()=>spaces.local.resume()}
  }});close.push(()=>net.shutdown())
  await net.request('net.init',{name,listen:true,host:'127.0.0.1',port:0});await net.request('net.protect',{passphrase:'local-test-protection'})
  return {path,net,spaces}
}
it('uses the real host append and durable original outbox for owner-local posts without a member join',async()=>{
  const a=await profile('Owner'),created=await a.spaces.local.request('spaces.create',{name:'Local'})
  const [first,second]=await Promise.all([a.spaces.local.request('spaces.post',{stream:created.channel,text:'first'}),a.spaces.local.request('spaces.post',{stream:created.channel,text:'second'})])
  expect(first).toMatchObject({state:'sent',position:{epoch:1,seq:1}});expect(second).toMatchObject({state:'sent',position:{epoch:1,seq:2}})
  expect(a.spaces.client.binding(created.space)).toBeUndefined()
  const page=await a.spaces.local.request('spaces.tail',{stream:created.channel})
  expect(page.records.map(r=>r.envelope.id)).toEqual([first.id,second.id]);expect(page.records.map(r=>r.envelope.body)).toEqual([{text:'first'},{text:'second'}])
  expect((await a.spaces.local.request('spaces.outbox',{stream:created.channel})).entries.map(e=>e.state)).toEqual(['sent','sent'])
  await expect(a.spaces.local.request('spaces.leave',{space:created.space})).rejects.toMatchObject({code:'forbidden'})
})
it('joins independent identities over actual TCP TLS, queues offline FIFO, and leaves with preserved readonly local history',async()=>{
  const a=await profile('Owner'),b=await profile('Member'),created=await a.spaces.local.request('spaces.create',{name:'Public'}),invite=await a.spaces.local.request('spaces.invite',{space:created.space})
  expect(await b.spaces.local.request('spaces.join',{invite:invite.invite})).toMatchObject({space:created.space,member:true,readonly:false})
  await b.spaces.local.request('spaces.channels',{space:created.space});await b.spaces.local.request('spaces.tail',{stream:created.channel})
  const first=await b.spaces.local.request('spaces.post',{stream:created.channel,text:'member first'})
  expect(first.state).toBe('sent')
  await vi.waitFor(async()=>expect((await b.spaces.local.request('spaces.tail',{stream:created.channel})).records).toHaveLength(1))
  b.spaces.client.disconnect(created.space)
  const originalResume=b.spaces.local.resume;b.spaces.local.resume=()=>{}
  const pending=await b.spaces.local.request('spaces.post',{stream:created.channel,text:'offline second'})
  expect(pending.state).toBe('pending')
  b.spaces.local.resume=originalResume
  await b.spaces.client.connect(created.space);await b.spaces.client.subscribe(created.channel)
  await vi.waitFor(()=>expect(b.net.runtime().outbox.get(pending.id)?.state).toBe('sent'))
  const leave=await b.spaces.local.request('spaces.leave',{space:created.space})
  await vi.waitFor(()=>expect(b.net.runtime().outbox.get(leave.id)?.state).toBe('sent'))
  expect(a.spaces.meta.member(created.space,b.net.runtime().identity.self()!.user)).toBeUndefined()
  await expect(b.spaces.local.request('spaces.post',{stream:created.channel,text:'fenced'})).rejects.toMatchObject({code:'not_member'})
  const retained=await b.spaces.local.request('spaces.tail',{stream:created.channel})
  expect(retained.readonly).toBe(true);expect(retained.records.map(r=>r.envelope.id)).toEqual([first.id,pending.id])
  const originalHead=b.spaces.store.head(created.channel)
  await a.spaces.local.request('spaces.post',{stream:created.channel,text:'after leave'})
  b.spaces.local.resume();await new Promise(resolve=>setTimeout(resolve,30))
  expect(b.spaces.store.head(created.channel)).toEqual(originalHead)
  expect((await b.spaces.local.request('spaces.list',{})).spaces[0]).toMatchObject({readonly:true,leave:{id:leave.id,state:'sent'}})
},30000)
it('admits exact profile-bound net.v1 local DTOs and denies extra authority, wrong profile and missing capability',async()=>{
  const id=newId('space'),stream=newId('stream'),valid:Record<string,unknown>={'spaces.create':{name:'Space'},'spaces.invite':{space:id},'spaces.join':{invite:'sj1_payload'},'spaces.list':{},'spaces.channels':{space:id},'spaces.post':{stream,text:'hello'},'spaces.tail':{stream},'spaces.members':{space:id},'spaces.leave':{space:id},'spaces.outbox':{stream}}
  for(const method of SPACES_LOCAL_METHODS){expect(validateSpacesLocal(method,valid[method])).toEqual(valid[method]);for(const extra of ['profileId','provider','path','login','capabilities','bot'])expect(()=>validateSpacesLocal(method,{...(valid[method] as object),[extra]:'no'})).toThrow()}
  for(const value of [{stream,limit:129},{stream,after:{epoch:1,seq:-1}},{stream,after:{epoch:1,seq:0,secret:true}}])expect(()=>validateSpacesLocal('spaces.tail',value)).toThrow()
  const registry=new DomainHandlerRegistry(),seen:string[]=[];registerSpaceMethods(registry,profile=>({request:async()=>{seen.push(profile);return {ok:true}}}))
  await expect(registry.dispatch({connection:{id:'c',capabilities:new Set()}} as any,'spaces.list',{})).rejects.toMatchObject({code:'profile_binding_required'})
  await expect(registry.dispatch({connection:{id:'c',binding:{profileId:'a',epoch:1},capabilities:new Set()}} as any,'spaces.list',{})).rejects.toMatchObject({code:'capability_required'})
  const context={connection:{id:'c',binding:{profileId:'a',epoch:1},capabilities:new Set(['net.v1'])}} as any
  await expect(registry.dispatch(context,'spaces.list',{profileId:'b'})).rejects.toMatchObject({code:'profile_mismatch'})
  expect(await registry.dispatch(context,'spaces.list',{})).toEqual({ok:true});expect(seen).toEqual(['a'])
})
it('bounds delivery metadata with indexed keyset pages and exact original IDs without exporting signed payloads',async()=>{
  const a=await profile('Owner'),created=await a.spaces.local.request('spaces.create',{name:'Bounded'})
  const first=await a.spaces.local.request('spaces.post',{stream:created.channel,text:'one'}),second=await a.spaces.local.request('spaces.post',{stream:created.channel,text:'two'})
  const page=await a.spaces.local.request('spaces.outbox',{stream:created.channel,limit:1})
  expect(page).toMatchObject({total:2,entries:[{id:first.id}],nextAfter:expect.any(Number)})
  const next=await a.spaces.local.request('spaces.outbox',{stream:created.channel,after:page.nextAfter!,limit:1})
  expect(next.entries.map(e=>e.id)).toEqual([second.id])
  const exact=await a.spaces.local.request('spaces.outbox',{stream:created.channel,id:first.id})
  expect(exact.entries).toEqual([first]);expect(JSON.stringify(exact)).not.toContain('envelope');expect(JSON.stringify(exact)).not.toContain('sig')
  const other=await a.spaces.local.request('spaces.channels',{space:created.space,name:'other'})
  await expect(a.spaces.local.request('spaces.outbox',{stream:other.created!,id:first.id})).rejects.toMatchObject({code:'bad_request'})
  expect(()=>validateSpacesLocal('spaces.outbox',{stream:created.channel,id:first.id,after:0})).toThrow()
  expect(()=>validateSpacesLocal('spaces.outbox',{stream:created.channel,limit:257})).toThrow()
  const plan=a.net.runtime().db.database.prepare('EXPLAIN QUERY PLAN SELECT rowid,id FROM net_outbox WHERE stream=? AND rowid>? ORDER BY rowid LIMIT ?').all(created.channel,0,1).map(row=>row.detail).join(' ')
  expect(plan).toContain('net_space_local_outbox_stream');expect(plan).toContain('rowid>')
})
it('denies private stream DTO use and all public reads/writes under an upgrade-required meta guard',async()=>{
  const a=await profile('Owner'),created=await a.spaces.local.request('spaces.create',{name:'Guarded'}),privateId=newId('stream')
  a.spaces.store.createStream({id:privateId,kind:'space.private',space:created.space,parent:created.channel,participants:[a.net.runtime().identity.self()!.user],authority:a.net.runtime().identity.self()!.node,createdAt:Date.now()},1)
  for(const method of ['spaces.tail','spaces.outbox'] as const)await expect(a.spaces.local.request(method,{stream:privateId})).rejects.toMatchObject({code:'forbidden'})
  await expect(a.spaces.local.request('spaces.post',{stream:privateId,text:'plaintext'})).rejects.toMatchObject({code:'forbidden'})
  a.spaces.meta.block(created.space,'upgradeRequired')
  for(const method of ['spaces.tail','spaces.outbox'] as const)await expect(a.spaces.local.request(method,{stream:created.channel})).rejects.toMatchObject({code:'upgrade_required'})
  await expect(a.spaces.local.request('spaces.post',{stream:created.channel,text:'denied'})).rejects.toMatchObject({code:'upgrade_required'})
  expect((await a.spaces.local.request('spaces.list',{})).spaces[0]).toMatchObject({readonly:true,error:'upgrade_required'})
})
it('keeps a pending leave fenced and requires a fresh signed join receipt before explicit reactivation',async()=>{
  const a=await profile('Owner'),b=await profile('Member'),created=await a.spaces.local.request('spaces.create',{name:'Rejoin'}),original=await a.spaces.local.request('spaces.invite',{space:created.space})
  await b.spaces.local.request('spaces.join',{invite:original.invite});await b.spaces.local.request('spaces.tail',{stream:created.channel})
  b.spaces.client.disconnect(created.space)
  const resume=b.spaces.local.resume;b.spaces.local.resume=()=>{}
  const intent=await b.spaces.local.request('spaces.leave',{space:created.space});expect(intent.state).toBe('pending')
  b.spaces.local.resume=resume
  await expect(b.spaces.local.request('spaces.join',{invite:original.invite})).rejects.toMatchObject({code:'outcome_uncertain'})
  expect((await b.spaces.local.request('spaces.list',{})).spaces[0].readonly).toBe(true)
  await vi.waitFor(()=>expect(b.net.runtime().outbox.get(intent.id)?.state).toBe('sent'))
  await expect(b.spaces.local.request('spaces.join',{invite:original.invite})).rejects.toMatchObject({code:'conflict'})
  const fresh=await a.spaces.local.request('spaces.invite',{space:created.space})
  const joined=await b.spaces.local.request('spaces.join',{invite:fresh.invite})
  expect(joined).toMatchObject({member:true,readonly:false});expect(joined.leave).toBeUndefined()
  expect((await b.spaces.local.request('spaces.post',{stream:created.channel,text:'explicit fresh membership'})).state).toBe('sent')
},30000)

it('finds a pending original beyond an already sent first delivery page without returning ciphertext or text',async()=>{
  const a=await profile('Owner'),created=await a.spaces.local.request('spaces.create',{name:'Pending metadata'})
  await a.spaces.local.request('spaces.post',{stream:created.channel,text:'sent first'})
  await a.spaces.local.request('spaces.post',{stream:created.channel,text:'sent second'})
  await vi.waitFor(()=>expect(a.spaces.local.activeCount()).toBe(0))
  const resume=a.spaces.local.resume;a.spaces.local.resume=()=>{}
  const pending=a.spaces.client.post(created.channel,'PENDING PRIVATE DISPLAY CANARY')
  const nextPending=a.spaces.client.post(created.channel,'SECOND PENDING DISPLAY CANARY')
  expect(a.net.runtime().outbox.get(pending)?.state).toBe('pending')
  const first=await a.spaces.local.request('spaces.outbox',{stream:created.channel,limit:2})
  expect(first.entries.map(entry=>entry.state)).toEqual(['sent','sent'])
  const filtered=await a.spaces.local.request('spaces.outbox',{stream:created.channel,states:['pending','unknown','failed'],limit:1})
  expect(filtered.total).toBe(2)
  expect(filtered.entries.map(entry=>entry.id)).toEqual([pending])
  const next=await a.spaces.local.request('spaces.outbox',{stream:created.channel,states:['pending','unknown','failed'],after:filtered.nextAfter!,limit:1})
  expect(next.entries.map(entry=>entry.id)).toEqual([nextPending])
  expect(JSON.stringify(filtered)).not.toContain('PENDING PRIVATE DISPLAY CANARY')
  expect(()=>validateSpacesLocal('spaces.outbox',{stream:created.channel,states:['invented']})).toThrow()
  expect(()=>validateSpacesLocal('spaces.outbox',{stream:created.channel,states:['pending','pending']})).toThrow()
  expect(()=>validateSpacesLocal('spaces.outbox',{stream:created.channel,states:[['pending']]})).toThrow()
  expect(()=>validateSpacesLocal('spaces.outbox',{stream:created.channel,id:pending,states:['pending']})).toThrow()
  a.spaces.local.resume=resume
})
