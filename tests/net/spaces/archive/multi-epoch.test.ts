import {mkdtempSync,realpathSync,rmSync} from 'node:fs'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import {expect,it,vi} from 'vitest'
import {MousseMainService} from '../../../../src/mms/MousseMainService'
import {readVerifiedSpaceArchive,verifyArchiveHistory} from '../../../../src/mms/spaces/archive/verify'
import {signedDocument,decodeBase64} from '../../../../src/mms/net/identity/crypto'
import {newId,type SpaceDescriptor} from '../../../../src/shared/net'
import {decodeEnvelope} from '../../../../src/mms/net/sync/codec'

it('re-exports and replays original private history across successive composed Space restores with fresh keys',async()=>{
  const root=realpathSync(mkdtempSync(join(tmpdir(),'archive-multi-epoch-'))),main=await MousseMainService.create({homeDir:join(root,'home'),repoRoot:root,headless:true,requireOwnership:false})
  try{
    await main.net.request('net.init',{listen:true,port:0});await main.net.request('net.protect',{passphrase:'task-owned-multi-epoch'})
    const spaces=main.spaces,rt=main.net.runtime(),self=rt.identity.self()!,space=spaces.host.create({name:'Successive actual private restores'}),channel=spaces.host.createChannel(space.space,'general'),created=spaces.private.prepareCreation(space.space,channel,[self.user]);await spaces.private.publishCreation(created.descriptor.id)
    const stream=created.descriptor.id,originals=[],keys=[],prefixes=[]
    let carry:unknown
    for(let epoch=1;epoch<=3;epoch++){
      const opening=spaces.store.read(stream,{epoch,seq:0},1,65536).records[0]
      const previous=carry;carry=rt.db.transaction(()=>spaces.private.appendArchiveHistory([opening],spaces.store.getStream(stream)!,{epoch,seq:1},carry))
      if(epoch>1){expect(()=>rt.db.transaction(()=>spaces.private.append([opening],spaces.store.getStream(stream)!,{epoch,seq:1},previous))).toThrow(expect.objectContaining({code:'snapshot_required'}));expect(()=>rt.db.transaction(()=>spaces.private.appendArchiveHistory([{...opening,epoch:epoch-1}],spaces.store.getStream(stream)!,{epoch:epoch-1,seq:1},carry))).toThrow(expect.objectContaining({code:'snapshot_required'}))}
      const sealed=spaces.private.seal(stream,'message.posted',{text:`Original epoch ${epoch}`});await spaces.append(stream,sealed.id,sealed.envelope,sealed.sig)
      const record=spaces.store.getById(stream,sealed.id)!;originals.push(record)
      expect(()=>rt.db.transaction(()=>spaces.private.appendArchiveHistory([{...record,seq:record.seq+1}],spaces.store.getStream(stream)!,{epoch,seq:record.seq+1},carry))).toThrow(expect.objectContaining({code:'snapshot_required'}))
      const tampered=structuredClone(decodeEnvelope(record.envelope).envelope);tampered.sealed!.keyEpoch++;const bytes=Buffer.from(JSON.stringify(tampered)),bad={...record,envelope:bytes,sig:rt.keys.signAsNode(bytes)}
      expect(()=>rt.db.transaction(()=>spaces.private.appendArchiveHistory([bad],spaces.store.getStream(stream)!,{epoch,seq:record.seq},carry))).toThrow(expect.objectContaining({code:'forbidden'}))
      carry=rt.db.transaction(()=>spaces.private.appendArchiveHistory([record],spaces.store.getStream(stream)!,{epoch,seq:record.seq},carry))
      expect(()=>rt.db.transaction(()=>spaces.private.appendArchiveHistory([],spaces.store.getStream(stream)!,{epoch,seq:record.seq+1},carry))).toThrow(expect.objectContaining({code:'snapshot_required'}))
      rt.db.transaction(()=>spaces.private.appendArchiveHistory([],spaces.store.getStream(stream)!,{epoch,seq:record.seq},carry))
      keys.push(rt.keys.getSecret(`private/${stream}/${epoch}`)!.toString('base64url'))
      const control=spaces.private.state(stream)!.control;prefixes.push(...control.writers.map(w=>w.noncePrefix));expect(control.keyEpoch).toBe(epoch)
      for(const original of originals){const stored=spaces.store.getById(stream,decodeEnvelope(original.envelope).envelope.id)!;expect(Buffer.from(stored.envelope)).toEqual(Buffer.from(original.envelope));expect(Buffer.from(stored.sig)).toEqual(Buffer.from(original.sig));expect(stored.epoch).toBe(original.epoch)}
      if(epoch===3){
        for(let i=0;i<61;i++)carry=rt.db.transaction(()=>spaces.private.appendArchiveHistory([{...opening,seq:3+i}],spaces.store.getStream(stream)!,{epoch,seq:3+i},carry))
        expect(()=>rt.db.transaction(()=>spaces.private.appendArchiveHistory([{...opening,seq:64}],spaces.store.getStream(stream)!,{epoch,seq:64},carry))).toThrow(expect.objectContaining({code:'too_large'}))
        break
      }
      await vi.waitFor(()=>expect(main.net.getActiveCount()).toBe(0))
      const archive=main.bridge.archives,path=join(root,`archive-${epoch}`)
      await archive.request('spaces.archive.freeze',{space:space.space,reason:`Actual epoch ${epoch} cut`})
      await archive.request('spaces.archive.export',{space:space.space,path})
      const owner={user:self.user,rootKey:rt.keys.rootKey()!},verified=readVerifiedSpaceArchive(path,{owner})
      try{
        const first=JSON.parse(decodeBase64(verified.manifest.descriptors[0].payload).toString()) as SpaceDescriptor
        for(const change of [{owner:newId('user')},{epoch:epoch+1},{hostNode:newId('node')}]){
          const changed=signedDocument({...first,...change},bytes=>rt.keys.signAsRoot(bytes)),spoof={...verified,manifest:{...verified.manifest,descriptors:[changed,...verified.manifest.descriptors.slice(1)]}}
          expect(()=>verifyArchiveHistory(spoof,{owner})).toThrow()
        }
      }finally{verified.close()}
      await archive.request('spaces.archive.import',{path,mode:'restore'})
      expect(await archive.request('spaces.archive.activate',{space:space.space})).toMatchObject({state:'activeNew',epoch:epoch+1})
    }
    expect(new Set(keys).size).toBe(3);expect(new Set(prefixes).size).toBe(prefixes.length)
  }finally{await main.stop();rmSync(root,{recursive:true,force:true})}
},25000)
