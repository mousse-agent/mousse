import { NetError,isId,newId,type BotDelegation,type BotRecord,type Envelope,type MemberRecord,type NodeDelegation,type Roster,type Signed,type SpaceDescriptor,type SpaceId,type StreamDescriptor,type StreamId } from '../../../shared/net'
import type { SpaceProfileService } from '../SpaceProfileService'
import { SqlPrivateStreamKeys } from '../../net/identity'
import { verifyDocument } from '../../net/identity/crypto'
import { canonicalJson,decodeEnvelope } from '../../net/sync/codec'
import { digest,json } from '../../net/store/database'
import { isVerifiedSpaceArchive } from './container'
import type { VerifiedSpaceArchive } from './contracts'
import type { PreparedSpaceRecovery } from './ImportCoordinator'
import { ArchiveJournal } from './journal'
import { SpaceImportStage } from './ImportStage'
import { PRIVATE_BOOTSTRAP_MAX_CONTROL_BYTES,PRIVATE_BOOTSTRAP_MAX_CONTROLS } from '../private'

type Control=NonNullable<Envelope<'participants.changed'>['body']>
/** Concrete controller recovery. A remote controller cannot be impersonated by
 * the owner. Recipients require independently current pinned root/roster evidence,
 * never the historical rosters included in the archive. */
export class SpaceArchiveRecovery {
  constructor(readonly profile:SpaceProfileService,readonly archive:VerifiedSpaceArchive){}
  async prepare(input:{space:SpaceId;descriptor:Signed;streams:StreamDescriptor[];signal:AbortSignal}):Promise<PreparedSpaceRecovery>{
    const rt=this.profile.options.runtime,self=rt.identity.self(),keys=rt.keys as typeof rt.keys&{encryptedAtRest?():boolean},root=self&&rt.identity.pinnedRootKey(self.user)
    if(input.signal.aborted)throw new NetError('cancelled')
    if(!isVerifiedSpaceArchive(this.archive)||!self?.isAuthority||!root||keys.state()!=='unlocked'||keys.encryptedAtRest?.()!==true||keys.rootKey()!==root||this.archive.manifest.space!==input.space||this.archive.manifest.owner.user!==self.user||this.archive.manifest.owner.rootKey!==root)throw new NetError('forbidden')
    const journal=new ArchiveJournal(rt.db),op=journal.forSpace(input.space)
    if(op?.state!=='importedFrozen'||op.digest!==this.archive.digest)throw new NetError('conflict')
    const stage=SpaceImportStage.resume(rt.db,op.id,op.digest),meta=stage.descriptors().find(s=>s.kind==='space.meta')!,carry=stage.projectionCarry(meta.id) as {generation:string}
    const descriptor=verifyDocument<SpaceDescriptor>(input.descriptor,root,'spaceDescriptor')
    if(descriptor.space!==input.space||descriptor.owner!==self.user||descriptor.hostNode!==self.node||descriptor.hostTransportKey!==keys.nodeKeys().transport||descriptor.epoch<=op.frozen.epoch)throw new NetError('forbidden')
    const privateStreams=input.streams.filter(s=>s.kind==='space.private')
    if(privateStreams.length>8)throw new NetError('too_large')
    const originals=new Map(this.archive.manifest.streams.map(s=>[s.descriptor.id,s.descriptor]))
    const crypto=new SqlPrivateStreamKeys({database:rt.db.database,keys,node:self.node,user:self.user,
      spaceForStream:stream=>{if(originals.get(stream)?.space!==input.space)throw new NetError('forbidden');return input.space},transaction:work=>rt.db.transaction(work),charge:(rows,bytes)=>rt.db.charge(rows,bytes),checkpoint:point=>rt.db.checkpoint(point)})
    const prepared:Array<{original:StreamDescriptor;entry:ReturnType<SqlPrivateStreamKeys['archiveRotationOriginal']>;before:Control;recipients:Array<{node:NodeDelegation['subject'];agree:string}>;prefixes:string[];binding:string}>=[]
    let rows=0,bytes=0,totalControls=0,totalControlBytes=0,freshBytes=0
    for(const stream of privateStreams){
      input.signal.throwIfAborted()
      const original=originals.get(stream.id)
      if(!original||original.kind!=='space.private'||json(original)!==json(stream))throw new NetError('conflict')
      const controls=[] as Array<ReturnType<typeof decodeEnvelope>['envelope']>
      for(const record of this.archive.records(stream.id)){
        const envelope=decodeEnvelope(record.envelope).envelope
        if(envelope.type==='participants.changed'){
          controls.push(envelope);totalControls++;totalControlBytes+=record.envelope.length+record.sig.length
          if(totalControls>PRIVATE_BOOTSTRAP_MAX_CONTROLS||totalControlBytes>PRIVATE_BOOTSTRAP_MAX_CONTROL_BYTES)throw new NetError('too_large')
          const state={space:input.space,stream:stream.id,controller:(envelope.body as Control).controller,control:envelope.body,position:{epoch:record.epoch,seq:record.seq},blocked:false}
          rows++;bytes+=Buffer.byteLength(json(state))
        }
      }
      const before=controls.at(-1)?.body as Control|undefined
      if(!before||before.controller!==self.user)throw new NetError('profile_unsupported')
      const recipients=this.recipients(carry.generation,before,root),own=recipients.find(n=>n.subject===self.node)
      if(!own||own.keys.sign!==keys.nodeKeys().sign||own.keys.agree!==keys.nodeKeys().agree)throw new NetError('bad_delegation')
      const scope=recipients.map(n=>({node:n.subject,agree:n.keys.agree})),prefixes=[...new Set(controls.flatMap(e=>(e.body as Control).writers.map(w=>w.noncePrefix)))],binding=digest(canonicalJson({target:{space:descriptor.space,owner:descriptor.owner,hostNode:descriptor.hostNode,hostTransportKey:descriptor.hostTransportKey,epoch:descriptor.epoch},stream:original}))
      const body=crypto.prepareArchiveRotation(stream.id,before,scope,{operation:op.id,sourceHash:this.archive.digest,binding,forbiddenPrefixes:prefixes,sign:body=>{
        const envelope:Envelope<'participants.changed'>={v:1,minor:0,id:newId('event'),stream:stream.id,type:'participants.changed',crit:false,author:{user:self.user,node:self.node,keyEpoch:own.keyEpoch},ts:rt.db.clock.now(),auth:{metaEpoch:descriptor.epoch,metaSeq:1},body},envelopeBytes=canonicalJson(envelope),sig=keys.signAsNode(envelopeBytes)
        rt.identity.verifyAuthor(envelope.author,envelopeBytes,sig,rt.db.clock.now(),'newWork');return{envelope:envelopeBytes,sig}
      }})
      const entry=crypto.archiveRotationOriginal(stream.id,op.id,body.keyEpoch)
      freshBytes+=entry.envelope.length+entry.sig.length;if(freshBytes>65536)throw new NetError('too_large')
      // Actual charges are measured by the coordinator. Reserve a conservative
      // complete baseline/current/control/nonce/host-accounting budget too.
      rows+=24;bytes+=entry.envelope.length*12+8192
      prepared.push({original,entry,before,recipients:scope,prefixes,binding})
    }
    if(rt.db.database.prepare("SELECT 1 FROM net_executions WHERE scope=? AND state IN ('accepted','running','waitingApproval') LIMIT 1").get(input.space))throw new NetError('outcome_uncertain')
    return{rows,bytes,privateControls:prepared.map(p=>p.entry),commit:()=>{
      if(!rt.db.inTransaction||input.signal.aborted)throw new NetError('cancelled')
      for(const p of prepared){
        const current=crypto.prepareArchiveRotation(p.original.id,p.before,p.recipients,{operation:op.id,sourceHash:this.archive.digest,binding:p.binding,forbiddenPrefixes:p.prefixes,sign:()=>{throw new NetError('conflict')}})
        const original=crypto.archiveRotationOriginal(p.original.id,op.id,current.keyEpoch)
        if(!Buffer.from(original.envelope).equals(p.entry.envelope)||!Buffer.from(original.sig).equals(p.entry.sig))throw new NetError('conflict')
        this.profile.private.installArchiveBaseline(this.archive,p.original)
        this.profile.host.appendArchivePrivateControl(input.space,p.entry)
      }
    }}
  }
  private recipients(generation:string,before:Control,ownerRoot:string):NodeDelegation[]{
    const rt=this.profile.options.runtime,self=rt.identity.self()!,users=new Map<string,MemberRecord>(),bots:BotDelegation[]=[]
    for(const participant of before.participants){
      const user=isId('user',participant)?participant:(()=>{
        const row=rt.db.database.prepare("SELECT value FROM net_space_meta_entities WHERE generation=? AND kind='bot' AND id=?").get(generation,participant)
        if(!row?.value)throw new NetError('forbidden')
        const bot=JSON.parse(row.value as string) as BotRecord
        if(!before.participants.includes(bot.owner))throw new NetError('forbidden')
        const root=rt.identity.pinnedRootKey(bot.owner)
        if(!root)throw new NetError('profile_unsupported')
        const lease=verifyDocument<BotDelegation>(bot.delegation,root,'botDelegation');bots.push(lease);return bot.owner
      })()
      const row=rt.db.database.prepare("SELECT value FROM net_space_meta_roles WHERE generation=? AND user=? ORDER BY epoch DESC,seq DESC LIMIT 1").get(generation,user)
      if(!row?.value)throw new NetError('not_member')
      const member=JSON.parse(row.value as string) as MemberRecord
      if(member.user!==user||user===self.user&&member.rootKey!==ownerRoot)throw new NetError('forbidden')
      users.set(user,member)
    }
    const result=new Map<string,NodeDelegation>()
    for(const member of users.values()){
      const pinned=rt.identity.pinnedRootKey(member.user),signed=rt.identity.roster(member.user)
      if(!pinned||!signed)throw new NetError('profile_unsupported')
      if(pinned!==member.rootKey||rt.identity.rosterState(member.user)!=='ok')throw new NetError('bad_delegation')
      const roster=verifyDocument<Roster>(signed,pinned,'roster')
      if(roster.owner!==member.user||roster.rootKey!==member.rootKey||roster.issuedAt>rt.db.clock.now())throw new NetError('bad_delegation')
      const latest=new Map<string,NodeDelegation>()
      for(const row of roster.nodes){const node=verifyDocument<NodeDelegation>(row,pinned,'nodeDelegation'),held=latest.get(node.subject);if(!held||node.keyEpoch>held.keyEpoch||node.keyEpoch===held.keyEpoch&&node.issuedAt>held.issuedAt)latest.set(node.subject,node)}
      for(const node of latest.values())if(node.issuedAt<=rt.db.clock.now()&&rt.db.clock.now()<node.expiresAt&&!roster.revoked.some(r=>r.subject===node.subject&&r.throughKeyEpoch>=node.keyEpoch))result.set(node.subject,node)
      for(const bot of bots.filter(b=>b.owner===member.user)){
        const current=roster.bots.map(b=>verifyDocument<BotDelegation>(b,pinned,'botDelegation')).filter(b=>b.subject===bot.subject).sort((a,b)=>b.keyEpoch-a.keyEpoch)[0]
        if(!current||current.hostNode!==bot.hostNode||current.keyEpoch!==bot.keyEpoch||current.keys.sign!==bot.keys.sign||bot.issuedAt>rt.db.clock.now()||rt.db.clock.now()>=bot.expiresAt||!result.has(bot.hostNode)||roster.revoked.some(r=>r.subject===bot.subject&&r.throughKeyEpoch>=bot.keyEpoch))throw new NetError('bad_delegation')
      }
    }
    if(!result.size||result.size>64)throw new NetError('too_large')
    return [...result.values()].sort((a,b)=>a.subject.localeCompare(b.subject))
  }
}
