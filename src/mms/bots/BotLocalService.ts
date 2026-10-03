import { NetError,type BotId,type SpaceId } from '../../shared/net'
import type { BotLocalSummary,BotsLocalMethod,BotsLocalParams,BotsLocalResults } from '../../shared/bots/local'
import type { BotProfileService } from './BotProfileService'
import type { LocalBot } from './registry'
import { validateBotsLocal } from './registerMethods'
import { BotRegistrationService } from './BotRegistrationService'

/** Trusted owner IPC only. Neither provider credentials nor executable definitions
 * can enter through this catalogue. Qualification stays independently gated. */
export class BotLocalService {
  private pending=0
  private readonly registration:BotRegistrationService
  constructor(readonly profile:BotProfileService){this.registration=new BotRegistrationService(profile)}
  async request<K extends BotsLocalMethod>(method:K,input:BotsLocalParams[K]):Promise<BotsLocalResults[K]>{
    if (this.profile.options.isEnabled?.() === false) throw new NetError('disabled')
    const params=validateBotsLocal(method,input),rt=this.profile.options.runtime,self=rt.identity.self()
    if(!self)throw new NetError('not_enrolled')
    if(this.pending>=32)throw new NetError('rate_limited')
    this.pending++
    try {
      const p=params as unknown as Record<string,any>
      let result:unknown
      switch(method){
        case 'bots.add':result=await this.registration.add(params as BotsLocalParams['bots.add']);break
        case 'bots.list':{
          const rows=rt.db.database.prepare('SELECT record FROM net_bot_registry WHERE json_extract(record,\'$.owner\')=? AND (space>? OR (space=? AND bot>?)) ORDER BY space,bot LIMIT ?').all(self.user,p.after?.space??'',p.after?.space??'',p.after?.bot??'',(p.limit??128)+1)
          const more=rows.length>(p.limit??128),bots=rows.slice(0,p.limit??128).map(row=>this.summary(JSON.parse(row.record as string)))
          result={bots,...(more?{nextAfter:{space:bots.at(-1)!.space,bot:bots.at(-1)!.bot}}:{})};break
        }
        case 'bots.configure':{
          const placement=this.profile.options.spaces.meta.state(p.space)?.bots.get(p.bot)
          if(!placement||placement.owner!==self.user||placement.delegation.hostNode!==self.node||placement.profile!==p.profile)throw new NetError('forbidden')
          if(p.projectId!==undefined&&!this.profile.options.projects.getProject(p.projectId))throw new NetError('forbidden')
          result=this.summary(this.profile.configure(params as BotsLocalParams['bots.configure']));break
        }
        case 'bots.qualify':this.owned(p.space,p.bot);this.profile.qualify(params as BotsLocalParams['bots.qualify']);result=this.selected(p.space,p.bot);break
        case 'bots.stop':this.owned(p.space,p.bot);await this.profile.stop(params as BotsLocalParams['bots.stop']);result=this.selected(p.space,p.bot);break
        case 'bots.resume':this.owned(p.space,p.bot);this.profile.resume(params as BotsLocalParams['bots.resume']);result=this.selected(p.space,p.bot);break
        case 'bots.presence':{
          this.owned(p.space,p.bot)
          const stream=this.profile.options.spaces.store.getStream(p.stream)
          if(!stream||stream.space!==p.space||stream.kind!=='space.channel'||!this.profile.options.spaces.meta.canRead(p.space,stream,self.user))throw new NetError('forbidden')
          result={space:p.space,bot:p.bot,stream:p.stream,...this.profile.presenceReceiver.view(p.stream,p.bot)};break
        }
        case 'bots.grant':{
          const id=await this.profile.grant(params as BotsLocalParams['bots.grant']),descriptor=this.profile.options.spaces.store.getStream(p.stream)
          if(!descriptor?.space)throw new NetError('forbidden')
          try{await this.profile.options.spaces.flush(descriptor.space)}catch(error){if(!(error instanceof NetError))throw error}
          const entry=rt.outbox.get(id)
          if(!entry||entry.stream!==p.stream)throw new NetError('storage_corrupt')
          result={id:entry.id,stream:entry.stream,state:entry.state,attempts:entry.attempts,createdAt:entry.createdAt,...(entry.position?{position:entry.position}:{}),...(entry.error?{error:entry.error}:{})};break
        }
      }
      return result as BotsLocalResults[K]
    }finally{this.pending--}
  }
  private owned(space:SpaceId,bot:BotId):LocalBot{const record=this.profile.registry.get(space,bot);if(!record||record.owner!==this.profile.options.runtime.identity.self()?.user)throw new NetError('forbidden');return record}
  private selected(space:SpaceId,bot:BotId):BotLocalSummary{return this.summary(this.owned(space,bot))}
  private summary(row:LocalBot):BotLocalSummary{return{space:row.space,bot:row.bot,adapter:row.adapter,profile:row.profile,definitionRevision:row.definitionRevision,profileDigest:row.profileDigest,dailyBudgetUnits:row.dailyBudgetUnits,runCeilingUnits:row.runCeilingUnits,maxConcurrent:row.maxConcurrent,runsPerMemberHour:row.runsPerMemberHour,...(row.projectId?{projectId:row.projectId}:{}),owner:row.owner,hostNode:row.hostNode,placementEpoch:row.placementEpoch,activationHostTs:row.activationHostTs,revision:row.revision,stopped:row.stopped,qualified:row.qualified}}
}
