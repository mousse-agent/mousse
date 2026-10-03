import { afterEach, describe, expect, it } from 'vitest'
import { BotRecordAuthorization } from '../../../../src/mms/bots/admission'
import { decodeEnvelope } from '../../../../src/mms/net/sync/codec'
import { cleanup, peer } from '../../spaces/host/helpers'
import { setup } from './helpers'
import { newId } from '../../../../src/shared/net'
afterEach(cleanup)
describe('signed accepted receipt and immutable public bot output authorization',()=>{
 it('authorizes the real signed receipt and exact binding, while rejecting forged signatures/caller/trigger/execution',async()=>{const f=await setup(),input=f.message(),record=f.service.admit(input).record,receipt=f.outbox.list(record.binding!.stream)[0],descriptor=f.p.store.getStream(receipt.stream)!,envelope=decodeEnvelope(receipt.envelope).envelope,binding={space:f.space.space,stream:receipt.stream,parent:input.stream,bot:f.bot,trigger:decodeEnvelope(input.record.envelope).envelope.id,execution:record.id},gate=new BotRecordAuthorization({identity:f.p.identity,meta:f.p.projection,store:f.p.store,binding:()=>binding}),caller=peer(f.p);expect(gate.canRegisterAccepted(descriptor,receipt,caller)).toBe(true);expect(gate.canWrite(descriptor,envelope,caller,binding)).toBe(true);const signature=new Uint8Array(receipt.sig);signature[0]^=1;expect(gate.canRegisterAccepted(descriptor,{...receipt,sig:signature},caller)).toBe(false);expect(gate.canWrite(descriptor,envelope,{...caller,node:newId('node')},binding)).toBe(false);expect(gate.canWrite(descriptor,{...envelope,refs:{...envelope.refs,execution:newId('execution')}},caller,binding)).toBe(false);expect(gate.canWrite(descriptor,envelope,caller,{...binding,trigger:newId('event')})).toBe(false);expect(()=>gate.verifyHistory({...receipt,epoch:1,seq:1,recvTs:f.p.clock.now()},descriptor)).toThrow(expect.objectContaining({code:'forbidden'}));f.p.identity.revoke(f.bot);expect(gate.canRegisterAccepted(descriptor,receipt,caller)).toBe(false)})
})
