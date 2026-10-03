import { afterEach, describe, expect, it } from 'vitest'
import { BotRecordAuthorization } from '../../../../src/mms/bots/admission'
import { decodeEnvelope } from '../../../../src/mms/net/sync/codec'
import { cleanup, peer } from '../../spaces/host/helpers'
import { setup } from './helpers'
import { newId } from '../../../../src/shared/net'
afterEach(cleanup)
describe('signed accepted receipt and immutable public bot output authorization',()=>{
 it('admits an indexed human nested public mention with exact output scope and current read proofs',async()=>{
  const f=await setup(),initial=f.message(),trigger=decodeEnvelope(initial.record.envelope).envelope.id,execution=newId('execution'),thread=f.p.host.createThread({space:f.space.space,parent:f.parent,bot:f.bot,trigger,execution,title:'Existing output'})
  f.p.host.post(thread,'Nested human mention',{thread,replyTo:trigger,execution,mentions:[f.bot]})
  const record=f.p.store.read(thread,{epoch:1,seq:0},1,65536).records[0]
  const input={stream:thread,bot:f.bot,record,source:'delivery' as const},result=f.service.admit(input),receipt=f.outbox.list(result.record.binding!.stream)[0],descriptor=f.p.store.getStream(receipt.stream)!,envelope=decodeEnvelope(receipt.envelope).envelope,binding={space:f.space.space,stream:receipt.stream,parent:thread,bot:f.bot,trigger:decodeEnvelope(record.envelope).envelope.id,execution:result.record.id},gate=new BotRecordAuthorization({identity:f.p.identity,meta:f.p.projection,store:f.p.store,binding:()=>binding})
  expect(result.kind).toBe('admitted');expect(f.budgets.remaining(f.bot,f.space.space,f.p.clock.now())).toBe(940)
  expect(gate.canRegisterAccepted(descriptor,receipt,peer(f.p))).toBe(true);expect(gate.canWrite(descriptor,envelope,peer(f.p))).toBe(true)
  expect(f.service.admit(input)).toMatchObject({kind:'duplicate',record:{id:result.record.id}});expect(f.outbox.list(receipt.stream)).toHaveLength(1)
  const original=f.p.projection.canRead.bind(f.p.projection);f.p.projection.canRead=()=>false
  expect(gate.canWrite(descriptor,envelope,peer(f.p))).toBe(false)
  const later=f.p.host.options.store.getById(thread,decodeEnvelope(record.envelope).envelope.id)!;expect(()=>f.service.admit({...input,record:later})).toThrow(expect.objectContaining({code:'forbidden'}));f.p.projection.canRead=original
  f.p.host.postMeta(f.space.space,'bot.policyChanged',{bot:f.bot,policy:{steer:{kind:'everyone'},visibility:'private'}})
  expect(()=>f.service.admit(input)).toThrow(expect.objectContaining({code:'forbidden'}))
  expect(f.p.db.database.prepare('SELECT count(*) AS n FROM net_executions').get()!.n).toBe(1)
  expect(f.p.db.database.prepare('SELECT count(*) AS n FROM net_budget_reservations').get()!.n).toBe(1)
 })
 it('authorizes the real signed receipt and exact binding, while rejecting forged signatures/caller/trigger/execution',async()=>{const f=await setup(),input=f.message(),record=f.service.admit(input).record,receipt=f.outbox.list(record.binding!.stream)[0],descriptor=f.p.store.getStream(receipt.stream)!,envelope=decodeEnvelope(receipt.envelope).envelope,binding={space:f.space.space,stream:receipt.stream,parent:input.stream,bot:f.bot,trigger:decodeEnvelope(input.record.envelope).envelope.id,execution:record.id},gate=new BotRecordAuthorization({identity:f.p.identity,meta:f.p.projection,store:f.p.store,binding:()=>binding}),caller=peer(f.p);expect(gate.canRegisterAccepted(descriptor,receipt,caller)).toBe(true);expect(gate.canWrite(descriptor,envelope,caller,binding)).toBe(true);const signature=new Uint8Array(receipt.sig);signature[0]^=1;expect(gate.canRegisterAccepted(descriptor,{...receipt,sig:signature},caller)).toBe(false);expect(gate.canWrite(descriptor,envelope,{...caller,node:newId('node')},binding)).toBe(false);expect(gate.canWrite(descriptor,{...envelope,refs:{...envelope.refs,execution:newId('execution')}},caller,binding)).toBe(false);expect(gate.canWrite(descriptor,envelope,caller,{...binding,trigger:newId('event')})).toBe(false);expect(()=>gate.verifyHistory({...receipt,epoch:1,seq:1,recvTs:f.p.clock.now()},descriptor)).toThrow(expect.objectContaining({code:'forbidden'}));f.p.identity.revoke(f.bot);expect(gate.canRegisterAccepted(descriptor,receipt,caller)).toBe(false)})
})
