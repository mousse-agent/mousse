import { afterEach, expect, it, vi } from 'vitest'
import { newId } from '../../../../src/shared/net'
import { decodeEnvelope } from '../../../../src/mms/net/sync/codec'
import {profile,cleanup} from './profile'
import {systemClock} from '../../../../src/mms/net/clock'
afterEach(async()=>{for(const close of cleanup.splice(0).reverse())await close()})
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

it('discovers signed controls containing a foreign member bot without globally pinning that owner',async()=>{
 const host=profile(),executor=profile(),fresh=profile();for(const p of[host,executor,fresh]){await p.net.request('net.init',{listen:true});await p.net.request('net.protect',{passphrase:'discovery-fixture'})}
 const space=host.spaces.host.create({name:'Foreign bot controls'}),channel=host.spaces.host.createChannel(space.space,'general')
 await executor.spaces.client.join(executor.spaces.client.prepareJoin(host.spaces.host.invite(space.space).text));await executor.spaces.client.connect(space.space)
 const rt=executor.net.runtime(),self=rt.identity.self()!,bot=newId('bot'),key=rt.keys.createBotKey(bot),delegation=rt.identity.issueBotDelegation({bot,key,name:'Foreign participant',hostNode:self.node})
 await vi.waitFor(()=>expect(JSON.parse(Buffer.from(host.net.runtime().identity.roster(self.user)!.payload,'base64url').toString()).bots).toHaveLength(1))
 executor.spaces.client.queue(space.meta,'bot.added',{record:{bot,owner:self.user,delegation,displayName:'Foreign',profile:'chat',policy:{steer:{kind:'everyone'},visibility:'private'}}});await executor.spaces.client.flush(space.space)
 await fresh.spaces.client.join(fresh.spaces.client.prepareJoin(host.spaces.host.invite(space.space).text));await fresh.spaces.client.connect(space.space)
 const owner=host.net.runtime().identity.self()!,recipient=fresh.net.runtime().identity.self()!,created=host.spaces.private.prepareCreation(space.space,channel,[owner.user,recipient.user,self.user,bot]);await host.spaces.private.publishCreation(created.descriptor.id);await fresh.spaces.client.subscribe(channel)
 expect(fresh.net.runtime().identity.pinnedRootKey(self.user)).toBeUndefined()
 const proof=await fresh.spaces.session(space.space)!.discoverSpaceStream!(space.space,created.descriptor.id,fresh.spaces.meta.state(space.space)!.applied),input={descriptor:proof.descriptor,controllerEvent:proof.controllerEvents[0],parentOpenEvent:proof.parentOpenEvent},historical=fresh.spaces.private.options.rosterAt!
 fresh.spaces.private.options.rosterAt=(space,user,at,root)=>user===self.user?undefined:historical(space,user,at,root)
 expect(()=>fresh.spaces.private.validateCreation(input,'history')).toThrow(expect.objectContaining({code:'meta_stale'}));fresh.spaces.private.options.rosterAt=historical
 expect(()=>fresh.net.runtime().db.transaction(()=>{fresh.net.runtime().identity.pinUser(self.user,host.net.runtime().keys.rootKey()!);fresh.spaces.private.validateCreation(input,'history')})).toThrow(expect.objectContaining({code:'bad_delegation'}))
 expect(fresh.net.runtime().identity.pinnedRootKey(self.user)).toBeUndefined();expect(fresh.spaces.private.state(created.descriptor.id)).toBeUndefined()
 await fresh.spaces.discover(space.space,created.descriptor.id)
 expect(fresh.spaces.private.state(created.descriptor.id)?.control.participants).toContain(bot)
 expect(fresh.net.runtime().identity.pinnedRootKey(self.user)).toBeUndefined()
 await fresh.spaces.client.subscribe(created.descriptor.id)
 const message=host.spaces.client.post(created.descriptor.id,'Foreign audience historical plaintext');await host.spaces.flush(space.space)
 await vi.waitFor(()=>expect(fresh.spaces.store.getById(created.descriptor.id,message)).toBeDefined())
 expect(fresh.spaces.private.open(created.descriptor.id,fresh.spaces.store.getById(created.descriptor.id,message)!)).toEqual({text:'Foreign audience historical plaintext'})
 // Historical evidence gives display/decryption authority only; the separately reviewed CURRENT audience path is still required for writes.
 expect(()=>fresh.spaces.private.seal(created.descriptor.id,'message.posted',{text:'Requires current participant proof'})).toThrow(expect.objectContaining({code:'meta_stale'}))
 const follower=profile(),invite=await executor.net.request('bridge.invite',{}) as{invite:string};await follower.net.request('bridge.join',{invite:invite.invite,name:'Foreign new participant node'})
 await vi.waitFor(()=>expect(JSON.parse(Buffer.from(host.net.runtime().identity.roster(self.user)!.payload,'base64url').toString()).nodes).toHaveLength(2))
 const failures:string[]=[];fresh.spaces.session(space.space)!.onClosed(error=>{if(error&&'code'in error)failures.push(String(error.code))})
 host.spaces.private.rewrap(created.descriptor.id,follower.net.runtime().identity.self()!.node);await host.spaces.flush(space.space)
 await vi.waitFor(()=>expect(fresh.spaces.private.state(created.descriptor.id)?.control.wrapped.some(w=>w.node===follower.net.runtime().identity.self()!.node)).toBe(true),{timeout:2000});expect(failures).toEqual([])
},20000)

it('rejects an authenticated Space member outside the private audience and rejects cached discovery after removal and cross-Space substitution',async()=>{
 const host=profile(),member=profile(),outsider=profile();for(const p of[host,member,outsider]){await p.net.request('net.init',{listen:true});await p.net.request('net.protect',{passphrase:'discovery-fixture'})}
 const space=host.spaces.host.create({name:'Discovery ACL'}),other=host.spaces.host.create({name:'Other Space'}),channel=host.spaces.host.createChannel(space.space,'general')
 for(const p of[member,outsider]){await p.spaces.client.join(p.spaces.client.prepareJoin(host.spaces.host.invite(space.space).text));await p.spaces.client.connect(space.space)}
 const owner=host.net.runtime().identity.self()!,recipient=member.net.runtime().identity.self()!,created=host.spaces.private.prepareCreation(space.space,channel,[owner.user,recipient.user]);await host.spaces.private.publishCreation(created.descriptor.id)
 for(const p of[member,outsider])await p.spaces.client.subscribe(channel)
 await expect(outsider.spaces.discover(space.space,created.descriptor.id)).rejects.toMatchObject({code:'forbidden'});expect(outsider.spaces.store.getStream(created.descriptor.id)).toBeUndefined()
 const session=member.spaces.session(space.space)!,head=member.spaces.meta.state(space.space)!.applied
 await expect(session.discoverSpaceStream!(other.space,created.descriptor.id,head)).rejects.toMatchObject({code:'meta_stale'})
 await member.spaces.discover(space.space,created.descriptor.id)
 const oldProof=await session.discoverSpaceStream!(space.space,created.descriptor.id,head)
 host.spaces.private.rotate(created.descriptor.id,[owner.user]);await host.spaces.flush(space.space)
 await expect(member.spaces.discover(space.space,created.descriptor.id)).rejects.toMatchObject({code:'forbidden'})
 // Local retained proof remains display history, while actual current source denies subscription/access.
 await expect(member.spaces.client.subscribe(created.descriptor.id)).rejects.toMatchObject({code:'route_unreachable'})
 expect(oldProof.controllerEvents).toHaveLength(1)
},20000)

it('bounds outstanding proofs and frees every aborted slot on an actual authenticated connection',async()=>{
 const host=profile(),member=profile();for(const p of[host,member]){await p.net.request('net.init',{listen:true});await p.net.request('net.protect',{passphrase:'discovery-fixture'})}
 const space=host.spaces.host.create({name:'Proof cancellation'});await member.spaces.client.join(member.spaces.client.prepareJoin(host.spaces.host.invite(space.space).text));await member.spaces.client.connect(space.space)
 const session=member.spaces.session(space.space)!,user=host.net.runtime().identity.self()!.user,head=member.spaces.meta.state(space.space)!.applied,controllers=Array.from({length:8},()=>new AbortController()),pending=controllers.map(controller=>session.spaceIdentity!(space.space,user,head,{signal:controller.signal}))
 expect(()=>session.spaceIdentity!(space.space,user,head)).toThrow(expect.objectContaining({code:'rate_limited'}))
 for(const controller of controllers)controller.abort()
 const results=await Promise.allSettled(pending);expect(results.every(result=>result.status==='rejected'&&result.reason.code==='cancelled')).toBe(true)
 expect(await session.spaceIdentity!(space.space,user,head)).toEqual(host.net.runtime().identity.roster())
 const late=session.spaceIdentity!(space.space,user,head);session.close();await expect(late).rejects.toMatchObject({code:'cancelled'})
},15000)

it('revalidates the real current authority head after an asynchronous boundary before emitting a roster proof',async()=>{
 const host=profile(),member=profile();for(const p of[host,member]){await p.net.request('net.init',{listen:true});await p.net.request('net.protect',{passphrase:'discovery-fixture'})}
 const space=host.spaces.host.create({name:'Proof current boundary'});await member.spaces.client.join(member.spaces.client.prepareJoin(host.spaces.host.invite(space.space).text));await member.spaces.client.connect(space.space)
 const original=host.current.source.get;host.current.source.get=(request,peer)=>{const roster=original(request,peer);queueMicrotask(()=>host.spaces.host.createChannel(space.space,'Changed while proof pending'));return roster}
 const session=member.spaces.session(space.space)!,user=host.net.runtime().identity.self()!.user,head=member.spaces.meta.state(space.space)!.applied
 await expect(session.spaceIdentity!(space.space,user,head)).rejects.toMatchObject({code:'meta_stale'})
 expect(member.net.runtime().db.database.prepare('SELECT count(*) AS n FROM net_space_current_identity').get()!.n).toBe(0)
},15000)

it('refuses an actual oversized control chain rather than installing a truncated private proof',async()=>{
 let elapsed=0;const clock={...systemClock,now:()=>systemClock.now()+elapsed,monotonic:()=>systemClock.monotonic()+elapsed};const host=profile(clock),member=profile();for(const p of[host,member]){await p.net.request('net.init',{listen:true});await p.net.request('net.protect',{passphrase:'discovery-fixture'})}
 const space=host.spaces.host.create({name:'Bounded controls'}),channel=host.spaces.host.createChannel(space.space,'general');await member.spaces.client.join(member.spaces.client.prepareJoin(host.spaces.host.invite(space.space).text));await member.spaces.client.connect(space.space)
 const audience=[host.net.runtime().identity.self()!.user,member.net.runtime().identity.self()!.user],created=host.spaces.private.prepareCreation(space.space,channel,audience);await host.spaces.private.publishCreation(created.descriptor.id);await member.spaces.client.subscribe(channel)
 for(let count=1;count<65;count++){elapsed+=1100;const rotation=host.spaces.private.rotate(created.descriptor.id,audience);await host.spaces.flush(space.space);expect(host.net.runtime().outbox.get(rotation.id),`rotation ${count}`).toMatchObject({state:'sent'});expect(host.spaces.private.state(created.descriptor.id)?.control.keyEpoch).toBe(count+1)}
 expect(host.spaces.private.state(created.descriptor.id)?.control.keyEpoch).toBe(65)
 await expect(member.spaces.discover(space.space,created.descriptor.id)).rejects.toMatchObject({code:'too_large'})
 expect(member.spaces.store.getStream(created.descriptor.id)).toBeUndefined();expect(member.spaces.private.state(created.descriptor.id)).toBeUndefined()
},30000)

it('requires an exact self-wrap for a real newly enrolled node of an existing participant before discovery',async()=>{
 const host=profile(),member=profile(),follower=profile();for(const p of[host,member]){await p.net.request('net.init',{listen:true});await p.net.request('net.protect',{passphrase:'discovery-fixture'})}
 const space=host.spaces.host.create({name:'Exact node wrap'}),channel=host.spaces.host.createChannel(space.space,'general');await member.spaces.client.join(member.spaces.client.prepareJoin(host.spaces.host.invite(space.space).text));await member.spaces.client.connect(space.space)
 const owner=host.net.runtime().identity.self()!,user=member.net.runtime().identity.self()!.user,created=host.spaces.private.prepareCreation(space.space,channel,[owner.user,user]);await host.spaces.private.publishCreation(created.descriptor.id)
 const invite=await member.net.request('bridge.invite',{}) as{invite:string};await follower.net.request('bridge.join',{invite:invite.invite,name:'Unwrapped follower'});await follower.net.request('net.protect',{passphrase:'discovery-fixture'})
 const self=follower.net.runtime().identity.self()!;expect(self.user).toBe(user);expect(self.node).not.toBe(member.net.runtime().identity.self()!.node)
 await follower.spaces.client.join(follower.spaces.client.prepareJoin(host.spaces.host.invite(space.space).text,host.spaces.meta.member(space.space,user)!.displayName));await follower.spaces.client.connect(space.space);await follower.spaces.client.subscribe(channel)
 expect(host.spaces.private.state(created.descriptor.id)!.control.wrapped.some(w=>w.node===self.node)).toBe(false)
 await expect(follower.spaces.discover(space.space,created.descriptor.id)).rejects.toMatchObject({code:'forbidden'});expect(follower.spaces.private.state(created.descriptor.id)).toBeUndefined()
 host.spaces.private.rewrap(created.descriptor.id,self.node);await host.spaces.flush(space.space)
 await follower.spaces.discover(space.space,created.descriptor.id)
 expect(follower.spaces.private.state(created.descriptor.id)?.control.wrapped.some(w=>w.node===self.node&&w.recipientAgreementKey===follower.net.runtime().keys.nodeKeys().agree)).toBe(true)
 await follower.spaces.client.subscribe(created.descriptor.id)
},20000)

it('closes rather than adopting an actual authenticated authority reply with substituted request context',async()=>{
 const host=profile(),member=profile(),third=profile();for(const p of[host,member,third]){await p.net.request('net.init',{listen:true});await p.net.request('net.protect',{passphrase:'discovery-fixture'})}
 const space=host.spaces.host.create({name:'Reply context'});for(const p of[member,third])await p.spaces.client.join(p.spaces.client.prepareJoin(host.spaces.host.invite(space.space).text));await member.spaces.client.connect(space.space)
 const original=host.current.source.get;host.current.source.get=(request,peer)=>{const roster=original(request,peer);request.user=host.net.runtime().identity.self()!.user;return roster}
 const session=member.spaces.session(space.space)!,target=third.net.runtime().identity.self()!.user
 await expect(session.spaceIdentity!(space.space,target,member.spaces.meta.state(space.space)!.applied)).rejects.toMatchObject({code:'conflict'})
 expect(member.net.runtime().identity.pinnedRootKey(target)).toBeUndefined();expect(member.net.runtime().db.database.prepare('SELECT count(*) AS n FROM net_space_current_identity').get()!.n).toBe(0)
},15000)
