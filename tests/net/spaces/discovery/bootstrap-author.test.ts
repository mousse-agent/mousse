import { afterEach, expect, it } from 'vitest'
import {decodeEnvelope} from '../../../../src/mms/net/sync/codec'
import {newId} from '../../../../src/shared/net'
import {profile,cleanup} from './profile'
afterEach(async()=>{for(const close of cleanup.splice(0).reverse())await close()})
it('invokes scoped UNKNOWN-child history verification only after the exact committed parent and rejects a mismatched verified author before adoption',async()=>{
 const host=profile(),member=profile();for(const p of[host,member]){await p.net.request('net.init',{listen:true});await p.net.request('net.protect',{passphrase:'scoped-author-fixture'})}
 const space=host.spaces.host.create({name:'Bootstrap author boundary'}),channel=host.spaces.host.createChannel(space.space,'general');await member.spaces.client.join(member.spaces.client.prepareJoin(host.spaces.host.invite(space.space).text));await member.spaces.client.connect(space.space)
 const created=host.spaces.private.prepareCreation(space.space,channel,[host.net.runtime().identity.self()!.user,member.net.runtime().identity.self()!.user]);await host.spaces.private.publishCreation(created.descriptor.id);await member.spaces.client.subscribe(channel)
 const proof=await member.spaces.session(space.space)!.discoverSpaceStream!(space.space,created.descriptor.id,member.spaces.meta.state(space.space)!.applied),input={descriptor:proof.descriptor,controllerEvent:proof.controllerEvents[0],parentOpenEvent:proof.parentOpenEvent};let calls=0
 const verify=(descriptor:typeof proof.descriptor,record:typeof input.controllerEvent)=>{calls++;expect(descriptor.id).toBe(created.descriptor.id);expect(member.spaces.store.getStream(descriptor.id)).toBeUndefined();const envelope=decodeEnvelope(record.envelope).envelope;return member.spaces.client.options.identity.verifyAuthor(envelope.author,record.envelope,record.sig,envelope.ts,'history')}
 member.spaces.private.options.verifyBootstrapAuthor=(descriptor,record)=>verify(descriptor,{...input.controllerEvent,...record})
 const damaged={...input.parentOpenEvent,sig:new Uint8Array(input.parentOpenEvent.sig)};damaged.sig[0]^=1
 expect(()=>member.spaces.private.validateCreation({...input,parentOpenEvent:damaged},'history')).toThrow(expect.objectContaining({code:'forbidden'}));expect(calls).toBe(0)
 expect(()=>member.spaces.private.validateCreation({...input,parentOpenEvent:{...input.parentOpenEvent,recvTs:input.parentOpenEvent.recvTs+1}},'history')).toThrow(expect.objectContaining({code:'forbidden'}));expect(calls).toBe(0)
 expect(()=>member.spaces.private.validateCreation({...input,descriptor:{...input.descriptor,space:newId('space')}},'history')).toThrow();expect(calls).toBe(0)
 member.spaces.private.options.verifyBootstrapAuthor=(descriptor,record)=>({...verify(descriptor,{...input.controllerEvent,...record}),user:member.net.runtime().identity.self()!.user})
 expect(()=>member.spaces.private.validateCreation(input,'history')).toThrow(expect.objectContaining({code:'bad_delegation'}));expect(member.spaces.store.getStream(created.descriptor.id)).toBeUndefined()
 member.spaces.private.options.verifyBootstrapAuthor=(descriptor,record)=>verify(descriptor,{...input.controllerEvent,...record})
 expect(member.spaces.private.validateCreation(input,'history').keyEpoch).toBe(1);expect(member.spaces.store.getStream(created.descriptor.id)).toBeUndefined()
 await member.spaces.discover(space.space,created.descriptor.id);expect(member.spaces.private.state(created.descriptor.id)?.control.keyEpoch).toBe(1)
},15000)
