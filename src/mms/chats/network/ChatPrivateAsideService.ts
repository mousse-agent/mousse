import type { ChatAsideCreateInput, ChatAsideCreation, ChatAsideSendInput, ChatAsideSendResult, ChatNetworkBinding, ChatAsideProjection, ChatWorkProjection } from '../../../shared/chatsNetwork'
import { NetError, isId, newId, type Envelope, type NodeDelegation, type Roster, type SpaceId, type StreamId, type UserId, type EventId } from '../../../shared/net'
import type { SpaceLocalDelivery } from '../../../shared/spaces/local'
import type { NetRuntime } from '../../net/NetService'
import type { OutboxEntry } from '../../net/contracts'
import { canonicalJson, decodeEnvelope } from '../../net/sync/codec'
import { digest, json, same } from '../../net/store/database'
import type { SpaceProfileService } from '../../spaces/SpaceProfileService'
import { privateContentAAD } from '../../spaces/private/service'

export const chatPrivateClientKey=(value:unknown):value is string=>typeof value==='string'&&/^[A-Za-z0-9_-]{1,128}$/.test(value)&&!['__proto__','constructor','prototype'].includes(value)

/** Human asides only. The exact committed channel opening is their Chat authority. */
export class ChatPrivateAsideService {
  constructor(readonly options:{rt:NetRuntime;spaces:SpaceProfileService;profileId:string;check(id:string):ChatNetworkBinding;fresh(id:string):Promise<ChatNetworkBinding>;prepareAudience(space:SpaceId,participants:UserId[]):Promise<void>}){
    options.rt.db.transaction(()=>options.rt.db.database.exec(`
      CREATE TABLE IF NOT EXISTS net_chat_asides(profile TEXT NOT NULL,chat TEXT NOT NULL,client_key TEXT NOT NULL,request_hash TEXT NOT NULL,stream TEXT NOT NULL UNIQUE,participants TEXT NOT NULL,opening TEXT NOT NULL,control TEXT NOT NULL,
        PRIMARY KEY(profile,chat,client_key),FOREIGN KEY(profile,chat) REFERENCES net_chat_publications(profile,chat)) STRICT;
      CREATE TABLE IF NOT EXISTS net_chat_aside_messages(profile TEXT NOT NULL,chat TEXT NOT NULL,stream TEXT NOT NULL,client_key TEXT NOT NULL,request_hash TEXT NOT NULL,event TEXT NOT NULL UNIQUE,
        PRIMARY KEY(profile,chat,stream,client_key),FOREIGN KEY(profile,chat) REFERENCES net_chat_publications(profile,chat)) STRICT;
    `))
  }
  async create(value:ChatAsideCreateInput):Promise<ChatAsideCreation>{
    const input=structuredClone(value),{rt,spaces}=this.options
    if(!chatPrivateClientKey(input.asideId)||!Array.isArray(input.participants)||!input.participants.length||input.participants.length>16||new Set(input.participants).size!==input.participants.length||input.participants.some(user=>!isId('user',user)))throw new NetError('bad_request')
    if(rt.db.inTransaction)throw new NetError('forbidden')
    this.protected();const participants=[...input.participants].sort(),hash=digest(canonicalJson({participants})),binding=await this.options.fresh(input.chatId)
    if(!participants.includes(this.selfPeer().user))throw new NetError('forbidden')
    await this.options.prepareAudience(binding.space,participants)
    this.options.check(input.chatId);this.protected()
    let row=rt.db.database.prepare('SELECT * FROM net_chat_asides WHERE profile=? AND chat=? AND client_key=?').get(this.options.profileId,input.chatId,input.asideId)
    if(row&&row.request_hash!==hash)throw new NetError('conflict')
    if(!row){
      // The composed key port is lazy. Its schema must be durable outside the
      // enclosing prepare transaction, so a rollback cannot cache absent tables.
      void spaces.private.options.privateKeys.rotate
      rt.db.transaction(()=>{
        this.options.check(input.chatId);this.protected()
        if(Number(rt.db.database.prepare('SELECT count(*) AS n FROM net_chat_asides WHERE profile=? AND chat=?').get(this.options.profileId,input.chatId)!.n)>=128||Number(rt.db.database.prepare('SELECT count(*) AS n FROM net_chat_asides').get()!.n)>=10000)throw new NetError('too_large')
        // The existing preparation commits descriptor, wrapped control and both
        // original signed outbox entries in this same transaction. An orphan
        // protected key after rollback has no adopted control or active stream.
        const prepared=spaces.private.prepareCreation(binding.space,binding.channel,participants)
        rt.db.charge(1,1024)
        rt.db.database.prepare('INSERT INTO net_chat_asides VALUES(?,?,?,?,?,?,?,?)').run(this.options.profileId,input.chatId,input.asideId,hash,prepared.descriptor.id,json(participants),prepared.parentEvent.id,prepared.event.id)
        rt.db.checkpoint('chats.aside.beforeCommit')
      })
      rt.db.checkpoint('chats.aside.afterCommit')
      row=rt.db.database.prepare('SELECT * FROM net_chat_asides WHERE profile=? AND chat=? AND client_key=?').get(this.options.profileId,input.chatId,input.asideId)!
    }
    if(!isId('stream',row.stream))throw new NetError('storage_corrupt')
    if(rt.db.database.prepare('SELECT 1 FROM net_space_private_prepared WHERE stream=?').get(row.stream)){
      await this.options.fresh(input.chatId)
      try{await spaces.private.publishCreation(row.stream)}catch(error){if(!(error instanceof NetError)||!error.retryable&&error.code!=='outcome_uncertain')throw error}
    }
    this.options.check(input.chatId)
    return this.creation(input,row)
  }
  private creation(input:ChatAsideCreateInput,row:Record<string,unknown>):ChatAsideCreation{
    const {rt}=this.options
    if(!isId('stream',row.stream)||!isId('event',row.opening)||!isId('event',row.control))throw new NetError('storage_corrupt')
    const parent=rt.outbox.get(row.opening),control=rt.outbox.get(row.control)
    if(!parent||!control||control.stream!==row.stream||parent.stream!==this.options.check(input.chatId).channel)throw new NetError('storage_corrupt')
    const state=parent.state==='failed'||control.state==='failed'?'failed':parent.state==='sent'&&control.state==='sent'?'sent':parent.state==='unknown'||control.state==='unknown'?'unknown':'pending'
    return{chatId:input.chatId,asideId:input.asideId,stream:row.stream,participants:JSON.parse(String(row.participants)),opening:row.opening,control:row.control,state,parentDelivery:this.delivery(parent),controlDelivery:this.delivery(control)}
  }
  async send(value:ChatAsideSendInput):Promise<ChatAsideSendResult>{
    const input={...value},{rt,spaces}=this.options
    if(!isId('stream',input.stream)||!chatPrivateClientKey(input.clientMessageId)||typeof input.text!=='string'||!input.text.trim()||Buffer.byteLength(input.text)>32*1024||Buffer.from(input.text).toString()!==input.text)throw new NetError('bad_request')
    if(rt.db.inTransaction)throw new NetError('forbidden')
    this.protected();await this.options.fresh(input.chatId)
    let current=this.audience(input.chatId,input.stream)
    if(current.descriptor.authority!==rt.identity.self()?.node){
      // The known stream must catch up through the current authority ACL before
      // nonce reservation; cached control/key ownership alone is insufficient.
      await spaces.client.subscribe(input.stream)
      this.options.check(input.chatId);this.protected();current=this.audience(input.chatId,input.stream)
    }
    const hash=digest(canonicalJson({text:input.text}))
    let row=rt.db.database.prepare('SELECT event,request_hash FROM net_chat_aside_messages WHERE profile=? AND chat=? AND stream=? AND client_key=?').get(this.options.profileId,input.chatId,input.stream,input.clientMessageId)
    if(row&&row.request_hash!==hash)throw new NetError('conflict')
    if(!row){
      const peer=this.selfPeer(),meta=spaces.meta.assertUsable(current.descriptor.space!,true),id=newId('event'),envelope:Envelope={v:1,minor:0,id,stream:input.stream,type:'message.posted',crit:false,author:{user:peer.user,node:peer.node,keyEpoch:peer.delegation.keyEpoch},ts:rt.db.clock.now(),auth:{metaEpoch:meta.epoch,metaSeq:meta.seq}}
      // Reserve the durable nonce BEFORE the outbox transaction. Rollback may
      // burn that nonce, but cannot roll the SQL counter behind its key anchor.
      envelope.sealed=spaces.private.options.privateKeys.seal(input.stream,canonicalJson({text:input.text}),privateContentAAD(envelope))
      const bytes=canonicalJson(envelope),sig=rt.keys.signAsNode(bytes);decodeEnvelope(bytes)
      rt.db.transaction(()=>{
        this.options.check(input.chatId);this.protected()
        const fresh=this.audience(input.chatId,input.stream),now=spaces.meta.assertUsable(fresh.descriptor.space!,true)
        if(!same(fresh.state.control,current.state.control)||now.epoch!==meta.epoch||now.seq!==meta.seq||!spaces.private.canWrite(fresh.descriptor,envelope,peer))throw new NetError('forbidden')
        rt.identity.verifyAuthor(envelope.author,bytes,sig,envelope.ts,'newWork')
        if(Number(rt.db.database.prepare('SELECT count(*) AS n FROM net_chat_aside_messages WHERE profile=? AND chat=?').get(this.options.profileId,input.chatId)!.n)>=4096||Number(rt.db.database.prepare('SELECT count(*) AS n FROM net_chat_aside_messages').get()!.n)>=100000)throw new NetError('too_large')
        rt.outbox.enqueue({id,stream:input.stream,envelope:bytes,sig})
        rt.db.charge(1,512)
        rt.db.database.prepare('INSERT INTO net_chat_aside_messages VALUES(?,?,?,?,?,?)').run(this.options.profileId,input.chatId,input.stream,input.clientMessageId,hash,id)
        rt.db.checkpoint('chats.aside.message.beforeCommit')
      })
      rt.db.checkpoint('chats.aside.message.afterCommit');row={event:id,request_hash:hash}
    }
    if(!isId('event',row.event))throw new NetError('storage_corrupt')
    await spaces.flush(current.descriptor.space!);this.audience(input.chatId,input.stream)
    const entry=rt.outbox.get(row.event)
    if(!entry||entry.stream!==input.stream)throw new NetError('storage_corrupt')
    return{chatId:input.chatId,stream:input.stream,delivery:this.delivery(entry)}
  }
  projection(chat:string,view:ChatWorkProjection):ChatAsideProjection{
    const {descriptor,state}=this.audience(chat,view.descriptor.id)
    if(!view.private||!same(view.descriptor,descriptor))throw new NetError('forbidden')
    return{...view,private:true,audience:{controller:state.controller,participants:state.control.participants as UserId[],keyEpoch:state.control.keyEpoch,visibilityEpoch:state.control.visibilityEpoch}}
  }
  private audience(chat:string,stream:StreamId){
    const binding=this.options.check(chat),{spaces}=this.options,descriptor=spaces.store.getStream(stream),state=spaces.private.state(stream),peer=this.selfPeer()
    if(descriptor?.kind!=='space.private'||descriptor.space!==binding.space||descriptor.parent!==binding.channel||!state||state.blocked||!spaces.private.canRead(descriptor,peer)||state.control.participants.some(actor=>!isId('user',actor)))throw new NetError('forbidden')
    const rows=this.options.rt.db.database.prepare("SELECT r.envelope,r.sig FROM net_records r JOIN net_streams s ON s.active_generation=r.generation WHERE s.id=? AND json_extract(CAST(r.envelope AS TEXT),'$.type')='thread.opened' AND json_extract(CAST(r.envelope AS TEXT),'$.body.stream')=? LIMIT 2").all(binding.channel,stream)
    if(rows.length!==1)throw new NetError('forbidden')
    const bytes=rows[0].envelope as Uint8Array,sig=rows[0].sig as Uint8Array,opening=decodeEnvelope(bytes).envelope
    if(opening.stream!==binding.channel||opening.type!=='thread.opened'||(opening.body as {private?:boolean}).private!==true)throw new NetError('forbidden')
    spaces.client.options.identity.verifyAuthor(opening.author,bytes,sig,opening.ts,'history')
    return{descriptor,state}
  }
  private protected():void{const {rt}=this.options;if(rt.keys.state()!=='unlocked'||!rt.keys.encryptedAtRest())throw new NetError('keystore_locked');this.selfPeer()}
  private selfPeer(){
    const {rt}=this.options,self=rt.identity.self(),root=self&&rt.identity.pinnedRootKey(self.user),signed=self&&rt.identity.roster(self.user)
    if(!self||!root||!signed||rt.identity.rosterState(self.user)!=='ok')throw new NetError('bad_delegation')
    const roster=rt.identity.verifySigned<Roster>(signed,root),delegation=roster.nodes.map(row=>rt.identity.verifySigned<NodeDelegation>(row,root)).filter(row=>row.subject===self.node).sort((a,b)=>b.keyEpoch-a.keyEpoch||b.issuedAt-a.issuedAt)[0],now=rt.db.clock.now()
    if(!delegation||delegation.issuedAt>now||now>=delegation.expiresAt||roster.revoked.some(row=>row.subject===self.node&&row.throughKeyEpoch>=delegation.keyEpoch)||!delegation.caps.includes('write'))throw new NetError('forbidden')
    return{...self,delegation}
  }
  private delivery(entry:OutboxEntry):SpaceLocalDelivery{return{id:entry.id,stream:entry.stream,state:entry.state,attempts:entry.attempts,createdAt:entry.createdAt,...(entry.position?{position:entry.position}:{}),...(entry.error?{error:entry.error}:{})}}
}
