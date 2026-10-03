import { existsSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { ChatConversation, ChatsSnapshot } from '../../../shared/chats'
import type { ChatBindInput, ChatNetworkBinding, ChatNetworkPageInput, ChatNetworkSendInput, ChatPublishInput, ChatWorkGetInput, ChatWorkProjection, NetworkChatConversation, NetworkChatParticipant } from '../../../shared/chatsNetwork'
import type { ChatTaskDispatchInput, ChatTaskDispatchResult, ChatTaskGetInput, ChatTaskListInput, ChatTaskPage, ChatTaskRead, ChatTaskSelection, ChatTaskSelectionInput } from '../../../shared/chatsNetwork'
import { isId, NetError, spaceMetaStream, type EventId, type NodeDelegation, type Roster, type SpaceId, type StreamDescriptor, type StreamId, type UserId } from '../../../shared/net'
import type { NetRuntime } from '../../net/NetService'
import { digest, json } from '../../net/store/database'
import { decodeEnvelope } from '../../net/sync/codec'
import type { SpaceProfileService } from '../../spaces/SpaceProfileService'
import { DomainRpcError } from '../../protocol/domainRegistry'
import { chatId } from '../ChatStore'
import type { AgentChatService } from '../AgentChatService'
import type { BridgeHub } from '../../bridge/hub'
import { ChatTaskDispatchService } from './ChatTaskDispatchService'
import { ChatPrivateAsideService } from './ChatPrivateAsideService'
import type { ChatAsideCreateInput, ChatAsideCreation, ChatAsideSendInput, ChatAsideSendResult, ChatAsideGetInput, ChatAsideProjection } from '../../../shared/chatsNetwork'

interface PublicationRow {
  publication_id: string; request_hash: string; state: string; space: SpaceId | null; channel: StreamId | null;
  owner: UserId; local_count: number; local_last: string | null
}
interface PresentationRow { profile: string; chat: string; name: string; created_at: number }
export interface ChatNetworkBindingOptions {
  profileId: string; profileHome: string; chats: AgentChatService
  runtime(): NetRuntime
  spaces(): SpaceProfileService
  hub():BridgeHub
  preparePrivateAudience(space:SpaceId,participants:UserId[]):Promise<void>
}
const clientKey = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value) && !['__proto__', 'constructor', 'prototype'].includes(value)
const hash = (value: unknown): string => digest(Buffer.from(json(value)))

/** Durable dispatch authority lives only in net.db; the local transcript is never rewritten. */
export class ChatNetworkBindingService {
  private stopped = false
  private readonly pending = new Set<Promise<unknown>>()
  private readonly bindingWork = new Map<string,{key:string;work:Promise<NetworkChatConversation>}>()
  private readonly connections = new Map<SpaceId,Promise<void>>()
  private schemaRuntime?: NetRuntime
  private taskDispatch?:ChatTaskDispatchService
  private privateAsides?:ChatPrivateAsideService
  private asideSends=new Map<string,{hash:string;work:Promise<ChatAsideSendResult>}>()
  private asideStreams=new Map<string,Promise<unknown>>()
  private asideCreations=new Map<string,{hash:string;work:Promise<ChatAsideCreation>}>()
  constructor(readonly options: ChatNetworkBindingOptions) {
    if (options.chats.profileId !== options.profileId) throw new DomainRpcError('profile_mismatch', 'Chats belong to another profile')
    options.chats.setNetworkBindingGuard(id => this.blocksLocal(id))
  }
  private runtime(): NetRuntime {
    const rt = this.options.runtime()
    if (rt.db.directory !== join(realpathSync(this.options.profileHome), 'net')) throw new NetError('forbidden')
    if (this.schemaRuntime !== rt) {
      rt.db.transaction(() => rt.db.database.exec(`
        CREATE TABLE IF NOT EXISTS net_chat_publications(
          profile TEXT NOT NULL, chat TEXT NOT NULL, publication_id TEXT NOT NULL, request_hash TEXT NOT NULL,
          state TEXT NOT NULL CHECK(state IN ('publishing','published')), owner TEXT NOT NULL,
          space TEXT, channel TEXT, local_count INTEGER NOT NULL, local_last TEXT,
          PRIMARY KEY(profile,chat), UNIQUE(profile,publication_id), UNIQUE(channel)
        ) STRICT;
        CREATE TABLE IF NOT EXISTS net_chat_message_keys(
          profile TEXT NOT NULL, chat TEXT NOT NULL, client_key TEXT NOT NULL, request_hash TEXT NOT NULL, event TEXT NOT NULL UNIQUE,
          PRIMARY KEY(profile,chat,client_key), FOREIGN KEY(profile,chat) REFERENCES net_chat_publications(profile,chat)
        ) STRICT;
        CREATE TABLE IF NOT EXISTS net_chat_presentations(
          profile TEXT NOT NULL, chat TEXT NOT NULL, name TEXT NOT NULL, created_at INTEGER NOT NULL,
          PRIMARY KEY(profile,chat), FOREIGN KEY(profile,chat) REFERENCES net_chat_publications(profile,chat)
        ) STRICT;
      `))
      this.schemaRuntime = rt
    }
    return rt
  }
  private row(id: string): PublicationRow | undefined {
    if (!chatId(id)) throw new DomainRpcError('invalid_params', 'Invalid Group identity')
    // Ordinary local Chats do not activate Net. An established missing ledger
    // must still hit NetDatabase's recovery fence instead of restoring local execution.
    const dir = join(this.options.profileHome, 'net')
    if (!existsSync(join(dir, 'net.db')) && !existsSync(join(dir, 'ledger-established'))) return undefined
    return this.runtime().db.database.prepare('SELECT * FROM net_chat_publications WHERE profile=? AND chat=?').get(this.options.profileId, id) as unknown as PublicationRow | undefined
  }
  blocksLocal(id: string): boolean { return !!this.row(id) }
  selectTask(input:ChatTaskSelectionInput):ChatTaskSelection{this.accepting();return this.tasks().select(input)}
  listTasks(input:ChatTaskListInput):ChatTaskPage{this.accepting();return this.tasks().list({...input})}
  getTask(input:ChatTaskGetInput):Promise<ChatTaskRead>{
    this.accepting();input={...input}
    return this.track(async()=>{
      const tasks=this.tasks(),status=tasks.readStatus(input)
      if(input.result&&status.status.state!=='prepared'&&status.status.state!=='failed'){
        await this.freshRead(input.chatId)
        const read=await tasks.get(input)
        await this.freshRead(input.chatId)
        return{...read,selection:tasks.readStatus(input)}
      }
      return tasks.get(input)
    })
  }
  dispatch(input:ChatTaskDispatchInput):Promise<ChatTaskDispatchResult>{
    this.accepting();input={...input}
    return this.track(async()=>{
      await this.freshWrite(input.chatId)
      return this.tasks().dispatch(input)
    })
  }
  private async freshWrite(id:string):Promise<ChatNetworkBinding>{
      const binding=this.checked(id),spaces=this.options.spaces(),rt=this.runtime(),descriptor=spaces.store.getStream(binding.channel)!
      if(!spaces.canStartSpaceWork(binding.space))throw new NetError('space_frozen')
      spaces.meta.assertUsable(binding.space,true)
      let head
      if(descriptor.authority===rt.identity.self()?.node)head=spaces.store.head(spaceMetaStream(binding.space))
      else{
        const session=spaces.session(binding.space)
        if(!session||session.state()!=='open'||session.peer.node!==descriptor.authority||session.peer.user!==binding.owner)throw new NetError('peer_offline')
        head=await session.metaHead(spaceMetaStream(binding.space))
      }
      this.accepting();this.checked(id)
      const meta=spaces.meta.assertUsable(binding.space,true)
      if(!spaces.canStartSpaceWork(binding.space))throw new NetError('space_frozen')
      if(head.epoch!==meta.epoch||head.seq!==meta.seq)throw new NetError('meta_stale')
      return binding
  }
  private async freshRead(id:string):Promise<void>{
    const binding=this.checked(id),spaces=this.options.spaces(),rt=this.runtime(),descriptor=spaces.store.getStream(binding.channel)!
    let head
    if(descriptor.authority===rt.identity.self()?.node)head=spaces.store.head(spaceMetaStream(binding.space))
    else{
      const session=spaces.session(binding.space)
      if(!session||session.state()!=='open'||session.peer.node!==descriptor.authority||session.peer.user!==binding.owner)throw new NetError('peer_offline')
      head=await session.metaHead(spaceMetaStream(binding.space))
    }
    this.accepting();const current=this.checked(id),meta=spaces.meta.assertUsable(current.space)
    if(current.space!==binding.space||current.channel!==binding.channel||current.owner!==binding.owner)throw new NetError('conflict')
    if(head.epoch!==meta.epoch||head.seq!==meta.seq)throw new NetError('meta_stale')
  }
  asideCreate(input:ChatAsideCreateInput):Promise<ChatAsideCreation>{
    this.accepting();if(this.runtime().db.inTransaction)throw new NetError('forbidden');input=structuredClone(input)
    const key=json({chatId:input.chatId,asideId:input.asideId}),requestHash=hash({participants:Array.isArray(input.participants)?[...input.participants].sort():input.participants}),old=this.asideCreations.get(key)
    if(old)return old.hash===requestHash?old.work:Promise.reject(new NetError('conflict'))
    const work=this.track(()=>this.asides().create(input));this.asideCreations.set(key,{hash:requestHash,work})
    const settled=()=>this.asideCreations.delete(key);void work.then(settled,settled);return work
  }
  asideSend(input:ChatAsideSendInput):Promise<ChatAsideSendResult>{
    this.accepting();if(this.runtime().db.inTransaction)throw new NetError('forbidden');input={...input}
    const key=json({chatId:input.chatId,stream:input.stream,clientMessageId:input.clientMessageId}),requestHash=hash({text:input.text}),old=this.asideSends.get(key)
    if(old)return old.hash===requestHash?old.work:Promise.reject(new NetError('conflict'))
    const work=this.queueAsideStream(input.stream,()=>this.asides().send(input))
    this.asideSends.set(key,{hash:requestHash,work})
    const settled=()=>this.asideSends.delete(key);void work.then(settled,settled);return work
  }
  asideGet(input:ChatAsideGetInput):Promise<ChatAsideProjection>{this.accepting();input=structuredClone(input);return this.queueAsideStream(input.stream,async()=>this.asides().projection(input.chatId,await this.work(input)))}
  private queueAsideStream<T>(stream:string,operation:()=>Promise<T>):Promise<T>{
    const previous=this.asideStreams.get(stream),work=this.track(async()=>{if(previous)await previous.catch(()=>{});return operation()})
    this.asideStreams.set(stream,work)
    const settled=()=>{if(this.asideStreams.get(stream)===work)this.asideStreams.delete(stream)}
    void work.then(settled,settled);return work
  }
  private asides():ChatPrivateAsideService{
    return this.privateAsides??=new ChatPrivateAsideService({rt:this.runtime(),spaces:this.options.spaces(),profileId:this.options.profileId,
      check:id=>{this.accepting();const binding=this.checked(id),spaces=this.options.spaces();spaces.meta.assertUsable(binding.space,true);if(!spaces.canStartSpaceWork(binding.space))throw new NetError('space_frozen');return binding},
      fresh:id=>this.freshWrite(id),prepareAudience:(...args)=>this.options.preparePrivateAudience(...args)})
  }
  private tasks():ChatTaskDispatchService{
    if(!this.taskDispatch)this.taskDispatch=new ChatTaskDispatchService(this.runtime(),this.options.hub(),this.options.profileId,id=>{this.accepting();const binding=this.checked(id),spaces=this.options.spaces();spaces.meta.assertUsable(binding.space,true);if(!spaces.canStartSpaceWork(binding.space))throw new NetError('space_frozen');return binding},(space,bot)=>{const row=this.options.spaces().meta.state(space)?.bots.get(bot);return row?{owner:row.owner,hostNode:row.delegation.hostNode}:undefined},id=>{this.accepting();return this.checked(id)})
    return this.taskDispatch
  }
  private presentation(id: string): PresentationRow | undefined {
    return this.runtime().db.database.prepare('SELECT * FROM net_chat_presentations WHERE profile=? AND chat=?').get(this.options.profileId,id) as unknown as PresentationRow | undefined
  }
  bind(input: ChatBindInput): Promise<NetworkChatConversation> {
    this.accepting()
    input={...input}
    const scope=json({space:input.space,channel:input.channel}), key=json(input), pending=this.bindingWork.get(scope)
    if(pending)return pending.key===key?pending.work:Promise.reject(new NetError('conflict'))
    const work=this.track(async () => {
      if (!clientKey(input.bindingId) || !isId('space',input.space) || !isId('stream',input.channel)) throw new DomainRpcError('invalid_params','Invalid joined channel')
      const rt=this.runtime(), spaces=this.options.spaces()
      if (rt.db.inTransaction) throw new NetError('forbidden')
      const replica=spaces.client.binding(input.space)
      if (!replica || replica.state==='blocked') throw new NetError('not_member')
      if(spaces.session(input.space)?.state()!=='open'){
        let connection=this.connections.get(input.space)
        if(!connection){connection=spaces.client.connect(input.space);this.connections.set(input.space,connection);const held=connection;void connection.then(()=>{if(this.connections.get(input.space)===held)this.connections.delete(input.space)},()=>{if(this.connections.get(input.space)===held)this.connections.delete(input.space)})}
        await connection
      }
      this.accepting()
      await spaces.local.request('spaces.channels',{space:input.space})
      const descriptor=spaces.store.getStream(input.channel), meta=spaces.meta.assertUsable(input.space), self=rt.identity.self()
      if (!descriptor || descriptor.kind!=='space.channel' || descriptor.space!==input.space || !self || !spaces.meta.member(input.space,self.user) || !spaces.meta.canRead(input.space,descriptor,self.user)) throw new NetError('not_member')
      if (spaces.store.head(input.channel).epoch!==meta.epoch) throw new NetError('conflict')
      await spaces.client.subscribe(input.channel)
      this.accepting()
      const requestHash=hash({space:input.space,channel:input.channel})
      const id=rt.db.transaction(()=>{
        const current=spaces.meta.assertUsable(input.space), currentSelf=rt.identity.self(), channel=spaces.meta.channel(input.space,input.channel)
        if (!currentSelf || !spaces.meta.member(input.space,currentSelf.user) || !channel || !spaces.meta.canRead(input.space,descriptor,currentSelf.user) || spaces.store.head(input.channel).epoch!==current.epoch) throw new NetError('not_member')
        const previous=rt.db.database.prepare('SELECT chat,publication_id,request_hash FROM net_chat_publications WHERE profile=? AND (publication_id=? OR channel=?)').get(this.options.profileId,input.bindingId,input.channel)
        if (previous) {
          if (previous.publication_id!==input.bindingId || previous.request_hash!==requestHash || !this.presentation(String(previous.chat))) throw new NetError('conflict')
          return String(previous.chat)
        }
        if (Number(rt.db.database.prepare('SELECT count(*) AS n FROM net_chat_publications').get()!.n)>=10000) throw new NetError('too_large')
        const chat=randomUUID(), name=`${current.settings!.name} / ${channel.name}`, now=rt.db.clock.now()
        rt.db.charge(2,Buffer.byteLength(name)+1024)
        rt.db.database.prepare("INSERT INTO net_chat_publications VALUES(?,?,?,?,'published',?,?,?,0,NULL)").run(this.options.profileId,chat,input.bindingId,requestHash,current.owner!,input.space,input.channel)
        rt.db.database.prepare('INSERT INTO net_chat_presentations VALUES(?,?,?,?)').run(this.options.profileId,chat,name,now)
        rt.db.checkpoint('chats.binding.beforeCommit')
        return chat
      })
      rt.db.checkpoint('chats.binding.afterCommit')
      return this.get(id) as NetworkChatConversation
    })
    this.bindingWork.set(scope,{key,work})
    void work.then(()=>this.bindingWork.delete(scope),()=>this.bindingWork.delete(scope))
    return work
  }
  binding(id: string): ChatNetworkBinding | undefined {
    const row = this.row(id)
    if (!row) return undefined
    if (row.state !== 'published' || !row.space || !row.channel || !isId('space', row.space) || !isId('stream', row.channel) || !isId('user', row.owner)) throw new NetError('outcome_uncertain')
    return { publicationId: row.publication_id, space: row.space, channel: row.channel, owner: row.owner, state: 'published',
      localHistory: { messageCount: Number(row.local_count), ...(row.local_last ? { lastMessageId: row.local_last } : {}) } }
  }
  publish(input: ChatPublishInput): ChatNetworkBinding {
    this.accepting()
    if (!chatId(input.chatId) || !clientKey(input.publicationId) || input.name !== undefined && (typeof input.name !== 'string' || !input.name.trim() || input.name !== input.name.trim() || Array.from(input.name).length > 120 || /[\x00-\x1f\x7f]/.test(input.name))) throw new DomainRpcError('invalid_params', 'Invalid publication request')
    const rt = this.runtime()
    if (rt.db.inTransaction) throw new NetError('forbidden', 'Publication requires its own committed boundary')
    const conversation = this.options.chats.assertPublishable(input.chatId)
    const requestHash = hash({ chatId: input.chatId, name: input.name ?? conversation.name })
    const prior = this.row(input.chatId)
    if (prior) {
      if (prior.publication_id !== input.publicationId || prior.request_hash !== requestHash) throw new NetError('conflict')
      return this.checked(input.chatId)
    }
    if (rt.db.database.prepare('SELECT 1 FROM net_chat_publications WHERE profile=? AND publication_id=?').get(this.options.profileId, input.publicationId)) throw new NetError('conflict')
    const self = rt.identity.self()
    if (!self?.isAuthority || !rt.keys.rootKey()) throw new NetError('forbidden')
    if (!rt.keys.encryptedAtRest() || rt.keys.state() !== 'unlocked') throw new NetError('keystore_locked')
    const spaces = this.options.spaces()
    rt.db.transaction(() => {
      this.options.chats.assertPublishable(input.chatId)
      if (Number(rt.db.database.prepare('SELECT count(*) AS n FROM net_chat_publications').get()!.n) >= 10000) throw new NetError('too_large')
      rt.db.charge(1, 1024)
      rt.db.database.prepare("INSERT INTO net_chat_publications VALUES(?,?,?,?,'publishing',?,NULL,NULL,?,?)").run(this.options.profileId, input.chatId, input.publicationId, requestHash, self.user, conversation.messages.length, conversation.messages.at(-1)?.id ?? null)
      rt.db.checkpoint('chats.publication.reserved')
      const created = spaces.host.create({ name: input.name ?? conversation.name })
      const channel = spaces.host.createChannel(created.space, 'general')
      rt.db.checkpoint('chats.publication.hostCreated')
      rt.db.charge(1)
      rt.db.database.prepare("UPDATE net_chat_publications SET state='published',space=?,channel=? WHERE profile=? AND chat=?").run(created.space, channel, this.options.profileId, input.chatId)
      rt.db.checkpoint('chats.publication.beforeCommit')
    })
    // Losing the reply or the local display cannot undo the committed dispatch fence.
    rt.db.checkpoint('chats.publication.afterCommit')
    return this.checked(input.chatId)
  }
  private checked(id: string): ChatNetworkBinding {
    const binding = this.binding(id)
    if (!binding) throw new NetError('stream_unknown')
    const rt = this.runtime(), spaces = this.options.spaces(), self = rt.identity.self(), descriptor = spaces.store.getStream(binding.channel), meta = spaces.meta.assertUsable(binding.space)
    if (!self || !this.presentation(id) && self.user !== binding.owner || !spaces.meta.member(binding.space, self.user)) throw new NetError('not_member')
    if (descriptor?.kind !== 'space.channel' || descriptor.space !== binding.space || descriptor.authority!==spaces.meta.state(binding.space)!.descriptor.hostNode || spaces.store.head(descriptor.id).epoch !== meta.epoch || !spaces.meta.channel(binding.space, descriptor.id)) throw new NetError('conflict')
    if (!spaces.meta.canRead(binding.space, descriptor, self.user)) throw new NetError('forbidden')
    return binding
  }
  get(id: string, deliveryId?: EventId, input: ChatNetworkPageInput = {}): ChatConversation {
    this.accepting()
    const binding = this.checked(id), rt = this.runtime(), spaces = this.options.spaces()
    const presentation=this.presentation(id), head = spaces.store.head(binding.channel), limit=input.limit??128, after=input.after??{epoch:head.epoch,seq:0}
    if (!Number.isSafeInteger(limit) || limit<1 || limit>128 || !Number.isSafeInteger(after.epoch) || after.epoch<1 || !Number.isSafeInteger(after.seq) || after.seq<0 || after.seq>head.seq) throw new DomainRpcError('invalid_params','Invalid network page')
    if (after.epoch!==head.epoch) throw new NetError('snapshot_required')
    const page = spaces.store.read(binding.channel, after, head.seq, 256 * 1024)
    const records = page.records.slice(0, limit).map(record => ({ epoch: record.epoch, seq: record.seq, recvTs: record.recvTs, envelope: decodeEnvelope(record.envelope).envelope }))
    const last = records.at(-1), entry = deliveryId ? rt.outbox.get(deliveryId) : undefined
    if (deliveryId && (!entry || entry.stream !== binding.channel)) throw new NetError('conflict')
    const participants=this.participants(binding.space), cursor=last?{epoch:last.epoch,seq:last.seq}:after, state=spaces.meta.assertUsable(binding.space), self=rt.identity.self()!
    const network={binding,head,cursor,records,participants,offline:spaces.store.getStream(binding.channel)!.authority!==self.node && spaces.session(binding.space)?.state()!=='open',readonly:state.status!=='active' || !!spaces.meta.channel(binding.space,binding.channel)?.archived,
      ...(cursor.seq<head.seq?{nextAfter:cursor}:{}),...(entry?{delivery:{id:entry.id,stream:entry.stream,state:entry.state,attempts:entry.attempts,createdAt:entry.createdAt,...(entry.position?{position:entry.position}:{}),...(entry.error?{error:entry.error}:{})}}:{})}
    return presentation ? {presentation:'network',id,kind:'group',name:presentation.name,participants,createdAt:new Date(presentation.created_at).toISOString(),updatedAt:new Date(last?.recvTs??presentation.created_at).toISOString(),binding,messages:[],network} : {...this.options.chats.get(id),network}
  }
  private participants(space:SpaceId):NetworkChatParticipant[]{
    const state=this.options.spaces().meta.state(space)
    if (!state || state.members.size+state.bots.size>512) throw new NetError('too_large')
    return [...[...state.members].map(([id,row])=>({id,kind:'person' as const,name:row.displayName,active:true})),
      ...[...state.bots].map(([id,row])=>({id,kind:'agent' as const,name:row.displayName,active:state.members.has(row.owner),deviceId:row.delegation.hostNode,profile:row.profile}))]
  }
  work(input:ChatWorkGetInput):Promise<ChatWorkProjection>{
    this.accepting();input=structuredClone(input)
    return this.track(async()=>{
      if(!chatId(input.chatId)||!isId('stream',input.stream))throw new DomainRpcError('invalid_params','Invalid work stream')
      const binding=this.checked(input.chatId),rt=this.runtime(),spaces=this.options.spaces()
      if(rt.db.inTransaction)throw new NetError('forbidden')
      const rows=rt.db.database.prepare("SELECT s.id AS parent,r.id AS event FROM net_records r JOIN net_streams s ON s.active_generation=r.generation WHERE s.space_id=? AND json_extract(CAST(r.envelope AS TEXT),'$.type')='thread.opened' AND json_extract(CAST(r.envelope AS TEXT),'$.body.stream')=? LIMIT 2").all(binding.space,input.stream)
      if(rows.length!==1)throw new NetError('forbidden')
      const parent=spaces.store.getStream(rows[0].parent as StreamId)
      this.workAncestry(binding,parent)
      const opening=spaces.store.getById(parent!.id,rows[0].event as EventId)
      if(!opening)throw new NetError('forbidden')
      const opened=decodeEnvelope(opening.envelope).envelope
      if(opened.type!=='thread.opened'||opened.stream!==parent!.id||(opened.body as {stream?:StreamId}).stream!==input.stream)throw new NetError('forbidden')
      spaces.client.options.identity.verifyAuthor(opened.author,opening.envelope,opening.sig,opened.ts,'history')
      let descriptor=spaces.store.getStream(input.stream)
      const self=rt.identity.self()!
      if(parent!.authority!==self.node){
        descriptor=await spaces.discover(binding.space,input.stream)
        this.accepting();this.checked(input.chatId)
        await spaces.client.subscribe(input.stream)
      }
      this.accepting();this.checked(input.chatId)
      if(!descriptor||descriptor.parent!==parent!.id||descriptor.space!==binding.space||descriptor.authority!==parent!.authority||!['space.thread','space.private'].includes(descriptor.kind)||(opened.body as {private?:boolean}).private!==(descriptor.kind==='space.private'))throw new NetError('forbidden')
      this.workAncestry(binding,spaces.store.getStream(descriptor.parent))
      const signed=rt.identity.roster(self.user),root=rt.identity.pinnedRootKey(self.user)
      if(!signed||!root||rt.identity.rosterState(self.user)!=='ok')throw new NetError('bad_delegation')
      const roster=rt.identity.verifySigned<Roster>(signed,root),delegation=roster.nodes.map(row=>rt.identity.verifySigned<NodeDelegation>(row,root)).filter(row=>row.subject===self.node).sort((a,b)=>b.keyEpoch-a.keyEpoch||b.issuedAt-a.issuedAt)[0]
      if(!delegation)throw new NetError('bad_delegation')
      const peer={user:self.user,node:self.node,delegation}
      if(descriptor.kind==='space.private'?!spaces.private.canRead(descriptor,peer):!spaces.meta.canRead(binding.space,descriptor,self.user))throw new NetError('forbidden')
      const head=spaces.store.head(input.stream),limit=input.limit??128,after=input.after??{epoch:head.epoch,seq:0}
      if(head.epoch!==spaces.meta.position(binding.space)!.epoch)throw new NetError('conflict')
      if(!Number.isSafeInteger(limit)||limit<1||limit>128||!Number.isSafeInteger(after.epoch)||after.epoch<1||!Number.isSafeInteger(after.seq)||after.seq<0||after.seq>head.seq)throw new DomainRpcError('invalid_params','Invalid work page')
      if(after.epoch!==head.epoch)throw new NetError('snapshot_required')
      const page=spaces.store.read(input.stream,after,head.seq,256*1024),records=page.records.slice(0,limit).map(record=>{
        spaces.client.verifyRecord(record,descriptor!,true)
        const envelope=decodeEnvelope(record.envelope).envelope
        if(descriptor!.kind==='space.private'&&envelope.author.bot&&envelope.type.startsWith('bot.run.')){
          const control=envelope.sealed&&spaces.private.historyState(input.stream,envelope.sealed.keyEpoch)
          if(!control||!spaces.private.options.verifyBotRecord)throw new NetError('forbidden')
          spaces.private.options.verifyBotRecord(record,descriptor!,control)
        }
        return{epoch:record.epoch,seq:record.seq,recvTs:record.recvTs,envelope,...(descriptor!.kind==='space.private'&&envelope.sealed?{privateBody:spaces.private.open(input.stream,record)}:{})}
      }),last=records.at(-1),cursor=last?{epoch:last.epoch,seq:last.seq}:after
      return{binding,descriptor,private:descriptor.kind==='space.private',head,cursor,records,...(cursor.seq<head.seq?{nextAfter:cursor}:{})}
    })
  }
  private workAncestry(binding:ChatNetworkBinding,initial:StreamDescriptor|undefined):void{
    const spaces=this.options.spaces(),seen=new Set<StreamId>();let descriptor=initial
    for(let depth=0;descriptor&&depth<32;depth++){
      if(descriptor.space!==binding.space||seen.has(descriptor.id))throw new NetError('forbidden')
      if(descriptor.id===binding.channel)return
      if(descriptor.kind!=='space.thread'||!descriptor.parent||descriptor.authority!==spaces.store.getStream(binding.channel)!.authority)throw new NetError('forbidden')
      seen.add(descriptor.id);descriptor=spaces.store.getStream(descriptor.parent)
    }
    throw new NetError('forbidden')
  }
  snapshot(local:ChatsSnapshot):ChatsSnapshot{
    const dir=join(this.options.profileHome,'net')
    if (!existsSync(join(dir,'net.db')) && !existsSync(join(dir,'ledger-established'))) return local
    const rows=this.runtime().db.database.prepare('SELECT chat FROM net_chat_presentations WHERE profile=? ORDER BY created_at DESC LIMIT 10001').all(this.options.profileId)
    if(rows.length>10000)throw new NetError('too_large')
    const joined=rows.flatMap(row=>{
      try{const {messages:_messages,...summary}=this.get(String(row.chat));return [summary]}
      catch(error){if(error instanceof NetError && ['not_member','forbidden'].includes(error.code))return [];throw error}
    })
    return {...local,chats:[...local.chats,...joined].sort((a,b)=>b.updatedAt.localeCompare(a.updatedAt))}
  }
  send(input: ChatNetworkSendInput): Promise<ChatConversation> {
    this.accepting()
    const original = { ...input, ...(Array.isArray(input.mentions) ? { mentions: [...input.mentions] } : {}) }
    // Register ownership before any synchronous Host or flush callback can
    // admit effects or initiate profile shutdown.
    return this.track(() => this.sendOriginal(original))
  }
  private track<T>(operation:()=>Promise<T>):Promise<T>{
    const work=Promise.resolve().then(()=>{this.accepting();return operation()})
    this.pending.add(work)
    void work.then(() => this.pending.delete(work), () => this.pending.delete(work))
    return work
  }
  private async sendOriginal(input: ChatNetworkSendInput): Promise<ChatConversation> {
    if (!chatId(input.chatId) || !clientKey(input.clientMessageId) || typeof input.text !== 'string' || !input.text.trim() || Buffer.byteLength(input.text) > 60 * 1024 || Buffer.from(input.text).toString() !== input.text || input.mentions !== undefined && (!Array.isArray(input.mentions) || input.mentions.length > 16 || new Set(input.mentions).size !== input.mentions.length || input.mentions.some(bot => !isId('bot', bot)))) throw new DomainRpcError('invalid_params', 'Invalid published Group message')
    const rt = this.runtime()
    if (rt.db.inTransaction) throw new NetError('forbidden', 'Sending requires a committed original')
    const binding = this.checked(input.chatId), spaces = this.options.spaces()
    const requestHash = hash({ text: input.text, mentions: input.mentions ?? [] })
    const event = rt.db.transaction(() => {
      this.checked(input.chatId); spaces.meta.assertUsable(binding.space, true)
      const old = rt.db.database.prepare('SELECT event,request_hash FROM net_chat_message_keys WHERE profile=? AND chat=? AND client_key=?').get(this.options.profileId, input.chatId, input.clientMessageId)
      if (old) { if (old.request_hash !== requestHash) throw new NetError('conflict'); return old.event as EventId }
      if (Number(rt.db.database.prepare('SELECT count(*) AS n FROM net_chat_message_keys WHERE profile=? AND chat=?').get(this.options.profileId, input.chatId)!.n) >= 4096 || Number(rt.db.database.prepare('SELECT count(*) AS n FROM net_chat_message_keys').get()!.n) >= 100000) throw new NetError('too_large')
      for (const bot of input.mentions ?? []) if (!spaces.meta.bot(binding.space, bot)) throw new NetError('forbidden')
      const id = spaces.client.post(binding.channel, input.text, input.mentions?.length ? { mentions: input.mentions } : undefined)
      rt.db.charge(1, Buffer.byteLength(json(input)))
      rt.db.database.prepare('INSERT INTO net_chat_message_keys VALUES(?,?,?,?,?)').run(this.options.profileId, input.chatId, input.clientMessageId, requestHash, id)
      rt.db.checkpoint('chats.message.beforeCommit')
      return id
    })
    rt.db.checkpoint('chats.message.afterCommit')
    await spaces.flush(binding.space)
    this.accepting()
    return this.get(input.chatId, event)
  }
  activeCount(): number { return this.pending.size }
  beginShutdown(): void { this.stopped = true }
  private accepting(): void { if (this.stopped) throw new NetError('cancelled') }
  async close(): Promise<void> { this.beginShutdown(); await Promise.allSettled([...this.pending]) }
}
