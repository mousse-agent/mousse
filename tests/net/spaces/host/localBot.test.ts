import { afterEach, expect, it } from 'vitest'
import { BotRecordAuthorization } from '../../../../src/mms/bots/admission'
import { NetSyncSession } from '../../../../src/mms/net/sync/session'
import { canonicalJson, decodeEnvelope } from '../../../../src/mms/net/sync/codec'
import { newId } from '../../../../src/shared/net'
import { SpaceHostService } from '../../../../src/mms/spaces/host'
import { setup } from '../../bots/admission/helpers'
import { channels, cleanup, disposers } from './helpers'

afterEach(cleanup)
it('publishes the original owner-host public acceptance on its locally prepared thread through real TLS',async()=>{
  const f=await setup(),admitted=f.service.admit(f.message()).record,entry=f.outbox.list(admitted.binding!.stream)[0]
  let authority!:SpaceHostService
  const gate=new BotRecordAuthorization({identity:f.p.identity,meta:f.p.projection,store:f.p.store,binding:(space,execution)=>authority.executionBinding(space,execution)})
  authority=new SpaceHostService({...f.p.host.options,botAuthorization:gate,outbox:f.outbox})
  const tls=await channels(f.p,f.p),server=new NetSyncSession({channel:tls.server,identity:f.p.identity,store:f.p.store,authority,clock:f.p.clock}),client=new NetSyncSession({channel:tls.client,identity:f.p.identity,store:f.p.store,clock:f.p.clock})
  disposers.push(()=>server.close(),()=>client.close());await Promise.all([server.opened,client.opened])
  expect(f.p.store.head(entry.stream).seq).toBe(0)
  const substitute={...decodeEnvelope(entry.envelope).envelope,id:newId('event')},bytes=canonicalJson(substitute)
  await expect(client.append(entry.stream,substitute.id,bytes,f.p.keys.signAsBot(f.bot,bytes))).rejects.toMatchObject({code:'forbidden'})
  expect(authority.threadBinding(entry.stream)).toBeUndefined();expect(f.p.store.head(entry.stream).seq).toBe(0)
  expect(await client.append(entry.stream,entry.id,entry.envelope,entry.sig)).toMatchObject({epoch:1,seq:1})
  expect(authority.threadBinding(entry.stream)?.execution).toBe(admitted.id)
  const opening=f.p.store.read(f.parent,{epoch:1,seq:1},2,65536).records.map(record=>decodeEnvelope(record.envelope).envelope)
  expect(opening).toHaveLength(1);expect(opening[0].type).toBe('thread.opened')
  expect(await client.append(entry.stream,entry.id,entry.envelope,entry.sig)).toMatchObject({epoch:1,seq:1})
})
