import {mkdtempSync,rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {afterEach,expect,it,vi} from 'vitest'
import {NetService} from '../../../../src/mms/net/NetService'
import {NodeStreamAuthority} from '../../../../src/mms/net/sync/nodeAuthority'
import {systemClock} from '../../../../src/mms/net/clock'
import {SpaceProfileService} from '../../../../src/mms/spaces/SpaceProfileService'
import {SpaceCurrentIdentity} from '../../../../src/mms/spaces/SpaceCurrentIdentity'
const cleanup:Array<()=>void|Promise<void>>=[]
afterEach(async()=>{for(const close of cleanup.splice(0).reverse())await close()})
async function profile(){
 const path=mkdtempSync(join(tmpdir(),'private-current-snapshot-'));let spaces!:SpaceProfileService,current!:SpaceCurrentIdentity
 const net=new NetService({profileDir:path,composeRuntime:runtime=>{
  spaces=new SpaceProfileService({runtime,net,currentPrivateRoster:(space,user)=>current.currentPrivateRoster(space,user)})
  current=new SpaceCurrentIdentity({runtime,store:spaces.store,meta:spaces.meta,host:spaces.host,session:space=>spaces.session(space),retainHistoryRoster:signed=>spaces.evidence.retain(signed)})
  const composition=spaces.composition(new NodeStreamAuthority(runtime.identity,spaces.store,runtime.blobs,systemClock))
  return{...composition,session:{...composition.session,spaceIdentity:current.source},close:async()=>{current.close();await composition.close?.()}}
 }})
 cleanup.push(()=>rmSync(path,{recursive:true,force:true}),()=>net.shutdown());await net.request('net.init',{listen:true});await net.request('net.protect',{passphrase:'current-snapshot-fixture'});return{net,spaces,current}
}
it('prepares a foreign private audience through an explicit scoped current proof after actual full meta snapshot activation',async()=>{
 const host=await profile(),controller=await profile(),recipient=await profile(),space=host.spaces.host.create({name:'Current after snapshot'}),channel=host.spaces.host.createChannel(space.space,'general')
 for(const p of[controller,recipient])await p.spaces.client.join(p.spaces.client.prepareJoin(host.spaces.host.invite(space.space).text))
 const user=recipient.net.runtime().identity.self()!.user,local=controller.net.runtime().identity.self()!.user
 expect(controller.net.runtime().identity.pinnedRootKey(user)).toBeUndefined();expect(controller.net.runtime().identity.roster(user)).toBeUndefined()
 // Fault fixture: force the real TLS snapshot path while retaining the complete signed meta prefix.
 host.net.runtime().db.database.prepare('UPDATE net_streams SET retained=head WHERE id=?').run(space.meta)
 expect(host.spaces.store.snapshotReason(space.meta,controller.spaces.store.cursor(space.meta))).toBe('cursorTooOld')
 const snapshot=vi.spyOn(controller.spaces.store,'beginSnapshot');await controller.spaces.client.connect(space.space);await controller.spaces.client.subscribe(channel)
 expect(snapshot).toHaveBeenCalledWith(space.meta,host.spaces.store.head(space.meta))
 expect(controller.net.runtime().identity.pinnedRootKey(user)).toBe(recipient.net.runtime().keys.rootKey());expect(controller.net.runtime().identity.roster(user)).toBeUndefined()
 await controller.current.preparePrivateAudience(space.space,[local,user])
 expect(controller.net.runtime().identity.roster(user)).toBeUndefined()
 const prepared=controller.spaces.private.prepareCreation(space.space,channel,[local,user]);await controller.spaces.private.publishCreation(prepared.descriptor.id)
 expect(controller.net.runtime().outbox.get(prepared.event.id)?.state).toBe('sent')
 expect(host.spaces.private.state(prepared.descriptor.id)?.control.participants).toEqual([local,user].sort())
},15000)
