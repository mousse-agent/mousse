import { mkdtempSync,realpathSync,rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { expect,it,vi } from 'vitest'
import { MousseMainService } from '../../../../src/mms/MousseMainService'
import { SpaceArchiveHost,SpaceImportCoordinator,readVerifiedSpaceArchive } from '../../../../src/mms/spaces/archive'
import { SpaceArchiveRecovery } from '../../../../src/mms/spaces/archive/SpaceArchiveRecovery'
import { signedDocument } from '../../../../src/mms/net/identity/crypto'
import { decodeEnvelope } from '../../../../src/mms/net/sync/codec'
import { NetError,type RoutesRecord,type SpaceDescriptor } from '../../../../src/shared/net'

it('commits a genuinely fresh private controller original atomically with higher-epoch activation and retries identical prepared evidence after rollback',async()=>{
  const root=realpathSync(mkdtempSync(join(tmpdir(),'archive-private-activation-'))),main=await MousseMainService.create({homeDir:join(root,'home'),repoRoot:root,headless:true,requireOwnership:false})
  try{
    await main.net.request('net.init',{listen:true,port:0});await main.net.request('net.protect',{passphrase:'task-owned-private-archive'})
    const spaces=main.spaces,rt=main.net.runtime(),self=rt.identity.self()!,space=spaces.host.create({name:'Private recovery'}),channel=spaces.host.createChannel(space.space,'general')
    const created=spaces.private.prepareCreation(space.space,channel,[self.user]);await spaces.private.publishCreation(created.descriptor.id)
    const stream=created.descriptor.id,before=spaces.private.state(stream)!.control,sealed=spaces.private.seal(stream,'message.posted',{text:'Historical ciphertext'})
    await spaces.append(stream,sealed.id,sealed.envelope,sealed.sig)
    // This fixture deliberately has no peer, provider or uploads. It
    // checks actual composed task settlement; it is not a production drain port.
    const quiesce=async()=>{
      await vi.waitFor(()=>expect(main.net.getActiveCount()).toBe(0))
      expect(main.net.status().peers).toEqual([])
      expect(rt.db.database.prepare('SELECT count(*) AS n FROM net_uploads').get()!.n).toBe(0)
      expect(rt.db.database.prepare("SELECT count(*) AS n FROM net_executions WHERE state IN ('accepted','running','waitingApproval')").get()!.n).toBe(0)
    }
    const source=new SpaceArchiveHost({host:spaces.host,quiesce})
    source.freeze(space.space,'Task-owned private recovery cut')
    const directory=join(root,'archive');await source.export(space.space,directory,new AbortController().signal)
    const verified=readVerifiedSpaceArchive(directory,{owner:{user:self.user,rootKey:rt.keys.rootKey()!}})
    try{
      const recovery=new SpaceArchiveRecovery(spaces,verified),coordinator=new SpaceImportCoordinator({host:spaces.host,store:spaces.store,quiesce,prepareRecovery:input=>recovery.prepare(input)})
      await coordinator.import(verified,'restore',new AbortController().signal)
      const descriptor=signedDocument({v:1,space:space.space,owner:self.user,hostNode:self.node,hostTransportKey:rt.keys.nodeKeys().transport,routes:main.net.signedRoutes(),epoch:2,issuedAt:rt.db.clock.now()} satisfies SpaceDescriptor,bytes=>rt.keys.signAsRoot(bytes))
      const fault=vi.spyOn(rt.db,'checkpoint').mockImplementation(point=>{if(point==='spaces.archive.activation.beforeCommit')throw new NetError('cancelled')})
      await expect(coordinator.activate(space.space,descriptor,new AbortController().signal)).rejects.toMatchObject({code:'cancelled'});fault.mockRestore()
      expect(coordinator.journal.forSpace(space.space)?.state).toBe('importedFrozen')
      expect(spaces.meta.position(space.space)).toMatchObject({status:'frozen',epoch:1})
      expect(spaces.store.head(stream).epoch).toBe(1)
      const op=coordinator.journal.forSpace(space.space)!,saved=JSON.parse(rt.keys.getSecret(`archive/rotation/${op.id}/${stream}/2`)!.toString()).original
      const oldRoutes=JSON.parse(Buffer.from(main.net.signedRoutes().payload,'base64url').toString()) as RoutesRecord,refreshedRoutes=rt.identity.signAsNode({...oldRoutes,version:oldRoutes.version+1,issuedAt:rt.db.clock.now()})
      vi.spyOn(main.net,'signedRoutes').mockReturnValue(refreshedRoutes)
      const refreshed=signedDocument({...JSON.parse(Buffer.from(descriptor.payload,'base64url').toString()),routes:refreshedRoutes,issuedAt:rt.db.clock.now()},bytes=>rt.keys.signAsRoot(bytes))
      const prepared=await recovery.prepare({space:space.space,descriptor:refreshed,streams:[...verified.streams()].map(s=>s.descriptor),signal:new AbortController().signal}),original=prepared.privateControls![0]
      expect(Buffer.from(original.envelope).toString('base64url')).toBe(saved.envelope);expect(Buffer.from(original.sig).toString('base64url')).toBe(saved.sig)
      await coordinator.activate(space.space,refreshed,new AbortController().signal)
      expect(coordinator.journal.forSpace(space.space)?.state).toBe('activeNew')
      const control=decodeEnvelope(original.envelope).envelope,stored=spaces.store.getById(stream,control.id)!
      expect(stored).toMatchObject({epoch:2,seq:1});expect(Buffer.from(stored.envelope)).toEqual(Buffer.from(original.envelope));expect(Buffer.from(stored.sig)).toEqual(Buffer.from(original.sig))
      const after=spaces.private.state(stream)!.control
      expect(after.keyEpoch).toBe(before.keyEpoch+1);expect(after.writers.every(w=>!before.writers.some(old=>old.noncePrefix===w.noncePrefix))).toBe(true)
      const next=spaces.private.seal(stream,'message.posted',{text:'New key only'}),position=spaces.host.appendLocal(stream,next.id,next.envelope,next.sig),record=spaces.store.getById(stream,next.id)!
      expect(position).toMatchObject({epoch:2,seq:2});expect(decodeEnvelope(next.envelope).envelope.sealed).toMatchObject({keyEpoch:2});expect(spaces.private.open(stream,record)).toEqual({text:'New key only'})
      expect(rt.db.database.prepare("SELECT count(*) AS n FROM net_private_nonce WHERE stream=? AND epoch=2").get(stream)!.n).toBe(1)
    }finally{verified.close()}
  }finally{await main.stop();rmSync(root,{recursive:true,force:true})}
},20000)
