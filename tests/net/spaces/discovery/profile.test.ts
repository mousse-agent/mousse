import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { NetService } from '../../../../src/mms/net/NetService'
import { NodeStreamAuthority } from '../../../../src/mms/net/sync/nodeAuthority'
import { systemClock } from '../../../../src/mms/net/clock'
import { SpaceProfileService } from '../../../../src/mms/spaces/SpaceProfileService'
import { SpaceCurrentIdentity } from '../../../../src/mms/spaces/SpaceCurrentIdentity'
import { newId } from '../../../../src/shared/net'
import { decodeEnvelope } from '../../../../src/mms/net/sync/codec'
const cleanup:Array<()=>void|Promise<void>>=[]
afterEach(async()=>{for(const close of cleanup.splice(0).reverse())await close()})
function profile(){
 const path=mkdtempSync(join(tmpdir(),'space-discovery-'));let spaces!:SpaceProfileService
 const net=new NetService({profileDir:path,composeRuntime:runtime=>{spaces=new SpaceProfileService({runtime,net});const current=new SpaceCurrentIdentity({runtime,store:spaces.store,meta:spaces.meta,host:spaces.host,session:space=>spaces.session(space)});spaces.options.spaceIdentity=current.source;return spaces.composition(new NodeStreamAuthority(runtime.identity,spaces.store,runtime.blobs,systemClock))}})
 cleanup.push(()=>rmSync(path,{recursive:true,force:true}),()=>net.shutdown());return{net,get spaces(){return spaces}}
}
it('discovers and subscribes an actual separately authenticated private recipient through its committed opening and full signed controls over direct TLS',async()=>{
 const host=profile(),member=profile();for(const p of[host,member]){await p.net.request('net.init',{listen:true});await p.net.request('net.protect',{passphrase:'discovery-fixture'})}
 const space=host.spaces.host.create({name:'Private discovery'}),channel=host.spaces.host.createChannel(space.space,'general')
 await member.spaces.client.join(member.spaces.client.prepareJoin(host.spaces.host.invite(space.space).text));await member.spaces.client.connect(space.space)
 const owner=host.net.runtime().identity.self()!,recipient=member.net.runtime().identity.self()!,created=host.spaces.private.prepareCreation(space.space,channel,[owner.user,recipient.user]);await host.spaces.private.publishCreation(created.descriptor.id)
 await member.spaces.client.subscribe(channel)
 const opening=member.spaces.store.getById(channel,created.parentEvent.id)!;expect((decodeEnvelope(opening.envelope).envelope.body as{stream:string}).stream).toBe(created.descriptor.id)
 expect(host.spaces.private.state(created.descriptor.id)!.control.wrapped.some(w=>w.node===recipient.node&&w.recipientAgreementKey===member.net.runtime().keys.nodeKeys().agree)).toBe(true)
 expect(member.spaces.store.getStream(created.descriptor.id)).toBeUndefined();expect(member.spaces.private.state(created.descriptor.id)).toBeUndefined()
 await expect(member.spaces.client.subscribe(created.descriptor.id)).rejects.toMatchObject({code:'stream_unknown'})
 await member.spaces.discover(space.space,created.descriptor.id)
 expect(member.spaces.private.state(created.descriptor.id)?.control.keyEpoch).toBe(1)
 await member.spaces.client.subscribe(created.descriptor.id)
 const message=member.spaces.client.post(created.descriptor.id,'Actual discovery private message');await member.spaces.client.flush(space.space)
 expect(member.net.runtime().outbox.get(message)?.state).toBe('sent');expect(host.spaces.store.getById(created.descriptor.id,message)).toBeDefined()
},15000)

it('queries a current third-member roster only through a scoped authority TLS proof and rejects stale/cross-Space/absent contexts without global adoption',async()=>{
 const host=profile(),member=profile(),third=profile();for(const p of[host,member,third]){await p.net.request('net.init',{listen:true});await p.net.request('net.protect',{passphrase:'discovery-fixture'})}
 const space=host.spaces.host.create({name:'Current member wire'}),channel=host.spaces.host.createChannel(space.space,'general')
 for(const p of[member,third])await p.spaces.client.join(p.spaces.client.prepareJoin(host.spaces.host.invite(space.space).text))
 await member.spaces.client.connect(space.space)
 const target=third.net.runtime().identity.self()!.user,identity=member.net.runtime().identity,before=member.net.runtime().db.database.prepare('SELECT value FROM net_identity_state').get()!.value,session=member.spaces.session(space.space)!,head=member.spaces.meta.state(space.space)!.applied
 expect(identity.roster(target)).toBeUndefined()
 const signed=await session.spaceIdentity!(space.space,target,head)
 expect(host.net.runtime().identity.verifySigned<{owner:string}>(signed,third.net.runtime().keys.rootKey()!).owner).toBe(target)
 expect(member.net.runtime().db.database.prepare('SELECT value FROM net_identity_state').get()!.value).toBe(before)
 expect(identity.roster(target)).toBeUndefined();expect(identity.pinnedRootKey(target)).toBeUndefined()
 await expect(session.spaceIdentity!(space.space,target,{...head,seq:head.seq-1})).rejects.toMatchObject({code:'meta_stale'})
 await expect(session.spaceIdentity!(newId('space'),target,head)).rejects.toMatchObject({code:'forbidden'})
 await expect(session.spaceIdentity!(space.space,newId('user'),head)).rejects.toMatchObject({code:'bad_delegation'})
 const abort=new AbortController();abort.abort();expect(()=>session.spaceIdentity!(space.space,target,head,{signal:abort.signal})).toThrow(expect.objectContaining({code:'cancelled'}))
 expect(()=>session.rpc('projects.list',{},{id:newId('rpc'),deadlineMs:1000})).toThrow(expect.objectContaining({code:'forbidden'}))
 expect(()=>session.rpcResult(newId('rpc'),{deadlineMs:1000})).toThrow(expect.objectContaining({code:'forbidden'}))
 expect(()=>session.rpcCancel(newId('rpc'))).toThrow(expect.objectContaining({code:'forbidden'}))
 const message=member.spaces.client.post(channel,'After rejected queries');await member.spaces.client.flush(space.space);expect(host.spaces.store.getById(channel,message)).toBeDefined()
},20000)
