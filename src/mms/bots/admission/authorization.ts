import type { IdentityService, MetaProjection, StreamStore, SyncSession } from '../../net/contracts'
import type { Envelope, StoredRecord, StreamDescriptor, SpaceId, UserId, BotId, ExecutionId, StreamId, EnvelopeAuthRef } from '../../../shared/net'
import { NetError } from '../../../shared/net'
import { decodeEnvelope } from '../../net/sync/codec'
import type { ThreadBinding } from '../../spaces/host'
import type { PrivateSpaceService } from '../../spaces/private'
export interface BotRecordAuthorizationOptions {
  identity: IdentityService; meta: MetaProjection; store: StreamStore; private?: PrivateSpaceService
  binding(space: SpaceId, execution: ExecutionId): ThreadBinding | undefined
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
  canWrite(descriptor: StreamDescriptor, envelope: Envelope, peer: SyncSession['peer'], supplied?: ThreadBinding): boolean {
    try {
      const binding=supplied??(descriptor.space&&envelope.refs?.execution?this.options.binding(descriptor.space,envelope.refs.execution):undefined)
      if(!binding||!envelope.type.startsWith('bot.run.'))return false
      return this.current(descriptor,envelope,peer,binding)
    } catch { return false }
  }
  verifyHistory(record: StoredRecord, descriptor: StreamDescriptor): void {
    const envelope=decodeEnvelope(record.envelope).envelope,author=this.options.identity.verifyAuthor(envelope.author,record.envelope,record.sig,envelope.ts,'history')
    if(author.kind!=='bot'||!descriptor.space||!envelope.auth||envelope.stream!==descriptor.id||!envelope.refs?.execution)throw new NetError('forbidden')
    const binding=this.options.binding(descriptor.space,envelope.refs.execution),bot=this.options.historicalBot?.(descriptor.space,author.bot,envelope.auth)
    if(!binding||!bot||bot.owner!==author.user||bot.hostNode!==author.node||bot.keyEpoch!==envelope.author.keyEpoch||binding.stream!==descriptor.id||binding.bot!==author.bot||binding.trigger!==envelope.refs.subject||binding.trigger!==envelope.refs.replyTo||envelope.refs.thread!==descriptor.id)throw new NetError('forbidden')
    const trigger=this.options.store.getById(binding.parent,binding.trigger)
    if(!trigger)throw new NetError('forbidden')
    const message=decodeEnvelope(trigger.envelope).envelope,original=this.options.identity.verifyAuthor(message.author,trigger.envelope,trigger.sig,message.ts,'history')
    if(original.kind!=='node'||message.type!=='message.posted'||!message.refs?.mentions?.includes(author.bot)||!message.auth||this.options.historicalMember?.(descriptor.space,original.user,message.auth)!==true||this.options.historicalCanSteer?.(descriptor.space,author.bot,original.user,message.auth)!==true)throw new NetError('forbidden')
  }
  private current(descriptor:StreamDescriptor,envelope:Envelope,peer:SyncSession['peer'],binding:ThreadBinding):boolean {
    const meta=descriptor.space&&this.options.meta.state(descriptor.space),bot=envelope.author.bot&&meta?.bots.get(envelope.author.bot)
    if(!meta||meta.frozen||meta.upgradeRequired||!bot||!envelope.author.bot||envelope.author.user||peer.user!==bot.owner||peer.node!==bot.delegation.hostNode||envelope.author.node!==peer.node||envelope.author.keyEpoch!==bot.delegation.keyEpoch||!envelope.auth||envelope.auth.metaEpoch!==meta.applied.epoch||envelope.auth.metaSeq>meta.applied.seq||descriptor.authority!==meta.descriptor.hostNode)return false
    if(this.options.identity.rosterState(bot.owner)==='conflict'||binding.space!==descriptor.space||binding.stream!==descriptor.id||binding.bot!==envelope.author.bot||binding.execution!==envelope.refs?.execution||binding.trigger!==envelope.refs.subject||binding.trigger!==envelope.refs.replyTo||envelope.refs.thread!==descriptor.id||descriptor.kind==='space.thread'&&descriptor.parent!==binding.parent)return false
    if(descriptor.kind==='space.thread'&&bot.policy.visibility!=='public'||descriptor.kind!=='space.thread'&&descriptor.kind!=='space.private')return false
    const trigger=this.options.store.getById(binding.parent,binding.trigger),parent=this.options.store.getStream(binding.parent)
    if(!trigger||!parent||parent.space!==descriptor.space)return false
    const message=decodeEnvelope(trigger.envelope).envelope,author=this.options.identity.verifyAuthor(message.author,trigger.envelope,trigger.sig,message.ts,'newWork')
    if(author.kind!=='node'||!meta.members.has(author.user)||!message.refs?.mentions?.includes(binding.bot)||message.type!=='message.posted'||!this.options.meta.canSteer(descriptor.space!,binding.bot,author.user))return false
    if(descriptor.kind==='space.private'){
      const state=this.options.private?.state(descriptor.id)
      if(!state||state.blocked||!envelope.sealed||envelope.sealed.keyEpoch!==state.control.keyEpoch||!state.control.participants.includes(binding.bot)||!state.control.participants.includes(author.user)||!state.control.participants.includes(bot.owner))return false
    } else if(envelope.sealed||!this.options.meta.canRead(descriptor.space!,parent,bot.owner))return false
    return true
  }
}
