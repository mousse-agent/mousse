import { createHash } from 'node:crypto'
import type { IdentityService, MetaProjection, StreamStore, SyncSession } from '../../net/contracts'
import type { Envelope, StoredRecord, StreamDescriptor, SpaceId, UserId, BotId, ExecutionId, EnvelopeAuthRef, Roster, BotDelegation } from '../../../shared/net'
import { NetError } from '../../../shared/net'
import { canonicalJson, decodeEnvelope } from '../../net/sync/codec'
import { decodeBase64 } from '../../net/identity/crypto'
import type { ThreadBinding } from '../../spaces/host'
import type { PrivateSpaceService, PrivateState } from '../../spaces/private'
export interface BotOutputBinding extends ThreadBinding { visibilityEpoch?: number; participantHash?: string }
export interface BotRecordAuthorizationOptions {
  identity: IdentityService; meta: MetaProjection; store: StreamStore; private?: PrivateSpaceService
  binding(space: SpaceId, execution: ExecutionId): BotOutputBinding | undefined
  /** Historical role/policy proofs from signed meta, never an inferred current registry row. */
  historicalBot?(space: SpaceId, bot: BotId, auth: EnvelopeAuthRef): { owner: UserId; hostNode: string; keyEpoch: number } | undefined
  historicalMember?(space: SpaceId, user: UserId, auth: EnvelopeAuthRef): boolean
  historicalCanSteer?(space: SpaceId, bot: BotId, user: UserId, auth: EnvelopeAuthRef): boolean
}
/** Host/client crypto-policy gates. Budget/effect enforcement remains the authenticated executor's responsibility. */
export class BotRecordAuthorization {
  constructor(readonly options: BotRecordAuthorizationOptions) {}
  canRegisterAccepted(descriptor: StreamDescriptor, record: Pick<StoredRecord,'envelope'|'sig'>, peer: SyncSession['peer']): boolean {
    try {
      const envelope = decodeEnvelope(record.envelope).envelope
      this.options.identity.verifyAuthor(envelope.author,record.envelope,record.sig,envelope.ts,'newWork')
      if(envelope.type!=='bot.run.accepted'||descriptor.kind!=='space.thread'||!descriptor.parent||descriptor.id!==envelope.stream||descriptor.createdAt!==envelope.ts||envelope.refs?.thread!==descriptor.id||!envelope.refs.execution||envelope.refs.subject!==envelope.refs.replyTo) return false
      return this.current(descriptor,envelope,peer,{space:descriptor.space!,stream:descriptor.id,parent:descriptor.parent,bot:envelope.author.bot!,trigger:envelope.refs.subject!,execution:envelope.refs.execution})
    } catch { return false }
  }
  /** Root journals the candidate only after this signature/current-policy proof succeeds in its append transaction. */
  canRegisterPrivateAccepted(descriptor:StreamDescriptor,record:Pick<StoredRecord,'envelope'|'sig'>,peer:SyncSession['peer'],candidate:BotOutputBinding):boolean {
    try{
      const envelope=decodeEnvelope(record.envelope).envelope,author=this.options.identity.verifyAuthor(envelope.author,record.envelope,record.sig,envelope.ts,'newWork')
      if(author.kind!=='bot'||author.user!==peer.user||descriptor.kind!=='space.private'||envelope.type!=='bot.run.accepted'||envelope.minor!==0||envelope.crit||envelope.blobs?.length||!envelope.sealed)return false
      return this.current(descriptor,envelope,peer,candidate)
    }catch{return false}
  }
  canWrite(descriptor: StreamDescriptor, envelope: Envelope, peer: SyncSession['peer'], supplied?: BotOutputBinding): boolean {
    try {
      if(envelope.type==='bot.run.expired'){
        const binding=this.expiredBinding(descriptor,envelope)
        return !!binding&&this.current(descriptor,envelope,peer,binding,false,true)
      }
      const binding=supplied??(descriptor.space&&envelope.refs?.execution?this.options.binding(descriptor.space,envelope.refs.execution):undefined)
      if(!binding)return false
      if(envelope.type==='bot.permission.requested')return descriptor.kind==='space.private'&&this.current(descriptor,envelope,peer,binding,true)
      if(!envelope.type.startsWith('bot.run.'))return false
      return this.current(descriptor,envelope,peer,binding)
    } catch { return false }
  }
  /** No broad cross-stream waiver: every reference is the original human trigger of this immutable execution. */
  verifyExecutionReferences(descriptor: StreamDescriptor, envelope: Envelope, peer: SyncSession['peer']): boolean {
    if(descriptor.kind!=='space.private'||!['bot.run.accepted','bot.run.progress','bot.run.toolSummary','bot.run.waitingApproval','bot.run.completed','bot.run.failed','bot.run.cancelled','bot.run.uncertain'].includes(envelope.type))return false
    return this.canWrite(descriptor,envelope,peer)
  }
  private expiredBinding(descriptor:StreamDescriptor,envelope:Envelope):BotOutputBinding|undefined{
    const refs=envelope.refs
    if(!descriptor.space||envelope.stream!==descriptor.id||!envelope.author.bot||!refs?.execution||!refs.subject||refs.subject!==refs.replyTo||refs.thread!==descriptor.id||refs.mentions?.length||envelope.blobs?.length||this.options.binding(descriptor.space,refs.execution))return
    const state=descriptor.kind==='space.private'?this.options.private?.state(descriptor.id):undefined
    if(descriptor.kind==='space.private'&&!state)return
    return{space:descriptor.space,stream:descriptor.id,parent:descriptor.id,bot:envelope.author.bot,trigger:refs.subject,execution:refs.execution,...(state?{visibilityEpoch:state.control.visibilityEpoch,participantHash:createHash('sha256').update(canonicalJson(state.control.participants)).digest('base64url')}:{})}
  }
  verifyHistory(record: StoredRecord, descriptor: StreamDescriptor, verifiedControl?:PrivateState): void {
    const envelope=decodeEnvelope(record.envelope).envelope,author=this.options.identity.verifyAuthor(envelope.author,record.envelope,record.sig,envelope.ts,'history')
    if(author.kind!=='bot'||!descriptor.space||!envelope.auth||envelope.stream!==descriptor.id||!envelope.refs?.execution)throw new NetError('forbidden')
    const expired=envelope.type==='bot.run.expired'
    if(!envelope.type.startsWith('bot.run.')||expired&&(!envelope.refs.subject||envelope.refs.subject!==envelope.refs.replyTo||envelope.refs.thread!==descriptor.id||envelope.refs.mentions?.length||envelope.blobs?.length))throw new NetError('forbidden')
    const binding=expired?{space:descriptor.space,stream:descriptor.id,parent:descriptor.id,bot:author.bot,trigger:envelope.refs.subject!,execution:envelope.refs.execution}:this.options.binding(descriptor.space,envelope.refs.execution),bot=this.options.historicalBot?.(descriptor.space,author.bot,envelope.auth)
    if(!binding||!bot||binding.space!==descriptor.space||bot.owner!==author.user||bot.hostNode!==author.node||bot.keyEpoch!==envelope.author.keyEpoch||binding.stream!==descriptor.id||binding.bot!==author.bot||binding.trigger!==envelope.refs.subject||binding.trigger!==envelope.refs.replyTo||envelope.refs.thread!==descriptor.id)throw new NetError('forbidden')
    const trigger=this.options.store.getById(binding.parent,binding.trigger),parent=this.options.store.getStream(binding.parent)
    if(!trigger||!parent||parent.space!==descriptor.space||!expired&&descriptor.kind==='space.thread'&&descriptor.parent!==binding.parent||parent.kind==='space.private'&&binding.parent!==descriptor.id)throw new NetError('forbidden')
    const message=decodeEnvelope(trigger.envelope).envelope,original=this.options.identity.verifyAuthor(message.author,trigger.envelope,trigger.sig,message.ts,'history')
    if(original.kind!=='node'||message.type!=='message.posted'||!message.refs?.mentions?.includes(author.bot)||!message.auth||this.options.historicalMember?.(descriptor.space,bot.owner,envelope.auth)!==true||this.options.historicalMember?.(descriptor.space,original.user,message.auth)!==true||this.options.historicalMember?.(descriptor.space,original.user,envelope.auth)!==true||this.options.historicalCanSteer?.(descriptor.space,author.bot,original.user,envelope.auth)!==true)throw new NetError('forbidden')
    if(descriptor.kind==='space.private'){
      const state=verifiedControl??(envelope.sealed&&this.options.private?.historyState(descriptor.id,envelope.sealed.keyEpoch))
      if(!state||state.stream!==descriptor.id||state.space!==descriptor.space||state.blocked||!envelope.sealed||state.control.keyEpoch!==envelope.sealed.keyEpoch||!state.control.participants.includes(author.bot)||!state.control.participants.includes(original.user)||!state.control.participants.includes(bot.owner)||!expired&&((binding as BotOutputBinding).visibilityEpoch!==state.control.visibilityEpoch||(binding as BotOutputBinding).participantHash!==createHash('sha256').update(canonicalJson(state.control.participants)).digest('base64url')))throw new NetError('forbidden')
    }else if(envelope.sealed||!['space.channel','space.thread'].includes(descriptor.kind)||!expired&&descriptor.kind!=='space.thread')throw new NetError('forbidden')
  }
  private current(descriptor:StreamDescriptor,envelope:Envelope,peer:SyncSession['peer'],binding:BotOutputBinding,permission=false,expired=false):boolean {
    const meta=descriptor.space&&this.options.meta.state(descriptor.space),bot=envelope.author.bot&&meta?.bots.get(envelope.author.bot)
    if(!meta||meta.frozen||meta.upgradeRequired||!bot||!envelope.author.bot||envelope.author.user||peer.user!==bot.owner||peer.node!==bot.delegation.hostNode||envelope.author.node!==peer.node||envelope.author.keyEpoch!==bot.delegation.keyEpoch||!envelope.auth||envelope.auth.metaEpoch!==meta.applied.epoch||envelope.auth.metaSeq>meta.applied.seq||descriptor.authority!==meta.descriptor.hostNode)return false
    const root=this.options.identity.pinnedRootKey(bot.owner),signed=root&&this.options.identity.roster(bot.owner)
    if(!root||!signed)return false
    const roster=this.options.identity.verifySigned<Roster>(signed,root),live=roster.bots.map(row=>this.options.identity.verifySigned<BotDelegation>(row,root)).filter(row=>row.subject===envelope.author.bot).sort((a,b)=>b.keyEpoch-a.keyEpoch||b.issuedAt-a.issuedAt)[0]
    if(!live||live.owner!==bot.owner||live.hostNode!==peer.node||live.keyEpoch!==bot.delegation.keyEpoch||live.keys.sign!==bot.delegation.keys.sign||live.issuedAt>envelope.ts||envelope.ts>=live.expiresAt||roster.revoked.some(row=>(row.subject===envelope.author.bot&&row.throughKeyEpoch>=live.keyEpoch)||(row.subject===peer.node&&row.throughKeyEpoch>=peer.delegation.keyEpoch)))return false
    if(this.options.identity.rosterState(bot.owner)==='conflict'||!meta.members.has(bot.owner)||binding.space!==descriptor.space||!permission&&binding.stream!==descriptor.id||binding.bot!==envelope.author.bot||binding.execution!==envelope.refs?.execution||!permission&&binding.trigger!==envelope.refs.subject||!permission&&binding.trigger!==envelope.refs.replyTo||envelope.refs.thread!==descriptor.id||descriptor.kind==='space.thread'&&!expired&&descriptor.parent!==binding.parent)return false
    if(descriptor.kind==='space.thread'&&!expired&&bot.policy.visibility!=='public'||descriptor.kind!=='space.thread'&&descriptor.kind!=='space.private'&&(!expired||descriptor.kind!=='space.channel'))return false
    if(descriptor.kind==='space.channel'&&meta.channels.get(descriptor.id)?.archived)return false
    const trigger=this.options.store.getById(binding.parent,binding.trigger),parent=this.options.store.getStream(binding.parent)
    if(!trigger||!parent||parent.space!==descriptor.space)return false
    const message=decodeEnvelope(trigger.envelope).envelope,author=this.options.identity.verifyAuthor(message.author,trigger.envelope,trigger.sig,message.ts,'newWork')
    if(author.kind!=='node'||!meta.members.has(author.user)||!message.auth||message.auth.metaEpoch!==meta.applied.epoch||message.auth.metaSeq>meta.applied.seq||!message.refs?.mentions?.includes(binding.bot)||message.type!=='message.posted'||!this.options.meta.canSteer(descriptor.space!,binding.bot,author.user))return false
    if(parent.kind==='space.private'){
      const original=this.options.private?.state(parent.id)
      if(!original||original.blocked||!message.sealed||message.sealed.keyEpoch!==original.control.keyEpoch||!original.control.participants.includes(author.user)||!original.control.participants.includes(bot.owner)||!original.control.participants.includes(binding.bot)||!permission&&descriptor.id!==parent.id)return false
    }else if(!expired&&!permission&&parent.kind!=='space.channel')return false
    if(descriptor.kind==='space.private'){
      const state=this.options.private?.state(descriptor.id)
      if(permission){
        if(envelope.refs?.subject||envelope.refs?.replyTo||!state||JSON.stringify(state.control.participants)!==JSON.stringify([...new Set([bot.owner,author.user,binding.bot])].sort()))return false
        const output=this.options.store.getStream(binding.stream)
        if(!output||output.space!==descriptor.space||output.kind==='space.thread'&&bot.policy.visibility!=='public')return false
        if(output.kind==='space.private'){const original=this.options.private?.state(output.id);if(!original||original.blocked||binding.visibilityEpoch!==original.control.visibilityEpoch||binding.participantHash!==createHash('sha256').update(canonicalJson(original.control.participants)).digest('base64url'))return false}
      }
      if(!state||state.blocked||!permission&&(binding.visibilityEpoch!==state.control.visibilityEpoch||binding.participantHash!==createHash('sha256').update(canonicalJson(state.control.participants)).digest('base64url'))||!envelope.sealed||envelope.sealed.keyEpoch!==state.control.keyEpoch||!state.control.participants.includes(binding.bot)||!state.control.participants.includes(author.user)||!state.control.participants.includes(bot.owner))return false
      if(!this.options.private?.canRead(descriptor,peer))return false
      const nonce=decodeBase64(envelope.sealed.nonce,12)
      if(!state.control.writers.some(writer=>writer.node===peer.node&&decodeBase64(writer.noncePrefix,4).equals(nonce.subarray(0,4))))return false
      if(!permission&&parent.kind!=='space.private'&&JSON.stringify(state.control.participants)!==JSON.stringify([...new Set([bot.owner,author.user,binding.bot])].sort()))return false
    } else if(envelope.sealed||!this.options.meta.canRead(descriptor.space!,parent,bot.owner))return false
    return true
  }
}
