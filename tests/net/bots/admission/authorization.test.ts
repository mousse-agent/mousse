import { afterEach, describe, expect, it } from 'vitest'
import { BotRecordAuthorization } from '../../../../src/mms/bots/admission'
import { decodeEnvelope } from '../../../../src/mms/net/sync/codec'
import { cleanup, peer } from '../../spaces/host/helpers'
import { setup } from './helpers'
import { newId } from '../../../../src/shared/net'
afterEach(cleanup)
describe('signed accepted receipt and immutable public bot output authorization',()=>{
 it('refuses the currently unqualified nested public thread trigger before reserving budget or execution effects',async()=>{
  const f=await setup(),initial=f.message(),trigger=decodeEnvelope(initial.record.envelope).envelope.id,execution=newId('execution'),thread=f.p.host.createThread({space:f.space.space,parent:f.parent,bot:f.bot,trigger,execution,title:'Existing output'})
  f.p.host.post(thread,'Nested human mention',{thread,replyTo:trigger,execution,mentions:[f.bot]})
  const record=f.p.store.read(thread,{epoch:1,seq:0},1,65536).records[0]
  expect(()=>f.service.admit({stream:thread,bot:f.bot,record,source:'delivery'})).toThrow(expect.objectContaining({code:'forbidden'}))
  expect(f.p.db.database.prepare('SELECT count(*) AS n FROM net_executions').get()!.n).toBe(0)
  expect(f.p.db.database.prepare('SELECT count(*) AS n FROM net_budget_reservations').get()!.n).toBe(0)
  expect(f.p.db.database.prepare('SELECT count(*) AS n FROM net_outbox').get()!.n).toBe(0)
 })
 it('authorizes the real signed receipt and exact binding, while rejecting forged signatures/caller/trigger/execution',async()=>{const f=await setup(),input=f.message(),record=f.service.admit(input).record,receipt=f.outbox.list(record.binding!.stream)[0],descriptor=f.p.store.getStream(receipt.stream)!,envelope=decodeEnvelope(receipt.envelope).envelope,binding={space:f.space.space,stream:receipt.stream,parent:input.stream,bot:f.bot,trigger:decodeEnvelope(input.record.envelope).envelope.id,execution:record.id},gate=new BotRecordAuthorization({identity:f.p.identity,meta:f.p.projection,store:f.p.store,binding:()=>binding}),caller=peer(f.p);expect(gate.canRegisterAccepted(descriptor,receipt,caller)).toBe(true);expect(gate.canWrite(descriptor,envelope,caller,binding)).toBe(true);const signature=new Uint8Array(receipt.sig);signature[0]^=1;expect(gate.canRegisterAccepted(descriptor,{...receipt,sig:signature},caller)).toBe(false);expect(gate.canWrite(descriptor,envelope,{...caller,node:newId('node')},binding)).toBe(false);expect(gate.canWrite(descriptor,{...envelope,refs:{...envelope.refs,execution:newId('execution')}},caller,binding)).toBe(false);expect(gate.canWrite(descriptor,envelope,caller,{...binding,trigger:newId('event')})).toBe(false);expect(()=>gate.verifyHistory({...receipt,epoch:1,seq:1,recvTs:f.p.clock.now()},descriptor)).toThrow(expect.objectContaining({code:'forbidden'}));f.p.identity.revoke(f.bot);expect(gate.canRegisterAccepted(descriptor,receipt,caller)).toBe(false)})
})
