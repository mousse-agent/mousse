import { createHash,randomUUID } from 'node:crypto'
import { afterEach,expect,it } from 'vitest'
import { BotLocalService } from '../../../../src/mms/bots/BotLocalService'
import { BotProfileService } from '../../../../src/mms/bots/BotProfileService'
import { PrivateSpaceService } from '../../../../src/mms/spaces/private'
import { SqlPrivateStreamKeys } from '../../../../src/mms/net/identity'
import { ProjectManager } from '../../../../src/mms/data/ProjectManager'
import { ThreadDataStore } from '../../../../src/mms/data/ThreadDataStore'
import { canonicalJson,decodeEnvelope } from '../../../../src/mms/net/sync/codec'
import { cleanup,disposers,peer } from '../../spaces/host/helpers'
import { setup } from '../admission/helpers'
import { NetError,newId } from '../../../../src/shared/net'

afterEach(cleanup)
function configuration(row:import('../../../../src/mms/bots/registry').LocalBot){return{space:row.space,bot:row.bot,adapter:row.adapter,profile:row.profile,definitionRevision:row.definitionRevision,profileDigest:row.profileDigest,dailyBudgetUnits:row.dailyBudgetUnits,runCeilingUnits:row.runCeilingUnits,maxConcurrent:row.maxConcurrent,runsPerMemberHour:row.runsPerMemberHour,...(row.projectId?{projectId:row.projectId}:{})}}
async function fixture(){
  const f=await setup(),self=peer(f.p),projects=new ProjectManager(f.p.path),threads=new ThreadDataStore(projects,f.p.path,{profileId:'profile-a',allowLegacyProjectData:false})
  projects.setThreadStore(threads)
  const privateKeys=new SqlPrivateStreamKeys({database:f.p.db.database,keys:f.p.keys,node:self.node,user:self.user,spaceForStream:stream=>f.p.store.getStream(stream)!.space!,transaction:work=>f.p.db.transaction(work)})
  const privateService=new PrivateSpaceService({db:f.p.db,identity:f.p.identity,keys:f.p.keys,privateKeys,store:f.p.store,meta:f.p.projection,outbox:f.outbox,clock:f.p.clock})
  let block=false
  const flush=async()=>{for(const descriptor of f.p.store.listStreams({space:f.space.space}))for(const entry of f.outbox.due(descriptor.id)){
    if(privateService.isPrepared(entry.id))continue
    f.outbox.markAttempt(entry.id)
    if(block)throw new NetError('peer_offline')
    const position=f.p.store.appendAsAuthority(entry.stream,{...entry,recvTs:f.p.clock.now()});f.outbox.markSent(entry.id,position)
  }}
  const bots=new BotProfileService({profileId:'profile-a',profileHome:f.p.path,installationHome:f.p.path,runtime:{db:f.p.db,keys:f.p.keys,identity:f.p.identity,executions:f.executions,budgets:f.budgets,outbox:f.outbox},spaces:{store:f.p.store,meta:f.p.projection,private:privateService,host:f.p.host,session:()=>undefined,appendSigned:async()=>{throw new NetError('forbidden')},flush},projects,threads,trustedQaAdapters:f.adapters})
  disposers.push(()=>bots.close())
  return{...f,bots,local:new BotLocalService(bots),projects,privateService,self,flush,setBlocked(value:boolean){block=value}}
}
it('pages real owner configurations and independently denies production qualification and foreign project IDs',async()=>{
  const f=await fixture(),second=f.p.host.create({name:'Second registered placement'}),root=f.p.keys.rootKey()!,roster=f.p.identity.verifySigned<import('../../../../src/shared/net').Roster>(f.p.identity.roster()!,root)
  f.p.host.postMeta(second.space,'bot.added',{record:{bot:f.bot,owner:f.self.user,delegation:roster.bots[0],displayName:'Fixture',profile:'chat',policy:{steer:{kind:'everyone'},visibility:'public'}}})
  const original=configuration(f.registry.get(f.space.space,f.bot)!)
  await f.local.request('bots.configure',{...original,space:second.space,adapter:'mousse'})
  const first=await f.local.request('bots.list',{limit:1}),next=await f.local.request('bots.list',{limit:1,after:first.nextAfter})
  expect(first.bots).toHaveLength(1);expect(next.bots).toHaveLength(1);expect(new Set([...first.bots,...next.bots].map(row=>row.space))).toEqual(new Set([f.space.space,second.space]));expect(next.nextAfter).toBeUndefined()
  await expect(f.local.request('bots.qualify',{space:second.space,bot:f.bot,definitionRevision:original.definitionRevision,profileDigest:original.profileDigest})).rejects.toMatchObject({code:'profile_unsupported'})
  expect(f.bots.registry.get(second.space,f.bot)?.qualified).toBe(false)
  await expect(f.local.request('bots.configure',{...original,profile:'reader',projectId:randomUUID()})).rejects.toMatchObject({code:'forbidden'})
  await expect(f.local.request('bots.stop',{space:second.space,bot:newId('bot')})).rejects.toMatchObject({code:'forbidden'})
  await f.local.request('bots.stop',{space:second.space,bot:f.bot});expect(f.bots.registry.get(second.space,f.bot)?.stopped).toBe(true)
  await f.local.request('bots.resume',{space:second.space,bot:f.bot});expect(f.bots.registry.get(second.space,f.bot)).toMatchObject({stopped:false,qualified:false})
  await expect(f.local.request('bots.presence',{space:second.space,bot:f.bot,stream:f.parent})).rejects.toMatchObject({code:'forbidden'})
})
it('returns an original unknown private decision and later its genuine stored ACK without signing a replacement',async()=>{
  const f=await fixture(),input=f.message();await f.bots.refresh(f.space.space)
  const record=f.bots.admission.admit(input).record
  f.executions.transition(record.id,'running',f.p.clock.now());await f.flush()
  const created=f.privateService.prepareCreation(f.space.space,f.parent,[f.self.user,f.bot])
  const opening=f.p.store.appendAsAuthority(f.parent,{...created.parentEvent,recvTs:f.p.clock.now()}),control=f.p.store.appendAsAuthority(created.descriptor.id,{...created.event,recvTs:f.p.clock.now()})
  expect(opening.seq).toBeGreaterThan(0);f.privateService.applyStored(created.descriptor,{...created.event,...control},'live')
  f.p.db.transaction(()=>{f.p.db.charge(1);f.p.db.database.prepare('INSERT INTO net_bot_profile_plans VALUES(?,?,?,?,?)').run(f.space.space,f.bot,record.trigger,'permission',created.descriptor.id)})
  const hash=(value:unknown)=>createHash('sha256').update(canonicalJson(value)).digest('base64url'),argumentDigest=hash({read:'owned fixture'}),binding={stream:record.binding!.stream,compartment:record.binding!.compartment},abort=new AbortController()
  const pending=f.bots.permissions.port(record.id,abort.signal).requestAction({tool:'safe_read',argumentDigest,actionHash:hash({execution:record.id,tool:'safe_read',argumentDigest,profileDigest:record.binding!.profileDigest,binding})});pending.catch(()=>{})
  try{
    await f.bots.drain()
    const request=f.outbox.list(created.descriptor.id).find(entry=>decodeEnvelope(entry.envelope).envelope.type==='bot.permission.requested')!
    expect(request.state).toBe('sent');f.setBlocked(true)
    const unknown=await f.local.request('bots.grant',{stream:request.stream,request:request.id,approved:true})
    expect(unknown.state).toBe('unknown');expect(unknown.position).toBeUndefined()
    const original=f.outbox.get(unknown.id)!,env=decodeEnvelope(original.envelope).envelope
    expect(env.sealed).toBeDefined();expect(env.body).toBeUndefined();expect(f.p.identity.verifyAuthor(env.author,original.envelope,original.sig,env.ts,'newWork').user).toBe(f.self.user)
    await expect(f.local.request('bots.grant',{stream:request.stream,request:request.id,approved:false})).rejects.toMatchObject({code:'conflict'})
    f.setBlocked(false)
    const ack=await f.local.request('bots.grant',{stream:request.stream,request:request.id,approved:true})
    expect(ack).toMatchObject({id:unknown.id,state:'sent'});expect(ack.position).toBeDefined()
    expect(f.outbox.get(ack.id)!.envelope).toEqual(original.envelope);expect(f.outbox.get(ack.id)!.sig).toEqual(original.sig)
    const stored=f.p.store.getById(request.stream,ack.id)!;f.bots.permissions.receive(request.stream,stored)
    expect(await pending).toMatchObject({decision:'approved',approval:ack.id})
  }finally{abort.abort();await pending.catch(()=>{})}
})
