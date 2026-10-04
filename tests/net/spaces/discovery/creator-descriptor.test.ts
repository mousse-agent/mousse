import { afterEach, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { cleanup, profile } from './profile'
import { newId, type SpaceStreamDiscoveryProof } from '../../../../src/shared/net'
import { canonicalJson, decodeEnvelope } from '../../../../src/mms/net/sync/codec'

afterEach(async()=>{for(const close of cleanup.splice(0).reverse())await close()})
it('reconciles only the creator timestamp from exact durable authority receipts and changes no control, key, head or history on conflicting proofs',async()=>{
 const host=profile(),creator=profile(),recipient=profile()
 for(const p of[host,creator,recipient]){await p.net.request('net.init',{listen:true});await p.net.request('net.protect',{passphrase:'creator-descriptor-fixture'})}
 const space=host.spaces.host.create({name:'Receipted descriptor'}),channel=host.spaces.host.createChannel(space.space,'general')
 for(const p of[creator,recipient]){await p.spaces.client.join(p.spaces.client.prepareJoin(host.spaces.host.invite(space.space).text));await p.spaces.client.connect(space.space);await p.spaces.client.subscribe(channel)}
 const user=creator.net.runtime().identity.self()!.user,other=recipient.net.runtime().identity.self()!.user
 creator.current.options.retainHistoryRoster=signed=>creator.spaces.evidence.retain(signed)
 await creator.current.preparePrivateAudience(space.space,[user,other])
 creator.spaces.private.options.currentRoster=(...args)=>creator.current.currentPrivateRoster(...args)
 const created=creator.spaces.private.prepareCreation(space.space,channel,[user,other]);await creator.spaces.private.publishCreation(created.descriptor.id)
 const session=creator.spaces.session(space.space)!,proof=await session.discoverSpaceStream(space.space,created.descriptor.id,creator.spaces.meta.state(space.space)!.applied),rt=creator.net.runtime()
 expect(proof.descriptor.createdAt).toBe(proof.controllerEvents[0].recvTs)
 expect(created.descriptor.createdAt).not.toBe(proof.descriptor.createdAt)
 const snapshot=()=>({descriptor:creator.spaces.store.getStream(created.descriptor.id),head:creator.spaces.store.head(created.descriptor.id),cursor:creator.spaces.store.cursor(created.descriptor.id),state:creator.spaces.private.state(created.descriptor.id),history:rt.db.database.prepare('SELECT * FROM net_space_private_history WHERE stream=?').all(created.descriptor.id),control:rt.db.database.prepare('SELECT * FROM net_private_control WHERE stream=?').all(created.descriptor.id),nonce:rt.db.database.prepare('SELECT * FROM net_private_nonce WHERE stream=?').all(created.descriptor.id),keysHash:createHash('sha256').update(readFileSync(join(rt.db.directory,'keys.json'))).digest('hex')})
 const before=snapshot(),negative:Array<[string,(proof:SpaceStreamDiscoveryProof)=>void]>=[
  ['stream',p=>{p.descriptor.id=newId('stream')}],['authority',p=>{p.descriptor.authority=newId('node')}],['Space',p=>{p.descriptor.space=newId('space')}],['parent',p=>{p.descriptor.parent=newId('stream')}],
  ['timestamp',p=>{p.descriptor.createdAt++}],['control epoch',p=>{p.controllerEvents[0].epoch++}],['parent position',p=>{p.parentOpenEvent.seq++}],['receipt timestamp',p=>{p.controllerEvents[0].recvTs++;p.descriptor.createdAt++}],
  ['creator',p=>{const e=decodeEnvelope(p.controllerEvents[0].envelope).envelope;e.author.user=other;p.controllerEvents[0].envelope=canonicalJson(e)}],
  ['initial audience',p=>{p.descriptor.participants=[user]}],['original signature',p=>{p.controllerEvents[0].sig[0]^=1}],['current meta head',p=>{p.metaHead.seq--}],
 ]
 for(const[name,mutate]of negative){const changed=structuredClone(proof);mutate(changed);expect(()=>creator.spaces.discovery.accept(changed,session.peer),name).toThrow();expect(snapshot(),name).toEqual(before)}
 expect(()=>creator.spaces.discovery.accept(proof,{...session.peer,node:newId('node')})).toThrow();expect(snapshot()).toEqual(before)
 const original=rt.outbox.get(created.event.id)!
 rt.db.transaction(()=>rt.db.database.prepare('UPDATE net_outbox SET seq=seq+1 WHERE id=?').run(original.id))
 expect(()=>creator.spaces.discovery.accept(proof,session.peer)).toThrow();expect(snapshot()).toEqual(before)
 rt.db.transaction(()=>rt.db.database.prepare('UPDATE net_outbox SET seq=? WHERE id=?').run(original.position!.seq,original.id))
 rt.db.transaction(()=>rt.db.database.prepare("UPDATE net_outbox SET state='unknown' WHERE id=?").run(original.id))
 expect(()=>creator.spaces.discovery.accept(proof,session.peer)).toThrow();expect(snapshot()).toEqual(before)
 rt.db.transaction(()=>rt.db.database.prepare("UPDATE net_outbox SET state='sent' WHERE id=?").run(original.id))
 const checkpoint=rt.db.checkpoint.bind(rt.db),fault=vi.spyOn(rt.db,'checkpoint').mockImplementation(point=>{if(point==='spaces.private.descriptor.reconcile.beforeCommit')throw Error('descriptor rollback');checkpoint(point)})
 expect(()=>creator.spaces.discovery.accept(proof,session.peer)).toThrow('descriptor rollback');fault.mockRestore();expect(snapshot()).toEqual(before)
 creator.spaces.discovery.accept(proof,session.peer)
 expect(snapshot()).toEqual({...before,descriptor:proof.descriptor});creator.spaces.discovery.accept(proof,session.peer);expect(snapshot()).toEqual({...before,descriptor:proof.descriptor})
 await recipient.spaces.client.subscribe(channel);await recipient.spaces.discover(space.space,created.descriptor.id)
 const foreignSession=recipient.spaces.session(space.space)!,foreignProof=await foreignSession.discoverSpaceStream(space.space,created.descriptor.id,recipient.spaces.meta.state(space.space)!.applied)
 foreignProof.descriptor.createdAt++
 expect(()=>recipient.spaces.discovery.accept(foreignProof,foreignSession.peer)).toThrow()
 expect(recipient.spaces.store.getStream(created.descriptor.id)).toEqual(proof.descriptor)
},25000)
