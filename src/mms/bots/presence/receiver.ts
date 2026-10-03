import type { IdentityService, MetaProjection, StreamStore, SyncSession } from '../../net/contracts'
import type { PresenceMessage, BotId, StreamId } from '../../../shared/net'
import { validateWireMessage, NetError } from '../../../shared/net'
import { canonicalJson } from '../../net/sync/codec'
import { NetDatabase } from '../../net/store/database'
export interface BotPresenceReceiverOptions { db:NetDatabase; identity:IdentityService;meta:MetaProjection;store:StreamStore }
export type BotPresenceView = { state:'idle'|'working'|'workingPrivate'|'reconnecting'|'offline'; receivedAtMonotonic?:number }
/** Current signed placement plus durable anti-replay counter; volatile display freshness never survives boot. */
export class BotPresenceReceiver {
  private received=new Map<string,{message:PresenceMessage;at:number}>()
  constructor(readonly options:BotPresenceReceiverOptions){options.db.transaction(()=>options.db.database.exec('CREATE TABLE IF NOT EXISTS net_bot_presence_seen(bot TEXT NOT NULL,key_epoch INTEGER NOT NULL,counter INTEGER NOT NULL,PRIMARY KEY(bot,key_epoch))'))}
  receive(message:PresenceMessage,peer:SyncSession['peer']):boolean {
    try{
      if(this.options.db.inTransaction)return false
      if(!validateWireMessage(message)||message.t!=='presence')return false
      const descriptor=this.options.store.getStream(message.stream),meta=descriptor?.space&&this.options.meta.state(descriptor.space),bot=meta?.bots.get(message.subject as BotId)
      if(!descriptor||descriptor.kind!=='space.channel'||!meta||meta.frozen||meta.upgradeRequired||!bot||bot.owner!==peer.user||bot.delegation.hostNode!==peer.node||!meta.members.has(peer.user)||message.state==='workingPrivate'&&message.activity!==undefined)return false
      if(Math.abs(this.options.db.clock.now()-message.ts)>90000)return false
      const{sig,...unsigned}=message,author=this.options.identity.verifyAuthor({bot:message.subject as BotId,node:peer.node,keyEpoch:bot.delegation.keyEpoch},canonicalJson(unsigned),Buffer.from(sig,'base64url'),message.ts,'newWork')
      if(author.kind!=='bot'||author.user!==peer.user)return false
      return this.options.db.transaction(()=>{
        const previous=Number(this.options.db.database.prepare('SELECT counter FROM net_bot_presence_seen WHERE bot=? AND key_epoch=?').get(message.subject,bot.delegation.keyEpoch)?.counter??0)
        if(message.counter<=previous)return false
        this.options.db.charge(1);this.options.db.database.prepare('INSERT INTO net_bot_presence_seen VALUES(?,?,?) ON CONFLICT(bot,key_epoch) DO UPDATE SET counter=excluded.counter').run(message.subject,bot.delegation.keyEpoch,message.counter)
        this.options.db.afterCommit(()=>this.received.set(`${message.stream}/${message.subject}`,{message:structuredClone(message),at:this.options.db.clock.monotonic()}));return true
      })
    }catch(error){if(error instanceof NetError)return false;throw error}
  }
  view(stream:StreamId,bot:BotId):BotPresenceView {
    const row=this.received.get(`${stream}/${bot}`),descriptor=this.options.store.getStream(stream),meta=descriptor?.space&&this.options.meta.state(descriptor.space)
    if(!row||!meta?.bots.has(bot)||meta.frozen||meta.upgradeRequired)return{state:'offline'}
    try { const current=meta.bots.get(bot)!, {sig,...unsigned}=row.message;this.options.identity.verifyAuthor({bot,node:current.delegation.hostNode,keyEpoch:current.delegation.keyEpoch},canonicalJson(unsigned),Buffer.from(sig,'base64url'),row.message.ts,'newWork') } catch { return {state:'offline'} }
    const age=this.options.db.clock.monotonic()-row.at
    return{state:age<0||age>=90000?'offline':age>=45000?'reconnecting':row.message.state,receivedAtMonotonic:row.at}
  }
}
