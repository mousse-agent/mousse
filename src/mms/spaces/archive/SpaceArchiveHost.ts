import { DatabaseSync } from 'node:sqlite'
import { NetError } from '../../../shared/net'
import type { Signed, SpaceId, StoredRecord, StreamId } from '../../../shared/net'
import { decodeEnvelope } from '../../net/sync/codec'
import { json } from '../../net/store/database'
import type { SpaceHostService } from '../host/service'
import type { ArchiveManifest, ArchiveStream, SpaceArchiveSource } from './contracts'
import { ARCHIVE_LIMITS } from './contracts'
import { ArchiveJournal } from './journal'
import { writeSpaceArchive } from './container'
import { readVerifiedSpaceArchive,type ArchiveVerificationOptions } from './verify'

/** Only a trusted local composition can prove jobs/uploads/executions drained.
 * There is deliberately no default, timeout-to-success or remote path input. */
export interface SpaceArchiveHostOptions {
  host: SpaceHostService;
  quiesce(space: SpaceId, signal: AbortSignal): Promise<void>;
  verifyBotRecord?:ArchiveVerificationOptions['verifyBotRecord'];
}
export class SpaceArchiveHost {
  readonly journal: ArchiveJournal
  constructor(readonly options: SpaceArchiveHostOptions) {
    if (typeof options.quiesce !== 'function') throw new NetError('forbidden', 'Space archive requires a trusted quiescence port.')
    this.journal = new ArchiveJournal(options.host.options.db)
    const prior=options.host.options.archiveAccess
    options.host.options.archiveAccess=(space,action)=>this.journal.allows(space,action)&&prior?.(space,action)!==false
  }
  freeze(space: SpaceId, reason: string): StoredRecord {
    const {host} = this.options
    return host.options.db.transaction(() => {
      const record = host.freezeForArchive(space,reason)
      const existing = this.journal.forSpace(space)
      if (existing && existing.state!=='activeNew' && (existing.frozen.epoch !== record.epoch || existing.frozen.seq !== record.seq)) throw new NetError('conflict')
      if (!existing||existing.state==='activeNew') this.journal.create(space,{epoch:record.epoch,seq:record.seq})
      return record
    })
  }
  async export(space: SpaceId, destination: string, signal: AbortSignal): Promise<{digest:string;manifest:ArchiveManifest}> {
    const op = this.journal.forSpace(space)
    if (!op || !['frozen','failedFrozen'].includes(op.state)) throw new NetError('conflict')
    this.journal.transition(op.id,op.state,'exporting')
    try {
      signal.throwIfAborted(); await this.options.quiesce(space,signal); signal.throwIfAborted()
      const result = writeSpaceArchive(this.snapshot(space),destination,this.options.host.options.db.clock.now())
      const verified=readVerifiedSpaceArchive(destination,{owner:result.manifest.owner,verifyBotRecord:this.options.verifyBotRecord});verified.close()
      this.options.host.options.db.transaction(() => {
        this.journal.transition(op.id,'exporting','exported',result.digest)
        this.options.host.options.db.checkpoint('spaces.archive.export.beforeCommit')
      })
      return result
    } catch (error) { this.journal.transition(op.id,'exporting','failedFrozen'); throw error }
  }
  /** One pinned SQLite read transaction covers descriptors, events and blob refs. */
  private snapshot(space: SpaceId): SpaceArchiveSource {
    const o = this.options.host.options, p = o.projection.position(space), self = o.identity.self()
    if (!p || p.status !== 'frozen' || p.owner !== self?.user || !o.blobs) throw new NetError('forbidden')
    const owner = o.projection.member(space,p.owner!)!
    const db = new DatabaseSync(o.db.path,{readOnly:true}); db.exec('BEGIN')
    let closed = false
    const rows = db.prepare('SELECT * FROM net_streams WHERE space_id=? ORDER BY id LIMIT 129').all(space)
    if (rows.length > 128) { db.exec('ROLLBACK'); db.close(); throw new NetError('too_large') }
    const ss: ArchiveStream[] = rows.map(row => ({descriptor:JSON.parse(row.descriptor as string),head:{epoch:Number(row.epoch),seq:Number(row.head)},retained:Number(row.retained)}))
    const generations = new Map(rows.map(row => [row.id as StreamId,row.active_generation as string]))
    const proof = new Map<string,Signed>()
    let proofBytes=0
    const add = (signed: Signed | undefined): void => {
      if (!signed) throw new NetError('bad_delegation', 'Original Space history lacks retained roster evidence.')
      const value=json(signed)
      if(proof.has(value))return
      proofBytes+=Buffer.byteLength(value)
      if(proof.size>=ARCHIVE_LIMITS.rosters||proofBytes>ARCHIVE_LIMITS.rosterBytes)throw new NetError('too_large')
      proof.set(value,signed)
    }
    try {
      // Authenticated history may use old member/key epochs, so include public
      // evidence for actual authors rather than merely the latest roster.
      for (const s of ss) for (const row of db.prepare('SELECT recv_ts,envelope,sig FROM net_records WHERE generation=? ORDER BY epoch,seq').iterate(generations.get(s.descriptor.id)!)) {
        const bytes = row.envelope as Uint8Array, sig = row.sig as Uint8Array, envelope = decodeEnvelope(bytes).envelope
        o.identity.verifyAuthor(envelope.author,bytes,sig,Number(row.recv_ts),'history')
        add(o.identity.historicalRosterFor(envelope.author,Number(row.recv_ts)))
      }
      // Removed participants still authenticate original controller wraps. Read
      // only public rosters for authenticated historical members from the same
      // pinned snapshot; never export the identity singleton or private state.
      const generation=db.prepare('SELECT generation FROM net_space_meta_active WHERE space_id=?').get(space)?.generation
      if(!generation)throw new NetError('conflict')
      for(const member of db.prepare('SELECT DISTINCT user FROM net_space_meta_roles WHERE generation=? AND value IS NOT NULL').iterate(generation)) {
        const path=`$.users.${JSON.stringify(member.user)}.history`
        const row=db.prepare('SELECT json_extract(value,?) AS history FROM net_identity_state WHERE singleton=1').get(path)
        if(!row?.history)throw new NetError('bad_delegation','Original Space history lacks retained roster evidence.')
        for(const signed of JSON.parse(row.history as string) as Signed[])add(signed)
      }
      add(o.identity.roster(owner.user))
      const meta = ss.find(s => s.descriptor.kind === 'space.meta')
      if (!meta || meta.head.epoch !== p.epoch || meta.head.seq !== p.seq) throw new NetError('conflict')
      return {
        space,owner:{user:owner.user,rootKey:owner.rootKey},exporter:self!.node,frozen:{epoch:p.epoch,seq:p.seq},
        streams:() => ss,
        records:function*(stream) {
          const gen = generations.get(stream); if (!gen) throw new NetError('stream_unknown')
          for (const r of db.prepare('SELECT epoch,seq,recv_ts,envelope,sig FROM net_records WHERE generation=? ORDER BY epoch,seq').iterate(gen)) yield {epoch:Number(r.epoch),seq:Number(r.seq),recvTs:Number(r.recv_ts),envelope:new Uint8Array(r.envelope as Uint8Array),sig:new Uint8Array(r.sig as Uint8Array)}
        },
        rosters:() => proof.values(),
        refs:function*() {
          for (const r of db.prepare('SELECT br.*,b.bytes,b.sealed FROM net_blob_refs br JOIN net_blobs b ON b.id=br.blob JOIN net_streams s ON s.id=br.stream JOIN net_records r ON r.generation=s.active_generation AND r.id=br.event WHERE s.space_id=? ORDER BY br.stream,br.event,br.blob').iterate(space)) yield {stream:r.stream as StreamId,event:r.event as import('../../../shared/net').EventId,blob:r.blob as import('../../../shared/net').BlobId,bytes:Number(r.bytes),sealed:!!r.sealed}
        },
        readBlob:(...args) => o.blobs!.read(...args), sign:manifest => o.identity.signAsNode(manifest),
        close:() => { if (!closed) {closed=true;db.exec('ROLLBACK');db.close()} }
      }
    } catch (error) { db.exec('ROLLBACK'); db.close(); throw error }
  }
}
