import { NetError, STORE_TXN_MAX_BYTES, STORE_TXN_MAX_ROWS } from '../../../shared/net'
import type { Envelope, Signed, SpaceDescriptor, SpaceId, StreamId } from '../../../shared/net'
import { decodeBase64, verifyDocument } from '../../net/identity/crypto'
import { NetDatabase, integer, json } from '../../net/store/database'
import type { SqliteStreamStore } from '../../net/store/streams'
import type { SpaceHostService } from '../host/service'
import { RosterEvidence } from '../RosterEvidence'
import { SpaceImportStage } from './ImportStage'
import { ArchiveJournal } from './journal'
import { isVerifiedSpaceArchive } from './container'
import type { VerifiedSpaceArchive } from './contracts'
import { decodeEnvelope } from '../../net/sync/codec'
import {ArchiveHistoryPlacement} from './history'

export interface PreparedSpaceRecovery {
  /** Trusted port declares its complete synchronous transaction cost. Actual
   * NetDatabase charge still enforces the limit and rolls back an overrun. */
  rows:number; bytes:number; commit():void;
  privateControls?:Array<{stream:StreamId;envelope:Uint8Array;sig:Uint8Array}>;
}
export interface SpaceImportOptions {
  host:SpaceHostService;store:SqliteStreamStore;
  quiesce(space:SpaceId,signal:AbortSignal):Promise<void>;
  /** Must reconcile existing executions and prepare fresh controller controls /
   * nonce state for EVERY private stream. No default attestation is supplied. */
  prepareRecovery(input:{space:SpaceId;descriptor:Signed;streams:ReturnType<SpaceImportStage['descriptors']>;signal:AbortSignal}):Promise<PreparedSpaceRecovery>;
  verifyRetirement?(archive:VerifiedSpaceArchive,retirement:Signed):void;
}
/** Trusted local lifecycle controller. No network operation accepts archive
 * paths, private keys or a renderer-provided recovery callback. */
export class SpaceImportCoordinator {
  readonly journal:ArchiveJournal
  private readonly db:NetDatabase
  constructor(readonly options:SpaceImportOptions) {
    if(typeof options.quiesce!=='function'||typeof options.prepareRecovery!=='function')throw new NetError('forbidden')
    this.db=options.host.options.db;this.journal=new ArchiveJournal(this.db)
    this.db.database.exec('CREATE TABLE IF NOT EXISTS net_space_archive_added_refs(operation TEXT NOT NULL,blob TEXT NOT NULL,stream TEXT NOT NULL,event TEXT NOT NULL,PRIMARY KEY(operation,blob,stream,event)) STRICT')
    const prior=options.host.options.archiveAccess
    options.host.options.archiveAccess=(space,action)=>this.journal.allows(space,action)&&prior?.(space,action)!==false
  }
  async import(archive:VerifiedSpaceArchive,mode:'restore'|'move',signal:AbortSignal,retirement?:Signed):Promise<{operation:string;state:'importedFrozen'}> {
    if(!isVerifiedSpaceArchive(archive))throw new NetError('forbidden')
    const o=this.options.host.options,self=o.identity.self(),m=archive.manifest
    if(!self||self.user!==m.owner.user||o.identity.pinnedRootKey(self.user)!==m.owner.rootKey)throw new NetError('forbidden')
    if(mode==='move') {if(!retirement||!this.options.verifyRetirement)throw new NetError('forbidden');this.options.verifyRetirement(archive,retirement)}
    const previous=this.journal.forSpace(m.space)
    if(previous&&!['frozen','failedFrozen','exported','retired','activeNew','importing'].includes(previous.state))throw new NetError('conflict')
    const current=o.projection.position(m.space)
    if(current&&current.status!=='frozen')throw new NetError('space_frozen')
    signal.throwIfAborted();await this.options.quiesce(m.space,signal);signal.throwIfAborted()
    if(previous?.state==='importing') {
      if(previous.digest!==archive.digest||previous.mode!==mode)throw new NetError('conflict')
      this.discardRefs(previous.id);SpaceImportStage.discardOperation(this.db,previous.id)
    }
    const op=previous?.state==='importing'&&previous.digest===archive.digest&&previous.mode===mode?previous:this.journal.create(m.space,m.frozen,'importing',mode,archive.digest)
    // Public historical proof is retained without adopting unrelated user pins.
    const evidence=new RosterEvidence(this.db)
    for(const signed of archive.rosters()) {
      evidence.retain(signed)
      const raw=JSON.parse(decodeBase64(signed.payload).toString())
      if(raw.owner===self.user)o.identity.acceptRoster(signed,m.owner.rootKey)
    }
    const stage=SpaceImportStage.prepare(this.db,archive,op.id,mode)
    try {
      // Copy stored ciphertext through the real content-addressed blob verifier.
      // Pending slots protect writes; signed staged refs protect committed bytes
      // from GC while descriptors remain hidden.
      if(m.blobs.length&&!o.blobs)throw new NetError('forbidden')
      for(const blob of m.blobs)if(!o.blobs!.has(blob.id)) {
        const upload=o.blobs!.begin(blob.id,blob.bytes,blob.sealed)
        try{for(let offset=0;offset<blob.bytes;){signal.throwIfAborted();const chunk=archive.readBlob(blob.id,offset,Math.min(65536,blob.bytes-offset));upload.write(offset,chunk);offset+=chunk.length}upload.commit()}catch(error){upload.abort();throw error}
      }
      for(const ref of archive.refs())this.db.transaction(()=>{
        const blob=this.db.database.prepare('SELECT bytes,sealed FROM net_blobs WHERE id=?').get(ref.blob)
        if(!blob||Number(blob.bytes)!==ref.bytes||!!blob.sealed!==ref.sealed)throw new NetError('conflict')
        if(this.db.database.prepare('SELECT 1 FROM net_blob_refs WHERE blob=? AND stream=? AND event=?').get(ref.blob,ref.stream,ref.event))return
        this.db.charge(2);this.db.database.prepare('INSERT INTO net_blob_refs VALUES(?,?,?)').run(ref.blob,ref.stream,ref.event)
        this.db.database.prepare('INSERT INTO net_space_archive_added_refs VALUES(?,?,?,?)').run(op.id,ref.blob,ref.stream,ref.event)
      })
      const meta=[...archive.streams()].find(s=>s.descriptor.kind==='space.meta')!
      const placement=new ArchiveHistoryPlacement(archive)
      let carry:unknown
      for(const record of archive.records(meta.descriptor.id))this.db.transaction(()=>{
        signal.throwIfAborted();const prior=o.projection.options.store;o.projection.options.store=placement.store(this.options.store,record.epoch)
        try{carry=o.projection.append([record],placement.descriptor(meta.descriptor,record.epoch),meta.head,carry)}finally{o.projection.options.store=prior}
        stage.saveProjectionCarry(meta.descriptor.id,carry)
        const gen=(carry as {generation:string}).generation
        if(this.db.database.prepare('SELECT 1 FROM net_space_meta_violations WHERE generation=? LIMIT 1').get(gen))throw new NetError('forbidden')
      })
      const generation=(carry as {generation:string}).generation,state=JSON.parse(this.db.database.prepare('SELECT state FROM net_space_meta_state WHERE generation=?').get(generation)!.state as string)
      if(state.status!=='frozen'||state.owner!==m.owner.user||state.epoch!==m.frozen.epoch||state.seq!==m.frozen.seq)throw new NetError('forbidden')
      if(Number(this.db.database.prepare('SELECT count(DISTINCT user) AS n FROM net_space_meta_roles WHERE generation=? AND value IS NOT NULL').get(generation)!.n)>64)throw new NetError('too_large')
      this.db.transaction(()=>{this.journal.transition(op.id,'importing','importedFrozen');this.db.checkpoint('spaces.archive.import.beforeCommit')})
      return {operation:op.id,state:'importedFrozen'}
    } catch(error) {this.discardRefs(op.id);stage.discard();throw error}
  }
  async activate(space:SpaceId,descriptor:Signed,signal:AbortSignal):Promise<import('../../../shared/net').StoredRecord> {
    const op=this.journal.forSpace(space)
    if(op?.state!=='importedFrozen'||!op.digest)throw new NetError('conflict')
    const stage=SpaceImportStage.resume(this.db,op.id,op.digest),ss=stage.descriptors(),meta=ss.find(s=>s.kind==='space.meta')!,o=this.options.host.options
    const doc=verifyDocument<SpaceDescriptor>(descriptor,o.identity.pinnedRootKey(o.identity.self()!.user)!,'spaceDescriptor')
    const held=this.db.database.prepare('SELECT max(r.epoch) AS epoch FROM net_records r JOIN net_generations g ON g.id=r.generation JOIN net_streams s ON s.id=g.stream WHERE s.space_id=?').get(space)
    const current=this.db.database.prepare('SELECT max(epoch) AS epoch FROM net_streams WHERE space_id=?').get(space)
    if(doc.space!==space||doc.epoch<=Math.max(op.frozen.epoch,Number(held?.epoch??0),Number(current?.epoch??0)))throw new NetError('conflict')
    signal.throwIfAborted();await this.options.quiesce(space,signal);signal.throwIfAborted()
    const recovery=await this.options.prepareRecovery({space,descriptor,streams:ss,signal});signal.throwIfAborted()
    integer(recovery.rows);integer(recovery.bytes)
    const privateStreams=ss.filter(s=>s.kind==='space.private'),controls=recovery.privateControls??[]
    if(controls.length!==privateStreams.length||new Set(controls.map(c=>c.stream)).size!==controls.length)throw new NetError('forbidden','Every private stream requires a prepared fresh controller rotation.')
    for(const stream of privateStreams) {
      const entry=stage.plan.entries.find(e=>e.descriptor.id===stream.id)!,control=controls.find(c=>c.stream===stream.id)!
      const prior=this.db.database.prepare("SELECT envelope FROM net_records WHERE generation=? AND json_extract(CAST(envelope AS TEXT),'$.type')='participants.changed' ORDER BY epoch,seq LIMIT 65").all(entry.generation)
      if(!prior.length||prior.length>64)throw new NetError('forbidden')
      const old=prior.map(row=>decodeEnvelope(row.envelope as Uint8Array).envelope.body as NonNullable<Envelope<'participants.changed'>['body']>),last=old.at(-1)!,fresh=decodeEnvelope(control.envelope).envelope,body=fresh.body as NonNullable<Envelope<'participants.changed'>['body']>,prefixes=new Set(old.flatMap(b=>b.writers.map(w=>w.noncePrefix)))
      if(fresh.type!=='participants.changed'||fresh.stream!==stream.id||fresh.author.bot||fresh.author.user!==last.controller||body.controller!==last.controller||fresh.auth?.metaEpoch!==doc.epoch||fresh.auth.metaSeq!==1||body.keyEpoch!==last.keyEpoch+1||body.writers.some(w=>prefixes.has(w.noncePrefix))||new Set(body.writers.map(w=>w.noncePrefix)).size!==body.writers.length)throw new NetError('forbidden')
    }
    // Each stream costs up to 4 pointer rows + one epoch/authority row. Reserve
    // rates for ≤64 members, identity/projection + terminal/journal overhead.
    const carry=stage.projectionCarry(meta.id) as {generation:string}
    const identityRow=this.db.database.prepare('SELECT value FROM net_identity_state WHERE singleton=1').get()
    let pinBytes=0
    if(o.projection.options.activatePins) {
      if(!identityRow)throw new NetError('not_enrolled')
      const checkpoint=JSON.parse(identityRow.value as string) as {users:Record<string,unknown>}
      const roots=this.db.database.prepare('SELECT user FROM net_space_meta_roles WHERE generation=? AND value IS NOT NULL GROUP BY user LIMIT 65').all(carry.generation)
      if(roots.length>64)throw new NetError('too_large')
      for(const root of roots) {
        const member=JSON.parse(this.db.database.prepare('SELECT value FROM net_space_meta_roles WHERE generation=? AND user=? AND value IS NOT NULL ORDER BY epoch DESC,seq DESC LIMIT 1').get(carry.generation,root.user!)!.value as string)
        if(!checkpoint.users[member.user])checkpoint.users[member.user]={root:member.rootKey,history:[],conflicts:[],state:'ok',revocations:{}}
      }
      pinBytes=Buffer.byteLength(JSON.stringify(checkpoint))
    }
    const fixedRows=ss.length*5+64*2+24,fixedBytes=Buffer.byteLength(json(ss))*2+65536+pinBytes
    if(fixedRows+recovery.rows>STORE_TXN_MAX_ROWS||fixedBytes+recovery.bytes>STORE_TXN_MAX_BYTES)throw new NetError('too_large')
    this.journal.transition(op.id,'importedFrozen','activating')
    try {
      const record=this.db.transaction(()=>{
        stage.commit()
        o.projection.finish(carry,meta,op.frozen)
        // The identity foundation bounds its singleton but does not use the
        // NetDatabase charge port. Include its actual rewrite in this combined
        // archive commit rather than omitting its potentially large bytes.
        if(o.projection.options.activatePins)this.db.charge(1,Buffer.byteLength(this.db.database.prepare('SELECT value FROM net_identity_state WHERE singleton=1').get()!.value as string))
        stage.clearProjectionCarry(meta.id)
        this.options.host.initializeArchiveAccounting(space)
        const result=this.options.host.activateForArchive(space,descriptor,(epoch,authority)=>this.options.store.activateSpaceEpoch(space,epoch,authority))
        const before=this.db.transactionUsage
        const callbackResult:unknown=recovery.commit()
        if(callbackResult&&typeof(callbackResult as {then?:unknown}).then==='function')throw new NetError('bad_request')
        const after=this.db.transactionUsage
        if(after.rows-before.rows>recovery.rows||after.bytes-before.bytes>recovery.bytes)throw new NetError('too_large')
        for(const control of controls) {
          const envelope=decodeEnvelope(control.envelope).envelope
          o.identity.verifyAuthor(envelope.author,control.envelope,control.sig,this.db.clock.now(),'newWork')
          if(!o.projection.member(space,envelope.author.user!))throw new NetError('not_member')
          const record=this.options.store.getById(control.stream,envelope.id)
          if(!record||record.epoch!==doc.epoch||record.seq!==1||!Buffer.from(record.envelope).equals(control.envelope)||!Buffer.from(record.sig).equals(control.sig))throw new NetError('forbidden','Fresh private controls did not commit as prepared.')
        }
        if(this.db.database.prepare("SELECT 1 FROM net_executions WHERE scope=? AND state IN ('accepted','running','waitingApproval') LIMIT 1").get(space))throw new NetError('outcome_uncertain')
        this.journal.transition(op.id,'activating','activeNew')
        this.db.checkpoint('spaces.archive.activation.beforeCommit')
        return result
      })
      this.clearRefMarkers(op.id)
      return record
    } catch(error) {this.journal.transition(op.id,'activating','importedFrozen');throw error}
  }
  private clearRefMarkers(operation:string):void {
    for(;;){const rows=this.db.database.prepare('SELECT rowid FROM net_space_archive_added_refs WHERE operation=? LIMIT 500').all(operation);if(!rows.length)break;this.db.transaction(()=>{this.db.charge(rows.length);for(const row of rows)this.db.database.prepare('DELETE FROM net_space_archive_added_refs WHERE rowid=?').run(row.rowid!)})}
  }
  private discardRefs(operation:string):void {
    for(;;){const rows=this.db.database.prepare('SELECT rowid,* FROM net_space_archive_added_refs WHERE operation=? LIMIT 250').all(operation);if(!rows.length)break;this.db.transaction(()=>{this.db.charge(rows.length*2);for(const row of rows){this.db.database.prepare('DELETE FROM net_blob_refs WHERE blob=? AND stream=? AND event=?').run(row.blob!,row.stream!,row.event!);this.db.database.prepare('DELETE FROM net_space_archive_added_refs WHERE rowid=?').run(row.rowid!)}})}
  }
}
