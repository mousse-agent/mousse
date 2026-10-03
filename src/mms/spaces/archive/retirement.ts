import { NetError } from '../../../shared/net'
import type { NodeDelegation,Roster,Signed,SpaceId,StreamHead,UserId,NodeId } from '../../../shared/net'
import { decodeBase64,verifyDocument } from '../../net/identity/crypto'
import type { SpaceArchiveHost } from './SpaceArchiveHost'
import { isVerifiedSpaceArchive } from './container'
import type { VerifiedSpaceArchive } from './contracts'
import { json } from '../../net/store/database'

interface Retirement {
  v:1;kind:'space.archive.retirement';space:SpaceId;archiveDigest:string;frozen:StreamHead;
  owner:UserId;source:NodeId;at:number;roster:Signed;
}
export function verifySpaceRetirement(archive:VerifiedSpaceArchive,evidence:Signed):void {
  if(!isVerifiedSpaceArchive(archive))throw new NetError('forbidden')
  const raw=JSON.parse(decodeBase64(evidence.payload).toString()) as Retirement,m=archive.manifest
  if(raw.v!==1||raw.kind!=='space.archive.retirement'||raw.space!==m.space||raw.archiveDigest!==archive.digest||json(raw.frozen)!==json(m.frozen)||raw.owner!==m.owner.user||raw.source!==m.exporter||!Number.isSafeInteger(raw.at)||raw.at<m.exportedAt)throw new NetError('forbidden')
  const roster=verifyDocument<Roster>(raw.roster,m.owner.rootKey,'roster')
  if(roster.owner!==m.owner.user||roster.issuedAt>raw.at)throw new NetError('bad_delegation')
  const node=roster.nodes.map(d=>verifyDocument<NodeDelegation>(d,m.owner.rootKey,'nodeDelegation')).filter(d=>d.subject===raw.source).sort((a,b)=>b.keyEpoch-a.keyEpoch||b.issuedAt-a.issuedAt)[0]
  if(!node||node.owner!==raw.owner||node.issuedAt>raw.at||raw.at>=node.expiresAt||roster.revoked.some(r=>r.subject===node.subject&&r.throughKeyEpoch>=node.keyEpoch&&r.revokedAt<=raw.at))throw new NetError('bad_delegation')
  if(json(verifyDocument<Retirement>(evidence,node.keys.sign))!==json(raw))throw new NetError('bad_signature')
}

/** Source fence/evidence precede deletion. Cleanup is bounded and resumable;
 * the signed proof and journal deliberately live outside the deleted Space. */
export async function retireSpaceAuthority(host:SpaceArchiveHost,archive:VerifiedSpaceArchive,signal:AbortSignal):Promise<Signed> {
  const o=host.options.host.options,db=o.db,space=archive.manifest.space,op=host.journal.forSpace(space)
  if(!isVerifiedSpaceArchive(archive)||!op||!['exported','retiring','retired'].includes(op.state)||op.digest!==archive.digest||json(op.frozen)!==json(archive.manifest.frozen))throw new NetError('conflict')
  db.database.exec('CREATE TABLE IF NOT EXISTS net_space_archive_retirements(operation TEXT PRIMARY KEY,space TEXT NOT NULL,digest TEXT NOT NULL,evidence TEXT NOT NULL) STRICT')
  let evidence:Signed
  const previous=db.database.prepare('SELECT evidence FROM net_space_archive_retirements WHERE operation=?').get(op.id)
  if(previous)evidence=JSON.parse(previous.evidence as string)
  else {
    const self=o.identity.self(),p=o.projection.position(space)
    if(op.state!=='exported'||self?.node!==archive.manifest.exporter||self.user!==archive.manifest.owner.user||p?.status!=='frozen'||p.epoch!==op.frozen.epoch||p.seq!==op.frozen.seq)throw new NetError('forbidden')
    evidence=o.identity.signAsNode({v:1,kind:'space.archive.retirement',space,archiveDigest:archive.digest,frozen:op.frozen,owner:self.user,source:self.node,at:db.clock.now(),roster:o.identity.roster(self.user)!} satisfies Retirement)
    verifySpaceRetirement(archive,evidence)
    db.transaction(()=>{db.charge(1,Buffer.byteLength(json(evidence)));db.database.prepare('INSERT INTO net_space_archive_retirements VALUES(?,?,?,?)').run(op.id,space,archive.digest,json(evidence));host.journal.transition(op.id,'exported','retiring');db.checkpoint('spaces.archive.retirement.beforeFenceCommit')})
  }
  verifySpaceRetirement(archive,evidence)
  if(op.state==='retired')return evidence
  signal.throwIfAborted();await host.options.quiesce(space,signal);signal.throwIfAborted()
  const exists=(table:string)=>!!db.database.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name=?").get(table)
  const remove=(table:string,column:string,value:string)=>{
    if(!exists(table))return
    for(;;){const rows=db.database.prepare(`SELECT rowid FROM ${table} WHERE ${column}=? LIMIT 500`).all(value);if(!rows.length)break;db.transaction(()=>{db.charge(rows.length);for(const row of rows)db.database.prepare(`DELETE FROM ${table} WHERE rowid=?`).run(row.rowid!)})}
  }
  // Preserve execution dedup/outcomes, identity/root/node keys and unrelated
  // local sender state. Authority caches/bearers and original Space rows go.
  for(const row of db.database.prepare('SELECT id FROM net_space_host_invites WHERE space_id=? ORDER BY id').iterate(space)) {
    signal.throwIfAborted();o.keys.deleteSecret(`spaces/${row.id as string}/proof`)
  }
  for(const table of ['net_space_host_invites','net_space_host_receipts','net_space_thread_bindings','net_space_private_execution_bindings','net_space_private_openings','net_space_private_state','net_space_private_history','net_space_private_prepared'])remove(table,'space_id',space)
  remove('net_space_meta_active','space_id',space)
  for(const table of ['net_space_meta_entities','net_space_meta_roles','net_space_meta_violations','net_space_meta_state'])remove(table,'space_id',space)
  const streams=db.database.prepare('SELECT id FROM net_streams WHERE space_id=? ORDER BY id LIMIT 129').all(space)
  if(streams.length>128)throw new NetError('too_large')
  for(const row of streams) {
    const stream=row.id as string
    const generations=db.database.prepare('SELECT id FROM net_generations WHERE stream=?').all(stream)
    for(const gen of generations) {remove('net_records','generation',gen.id as string);remove('net_snapshot_progress','generation',gen.id as string)}
    for(const table of ['net_blob_refs','net_event_ids','net_space_verified_uploads','net_private_control','net_private_nonce'])remove(table,'stream',stream)
    remove('net_generations','stream',stream);remove('net_streams','id',stream)
  }
  db.transaction(()=>{host.journal.transition(op.id,'retiring','retired');db.checkpoint('spaces.archive.retirement.beforeCommit')})
  return evidence
}
