import {createHash} from 'node:crypto'
import {NetError,type BotDelegation,type ExecutionId,type StoredRecord,type StreamDescriptor,type StreamId} from '../../../shared/net'
import type {IdentityService,StreamStore} from '../../net/contracts'
import {NetDatabase,json} from '../../net/store/database'
import {canonicalJson,decodeEnvelope} from '../../net/sync/codec'
import {BotRecordAuthorization,type BotOutputBinding} from '../../bots/admission/authorization'
import type {MetaProjection} from '../host/meta'
import type {PrivateState} from '../private'
import type {ArchiveHistoryPlacement} from './history'
const receipts=new Set(['bot.run.accepted','bot.run.progress','bot.run.toolSummary','bot.run.waitingApproval','bot.run.completed','bot.run.failed','bot.run.cancelled','bot.run.uncertain','bot.run.expired'])
interface Pointer {stream:string;epoch:number;seq:number;id:string;type:string;execution:string}
const stored=(row:Record<string,unknown>):StoredRecord=>({epoch:Number(row.epoch),seq:Number(row.seq),recvTs:Number(row.recv_ts),envelope:new Uint8Array(row.envelope as Uint8Array),sig:new Uint8Array(row.sig as Uint8Array)})

/** Archive-only historical statements, using isolated public evidence. This
 * class never instantiates an executor, adopts keys or writes profile bindings. */
export class ArchiveBotReceiptVerifier {
  private readonly gate:BotRecordAuthorization
  private indexed=0
  private openings=0
  constructor(readonly options:{db:NetDatabase;identity:IdentityService;store:StreamStore;meta:MetaProjection;placement:ArchiveHistoryPlacement}){
    const {db,identity,meta}=options
    db.database.exec(`CREATE TABLE archive_bot_receipts(stream TEXT NOT NULL,epoch INTEGER NOT NULL,seq INTEGER NOT NULL,id TEXT NOT NULL,type TEXT NOT NULL,execution TEXT NOT NULL,PRIMARY KEY(stream,epoch,seq)) STRICT;
      CREATE INDEX archive_bot_execution ON archive_bot_receipts(execution,type);
      CREATE TABLE archive_thread_openings(stream TEXT NOT NULL,child TEXT NOT NULL,epoch INTEGER NOT NULL,seq INTEGER NOT NULL,id TEXT NOT NULL,PRIMARY KEY(stream,epoch,seq)) STRICT;
      CREATE INDEX archive_opening_child ON archive_thread_openings(stream,child);
      CREATE UNIQUE INDEX archive_bot_acceptance ON archive_bot_receipts(execution) WHERE type='bot.run.accepted';
      CREATE TABLE archive_private_controls(stream TEXT NOT NULL,epoch INTEGER NOT NULL,seq INTEGER NOT NULL,key_epoch INTEGER NOT NULL,state TEXT NOT NULL,PRIMARY KEY(stream,epoch,seq)) STRICT;
      CREATE INDEX archive_private_control_lookup ON archive_private_controls(stream,key_epoch,epoch,seq);
      CREATE TABLE archive_bot_bindings(execution TEXT PRIMARY KEY,accepted TEXT NOT NULL,binding TEXT NOT NULL) STRICT`)
    this.gate=new BotRecordAuthorization({identity,meta,store:options.store,binding:(_space,execution)=>this.binding(execution),
      historicalBot:(space,bot,auth)=>{const row=meta.botAt(space,bot,auth),member=row&&meta.memberAt(space,row.owner,auth);if(!row||!member)return;const delegated=identity.verifySigned<BotDelegation>(row.delegation,member.rootKey);return{owner:row.owner,hostNode:delegated.hostNode,keyEpoch:delegated.keyEpoch}},
      historicalMember:(space,user,auth)=>!!meta.memberAt(space,user,auth),historicalCanSteer:(space,bot,user,auth)=>meta.canSteerAt(space,bot,user,auth)})
  }
  index(record:StoredRecord,descriptor:StreamDescriptor):void{
    const envelope=decodeEnvelope(record.envelope).envelope
    if(envelope.type==='thread.opened'){
      const body=envelope.body as {stream?:string}|undefined
      if(!body?.stream)throw new NetError('profile_unsupported')
      if(this.openings>=65536)throw new NetError('too_large')
      const db=this.options.db
      db.transaction(()=>{db.charge(1,256);db.database.prepare('INSERT INTO archive_thread_openings VALUES(?,?,?,?,?)').run(descriptor.id,body.stream!,record.epoch,record.seq,envelope.id)});this.openings++
    }
    if(envelope.type.startsWith('bot.permission.'))throw new NetError('profile_unsupported')
    if(envelope.type.startsWith('bot.run.')&&!envelope.author.bot)throw new NetError('forbidden')
    if(!envelope.author.bot)return
    if(!receipts.has(envelope.type))throw new NetError('profile_unsupported')
    if(!descriptor.space||!envelope.refs?.execution)throw new NetError('forbidden')
    const db=this.options.db,execution=envelope.refs.execution
    if(this.indexed>=65536)throw new NetError('too_large')
    if(envelope.type==='bot.run.accepted'&&db.database.prepare("SELECT 1 FROM archive_bot_receipts WHERE execution=? AND type='bot.run.accepted'").get(envelope.refs.execution))throw new NetError('conflict')
    db.transaction(()=>{db.charge(1,256);db.database.prepare('INSERT INTO archive_bot_receipts VALUES(?,?,?,?,?,?)').run(descriptor.id,record.epoch,record.seq,envelope.id,envelope.type,execution)});this.indexed++
  }
  /** Only after ordinary private replay successfully verified this original. */
  retainControl(record:StoredRecord,descriptor:StreamDescriptor):void{
    const envelope=decodeEnvelope(record.envelope).envelope
    if(envelope.type!=='participants.changed'||descriptor.kind!=='space.private'||!descriptor.space)throw new NetError('forbidden')
    const body=envelope.body as PrivateState['control'],state:PrivateState={space:descriptor.space,stream:descriptor.id,controller:body.controller,control:body,position:{epoch:record.epoch,seq:record.seq},blocked:false},text=json(state),db=this.options.db
    db.charge(1,Buffer.byteLength(text));db.database.prepare('INSERT INTO archive_private_controls VALUES(?,?,?,?,?)').run(descriptor.id,record.epoch,record.seq,body.keyEpoch,text)
  }
  control(descriptor:StreamDescriptor,record:StoredRecord):PrivateState|undefined{
    if(descriptor.kind!=='space.private')return
    const envelope=decodeEnvelope(record.envelope).envelope
    if(!envelope.sealed)throw new NetError('forbidden')
    const row=this.options.db.database.prepare('SELECT state FROM archive_private_controls WHERE stream=? AND key_epoch=? AND (epoch<? OR (epoch=? AND seq<?)) ORDER BY epoch DESC,seq DESC LIMIT 1').get(descriptor.id,envelope.sealed.keyEpoch,record.epoch,record.epoch,record.seq)
    if(!row)throw new NetError('forbidden')
    return JSON.parse(row.state as string) as PrivateState
  }
  verifyAll(additional?:(record:StoredRecord,descriptor:StreamDescriptor,control?:PrivateState)=>void):void{
    const db=this.options.db;let verified=0
    for(const row of db.database.prepare('SELECT * FROM archive_bot_receipts ORDER BY epoch,stream,seq').iterate()){
      const receipt=row as unknown as Pointer,record=this.record(receipt),descriptor=this.descriptor(receipt),control=this.control(descriptor,record),envelope=decodeEnvelope(record.envelope).envelope
      if(envelope.type==='bot.run.expired'){
        if(db.database.prepare("SELECT 1 FROM archive_bot_receipts WHERE execution=? AND type!='bot.run.expired' LIMIT 1").get(receipt.execution))throw new NetError('conflict')
      }else {
        this.ensureAcceptance(receipt.execution as ExecutionId)
        const accepted=db.database.prepare("SELECT epoch,seq,id FROM archive_bot_receipts WHERE execution=? AND type='bot.run.accepted'").get(receipt.execution)!
        if(envelope.type!=='bot.run.accepted'&&(record.epoch<Number(accepted.epoch)||record.epoch===accepted.epoch&&record.seq<=Number(accepted.seq)))throw new NetError('forbidden')
      }
      this.withStore(record.epoch,()=>this.gate.verifyHistory(record,descriptor,control))
      this.verifyTriggerControl(record,descriptor,control)
      verified++
    }
    if(verified!==this.indexed||verified!==Number(db.database.prepare('SELECT count(*) AS n FROM archive_bot_receipts').get()!.n))throw new NetError('forbidden')
    // Extra trusted policy can only deny after the complete builtin proof.
    if(additional)for(const row of db.database.prepare('SELECT * FROM archive_bot_receipts ORDER BY epoch,stream,seq').iterate()){const pointer=row as unknown as Pointer,record=this.record(pointer),descriptor=this.descriptor(pointer);additional(record,descriptor,this.control(descriptor,record))}
  }
  private ensureAcceptance(execution:ExecutionId):void{
    if(this.binding(execution))return
    const row=this.options.db.database.prepare("SELECT * FROM archive_bot_receipts WHERE execution=? AND type='bot.run.accepted' LIMIT 1").get(execution)
    if(!row)throw new NetError('forbidden')
    const pointer=row as unknown as Pointer,record=this.record(pointer),descriptor=this.descriptor(pointer),envelope=decodeEnvelope(record.envelope).envelope,control=this.control(descriptor,record)
    if(!descriptor.space||!envelope.refs?.subject||!envelope.author.bot)throw new NetError('forbidden')
    let parent=descriptor.parent
    if(descriptor.kind==='space.private'){
      const rows=this.options.db.database.prepare("SELECT s.id FROM net_records r JOIN net_streams s ON s.active_generation=r.generation WHERE r.id=? AND s.space_id=? AND s.kind IN ('space.channel','space.private') LIMIT 2").all(envelope.refs.subject,descriptor.space)
      if(rows.length!==1)throw new NetError('forbidden');parent=rows[0].id as StreamId
    }
    if(!parent)throw new NetError('forbidden')
    this.verifyOpening(record,descriptor,control)
    const binding:BotOutputBinding={space:descriptor.space,stream:descriptor.id,parent,bot:envelope.author.bot,trigger:envelope.refs.subject,execution,...(control?{visibilityEpoch:control.control.visibilityEpoch,participantHash:createHash('sha256').update(canonicalJson(control.control.participants)).digest('base64url')}:{})}
    const prior=this.gate.options.binding;this.gate.options.binding=(_space,id)=>id===execution?binding:prior(_space,id)
    try{this.withStore(record.epoch,()=>this.gate.verifyHistory(record,descriptor,control));this.verifyTriggerControl(record,descriptor,control,binding)}finally{this.gate.options.binding=prior}
    const text=json(binding),db=this.options.db
    db.transaction(()=>{db.charge(1,Buffer.byteLength(text)+envelope.id.length+execution.length);db.database.prepare('INSERT INTO archive_bot_bindings VALUES(?,?,?)').run(execution,envelope.id,text)})
  }
  private verifyOpening(record:StoredRecord,descriptor:StreamDescriptor,control?:PrivateState):void{
    if(!descriptor.space||!descriptor.parent)throw new NetError('forbidden')
    const receipt=decodeEnvelope(record.envelope).envelope
    if(descriptor.kind==='space.thread'&&descriptor.createdAt!==receipt.ts)throw new NetError('forbidden')
    const rows=this.options.db.database.prepare('SELECT stream,epoch,seq,id FROM archive_thread_openings WHERE stream=? AND child=? LIMIT 2').all(descriptor.parent,descriptor.id)
    if(rows.length!==1)throw new NetError('forbidden')
    const opening=this.record(rows[0] as unknown as Pointer),envelope=decodeEnvelope(opening.envelope).envelope,body=envelope.body as {stream:string;private:boolean},author=this.options.identity.verifyAuthor(envelope.author,opening.envelope,opening.sig,envelope.ts,'history')
    if(author.kind!=='node'||!envelope.auth||body.stream!==descriptor.id||body.private!==(descriptor.kind==='space.private')||opening.epoch>record.epoch)throw new NetError('forbidden')
    const owner=this.options.meta.position(descriptor.space)?.owner,original=this.options.placement.descriptor(this.options.store.getStream(descriptor.id)!,opening.epoch)
    if(descriptor.kind==='space.thread'){
      if(author.node!==original.authority||author.user!==owner||envelope.refs?.replyTo!==receipt.refs?.subject||this.options.meta.memberAt(descriptor.space,author.user,envelope.auth)?.role!=='owner')throw new NetError('forbidden')
    }else if(!control||control.controller!==author.user||envelope.refs||!this.options.meta.memberAt(descriptor.space,author.user,envelope.auth))throw new NetError('forbidden')
  }
  private verifyTriggerControl(record:StoredRecord,descriptor:StreamDescriptor,control?:PrivateState,supplied?:BotOutputBinding):void{
    const envelope=decodeEnvelope(record.envelope).envelope,binding=supplied??(envelope.refs?.execution?this.binding(envelope.refs.execution):undefined),parent=binding?.parent??descriptor.id,triggerId=binding?.trigger??envelope.refs?.subject
    if(!triggerId||!descriptor.space)throw new NetError('forbidden')
    const original=this.options.store.getById(parent,triggerId),parentDescriptor=this.options.store.getStream(parent)
    if(!original||!parentDescriptor||parentDescriptor.space!==descriptor.space||original.epoch>record.epoch||parent===descriptor.id&&original.epoch===record.epoch&&original.seq>=record.seq)throw new NetError('forbidden')
    const message=decodeEnvelope(original.envelope).envelope
    if(parentDescriptor.kind==='space.private'){
      const state=this.control(parentDescriptor,original)
      if(!state||!message.author.user||!envelope.author.bot||!state.control.participants.includes(message.author.user)||!state.control.participants.includes(envelope.author.bot)||!control||state.control.visibilityEpoch!==control.control.visibilityEpoch||json(state.control.participants)!==json(control.control.participants))throw new NetError('forbidden')
    }
  }
  private binding(execution:ExecutionId):BotOutputBinding|undefined{const row=this.options.db.database.prepare('SELECT binding FROM archive_bot_bindings WHERE execution=?').get(execution);return row?JSON.parse(row.binding as string):undefined}
  private record(pointer:Pointer):StoredRecord{
    const row=this.options.db.database.prepare('SELECT r.* FROM net_records r JOIN net_streams s ON s.active_generation=r.generation WHERE s.id=? AND r.epoch=? AND r.seq=? AND r.id=?').get(pointer.stream,pointer.epoch,pointer.seq,pointer.id)
    if(!row)throw new NetError('forbidden');return stored(row)
  }
  private descriptor(pointer:Pointer):StreamDescriptor{const descriptor=this.options.store.getStream(pointer.stream as StreamId);if(!descriptor)throw new NetError('forbidden');return this.options.placement.descriptor(descriptor,pointer.epoch)}
  private withStore(epoch:number,work:()=>void):void{const prior=this.gate.options.store;this.gate.options.store=this.options.placement.store(this.options.store,epoch);try{work()}finally{this.gate.options.store=prior}}
}
