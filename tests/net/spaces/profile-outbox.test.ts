import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { NetService } from '../../../src/mms/net/NetService'
import { NodeStreamAuthority } from '../../../src/mms/net/sync/nodeAuthority'
import { systemClock } from '../../../src/mms/net/clock'
import { SpaceProfileService } from '../../../src/mms/spaces/SpaceProfileService'
import { canonicalJson } from '../../../src/mms/net/sync/codec'
import { verifyDocument } from '../../../src/mms/net/identity/crypto'
import { NetError, newId, type Envelope, type StreamId, type Roster, type NodeDelegation } from '../../../src/shared/net'

async function fixture() {
  const path=mkdtempSync(join(tmpdir(),'space-profile-outbox-'))
  let spaces!:SpaceProfileService
  const net=new NetService({profileDir:path,composeRuntime:runtime=>{spaces=new SpaceProfileService({runtime,net});return spaces.composition(new NodeStreamAuthority(runtime.identity,spaces.store,runtime.blobs,systemClock))}})
  await net.request('net.init',{listen:true})
  const space=spaces.host.create({name:'Owner receipt boundary'}),channel=spaces.host.createChannel(space.space,'general')
  const prepare=(stream:StreamId,text:string)=>{
    const rt=net.runtime(),self=rt.identity.self()!,meta=spaces.meta.position(space.space)!
    const root=rt.identity.pinnedRootKey(self.user)!,roster=verifyDocument<Roster>(rt.identity.roster(self.user)!,root,'roster')
    const delegation=roster.nodes.map(signed=>verifyDocument<NodeDelegation>(signed,root,'nodeDelegation')).filter(node=>node.subject===self.node).sort((a,b)=>b.keyEpoch-a.keyEpoch)[0]
    const envelope:Envelope={v:1,minor:0,id:newId('event'),stream,type:'message.posted',crit:false,author:{user:self.user,node:self.node,keyEpoch:delegation.keyEpoch},ts:Date.now(),auth:{metaEpoch:meta.epoch,metaSeq:meta.seq},body:{text}}
    const bytes=canonicalJson(envelope),entry={id:envelope.id,stream,envelope:bytes,sig:rt.keys.signAsNode(bytes)}
    rt.outbox.enqueue(entry)
    return {entry,envelope}
  }
  return {net,spaces,space,channel,prepare,close:async()=>{await net.shutdown();rmSync(path,{recursive:true,force:true})}}
}

it('sends only the exact durable original through the actual owner authority and leaves receipt ownership to its caller',async()=>{
  const f=await fixture()
  try{
    const {entry,envelope}=f.prepare(f.channel,'original')
    const substitute=canonicalJson({...envelope,body:{text:'substituted'}})
    expect(()=>f.spaces.appendSigned({...entry,envelope:substitute,sig:f.net.runtime().keys.signAsNode(substitute)})).toThrow(expect.objectContaining({code:'conflict'}))
    expect(f.spaces.store.head(f.channel).seq).toBe(0)
    const position=await f.spaces.appendSigned(entry)
    expect(position).toMatchObject({epoch:1,seq:1})
    expect(f.net.runtime().outbox.get(entry.id)?.state).toBe('pending')
    await f.spaces.flush(f.space.space)
    expect(f.net.runtime().outbox.get(entry.id)).toMatchObject({state:'sent',position:{epoch:1,seq:1}})
    expect(f.spaces.store.head(f.channel).seq).toBe(1)
    await f.spaces.close()
    expect(()=>f.spaces.appendSigned(entry)).toThrow(expect.objectContaining({code:'cancelled'}))
    await expect(f.spaces.flush(f.space.space)).rejects.toMatchObject({code:'cancelled'})
  }finally{await f.close()}
})

it('flushes an original queued while callers coalesce onto the completed owner pass before its finalizer',async()=>{
  const f=await fixture()
  try{
    const earlier=f.spaces.flush(f.space.space)
    const entry=f.prepare(f.channel,'Queued at the completed pass boundary').entry
    const joined=f.spaces.flush(f.space.space)
    expect(joined).toBe(earlier)
    await joined
    expect(f.net.runtime().outbox.get(entry.id)).toMatchObject({state:'sent',position:{epoch:1,seq:1}})
    expect(f.spaces.store.getById(f.channel,entry.id)?.envelope).toEqual(entry.envelope)
    expect(f.spaces.store.head(f.channel).seq).toBe(1)
  }finally{await f.close()}
})

it('keeps the later owner original pending after a real host commit loses its acknowledgement, then reconciles both once in FIFO order',async()=>{
  const f=await fixture()
  try{
    const first=f.prepare(f.channel,'first').entry,second=f.prepare(f.channel,'second').entry
    f.net.runtime().db.database.prepare('UPDATE net_outbox SET created_at=100 WHERE id IN (?,?)').run(first.id,second.id)
    const original=f.spaces.host.appendLocal.bind(f.spaces.host)
    let lost=false
    f.spaces.host.appendLocal=(...args)=>{const position=original(...args);if(!lost){lost=true;throw new NetError('internal')}return position}
    await f.spaces.flush(f.space.space)
    expect(f.spaces.store.getById(f.channel,first.id)?.seq).toBe(1)
    expect(f.spaces.store.getById(f.channel,second.id)).toBeUndefined()
    expect(f.net.runtime().outbox.get(first.id)?.state).toBe('unknown')
    expect(f.net.runtime().outbox.get(second.id)?.state).toBe('pending')
    f.spaces.host.appendLocal=original
    await f.spaces.flush(f.space.space)
    expect(f.net.runtime().outbox.get(first.id)).toMatchObject({state:'sent',position:{epoch:1,seq:1}})
    expect(f.net.runtime().outbox.get(second.id)).toMatchObject({state:'sent',position:{epoch:1,seq:2}})
    expect(f.spaces.store.head(f.channel).seq).toBe(2)
    expect(f.spaces.store.getById(f.channel,first.id)?.envelope).toEqual(first.envelope)
  }finally{await f.close()}
})

it('keeps prepared private creation behind its controller publication boundary',async()=>{
  const f=await fixture()
  try{
    const prepared=f.spaces.private.prepareCreation(f.space.space,f.channel,[f.net.runtime().identity.self()!.user])
    await f.spaces.flush(f.space.space)
    expect(f.spaces.store.head(f.channel).seq).toBe(0)
    expect(f.spaces.private.state(prepared.descriptor.id)).toBeUndefined()
    expect(f.net.runtime().outbox.get(prepared.event.id)?.state).toBe('pending')
    await f.spaces.private.publishCreation(prepared.descriptor.id)
    expect(f.net.runtime().outbox.get(prepared.event.id)?.state).toBe('sent')
  }finally{await f.close()}
})
