import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { NetService } from '../../../../src/mms/net/NetService'
import { NodeStreamAuthority } from '../../../../src/mms/net/sync/nodeAuthority'
import { systemClock } from '../../../../src/mms/net/clock'
import { SpaceProfileService } from '../../../../src/mms/spaces/SpaceProfileService'
import { canonicalJson, decodeEnvelope } from '../../../../src/mms/net/sync/codec'
import { newId } from '../../../../src/shared/net'

it('publishes an owner-local private aside using the actual composed authority and durable original receipts',async()=>{
  const path=mkdtempSync(join(tmpdir(),'private-owner-profile-'))
  let spaces!:SpaceProfileService
  const net=new NetService({profileDir:path,composeRuntime:runtime=>{spaces=new SpaceProfileService({runtime,net});return spaces.composition(new NodeStreamAuthority(runtime.identity,spaces.store,runtime.blobs,systemClock))}})
  try{
    await net.request('net.init',{listen:true});await net.request('net.protect',{passphrase:'owner-private-test'})
    const space=spaces.host.create({name:'Owner local aside'}),channel=spaces.host.createChannel(space.space,'general'),self=net.runtime().identity.self()!
    const prepared=spaces.private.prepareCreation(space.space,channel,[self.user])
    const substitute={...decodeEnvelope(prepared.parentEvent.envelope).envelope,id:newId('event')},bytes=canonicalJson(substitute)
    expect(()=>spaces.host.appendLocal(channel,substitute.id,bytes,net.runtime().keys.signAsNode(bytes))).toThrow(expect.objectContaining({code:'forbidden'}))
    expect(spaces.store.head(channel).seq).toBe(0)
    spaces.host.appendLocal(channel,prepared.parentEvent.id,prepared.parentEvent.envelope,prepared.parentEvent.sig)
    const otherControl=spaces.private.signControl(prepared.descriptor.id,decodeEnvelope(prepared.event.envelope).envelope.body as Parameters<typeof spaces.private.signControl>[1])
    expect(()=>spaces.host.appendLocal(prepared.descriptor.id,otherControl.id,otherControl.envelope,otherControl.sig)).toThrow(expect.objectContaining({code:'forbidden'}))
    expect(spaces.store.head(prepared.descriptor.id).seq).toBe(0)
    expect(spaces.private.state(prepared.descriptor.id)).toBeUndefined()
    await spaces.private.publishCreation(prepared.descriptor.id)
    expect(net.runtime().outbox.get(prepared.parentEvent.id)?.state).toBe('sent')
    expect(net.runtime().outbox.get(prepared.event.id)?.state).toBe('sent')
    expect(spaces.store.getById(prepared.descriptor.id,prepared.event.id)?.seq).toBe(1)
    expect(spaces.private.state(prepared.descriptor.id)?.control.participants).toEqual([self.user])
  }finally{await net.shutdown();rmSync(path,{recursive:true,force:true})}
},10000)
