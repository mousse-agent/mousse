import { NetError, isId, type NodeDelegation, type Roster } from '../../../shared/net'
import type { ChatNetworkBinding, ChatTaskDispatchInput, ChatTaskDispatchResult, ChatTaskGetInput, ChatTaskListInput, ChatTaskPage, ChatTaskRead, ChatTaskSelection, ChatTaskSelectionInput, ChatTaskVerifiedResult } from '../../../shared/chatsNetwork'
import type { NetRuntime } from '../../net/NetService'
import type { BridgeHub } from '../../bridge/hub'
import { dispatchRequest } from '../../bridge/dispatch/validate'
import { digest, json } from '../../net/store/database'
import { chatId } from '../ChatStore'

/** Task selection is an exact prepared Bridge request, never a bot placement change. */
export class ChatTaskDispatchService {
  constructor(private readonly rt:NetRuntime,private readonly hub:BridgeHub,private readonly profileId:string,private readonly binding:(chat:string)=>ChatNetworkBinding,private readonly bot:(space:ChatNetworkBinding['space'],bot:NonNullable<ChatTaskSelectionInput['bot']>)=>{owner:string;hostNode:string}|undefined,private readonly readBinding:(chat:string)=>ChatNetworkBinding){
    rt.db.transaction(()=>rt.db.database.exec(`CREATE TABLE IF NOT EXISTS net_chat_task_bindings(
      profile TEXT NOT NULL,chat TEXT NOT NULL,task TEXT NOT NULL UNIQUE,target TEXT NOT NULL,request_hash TEXT NOT NULL,bot TEXT,validated_result_hash TEXT,
      PRIMARY KEY(profile,chat,task),FOREIGN KEY(profile,chat) REFERENCES net_chat_publications(profile,chat)
    ) STRICT;`))
  }
  list(input:ChatTaskListInput):ChatTaskPage{
    if(!chatId(input.chatId)||input.after!==undefined&&!isId('rpc',input.after)||input.limit!==undefined&&(!Number.isSafeInteger(input.limit)||input.limit<1||input.limit>128))throw new NetError('bad_request')
    this.readBinding(input.chatId)
    const self=this.rt.identity.self();if(!self)throw new NetError('not_enrolled');this.current(self.node,'read')
    const limit=input.limit??32,rows=this.rt.db.database.prepare('SELECT task FROM net_chat_task_bindings WHERE profile=? AND chat=? AND task>? ORDER BY task LIMIT ?').all(this.profileId,input.chatId,input.after??'',limit+1)
    const tasks=rows.slice(0,limit).map(row=>this.readStatus({chatId:input.chatId,taskId:row.task as ChatTaskSelectionInput['taskId']}))
    return{tasks,...(rows.length>limit?{nextAfter:tasks[tasks.length-1].taskId}:{})}
  }
  readStatus(input:ChatTaskDispatchInput):ChatTaskSelection{return this.status(input,true)}
  async get(input:ChatTaskGetInput):Promise<ChatTaskRead>{
    if(input.result!==undefined&&typeof input.result!=='boolean')throw new NetError('bad_request')
    if(this.rt.db.inTransaction)throw new NetError('forbidden')
    const selection=this.readStatus(input)
    // A prepared request has no target execution to query. Failed originals are
    // terminal metadata. Neither read can mutate the Hub journal or allocate an alias.
    if(!input.result||selection.status.state==='prepared'||selection.status.state==='failed')return{selection}
    this.current(selection.target,'write')
    const result=await this.hub.query(input.taskId) as ChatTaskVerifiedResult
    this.rt.db.transaction(()=>{
      this.readStatus(input)
      this.current(selection.target,'write')
      const resultHash=digest(Buffer.from(json(result))),row=this.rt.db.database.prepare('SELECT validated_result_hash FROM net_chat_task_bindings WHERE profile=? AND chat=? AND task=?').get(this.profileId,input.chatId,input.taskId)!
      if(row.validated_result_hash&&row.validated_result_hash!==resultHash)throw new NetError('conflict')
      this.rt.db.charge(1)
      this.rt.db.database.prepare('UPDATE net_chat_task_bindings SET validated_result_hash=? WHERE profile=? AND chat=? AND task=?').run(resultHash,this.profileId,input.chatId,input.taskId)
      this.rt.db.checkpoint('chats.task.validation.beforeCommit')
    })
    return{selection:this.readStatus(input),result}
  }
  select(value:ChatTaskSelectionInput):ChatTaskSelection{
    const input=structuredClone(value)
    if(!chatId(input.chatId)||!isId('rpc',input.taskId)||!isId('node',input.deviceId)||input.bot!==undefined&&!isId('bot',input.bot))throw new NetError('bad_request')
    if(this.rt.db.inTransaction)throw new NetError('forbidden')
    const binding=this.binding(input.chatId),request=dispatchRequest(input.input),hash=digest(Buffer.from(json({target:input.deviceId,input:request,bot:input.bot??null})))
    this.current(input.deviceId)
    if(input.bot!==undefined){const placement=this.bot(binding.space,input.bot),self=this.rt.identity.self()!;if(!placement||placement.owner!==self.user||placement.hostNode!==input.deviceId)throw new NetError('forbidden','Selecting a device does not transfer a Space bot.')}
    this.rt.db.transaction(()=>{
      this.binding(input.chatId);this.current(input.deviceId)
      const old=this.rt.db.database.prepare('SELECT * FROM net_chat_task_bindings WHERE task=?').get(input.taskId)
      if(old){if(old.profile!==this.profileId||old.chat!==input.chatId||old.target!==input.deviceId||old.request_hash!==hash)throw new NetError('conflict');return}
      if(Number(this.rt.db.database.prepare('SELECT count(*) AS n FROM net_chat_task_bindings WHERE profile=?').get(this.profileId)!.n)>=4096)throw new NetError('too_large')
      const original=this.hub.prepare(input.deviceId,'bridge.dispatch',request,{id:input.taskId,idem:`chats/${this.profileId}/${input.chatId}/${input.taskId}`,deadlineMs:Math.min(86400000,request.limits.maxElapsedMs+5000)})
      if(original!==input.taskId)throw new NetError('conflict')
      this.rt.db.charge(1,1024)
      this.rt.db.database.prepare('INSERT INTO net_chat_task_bindings(profile,chat,task,target,request_hash,bot) VALUES(?,?,?,?,?,?)').run(this.profileId,input.chatId,input.taskId,input.deviceId,hash,input.bot??null)
      this.rt.db.checkpoint('chats.task.beforeCommit')
    })
    this.rt.db.checkpoint('chats.task.afterCommit')
    return this.status(input)
  }
  async dispatch(input:ChatTaskDispatchInput):Promise<ChatTaskDispatchResult>{
    if(this.rt.db.inTransaction)throw new NetError('forbidden')
    this.status(input)
    const result=await this.hub.submit(input.taskId) as ChatTaskVerifiedResult
    // The Hub independently verifies the terminal caller/method/request and
    // signed result/artifact scope; no task mutation is replayed after ambiguity.
    this.rt.db.transaction(()=>{
      this.status(input)
      this.rt.db.charge(1)
      this.rt.db.database.prepare('UPDATE net_chat_task_bindings SET validated_result_hash=? WHERE profile=? AND chat=? AND task=?').run(digest(Buffer.from(json(result))),this.profileId,input.chatId,input.taskId)
      this.rt.db.checkpoint('chats.task.validation.beforeCommit')
    })
    return{selection:this.status(input),result}
  }
  private status(input:ChatTaskDispatchInput,read=false):ChatTaskSelection{
    if(!chatId(input.chatId)||!isId('rpc',input.taskId))throw new NetError('bad_request')
    const row=this.rt.db.database.prepare('SELECT * FROM net_chat_task_bindings WHERE profile=? AND chat=? AND task=?').get(this.profileId,input.chatId,input.taskId)
    if(!row||!isId('node',row.target))throw new NetError('forbidden')
    const binding=(read?this.readBinding:this.binding)(input.chatId);this.current(row.target,read?'read':'write')
    if(row.bot){if(!isId('bot',row.bot))throw new NetError('storage_corrupt');const placement=this.bot(binding.space,row.bot);if(!placement||placement.owner!==this.rt.identity.self()!.user||placement.hostNode!==row.target)throw new NetError('forbidden')}
    const status=this.hub.status(input.taskId)
    if(status.target!==row.target||status.method!=='bridge.dispatch'||status.original!==input.taskId)throw new NetError('conflict')
    return{kind:'bridge-task',chatId:input.chatId,taskId:input.taskId,target:row.target,validation:status.state==='completed'&&row.validated_result_hash?'authorized':status.state==='failed'?'rejected':'pendingTargetValidation',status}
  }
  private current(target:ChatTaskSelectionInput['deviceId'],capability:'read'|'write'='write'):void{
    const identity=this.rt.identity,self=identity.self(),root=self&&identity.pinnedRootKey(self.user),signed=self&&identity.roster(self.user),now=this.rt.db.clock.now()
    if(!self||!root||!signed||identity.rosterState(self.user)!=='ok')throw new NetError('bad_delegation')
    const roster=identity.verifySigned<Roster>(signed,root)
    for(const node of [self.node,target]){
      const delegation=roster.nodes.map(row=>identity.verifySigned<NodeDelegation>(row,root)).filter(row=>row.subject===node).sort((a,b)=>b.keyEpoch-a.keyEpoch||b.issuedAt-a.issuedAt)[0]
      if(!delegation||delegation.owner!==self.user||delegation.issuedAt>now||now>=delegation.expiresAt)throw new NetError('bad_delegation')
      if(roster.revoked.some(row=>row.subject===node&&row.throughKeyEpoch>=delegation.keyEpoch))throw new NetError('revoked')
      if(!delegation.caps.includes(capability))throw new NetError('forbidden')
    }
  }
}
