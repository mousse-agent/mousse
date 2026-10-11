import {
  closeSync,
  existsSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeSync,
  constants
} from 'node:fs'
import { join } from 'node:path'
import type { Stats } from 'node:fs'
import { createHash, randomUUID } from 'node:crypto'
import type { BlobStore, BlobUpload } from '../contracts'
import {
  BLOB_CHUNK_BYTES,
  BLOB_GC_GRACE_MS,
  DEFAULT_MAX_BLOB_BYTES,
  UPLOAD_PENDING_TTL_MS,
  isBlobId
} from '../../../shared/net'
import type { BlobId, EventId, StreamId } from '../../../shared/net'
import { decodeEnvelope } from '../sync/codec'
import { NetDatabase, fail, integer } from './database'
import { syncDirectory } from './directorySync'

export class FileBlobStore implements BlobStore {
  readonly root: string
  private closers = new Set<() => void>()
  constructor(private readonly db: NetDatabase) {
    this.root = join(db.directory, 'blobs')
    this.directory(this.root)
    this.directory(join(this.root, 'uploads'))
  }
  begin(blob: BlobId, expectedBytes: number, sealed: boolean): BlobUpload {
    if (this.db.inTransaction)
      fail('bad_request', 'Filesystem upload cannot begin inside an admission transaction.')
    this.id(blob)
    integer(expectedBytes)
    if (expectedBytes > DEFAULT_MAX_BLOB_BYTES || typeof sealed !== 'boolean')
      fail('too_large', 'Blob exceeds the configured store bound.')
    const present = this.db.database
      .prepare('SELECT bytes,sealed FROM net_blobs WHERE id=?')
      .get(blob)
    if (present && (present.bytes !== expectedBytes || Boolean(present.sealed) !== sealed))
      fail('conflict', 'Blob metadata changed.')
    const upload = randomUUID()
    const temp = this.temp(upload)
    const fd = openSync(temp, 'wx+', 0o600)
    try {
      this.db.transaction(() => {
        if (this.db.database.prepare('SELECT 1 FROM net_blob_gc WHERE id=?').get(blob))
          fail('rate_limited', 'Blob is being reclaimed; retry after cleanup.')
        const count = Number(
          this.db.database.prepare('SELECT count(*) AS n FROM net_uploads').get()!.n
        )
        if (count >= 8) fail('rate_limited', 'Too many pending blob uploads.')
        this.db.charge(1)
        this.db.database
          .prepare('INSERT INTO net_uploads VALUES(?,?,?,?,0,?)')
          .run(upload, blob, expectedBytes, sealed ? 1 : 0, this.db.clock.now())
      })
    } catch (error) {
      closeSync(fd)
      unlinkSync(temp)
      throw error
    }
    let closed = false
    const active = (): Record<string, any> => {
      if (closed) fail('conflict', 'Upload is already closed.')
      return (
        this.db.database.prepare('SELECT * FROM net_uploads WHERE id=?').get(upload) ??
        fail('conflict', 'Upload has expired or been aborted.')
      )
    }
    const result: BlobUpload = {
      write: (offset, chunk) => {
        if (this.db.inTransaction)
          fail('bad_request', 'Upload I/O cannot run inside a net transaction.')
        integer(offset)
        const row = active()
        if (
          !chunk.length ||
          chunk.length > BLOB_CHUNK_BYTES ||
          offset + chunk.length > expectedBytes
        )
          fail('too_large', 'Blob chunk exceeds its byte boundary.')
        if (offset < row.offset) {
          if (offset + chunk.length > row.offset)
            fail('bad_request', 'A duplicate chunk crosses the committed offset.')
          const previous = Buffer.alloc(chunk.length)
          if (
            readSync(fd, previous, 0, previous.length, offset) !== chunk.length ||
            !previous.equals(chunk)
          )
            fail('conflict', 'Duplicate upload chunk differs.')
          return
        }
        if (offset !== row.offset) fail('bad_request', 'Upload chunk skips its next byte offset.')
        this.directory(this.root)
        this.directory(join(this.root, 'uploads'))
        let written = 0
        while (written < chunk.length)
          written += writeSync(fd, chunk, written, chunk.length - written, offset + written)
        fsyncSync(fd)
        this.db.transaction(() => {
          this.db.charge(1)
          const updated = this.db.database
            .prepare('UPDATE net_uploads SET offset=? WHERE id=?')
            .run(offset + chunk.length, upload)
          if (!Number(updated.changes))
            fail('conflict', 'Upload expired before its chunk committed.')
        })
      },
      commit: () => {
        if (this.db.inTransaction)
          fail('bad_request', 'Blob filesystem commit cannot occur inside a net transaction.')
        const row = active()
        if (row.offset !== expectedBytes || fstatSync(fd).size !== expectedBytes)
          fail('conflict', 'Upload length does not match its promise.')
        const hash = createHash('sha256')
        const buffer = Buffer.alloc(BLOB_CHUNK_BYTES)
        for (let offset = 0; offset < expectedBytes;) {
          const count = readSync(
            fd,
            buffer,
            0,
            Math.min(buffer.length, expectedBytes - offset),
            offset
          )
          if (!count) fail('conflict', 'Upload ended while hashing.')
          hash.update(buffer.subarray(0, count))
          offset += count
        }
        if (`blb_${hash.digest('hex')}` !== blob)
          fail('conflict', 'Blob content hash does not match its identity.')
        fsyncSync(fd)
        const destination = this.path(blob, true)
        // Journal the filesystem publication before rename. A crash between
        // rename and metadata commit leaves a bounded, GC-visible orphan.
        this.db.transaction(() => {
          this.db.charge(1)
          this.db.database
            .prepare('INSERT OR IGNORE INTO net_blob_orphans VALUES(?,?,?)')
            .run(blob, expectedBytes, this.db.clock.now())
        })
        if (existsSync(destination)) {
          this.regular(destination)
          if (lstatSync(destination).size !== expectedBytes)
            fail('conflict', 'Existing content-addressed blob is inconsistent.')
          unlinkSync(temp)
        } else renameSync(temp, destination)
        syncDirectory(join(this.root, blob.slice(4, 6), blob.slice(6, 8)))
        this.db.checkpoint('blobs.commit.afterRename')
        this.db.transaction(() => {
          const previous = this.db.database
            .prepare('SELECT bytes,sealed FROM net_blobs WHERE id=?')
            .get(blob)
          if (previous && (previous.bytes !== expectedBytes || Boolean(previous.sealed) !== sealed))
            fail('conflict', 'Committed blob metadata conflicts.')
          this.db.charge(previous ? 2 : 3)
          this.db.database
            .prepare('INSERT OR IGNORE INTO net_blobs VALUES(?,?,?,?)')
            .run(blob, expectedBytes, sealed ? 1 : 0, this.db.clock.now())
          this.db.database.prepare('DELETE FROM net_uploads WHERE id=?').run(upload)
          this.db.database.prepare('DELETE FROM net_blob_orphans WHERE id=?').run(blob)
        })
        closeSync(fd)
        closed = true
        this.closers.delete(result.abort)
      },
      abort: () => {
        if (closed) return
        closeSync(fd)
        closed = true
        this.closers.delete(result.abort)
        if (existsSync(temp)) unlinkSync(temp)
        this.db.transaction(() =>
          this.db.database.prepare('DELETE FROM net_uploads WHERE id=?').run(upload)
        )
      }
    }
    this.closers.add(result.abort)
    return result
  }
  close(): void {
    for (const close of [...this.closers]) {
      try {
        close()
      } catch {
        /* Keep pending recovery rows if storage was disabled; handles are closed. */
      }
    }
  }
  has(blob: BlobId): boolean {
    this.id(blob)
    if (!this.db.database.prepare('SELECT id FROM net_blobs WHERE id=?').get(blob)) return false
    this.regular(this.path(blob))
    return true
  }
  size(blob: BlobId): number | undefined {
    return this.has(blob)
      ? (this.db.database.prepare('SELECT bytes FROM net_blobs WHERE id=?').get(blob)!
          .bytes as number)
      : undefined
  }
  read(blob: BlobId, offset: number, length: number): Uint8Array {
    integer(offset)
    integer(length)
    const size = this.size(blob) ?? fail('bad_request', 'Blob is not committed.')
    if (length > DEFAULT_MAX_BLOB_BYTES || offset + length > size)
      fail('bad_request', 'Blob range is outside committed bytes.')
    const path = this.path(blob)
    const before = this.regular(path)
    const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
    try {
      const actual = fstatSync(fd)
      if (actual.dev !== before.dev || actual.ino !== before.ino || actual.size !== size)
        fail('storage_corrupt', 'Blob changed while opening.')
      const result = Buffer.alloc(length)
      let count = 0
      while (count < length) {
        const n = readSync(fd, result, count, length - count, offset + count)
        if (!n) fail('storage_corrupt', 'Committed blob was truncated.')
        count += n
      }
      return result
    } finally {
      closeSync(fd)
    }
  }
  addRef(blob: BlobId, stream: StreamId, event: EventId): void {
    this.id(blob)
    this.db.transaction(() => {
      const b =
        this.db.database.prepare('SELECT bytes,sealed FROM net_blobs WHERE id=?').get(blob) ??
        fail('bad_request', 'Referenced blob is not committed.')
      const e = this.db.database
        .prepare(
          "SELECT r.envelope FROM net_records r JOIN net_generations g ON g.id=r.generation WHERE g.stream=? AND g.state='active' AND r.id=?"
        )
        .get(stream, event)
      if (!e) fail('bad_request', 'Blob reference has no active stored event.')
      const refs = decodeEnvelope(e.envelope as Uint8Array).envelope.blobs
      if (
        !refs?.some(
          (ref) =>
            ref.id === blob && ref.bytes === b.bytes && Boolean(ref.sealed) === Boolean(b.sealed)
        )
      )
        fail('forbidden', 'Event does not authorize this blob reference.')
      this.db.charge(1)
      this.db.database
        .prepare('INSERT OR IGNORE INTO net_blob_refs VALUES(?,?,?)')
        .run(blob, stream, event)
    })
  }
  isReferenced(blob: BlobId, stream: StreamId): boolean {
    this.id(blob)
    return !!this.db.database
      .prepare(
        'SELECT 1 FROM net_blob_refs b JOIN net_streams s ON s.id=b.stream JOIN net_records r ON r.generation=s.active_generation AND r.id=b.event WHERE b.blob=? AND b.stream=? LIMIT 1'
      )
      .get(blob, stream)
  }
  collectGarbage(now: number): { removed: number; bytes: number } {
    integer(now)
    if (this.db.inTransaction) fail('bad_request', 'Blob GC cannot run inside a net transaction.')
    const expired = this.db.database
      .prepare('SELECT id FROM net_uploads WHERE created_at<=? LIMIT 500')
      .all(now - UPLOAD_PENDING_TTL_MS)
    for (const row of expired) {
      const temp = this.temp(row.id as string)
      if (existsSync(temp)) {
        this.regular(temp)
        unlinkSync(temp)
      }
      this.db.transaction(() =>
        this.db.database.prepare('DELETE FROM net_uploads WHERE id=?').run(row.id!)
      )
    }
    const rows = this.db.database
      .prepare(
        'SELECT * FROM net_blobs WHERE created_at<=? AND NOT EXISTS(SELECT 1 FROM net_blob_refs WHERE blob=net_blobs.id) AND NOT EXISTS(SELECT 1 FROM net_uploads WHERE blob=net_blobs.id) LIMIT 500'
      )
      .all(now - BLOB_GC_GRACE_MS)
    let removed = 0
    let bytes = 0
    const orphans = this.db.database
      .prepare(
        'SELECT * FROM net_blob_orphans WHERE created_at<=? AND NOT EXISTS(SELECT 1 FROM net_blobs WHERE id=net_blob_orphans.id) AND NOT EXISTS(SELECT 1 FROM net_uploads WHERE blob=net_blob_orphans.id) LIMIT 500'
      )
      .all(now - BLOB_GC_GRACE_MS)
    for (const orphan of orphans) {
      this.db.transaction(() => {
        const deleted = this.db.database
          .prepare(
            'DELETE FROM net_blob_orphans WHERE id=? AND NOT EXISTS(SELECT 1 FROM net_blobs WHERE id=?) AND NOT EXISTS(SELECT 1 FROM net_uploads WHERE blob=?)'
          )
          .run(orphan.id!, orphan.id!, orphan.id!)
        if (Number(deleted.changes))
          this.db.database
            .prepare('INSERT OR IGNORE INTO net_blob_gc VALUES(?,?)')
            .run(orphan.id!, orphan.bytes!)
      })
    }
    for (const row of rows) {
      // Remove visibility and persist a GC lease atomically. New uploads cannot
      // reuse this path until deletion finishes, including after a process loss.
      this.db.transaction(() => {
        const deleted = this.db.database
          .prepare(
            'DELETE FROM net_blobs WHERE id=? AND NOT EXISTS(SELECT 1 FROM net_blob_refs WHERE blob=?) AND NOT EXISTS(SELECT 1 FROM net_uploads WHERE blob=?)'
          )
          .run(row.id!, row.id!, row.id!)
        if (Number(deleted.changes))
          this.db.database
            .prepare('INSERT OR IGNORE INTO net_blob_gc VALUES(?,?)')
            .run(row.id!, row.bytes!)
      })
    }
    this.db.checkpoint('blobs.gc.afterMetadataCommit')
    const garbage = this.db.database.prepare('SELECT * FROM net_blob_gc LIMIT 500').all()
    for (const row of garbage) {
      const path = this.path(row.id as BlobId)
      if (existsSync(path)) {
        this.regular(path)
        unlinkSync(path)
      }
      this.db.transaction(() =>
        this.db.database.prepare('DELETE FROM net_blob_gc WHERE id=?').run(row.id!)
      )
      removed++
      bytes += row.bytes as number
    }
    return { removed, bytes }
  }
  private id(blob: BlobId): void {
    if (!isBlobId(blob)) fail('bad_request', 'Invalid content-addressed blob identity.')
  }
  private temp(id: string): string {
    if (!/^[a-f0-9-]{36}$/.test(id)) fail('storage_corrupt', 'Invalid stored upload identity.')
    this.directory(join(this.root, 'uploads'))
    return join(this.root, 'uploads', id)
  }
  private path(blob: BlobId, create = false): string {
    this.id(blob)
    this.directory(this.root)
    const first = join(this.root, blob.slice(4, 6))
    const second = join(first, blob.slice(6, 8))
    if (create) {
      this.directory(first)
      this.directory(second)
    } else
      for (const directory of [first, second])
        if (
          existsSync(directory) &&
          (lstatSync(directory).isSymbolicLink() || realpathSync(directory) !== directory)
        )
          fail('forbidden', 'Blob path escaped its owned root.')
    return join(second, blob.slice(4))
  }
  private directory(path: string): void {
    if (existsSync(path) && lstatSync(path).isSymbolicLink())
      fail('forbidden', 'Blob directory cannot be a symlink.')
    mkdirSync(path, { recursive: true, mode: 0o700 })
    if (realpathSync(path) !== path) fail('forbidden', 'Blob directory escaped its owned root.')
  }
  private regular(path: string): Stats {
    if (!existsSync(path)) fail('storage_corrupt', 'Committed blob file is missing.')
    const stat = lstatSync(path)
    if (!stat.isFile() || stat.isSymbolicLink())
      fail('forbidden', 'Blob is not an owned regular file.')
    return stat
  }
}
