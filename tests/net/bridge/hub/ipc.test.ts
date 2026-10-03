import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Socket } from 'node:net'
import { expect, it, vi } from 'vitest'
import { MousseMainService } from '../../../../src/mms/MousseMainService'
import { MmsProtocolServer } from '../../../../src/mms/protocol/server'
import { LocalMmsClient } from '../../../../src/mms/protocol/client'
import type { DomainConnectionContext } from '../../../../src/mms/protocol/domainRegistry'
import { domainObject } from '../../../../src/mms/protocol/domainRegistry'
import { parseEnvelope } from '../../../../src/mms/protocol/validators'

it('delivers 5 MiB through actual MMS with awaited backpressure, no audience leak or replay, and rejects an old binding after A→B→A', async()=>{
  const root=realpathSync(mkdtempSync(join(tmpdir(),'bridge-ipc-'))),home=join(root,'home')
  const main=await MousseMainService.create({homeDir:home,repoRoot:root,headless:true,requireOwnership:false})
  const host=main.getInstallationHost()!,alice=host.getDefaultProfileId(),bob=host.manager.create({displayName:'Bob',slug:'bob'})
  let producer:NonNullable<DomainConnectionContext['emitConnectionEvent']>|undefined,flushed=0,producerId='',producerClosed=false
  main.domains.onConnectionClosed(id=>{if(id===producerId)producerClosed=true})
  const chunk='x'.repeat(32*1024),count=160
  main.domains.register({method:'fixture.display',scope:'profile',capability:'net.v1',requiredCapabilities:['net.v1'],validate:value=>domainObject(value,['capture']),handle:async ctx=>{
    producer=ctx.connection!.emitConnectionEvent!
    for(let i=0;i<count;i++){await producer('bridge.hub.thread',{part:i,content:chunk});flushed++}
    return {sent:flushed}
  }})
  main.domains.register({method:'fixture.captureDisplay',scope:'profile',requiredCapabilities:['net.v1'],validate:value=>domainObject(value,[]),handle:ctx=>{producer=ctx.connection!.emitConnectionEvent!;producerId=ctx.connection!.id;producerClosed=false;return {ready:true}}})
  const server=new MmsProtocolServer({mms:main,ownerToken:'test-owner'})
  const endpoint=await server.start()
  const client=()=>new LocalMmsClient({homeDir:home,endpoint,ownerToken:'test-owner',requestedCapabilities:['profiles-v1']})
  const a=client(),same=client(),b=client(),parts:Array<{part:number;content:string}>=[],others:unknown[]=[],closed:Error[]=[]
  try{
    await Promise.all([a.connect(),same.connect(),b.connect()])
    await a.request('profiles.bind',{profile:alice});await same.request('profiles.bind',{profile:alice});await b.request('profiles.bind',{profile:bob.id})
    a.onConnectionEvent(event=>{expect(event.profileId).toBe(alice);parts.push(event.data as typeof parts[number])})
    a.onConnectionClosed(error=>closed.push(error))
    same.onConnectionEvent(event=>others.push(event));b.onConnectionEvent(event=>others.push(event))
    const baseline=await same.subscribe()
    const socket=(a as unknown as {socket:Socket}).socket
    socket.pause()
    const sending=a.request('fixture.display',{})
    await vi.waitFor(()=>expect(producer).toBeDefined())
    await new Promise(resolve=>setTimeout(resolve,100))
    expect(flushed).toBeLessThan(count)
    expect(a.connected).toBe(true)
    socket.resume()
    await expect(sending).resolves.toEqual({sent:count})
    expect(parts).toHaveLength(count)
    expect(parts.every((part,index)=>part.part===index && part.content===chunk)).toBe(true)
    expect(parts.reduce((n,part)=>n+part.content.length,0)).toBe(5*1024*1024)
    expect(others).toEqual([])
    const after=await same.subscribe(baseline.sequence)
    expect(after.sequence).toBe(baseline.sequence);expect(after.replay).toEqual([]);expect(same.requiresResnapshot).toBe(false)
    const old=producer!
    await a.request('profiles.bind',{profile:bob.id});await a.request('profiles.bind',{profile:alice})
    await expect(old('bridge.hub.thread',{secret:'stale'})).rejects.toMatchObject({code:'connection_closed'})
    await a.request('fixture.captureDisplay',{})
    const abort=new AbortController();abort.abort()
    await expect(producer!('bridge.hub.thread',{secret:'aborted'},abort.signal)).rejects.toMatchObject({code:'connection_closed'})
    await expect(producer!('bridge.hub.thread',{content:'x'.repeat(65*1024)})).rejects.toThrow(/exceeds max/)
    await expect(producer!('bridge.hub.thread',{part:count,content:'fresh'})).resolves.toBeUndefined()
    await vi.waitFor(()=>expect(parts.at(-1)?.content).toBe('fresh'))
    expect(others).toEqual([])
    await a.close();expect(closed).toHaveLength(1)
    await vi.waitFor(()=>expect(producerClosed).toBe(true))
    await expect(producer!('bridge.hub.thread',{secret:'closed'})).rejects.toMatchObject({code:'connection_closed'})
  }finally{await Promise.all([a.close(),same.close(),b.close()]);await server.stop();await main.stop();rmSync(root,{recursive:true,force:true})}
},30000)

it('bounds and allowlists the connection lane independently of ordinary event envelopes',()=>{
  const valid={kind:'connection_event',type:'bridge.hub.thread',profileId:'profile',profileEpoch:1,data:{}}
  expect(parseEnvelope(valid)?.kind).toBe('connection_event')
  for(const value of [{...valid,type:'providers.changed'},{...valid,sequence:1},{...valid,profileEpoch:0},{...valid,data:'x'.repeat(65*1024)}])expect(parseEnvelope(value)).toBeNull()
})
