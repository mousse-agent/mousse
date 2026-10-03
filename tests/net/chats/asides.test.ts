import { afterEach, expect, it, vi } from 'vitest'
import { cleanup, profile } from './helpers'
import { newId } from '../../../src/shared/net'
import { decodeEnvelope } from '../../../src/mms/net/sync/codec'

afterEach(async()=>{for(const close of cleanup.splice(0).reverse())await close()})
async function linked(){
  const host=await profile(),creator=await profile(),recipient=await profile(),outsider=await profile(),group=await host.createGroup(),binding=host.services.chatNetwork.publish({chatId:group.id,publicationId:'aside-group'})
  async function join(member:Awaited<ReturnType<typeof profile>>,bindingId:string){
    const id=member.services.spaces.client.prepareJoin(host.services.spaces.host.invite(binding.space).text)
    await member.services.spaces.client.join(id);await member.services.spaces.client.connect(binding.space)
    return member.services.chatNetwork.bind({bindingId,space:binding.space,channel:binding.channel})
  }
  const created=await join(creator,'creator-chat'),received=await join(recipient,'recipient-chat'),outside=await join(outsider,'outsider-chat')
  return{host,creator,recipient,outsider,group,binding,created,received,outside,participants:[creator.services.net.runtime().identity.self()!.user,recipient.services.net.runtime().identity.self()!.user]}
}

it('publishes an ordinary foreign human aside with explicit audience and discovers/decrypts only through actual protected TLS',async()=>{
  const f=await linked(),request={chatId:f.created.id,asideId:'human-aside',participants:f.participants}
  const [one,two]=await Promise.all([f.creator.services.chatNetwork.asideCreate(request),f.creator.services.chatNetwork.asideCreate(request)])
  expect(two.stream).toBe(one.stream);expect(one.state).toBe('sent');expect(one.participants).toEqual([...f.participants].sort())
  expect(f.host.services.spaces.store.getById(f.binding.channel,one.opening)?.seq).toBe(1)
  const original=f.creator.services.net.runtime().outbox.get(one.control)!
  expect(f.host.services.spaces.store.getById(one.stream,one.control)?.envelope).toEqual(original.envelope)
  const text='PRIVATE HUMAN CANARY'
  const [a,b]=await Promise.all([f.creator.services.chatNetwork.asideSend({chatId:f.created.id,stream:one.stream,text,clientMessageId:'private-original'}),f.creator.services.chatNetwork.asideSend({chatId:f.created.id,stream:one.stream,text,clientMessageId:'private-original'})])
  expect(b.delivery.id).toBe(a.delivery.id);expect(a.delivery.state).toBe('sent')
  const [next,last]=await Promise.all(['next','last'].map(clientMessageId=>f.creator.services.chatNetwork.asideSend({chatId:f.created.id,stream:one.stream,text:clientMessageId,clientMessageId})))
  expect(next.delivery.state).toBe('sent');expect(last.delivery.state).toBe('sent')
  expect(next.delivery.position!.seq).toBe(3);expect(last.delivery.position!.seq).toBe(4)

  const stored=f.host.services.spaces.store.getById(one.stream,a.delivery.id)!,envelope=decodeEnvelope(stored.envelope).envelope
  expect(envelope.body).toBeUndefined();expect(envelope.sealed).toBeDefined();expect(Buffer.from(stored.envelope).toString()).not.toContain(text)
  await vi.waitFor(()=>expect(f.recipient.services.spaces.store.getById(f.binding.channel,one.opening)).toBeDefined())
  const view=await f.recipient.services.chatNetwork.asideGet({chatId:f.received.id,stream:one.stream})
  expect(view.private).toBe(true);expect(view.records.find(row=>row.envelope.id===a.delivery.id)?.privateBody).toEqual({text})
  const creatorView=await f.creator.services.chatNetwork.asideGet({chatId:f.created.id,stream:one.stream})
  expect(creatorView.records.find(row=>row.envelope.id===a.delivery.id)?.privateBody).toEqual({text})
  expect(view.audience).toEqual({controller:f.participants[0],participants:[...f.participants].sort(),keyEpoch:1,visibilityEpoch:1})
  expect(JSON.stringify(f.recipient.services.chatNetwork.get(f.received.id))).not.toContain(text)
  expect(JSON.stringify(f.host.services.chatNetwork.get(f.group.id))).not.toContain(text)
  await expect(f.outsider.services.chatNetwork.work({chatId:f.outside.id,stream:one.stream})).rejects.toThrow()
  await expect(f.host.services.chatNetwork.work({chatId:f.group.id,stream:one.stream})).rejects.toThrow()
  await expect(f.creator.services.chatNetwork.asideCreate({...request,participants:[f.participants[0]]})).rejects.toMatchObject({code:'conflict'})
  await expect(f.creator.services.chatNetwork.asideSend({chatId:f.created.id,stream:one.stream,text:'changed',clientMessageId:'private-original'})).rejects.toMatchObject({code:'conflict'})
  expect(f.creator.contexts).toHaveLength(0);expect(f.recipient.contexts).toHaveLength(0)
},30000)

it('recovers original creation and ciphertext after committed reply loss and profile restart',async()=>{
  const p=await profile(),group=await p.createGroup(),binding=p.services.chatNetwork.publish({chatId:group.id,publicationId:'aside-restart'}),request={chatId:group.id,asideId:'lost-creation',participants:[p.services.net.runtime().identity.self()!.user]},rt=p.services.net.runtime(),checkpoint=rt.db.checkpoint.bind(rt.db)
  const fault=vi.spyOn(rt.db,'checkpoint').mockImplementation(point=>{if(point==='chats.aside.afterCommit')throw new Error('lost private creation response');checkpoint(point)})
  await expect(p.services.chatNetwork.asideCreate(request)).rejects.toThrow('lost private creation response');fault.mockRestore()
  const row=rt.db.database.prepare('SELECT * FROM net_chat_asides').get()!,parent=rt.outbox.get(row.opening as any)!,control=rt.outbox.get(row.control as any)!
  await p.services.stop();const reopened=await profile({home:p.home,profileId:p.profileId})
  const created=await reopened.services.chatNetwork.asideCreate(request)
  expect(created).toMatchObject({stream:row.stream,opening:row.opening,control:row.control,state:'sent'})
  expect(reopened.services.spaces.store.getById(binding.channel,created.opening)?.envelope).toEqual(parent.envelope)
  expect(reopened.services.spaces.store.getById(created.stream,created.control)?.envelope).toEqual(control.envelope)
  const next=reopened.services.net.runtime(),nextCheckpoint=next.db.checkpoint.bind(next.db),loss=vi.spyOn(next.db,'checkpoint').mockImplementation(point=>{if(point==='chats.aside.message.afterCommit')throw new Error('lost ciphertext reply');nextCheckpoint(point)})
  const message={chatId:group.id,stream:created.stream,text:'exact sealed original',clientMessageId:'restart-message'}
  await expect(reopened.services.chatNetwork.asideSend(message)).rejects.toThrow('lost ciphertext reply');loss.mockRestore()
  const event=next.db.database.prepare('SELECT event FROM net_chat_aside_messages').get()!.event as any,bytes=next.outbox.get(event)!.envelope
  await reopened.services.stop();const again=await profile({home:p.home,profileId:p.profileId}),sent=await again.services.chatNetwork.asideSend(message)
  expect(sent.delivery.id).toBe(event);expect(sent.delivery.state).toBe('sent');expect(again.services.spaces.store.getById(created.stream,event)?.envelope).toEqual(bytes)
  expect(again.services.spaces.store.head(created.stream).seq).toBe(2)
},25000)

it('rolls back private creation/control slots and ciphertext journals without rolling a nonce anchor backwards',async()=>{
  const p=await profile(),group=await p.createGroup();p.services.chatNetwork.publish({chatId:group.id,publicationId:'aside-rollback'})
  const rt=p.services.net.runtime(),request={chatId:group.id,asideId:'rollback-aside',participants:[rt.identity.self()!.user]},checkpoint=rt.db.checkpoint.bind(rt.db)
  const failure=vi.spyOn(rt.db,'checkpoint').mockImplementation(point=>{if(point==='chats.aside.beforeCommit')throw new Error('creation rollback');checkpoint(point)})
  await expect(p.services.chatNetwork.asideCreate(request)).rejects.toThrow('creation rollback');failure.mockRestore()
  expect(rt.db.database.prepare('SELECT count(*) AS n FROM net_chat_asides').get()!.n).toBe(0)
  expect(rt.db.database.prepare('SELECT count(*) AS n FROM net_private_control').get()!.n).toBe(0)
  expect(p.services.spaces.store.listStreams({kind:'space.private'})).toHaveLength(0)
  const created=await p.services.chatNetwork.asideCreate(request),message={chatId:group.id,stream:created.stream,text:'rollback nonce',clientMessageId:'nonce-original'}
  const nonceBefore=rt.db.database.prepare('SELECT counter FROM net_private_nonce WHERE stream=?').get(created.stream)!.counter
  const failMessage=vi.spyOn(rt.db,'checkpoint').mockImplementation(point=>{if(point==='chats.aside.message.beforeCommit')throw new Error('message rollback');checkpoint(point)})
  await expect(p.services.chatNetwork.asideSend(message)).rejects.toThrow('message rollback');failMessage.mockRestore()
  expect(rt.db.database.prepare('SELECT count(*) AS n FROM net_chat_aside_messages').get()!.n).toBe(0)
  expect(BigInt(String(rt.db.database.prepare('SELECT counter FROM net_private_nonce WHERE stream=?').get(created.stream)!.counter))).toBeGreaterThan(BigInt(String(nonceBefore)))
  expect((await p.services.chatNetwork.asideSend(message)).delivery.state).toBe('sent')
},20000)

it('denies unprotected keys, missing self, guessed streams, foreign current removal and cross-channel injection before ciphertext effects',async()=>{
  const plain=await profile({protect:false}),local=await plain.createGroup()
  // Publication already requires protection; plain key denial precedes any
  // creation even when the caller guesses a local Chat identity.
  await expect(plain.services.chatNetwork.asideCreate({chatId:local.id,asideId:'plain',participants:[plain.services.net.runtime().identity.self()!.user]})).rejects.toMatchObject({code:'keystore_locked'})
  const f=await linked(),request={chatId:f.created.id,asideId:'current-aside',participants:f.participants},created=await f.creator.services.chatNetwork.asideCreate(request)
  await expect(f.creator.services.chatNetwork.asideCreate({...request,asideId:'missing-self',participants:[f.participants[1]]})).rejects.toMatchObject({code:'forbidden'})
  await expect(f.creator.services.chatNetwork.asideSend({chatId:f.created.id,stream:newId('stream'),text:'guessed',clientMessageId:'guessed'})).rejects.toMatchObject({code:'forbidden'})
  await expect(f.outsider.services.chatNetwork.asideSend({chatId:f.outside.id,stream:created.stream,text:'not a recipient',clientMessageId:'outside'})).rejects.toMatchObject({code:'forbidden'})
  const otherChannel=f.host.services.spaces.host.createChannel(f.binding.space,'other')
  await vi.waitFor(()=>expect(f.creator.services.spaces.meta.channel(f.binding.space,otherChannel)).toBeDefined())
  const otherChat=await f.creator.services.chatNetwork.bind({bindingId:'other-channel',space:f.binding.space,channel:otherChannel})
  const otherAside=await f.creator.services.chatNetwork.asideCreate({chatId:otherChat.id,asideId:'other-aside',participants:f.participants})
  await expect(f.creator.services.chatNetwork.asideSend({chatId:f.created.id,stream:otherAside.stream,text:'cross channel',clientMessageId:'cross-channel'})).rejects.toMatchObject({code:'forbidden'})
  f.host.services.spaces.host.postMeta(f.binding.space,'member.removed',{user:f.participants[0]})
  await expect(f.creator.services.chatNetwork.asideSend({chatId:f.created.id,stream:created.stream,text:'removed',clientMessageId:'removed'})).rejects.toThrow()
  expect(f.creator.services.net.runtime().db.database.prepare('SELECT count(*) AS n FROM net_chat_aside_messages').get()!.n).toBe(0)
  expect(f.host.services.spaces.store.head(created.stream).seq).toBe(1)
},30000)

it('rejects a cached prior private audience before sealing when the current controller removes the recipient but keeps Space membership',async()=>{
  const f=await linked(),created=await f.creator.services.chatNetwork.asideCreate({chatId:f.created.id,asideId:'audience-change',participants:f.participants})
  await vi.waitFor(()=>expect(f.recipient.services.spaces.store.getById(f.binding.channel,created.opening)).toBeDefined())
  await f.recipient.services.chatNetwork.work({chatId:f.received.id,stream:created.stream})
  const event=f.creator.services.spaces.private.rotate(created.stream,[f.participants[0]])
  await f.creator.services.spaces.flush(f.binding.space)
  expect(f.creator.services.net.runtime().outbox.get(event.id)?.state).toBe('sent')
  expect(f.host.services.spaces.private.state(created.stream)?.control.participants).toEqual([f.participants[0]])
  expect(f.recipient.services.spaces.meta.member(f.binding.space,f.participants[1])).toBeDefined()
  expect(f.recipient.services.spaces.session(f.binding.space)?.state()).toBe('open')
  const rt=f.recipient.services.net.runtime(),before=rt.db.database.prepare('SELECT counter FROM net_private_nonce WHERE stream=?').get(created.stream)!.counter
  await expect(f.recipient.services.chatNetwork.asideSend({chatId:f.received.id,stream:created.stream,text:'stale audience',clientMessageId:'removed-private'})).rejects.toThrow()
  expect(rt.db.database.prepare('SELECT count(*) AS n FROM net_chat_aside_messages').get()!.n).toBe(0)
  expect(rt.db.database.prepare('SELECT counter FROM net_private_nonce WHERE stream=?').get(created.stream)!.counter).toBe(before)
},30000)

it('keeps an aside read and send owned until both finish when they overlap during actual TLS subscription catchup',async()=>{
  const f=await linked(),created=await f.creator.services.chatNetwork.asideCreate({chatId:f.created.id,asideId:'read-send-overlap',participants:f.participants})
  await f.creator.services.chatNetwork.asideGet({chatId:f.created.id,stream:created.stream})
  const source=f.host.services.net.session(f.creator.services.net.runtime().identity.self()!.node) as any,client=f.creator.services.spaces.session(f.binding.space)!,send=source.send.bind(source),subscribe=client.subscribe.bind(client)
  let entered!:()=>void,release!:()=>void,held=false
  const started=new Promise<void>(resolve=>{entered=resolve}),gate=new Promise<void>(resolve=>{release=resolve}),handlers:Array<{onError(code:'cancelled'):void}>=[]
  const capture=vi.spyOn(client,'subscribe').mockImplementation((stream,listener)=>{if(stream===created.stream)handlers.push(listener);return subscribe(stream,listener)})
  const pause=vi.spyOn(source,'send').mockImplementation(async(header:any,parts:any,signal:any)=>{if(!held&&header.t==='caughtUp'&&header.stream===created.stream){held=true;entered();await gate}return send(header,parts,signal)})
  const sending=f.creator.services.chatNetwork.asideSend({chatId:f.created.id,stream:created.stream,text:'overlapping private original',clientMessageId:'overlap-original'})
  let reading:ReturnType<typeof f.creator.services.chatNetwork.asideGet>|undefined
  try{
    await started
    reading=f.creator.services.chatNetwork.asideGet({chatId:f.created.id,stream:created.stream})
    expect(f.creator.services.chatNetwork.activeCount()).toBeGreaterThan(0)
    await new Promise(resolve=>setTimeout(resolve,100));release()
    const complete=Promise.all([sending,reading]).then(()=>true)
    expect(await Promise.race([complete,new Promise(resolve=>setTimeout(()=>resolve(false),2000))])).toBe(true)
    const [sent,view]=await Promise.all([sending,reading])
    expect(sent.delivery.state).toBe('sent');expect(view.records.find(row=>row.envelope.id===sent.delivery.id)?.privateBody).toEqual({text:'overlapping private original'})
  }finally{
    release();pause.mockRestore();capture.mockRestore()
    // Drain a cancelled reader after observing the original failure. This
    // cleanup does not alter the actual protocol path under assertion.
    for(const listener of handlers)listener.onError('cancelled')
    await Promise.allSettled([sending,...(reading?[reading]:[])])
  }
},30000)
