import { createHash } from 'node:crypto'
import { afterEach, expect, it } from 'vitest'
import { BotOutbox, BotRecordAuthorization } from '../../../../src/mms/bots/admission'
import { SqlPrivateStreamKeys } from '../../../../src/mms/net/identity'
import { NetSyncSession } from '../../../../src/mms/net/sync/session'
import { canonicalJson, decodeEnvelope } from '../../../../src/mms/net/sync/codec'
import { SpaceHostService } from '../../../../src/mms/spaces/host'
import { PrivateSpaceService, privateContentAAD } from '../../../../src/mms/spaces/private/service'
import { newId } from '../../../../src/shared/net'
import { setup } from '../../bots/admission/helpers'
import { channels, cleanup, disposers, peer } from '../host/helpers'

afterEach(cleanup)
it('registers exact private execution bindings atomically through the real authority, with multiple runs on one aside',async()=>{
  const f=await setup(),self=peer(f.p)
  const privateKeys=new SqlPrivateStreamKeys({database:f.p.db.database,keys:f.p.keys,node:self.node,user:self.user,spaceForStream:stream=>f.p.store.getStream(stream)!.space!,transaction:work=>f.p.db.transaction(work)})
  const privateService=new PrivateSpaceService({db:f.p.db,identity:f.p.identity,keys:f.p.keys,privateKeys,store:f.p.store,meta:f.p.projection,outbox:f.outbox,clock:f.p.clock})
  const created=privateService.prepareCreation(f.space.space,f.parent,[self.user,f.bot]),control=f.p.store.appendAsAuthority(created.descriptor.id,{...created.event,recvTs:f.p.clock.now()})
  privateService.applyStored(created.descriptor,{...created.event,...control},'live')
  f.p.host.postMeta(f.space.space,'bot.policyChanged',{bot:f.bot,policy:{steer:{kind:'everyone'},visibility:'private'}})
  let authority!:SpaceHostService
  const gate=new BotRecordAuthorization({identity:f.p.identity,meta:f.p.projection,store:f.p.store,private:privateService,binding:(space,execution)=>authority.executionBinding(space,execution)})
  privateService.options.canBotWrite=(...args)=>gate.canWrite(...args)
  privateService.options.validateExecutionReferences=(...args)=>gate.verifyExecutionReferences(...args)
  authority=new SpaceHostService({...f.p.host.options,privateAuthorization:privateService,botAuthorization:gate})
  const original=f.service.options.output as BotOutbox
  const output=new BotOutbox({...original.options,private:privateService,privateKeys,plan:mention=>({...original.plan(mention),stream:created.descriptor.id,compartment:f.compartments.privateId(f.bot,created.descriptor.id,1),visibilityEpoch:1,participantHash:createHash('sha256').update(canonicalJson(privateService.state(created.descriptor.id)!.control.participants)).digest('base64url')})})
  f.service.options.output=output;f.service.options.private=privateService
  const tls=await channels(f.p,f.p),server=new NetSyncSession({channel:tls.server,identity:f.p.identity,store:f.p.store,authority,clock:f.p.clock}),client=new NetSyncSession({channel:tls.client,identity:f.p.identity,store:f.p.store,clock:f.p.clock})
  disposers.push(()=>server.close(),()=>client.close());await Promise.all([server.opened,client.opened])
  const first=f.service.admit(f.message()).record,accepted=f.outbox.list(created.descriptor.id).find(entry=>decodeEnvelope(entry.envelope).envelope.refs?.execution===first.id)!
  f.setFault('spaces.private.botBinding.beforeCommit')
  await expect(client.append(accepted.stream,accepted.id,accepted.envelope,accepted.sig)).rejects.toMatchObject({code:'cancelled'})
  expect(authority.executionBinding(f.space.space,first.id)).toBeUndefined()
  expect(f.p.store.getById(accepted.stream,accepted.id)).toBeUndefined()
  f.setFault('')
  expect(await client.append(accepted.stream,accepted.id,accepted.envelope,accepted.sig)).toMatchObject({epoch:1,seq:2})
  const replacement={...decodeEnvelope(accepted.envelope).envelope,id:newId('event')};delete replacement.sealed
  replacement.sealed=privateKeys.seal(replacement.stream,canonicalJson({title:'Private bot run'}),privateContentAAD(replacement))
  const replacementBytes=canonicalJson(replacement)
  await expect(client.append(replacement.stream,replacement.id,replacementBytes,f.p.keys.signAsBot(f.bot,replacementBytes))).rejects.toMatchObject({code:'conflict'})
  const secondClaim={...replacement,id:newId('event'),refs:{...replacement.refs!,execution:newId('execution')}};delete secondClaim.sealed
  secondClaim.sealed=privateKeys.seal(secondClaim.stream,canonicalJson({title:'Private bot run'}),privateContentAAD(secondClaim))
  const secondClaimBytes=canonicalJson(secondClaim)
  await expect(client.append(secondClaim.stream,secondClaim.id,secondClaimBytes,f.p.keys.signAsBot(f.bot,secondClaimBytes))).rejects.toMatchObject({code:'conflict'})
  expect(f.p.store.head(created.descriptor.id).seq).toBe(2)
  const binding=authority.executionBinding(f.space.space,first.id)!
  expect(binding).toMatchObject({stream:created.descriptor.id,execution:first.id,trigger:first.trigger,visibilityEpoch:1,participantHash:first.binding!.participantHash})
  expect(await client.append(accepted.stream,accepted.id,accepted.envelope,accepted.sig)).toMatchObject({epoch:1,seq:2})
  const progress=output.prepareTerminal(f.service.mentionForExecution(first.id),first.id,first.binding!,'bot.run.progress',{text:'Private progress'})
  expect(await client.append(progress.stream,progress.id,progress.envelope,progress.sig)).toMatchObject({epoch:1,seq:3})
  const second=f.service.admit(f.message()).record,secondAccepted=f.outbox.list(created.descriptor.id).find(entry=>decodeEnvelope(entry.envelope).envelope.refs?.execution===second.id)!
  expect(await client.append(secondAccepted.stream,secondAccepted.id,secondAccepted.envelope,secondAccepted.sig)).toMatchObject({epoch:1,seq:4})
  expect(authority.executionBinding(f.space.space,first.id)).toEqual(binding)
  expect(authority.executionBinding(f.space.space,second.id)?.trigger).toBe(second.trigger)
})
