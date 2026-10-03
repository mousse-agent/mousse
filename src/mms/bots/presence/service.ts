import type { IdentityService, KeyStore, ExecutionLedger, StreamStore } from '../../net/contracts'
import type { BotId, StreamId, PresenceMessage, PresenceState, ExecutionId } from '../../../shared/net'
import { NetError } from '../../../shared/net'
import { canonicalJson } from '../../net/sync/codec'
import { NetDatabase, integer } from '../../net/store/database'
import type { SqliteBotRegistry } from '../registry'
export interface BotPresenceOptions {
  db: NetDatabase; store: StreamStore; identity: IdentityService; keys: KeyStore; registry: SqliteBotRegistry; executions: ExecutionLedger
  /** Negotiated authenticated session transport. No durable outbox for ephemeral presence. */
  send(message: PresenceMessage): Promise<void>
}
/** Monotonic counters survive restart. Public activity for private work is a fixed indicator only. */
export class BotPresenceService {
  private timer?:ReturnType<NetDatabase['clock']['setTimeout']>
  private streams=new Map<string,{bot:BotId;stream:StreamId}>()
  private inFlight=false
  constructor(readonly options:BotPresenceOptions){options.db.transaction(()=>options.db.database.exec('CREATE TABLE IF NOT EXISTS net_bot_presence_counter(bot TEXT NOT NULL,key_epoch INTEGER NOT NULL,counter INTEGER NOT NULL,PRIMARY KEY(bot,key_epoch))'))}
  watch(bot:BotId,stream:StreamId):void{this.streams.set(`${bot}/${stream}`,{bot,stream});if(!this.timer)this.schedule()}
  unwatch(bot:BotId,stream?:StreamId):void{for(const[key,value]of this.streams)if(value.bot===bot&&(stream===undefined||value.stream===stream))this.streams.delete(key);if(!this.streams.size){this.timer?.cancel();this.timer=undefined}}
  close():void{this.timer?.cancel();this.timer=undefined;this.streams.clear()}
  async publish(bot:BotId,stream:StreamId,execution?:ExecutionId):Promise<void>{
    if(this.options.db.inTransaction)throw new NetError('bad_request')
    const descriptor=this.options.store.getStream(stream)
    if(!descriptor?.space||descriptor.kind!=='space.channel')throw new NetError('forbidden')
    const current=this.options.registry.current(descriptor.space,bot)
    if(!current)throw new NetError('forbidden')
    const self=this.options.identity.self();if(!self||self.node!==current.hostNode)throw new NetError('bad_delegation')
    let state:PresenceState='idle'
    const records=execution?[this.options.executions.get(execution)].filter(Boolean):this.options.db.database.prepare("SELECT id FROM net_executions WHERE target=? AND state IN ('accepted','running','waitingApproval') LIMIT 33").all(bot).map(row=>this.options.executions.get(row.id as ExecutionId))
    if(records.length>32)throw new NetError('storage_corrupt')
    if(records.some(row=>row?.target!==bot))throw new NetError('forbidden')
    if(records.length)state=records.some(row=>row?.binding?.visibilityEpoch!==undefined)?'workingPrivate':'working'
    const counter=this.options.db.transaction(()=>{const previous=Number(this.options.db.database.prepare('SELECT counter FROM net_bot_presence_counter WHERE bot=? AND key_epoch=?').get(bot,current.placementEpoch)?.counter??0),next=integer(previous+1,1);this.options.db.charge(1);this.options.db.database.prepare('INSERT INTO net_bot_presence_counter VALUES(?,?,?) ON CONFLICT(bot,key_epoch) DO UPDATE SET counter=excluded.counter').run(bot,current.placementEpoch,next);return next})
    const unsigned={t:'presence' as const,stream,subject:bot,counter,ts:this.options.db.clock.now(),state},message:PresenceMessage={...unsigned,sig:Buffer.from(this.options.keys.signAsBot(bot,canonicalJson(unsigned))).toString('base64url')}
    // Recheck after counter commit before any outbound effect; an unused counter is harmless.
    this.options.registry.current(current.space,bot);await this.options.send(message)
  }
  private schedule():void{this.timer=this.options.db.clock.setTimeout(()=>{this.timer=undefined;if(!this.inFlight){this.inFlight=true;void Promise.all([...this.streams.values()].map(({bot,stream})=>this.publish(bot,stream).catch(()=>{}))).finally(()=>{this.inFlight=false})}if(this.streams.size)this.schedule()},20000)}
}
