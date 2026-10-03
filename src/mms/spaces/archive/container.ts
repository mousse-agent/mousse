import { constants, closeSync, existsSync, fsyncSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, readSync, realpathSync, renameSync, rmSync, writeFileSync, writeSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { NetError, isId,spaceMetaStream } from '../../../shared/net'
import type { BlobId, Signed, StoredRecord, StreamId } from '../../../shared/net'
import { validateStreamDescriptor } from '../../../shared/net/schemas'
import { canonicalJson, decodeEnvelope, parseProtocolJson } from '../../net/sync/codec'
import { digest, integer, json } from '../../net/store/database'
import { ARCHIVE_LIMITS } from './contracts'
import type { ArchiveBlobRef, ArchiveManifest, ArchiveStream, SpaceArchiveSource, VerifiedSpaceArchive } from './contracts'

const SCHEMA = [
  'CREATE TABLE streams(id TEXT PRIMARY KEY,value TEXT NOT NULL) STRICT',
  'CREATE TABLE records(stream TEXT NOT NULL,epoch INTEGER NOT NULL,seq INTEGER NOT NULL,recv_ts INTEGER NOT NULL,id TEXT NOT NULL,envelope BLOB NOT NULL,sig BLOB NOT NULL,PRIMARY KEY(stream,epoch,seq),UNIQUE(stream,id)) STRICT',
  'CREATE TABLE rosters(hash TEXT PRIMARY KEY,value TEXT NOT NULL) STRICT',
  'CREATE TABLE refs(stream TEXT NOT NULL,event TEXT NOT NULL,blob TEXT NOT NULL,bytes INTEGER NOT NULL,sealed INTEGER NOT NULL,PRIMARY KEY(stream,event,blob)) STRICT'
]
const bad = (): never => { throw new NetError('bad_request', 'Space archive failed structural verification.') }
const large = (): never => { throw new NetError('too_large', 'Space archive exceeds the local qualification bounds.') }
const verifiedArchives = new WeakSet<object>()
export function isVerifiedSpaceArchive(value:VerifiedSpaceArchive):boolean { return verifiedArchives.has(value) }
function freezeDocument(value:unknown):void {
  if(value&&typeof value==='object'){for(const child of Object.values(value))freezeDocument(child);Object.freeze(value)}
}
function sync(path: string): void { const fd = openSync(path, 'r'); try { fsyncSync(fd) } finally { closeSync(fd) } }
function regular(path: string, max: number): void {
  const s = lstatSync(path)
  if (!s.isFile() || s.isSymbolicLink()) bad()
  if (s.size > max) large()
}
function folder(path: string): string {
  const absolute = resolve(path), s = lstatSync(absolute)
  if (!s.isDirectory() || s.isSymbolicLink() || realpathSync(absolute) !== absolute) bad()
  return absolute
}
function hashRows(db: DatabaseSync): string {
  const hash = createHash('sha256').update('mousse.space.archive.data.v1\0')
  for (const [table, order] of [['streams','id'],['records','stream,epoch,seq'],['rosters','hash'],['refs','stream,event,blob']]) {
    for (const row of db.prepare(`SELECT * FROM ${table} ORDER BY ${order}`).iterate()) {
      const value = Object.fromEntries(Object.entries(row).map(([key, v]) => [key, v instanceof Uint8Array ? Buffer.from(v).toString('base64url') : v]))
      const bytes = canonicalJson([table, value])
      hash.update(String(bytes.length)).update(':').update(bytes)
    }
  }
  return hash.digest('hex')
}
function streams(db: DatabaseSync): ArchiveStream[] { return db.prepare('SELECT value FROM streams ORDER BY id').all().map(r => JSON.parse(r.value as string)) }
function* records(db: DatabaseSync, stream: StreamId): Iterable<StoredRecord> {
  for (const r of db.prepare('SELECT * FROM records WHERE stream=? ORDER BY epoch,seq').iterate(stream)) {
    yield { epoch: Number(r.epoch), seq: Number(r.seq), recvTs: Number(r.recv_ts), envelope: new Uint8Array(r.envelope as Uint8Array), sig: new Uint8Array(r.sig as Uint8Array) }
  }
}
function* rosters(db: DatabaseSync): Iterable<Signed> { for (const r of db.prepare('SELECT value FROM rosters ORDER BY hash').iterate()) yield JSON.parse(r.value as string) }
function* refs(db: DatabaseSync): Iterable<ArchiveBlobRef> {
  for (const r of db.prepare('SELECT * FROM refs ORDER BY stream,event,blob').iterate()) yield { stream: r.stream as StreamId, event: r.event as ArchiveBlobRef['event'], blob: r.blob as BlobId, bytes: Number(r.bytes), sealed: !!r.sealed }
}
function validateStreams(values: ArchiveStream[], space: ArchiveManifest['space']): void {
  if (!values.length || values.length > ARCHIVE_LIMITS.streams) large()
  if (values.filter(s => s.descriptor.kind === 'space.meta').length !== 1) bad()
  if(values.find(s=>s.descriptor.kind==='space.meta')!.descriptor.id!==spaceMetaStream(space))bad()
  const seen = new Set<string>()
  for (const value of values) {
    if (!validateStreamDescriptor(value.descriptor) || value.descriptor.space !== space || !value.descriptor.kind.startsWith('space.') || seen.has(value.descriptor.id)) bad()
    seen.add(value.descriptor.id)
    integer(value.head.epoch, 1); integer(value.head.seq); integer(value.retained)
    if (value.retained > value.head.seq || value.descriptor.kind === 'space.meta' && value.retained !== 0) bad()
  }
  for (const value of values) if (value.descriptor.parent && !seen.has(value.descriptor.parent)) bad()
}
function verifyReferences(db:DatabaseSync,manifest:ArchiveManifest):void {
  const blobs=new Map(manifest.blobs.map(b=>[b.id,b]))
  if(blobs.size!==manifest.blobs.length)bad()
  if(db.prepare('SELECT 1 FROM records r LEFT JOIN streams s ON s.id=r.stream WHERE s.id IS NULL LIMIT 1').get())bad()
  const used=new Set<string>()
  for(const row of db.prepare('SELECT stream,id,envelope,sig FROM records ORDER BY stream,epoch,seq').iterate()) {
    const envelope=decodeEnvelope(row.envelope as Uint8Array).envelope
    if(envelope.stream!==row.stream||envelope.id!==row.id||(row.sig as Uint8Array).length!==64)bad()
    for(const ref of envelope.blobs??[]) {
      const blob=blobs.get(ref.id)
      if(!blob||blob.bytes!==ref.bytes||blob.sealed!==!!ref.sealed||!db.prepare('SELECT 1 FROM refs WHERE stream=? AND event=? AND blob=? AND bytes=? AND sealed=?').get(envelope.stream,envelope.id,ref.id,ref.bytes,Number(!!ref.sealed)))bad()
      used.add(ref.id)
    }
  }
  if(used.size!==blobs.size)bad()
  for(const ref of refs(db)) {
    const row=db.prepare("SELECT envelope FROM records WHERE stream=? AND id=? LIMIT 1").get(ref.stream,ref.event)
    if(!row||!decodeEnvelope(row.envelope as Uint8Array).envelope.blobs?.some(b=>b.id===ref.blob&&b.bytes===ref.bytes&&!!b.sealed===ref.sealed))bad()
  }
}

/** Local destination is task/operator selected, never accepted from a peer RPC. */
export function writeSpaceArchive(source: SpaceArchiveSource, destination: string, exportedAt: number): { digest: string; manifest: ArchiveManifest } {
  const parent = folder(resolve(destination, '..')), final = join(parent, destination.split('/').at(-1)!)
  if (existsSync(final)) throw new NetError('conflict')
  const stage = join(parent, `.space-archive-${randomUUID()}`)
  mkdirSync(stage, { mode: 0o700 }); mkdirSync(join(stage,'blobs'), { mode: 0o700 })
  const path = join(stage,'space.db'), db = new DatabaseSync(path)
  let closed = false
  try {
    db.exec('PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; PRAGMA trusted_schema=OFF;')
    for (const sql of SCHEMA) db.exec(sql)
    const ss = [...source.streams()].sort((a,b) => a.descriptor.id.localeCompare(b.descriptor.id))
    validateStreams(ss, source.space)
    if(ss.some(s=>s.descriptor.authority!==source.exporter))bad()
    const descriptors: Signed[] = [], blobMap = new Map<BlobId,{ id: BlobId; bytes: number; sealed: boolean }>()
    let count = 0, bytes = 0, rosterCount = 0, rosterBytes = 0, refCount = 0
    const insert = db.prepare('INSERT INTO records VALUES(?,?,?,?,?,?,?)')
    for (const s of ss) {
      db.prepare('INSERT INTO streams VALUES(?,?)').run(s.descriptor.id,json(s))
      let last: {epoch:number;seq:number} | undefined
      for (const r of source.records(s.descriptor.id)) {
        integer(r.epoch,1); integer(r.seq,1); integer(r.recvTs)
        const e = decodeEnvelope(r.envelope).envelope
        if (e.stream !== s.descriptor.id || r.sig.length !== 64 || r.epoch > s.head.epoch || r.epoch === s.head.epoch && r.seq > s.head.seq) bad()
        if (last && (r.epoch < last.epoch || r.epoch === last.epoch && r.seq !== last.seq + 1 || r.epoch > last.epoch && r.seq !== 1)) bad()
        if (!last && s.descriptor.kind === 'space.meta' && (r.epoch !== 1 || r.seq !== 1)) bad()
        last = {epoch:r.epoch,seq:r.seq}; bytes += r.envelope.length + r.sig.length
        if (++count > ARCHIVE_LIMITS.records || bytes > ARCHIVE_LIMITS.bytes) large()
        insert.run(e.stream,r.epoch,r.seq,r.recvTs,e.id,r.envelope,r.sig)
        if (s.descriptor.kind === 'space.meta' && ['space.created','space.descriptor'].includes(e.type)) descriptors.push((e.body as {descriptor:Signed}).descriptor)
      }
      if (s.head.seq && (!last || last.epoch !== s.head.epoch || last.seq !== s.head.seq)) bad()
    }
    for (const signed of source.rosters()) {
      const value = json(signed), hash = digest(Buffer.from(value))
      if (db.prepare('SELECT 1 FROM rosters WHERE hash=?').get(hash)) continue
      rosterBytes += Buffer.byteLength(value)
      if (++rosterCount > ARCHIVE_LIMITS.rosters || rosterBytes > ARCHIVE_LIMITS.rosterBytes) large()
      db.prepare('INSERT INTO rosters VALUES(?,?)').run(hash,value)
    }
    let totalBlobBytes = 0
    for (const ref of source.refs()) {
      if (!/^blb_[0-9a-f]{64}$/.test(ref.blob) || !ss.some(s => s.descriptor.id === ref.stream)) bad()
      integer(ref.bytes)
      const previous = blobMap.get(ref.blob)
      if (previous && (previous.bytes !== ref.bytes || previous.sealed !== ref.sealed)) bad()
      if (!previous) { blobMap.set(ref.blob,{id:ref.blob,bytes:ref.bytes,sealed:ref.sealed}); totalBlobBytes += ref.bytes }
      if (blobMap.size > ARCHIVE_LIMITS.blobs || totalBlobBytes > ARCHIVE_LIMITS.blobBytes || ++refCount > ARCHIVE_LIMITS.records) large()
      const row = db.prepare('SELECT envelope FROM records WHERE stream=? AND id=? LIMIT 1').get(ref.stream,ref.event)
      if (!row || !decodeEnvelope(row.envelope as Uint8Array).envelope.blobs?.some(b => b.id === ref.blob && b.bytes === ref.bytes && !!b.sealed === ref.sealed)) bad()
      db.prepare('INSERT INTO refs VALUES(?,?,?,?,?)').run(ref.stream,ref.event,ref.blob,ref.bytes,Number(ref.sealed))
    }
    for (const blob of blobMap.values()) {
      const fd = openSync(join(stage,'blobs',blob.id),'wx',0o600), hash = createHash('sha256')
      try {
        for (let offset = 0; offset < blob.bytes;) {
          const data = source.readBlob(blob.id,offset,Math.min(65536,blob.bytes-offset))
          if (!data.length || data.length > Math.min(65536,blob.bytes-offset)) bad()
          hash.update(data); let written = 0
          while (written < data.length) written += writeSync(fd,data,written,data.length-written)
          offset += data.length
        }
        if (`blb_${hash.digest('hex')}` !== blob.id) throw new NetError('conflict')
        fsyncSync(fd)
      } finally { closeSync(fd) }
    }
    const manifest: ArchiveManifest = { v:1,kind:'space.archive',space:source.space,owner:source.owner,exporter:source.exporter,exportedAt:integer(exportedAt),frozen:source.frozen,descriptors,streams:ss,counts:{records:count,rosters:rosterCount,refs:refCount,blobs:blobMap.size},dataHash:hashRows(db),blobs:[...blobMap.values()].sort((a,b) => a.id.localeCompare(b.id)) }
    verifyReferences(db,manifest)
    const authorization = source.sign(manifest), hash = digest(canonicalJson(manifest))
    writeFileSync(join(stage,'manifest.json'),json({manifest,authorization,digest:hash}),{flag:'wx',mode:0o600})
    db.close(); closed = true
    regular(path,ARCHIVE_LIMITS.bytes); sync(path); sync(join(stage,'manifest.json')); sync(join(stage,'blobs')); sync(stage)
    renameSync(stage,final); sync(parent)
    return {digest:hash,manifest}
  } catch (error) { if (!closed) { db.close(); closed = true } rmSync(stage,{recursive:true,force:true}); throw error }
  finally { source.close() }
}

/** Both authorization and complete original-history validation are mandatory.
 * Neither a matching container hash nor a self-asserted owner root grants trust. */
export function openSpaceArchive(directory: string, verify: {
  authorization(manifest: ArchiveManifest, signed: Signed): void;
  history(archive: VerifiedSpaceArchive): void;
}): VerifiedSpaceArchive {
  const path = folder(directory)
  regular(join(path,'manifest.json'),ARCHIVE_LIMITS.manifestDocumentBytes); regular(join(path,'space.db'),ARCHIVE_LIMITS.bytes); folder(join(path,'blobs'))
  const raw = parseProtocolJson(readFileSync(join(path,'manifest.json'))) as {manifest:ArchiveManifest;authorization:Signed;digest:string}
  const m = raw.manifest
  if(m&&canonicalJson(m).length>ARCHIVE_LIMITS.manifestBytes)large()
  if (!m || m.v !== 1 || m.kind !== 'space.archive' || !isId('space',m.space) || !isId('node',m.exporter) || !isId('user',m.owner?.user) || raw.digest !== digest(canonicalJson(m))) bad()
  validateStreams(m.streams,m.space); integer(m.exportedAt); integer(m.frozen.epoch,1); integer(m.frozen.seq,1)
  if(m.streams.some(s=>s.descriptor.authority!==m.exporter))bad()
  const db = new DatabaseSync(join(path,'space.db'),{readOnly:true})
  let closed = false
  const archive: VerifiedSpaceArchive = { manifest:m,digest:raw.digest,authorization:raw.authorization,
    streams:() => streams(db),records:id => records(db,id),rosters:() => rosters(db),refs:() => refs(db),
    readBlob:(id,offset,length) => {
      const blob = m.blobs.find(b => b.id === id)
      integer(offset); integer(length,1)
      if (!blob) return bad()
      if (length > 65536 || offset+length > blob.bytes) bad()
      const fd = openSync(join(path,'blobs',id),constants.O_RDONLY | constants.O_NOFOLLOW)
      try { if (!fstatSync(fd).isFile() || fstatSync(fd).size !== blob.bytes) bad(); const data = Buffer.alloc(length); if (readSync(fd,data,0,length,offset) !== length) bad(); return data } finally { closeSync(fd) }
    },close:() => { if (!closed) { closed=true; verifiedArchives.delete(archive); db.close() } }
  }
  try {
    db.exec('PRAGMA trusted_schema=OFF; PRAGMA query_only=ON; BEGIN')
    const schema = db.prepare("SELECT sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY name").all().map(r => r.sql)
    if (json(schema) !== json([...SCHEMA].sort((a,b) => a.split(' ')[2].localeCompare(b.split(' ')[2])))) bad()
    if (Object.values(db.prepare('PRAGMA quick_check').get()!)[0] !== 'ok' || json(streams(db)) !== json(m.streams)) bad()
    for (const [table,key,limit] of [['records','records',ARCHIVE_LIMITS.records],['rosters','rosters',ARCHIVE_LIMITS.rosters],['refs','refs',ARCHIVE_LIMITS.records]] as const) {
      const count = Number(db.prepare(`SELECT count(*) AS n FROM ${table}`).get()!.n)
      if (count > limit) large()
      if (count !== m.counts[key]) bad()
    }
    if(Number(db.prepare('SELECT coalesce(sum(length(CAST(value AS BLOB))),0) AS bytes FROM rosters').get()!.bytes)>ARCHIVE_LIMITS.rosterBytes)large()
    if (!Array.isArray(m.blobs) || m.blobs.length !== m.counts.blobs || m.blobs.length > ARCHIVE_LIMITS.blobs) bad()
    if(hashRows(db)!==m.dataHash)bad()
    verifyReferences(db,m)
    let bytes = 0
    for (const blob of m.blobs) {
      if (!/^blb_[0-9a-f]{64}$/.test(blob.id)) bad()
      integer(blob.bytes); bytes += blob.bytes; if (bytes > ARCHIVE_LIMITS.blobBytes) large()
      regular(join(path,'blobs',blob.id),blob.bytes)
      const hash = createHash('sha256')
      for (let offset=0;offset<blob.bytes;) { const chunk=archive.readBlob(blob.id,offset,Math.min(65536,blob.bytes-offset)); hash.update(chunk); offset+=chunk.length }
      if (`blb_${hash.digest('hex')}` !== blob.id) bad()
    }
    freezeDocument(m);freezeDocument(raw.authorization)
    verify.authorization(m,raw.authorization); verify.history(archive)
    Object.freeze(archive)
    verifiedArchives.add(archive)
    return archive
  } catch (error) { archive.close(); throw error }
}
