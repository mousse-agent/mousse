/**
 * Everything that touches a `thread.db`. It runs inside the thread database workers (see `threadDbClient.ts`), never
 * on the daemon's event loop, except in tests that run it in-process.
 *
 * One connection per database and worker, opened only for a file that exists (a moved or deleted thread folder is
 * never recreated empty), checked against the file's inode on every use, and closed after a short idle time.
 */
import { DatabaseSync, type StatementSync } from 'node:sqlite'
import { closeSync, existsSync, fsyncSync, linkSync, openSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { compose, decompose, normalizedForCompare, rowFields, type StoredThreadData } from './collections'
import { legacyFingerprint, readLegacyThreadData, sameFingerprint, type FileStamp } from '../legacyThreadData'
import { skeletonOf } from './jsonSkeleton'
import { formatCursor, parseCursor } from '../../../shared/pageCursor'
import { ThreadIndex, type IndexHit, type IndexSearchRequest, type IndexTarget } from './threadIndex'
import { collectBlobs, encodeRow, hydratePayload, parseBlobPaths, writeBlob, type BlobData, type BlobPath } from './threadBlobs'

export const THREAD_DB_FILE = 'thread.db'
export const THREAD_DB_FORMAT = 2
/** Rows are spaced this far apart, so a message inserted between two others rarely moves anything. */
export const ORD_STEP = 1024

export interface DbInfo { seq: number; epoch: number; dbId: string; horizon: number }
/** A row as read; `seq` is the thread's sequence when it last changed. */
export interface DbRow { rid: number; coll: string; ord: number; seq: number; payload: string; hasBlobs?: boolean; missing?: BlobPath[] }
export interface DbStateRow { key: string; payload: string }
export interface DbLoad { info: DbInfo; rows: DbRow[]; state: DbStateRow[] }
export interface DbChanges extends DbLoad { removed: Array<{ rid: number; coll: string }>; removedState: string[]; reset: boolean }

export interface SaveRequest {
  baseSeq: number
  epochBump: boolean
  inserts: Array<{ tmp: number; coll: string; ord: number; payload: string; blobPaths?: string | null }>
  updates: Array<{ rid: number; coll: string; ord: number; payload?: string; blobPaths?: string | null }>
  /** Blobs the rows refer to, written before the transaction that commits them. */
  blobs?: BlobData[]
  /** Rows that referred to blobs were removed or rewritten: collect blobs nothing refers to any more. */
  collectBlobs?: boolean
  deletes: Array<{ rid: number; coll: string }>
  state: Array<{ key: string; payload: string | null }>
  info?: Record<string, string>
}
export type SaveResult = { ok: true; info: DbInfo; rids: number[] } | { ok: false; conflict: true; info: DbInfo }

export interface BuildRequest { tmpName: string; transactional: boolean; fingerprint: FileStamp[] }
export type BuildResult =
  | { ok: true; tmpName: string; messages: number; rows: number }
  | { ok: false; stale: true }

export interface ThreadDbSummary { seq: number; messages: number }

export interface MessagePageRequest { before?: string; after?: string; limit: number; maxBytes: number; images?: boolean }
export interface MessagePage {
  info: DbInfo
  /** Message payloads (JSON), oldest first. */
  messages: string[]
  earlier?: { before: string; count: number }
  later?: { after: string; count: number }
  missing?: true
}
export interface MessageChanges { info: DbInfo; reset: boolean; messages: Array<{ ord: number; payload: string }>; removed: string[] }


const SCHEMA = `
CREATE TABLE info(key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE items(
  rid INTEGER PRIMARY KEY AUTOINCREMENT,
  coll TEXT NOT NULL,
  ord INTEGER NOT NULL,
  msg_id TEXT,
  role TEXT,
  kind TEXT,
  ts TEXT,
  hidden INTEGER NOT NULL DEFAULT 0,
  rev INTEGER NOT NULL DEFAULT 1,
  changed_seq INTEGER NOT NULL,
  payload TEXT NOT NULL,
  blob_paths TEXT
);
CREATE INDEX items_order ON items(coll, ord, rid);
CREATE INDEX items_changed ON items(changed_seq);
CREATE INDEX items_msg ON items(coll, msg_id);
CREATE TABLE state(key TEXT PRIMARY KEY, rev INTEGER NOT NULL DEFAULT 1, changed_seq INTEGER NOT NULL, payload TEXT NOT NULL);
CREATE TABLE removed(rid INTEGER NOT NULL, coll TEXT NOT NULL, changed_seq INTEGER NOT NULL, msg_id TEXT);
CREATE INDEX removed_changed ON removed(changed_seq);
`

/** Removal records kept for `changesSince`; older ones are dropped and a reader that far behind starts over. */
const REMOVED_KEEP = 20_000

export class ThreadDbError extends Error {
  constructor(readonly code: 'missing' | 'format' | 'corrupt', message: string) {
    super(message)
    this.name = 'ThreadDbError'
  }
}

interface Connection { db: DatabaseSync; ino: number; statements: Map<string, StatementSync>; timer?: ReturnType<typeof setTimeout> }

/** Flushes a file. Opened for writing: Windows flushes only a handle that may write. */
function fsyncFile(path: string): void {
  const fd = openSync(path, 'r+')
  try { fsyncSync(fd) } finally { closeSync(fd) }
}

/** Flushes a folder's entries. Windows cannot open a folder to flush it; NTFS journals folder entries itself. */
function fsyncDir(path: string): void {
  if (process.platform === 'win32') return
  const fd = openSync(path, 'r')
  try { fsyncSync(fd) } finally { closeSync(fd) }
}

function createSchema(db: DatabaseSync): void {
  // auto_vacuum only takes effect before the first table exists.
  db.exec('PRAGMA auto_vacuum=INCREMENTAL')
  db.exec(SCHEMA)
  db.exec(`PRAGMA user_version=${THREAD_DB_FORMAT}`)
}

function insertAll(db: DatabaseSync, dir: string, data: StoredThreadData, info: Record<string, string>): number {
  const { collections, state } = decompose(data)
  const insertRow = db.prepare('INSERT INTO items(coll, ord, msg_id, role, kind, ts, hidden, changed_seq, payload, blob_paths) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?)')
  let rows = 0
  for (const [coll, items] of collections) {
    items.forEach((item, index) => {
      const fields = rowFields(coll, item)
      const encoded = encodeRow(skeletonOf(item) ?? null)
      for (const blob of encoded.blobs) writeBlob(dir, blob)
      insertRow.run(coll, (index + 1) * ORD_STEP, fields.msgId, fields.role, fields.kind, fields.ts, fields.hidden, encoded.payload, encoded.paths ? JSON.stringify(encoded.paths) : null)
      rows += 1
    })
  }
  const insertState = db.prepare('INSERT INTO state(key, changed_seq, payload) VALUES (?, 1, ?)')
  for (const [key, value] of state) insertState.run(key, JSON.stringify(value))
  const insertInfo = db.prepare('INSERT INTO info(key, value) VALUES (?, ?)')
  for (const [key, value] of Object.entries({ seq: '1', epoch: '1', horizon: '0', dbId: randomUUID(), formatVersion: String(THREAD_DB_FORMAT), ...info })) {
    insertInfo.run(key, value)
  }
  return rows
}

function readInfo(db: DatabaseSync): DbInfo {
  const values = new Map<string, string>()
  for (const row of db.prepare("SELECT key, value FROM info WHERE key IN ('seq', 'epoch', 'dbId', 'horizon')").all() as Array<{ key: string; value: string }>) {
    values.set(row.key, row.value)
  }
  return { seq: Number(values.get('seq') ?? 0), epoch: Number(values.get('epoch') ?? 1), dbId: values.get('dbId') ?? '', horizon: Number(values.get('horizon') ?? 0) }
}

/** Rows as read from the table, with their blobs put back (image data too, unless `images` is false). */
function hydrateRows(dir: string, raw: Array<DbRow & { blob_paths: string | null }>, options: { images?: boolean } = {}): DbRow[] {
  return raw.map((row) => {
    const base = { rid: row.rid, coll: row.coll, ord: row.ord, seq: row.seq }
    if (!row.blob_paths) return { ...base, payload: row.payload }
    const hydrated = hydratePayload(dir, row.payload, row.blob_paths, options)
    return { ...base, payload: hydrated.payload, hasBlobs: true, ...(hydrated.missing.length ? { missing: hydrated.missing } : {}) }
  })
}

/** The cursor of a transcript row: its message id, and its occurrence when the id repeats. */
function rowCursor(db: DatabaseSync, row: { rid: number; ord: number; payload: string; msg_id: string | null }): string {
  const id = row.msg_id ?? String((JSON.parse(row.payload) as { id?: unknown }).id)
  // Occurrences among visible messages only, as a loaded transcript counts them.
  const total = Number((db.prepare("SELECT count(*) AS n FROM items WHERE coll = 'm' AND hidden = 0 AND msg_id = ?").get(id) as { n: number }).n)
  if (total <= 1) return id
  const earlier = db.prepare("SELECT count(*) AS n FROM items WHERE coll = 'm' AND hidden = 0 AND msg_id = ? AND (ord < ? OR (ord = ? AND rid < ?))").get(id, row.ord, row.ord, row.rid) as { n: number }
  return formatCursor(id, Number(earlier.n), true)
}

function loadFrom(db: DatabaseSync, dir: string): DbLoad {
  db.exec('BEGIN')
  try {
    const info = readInfo(db)
    const rows = hydrateRows(dir, db.prepare('SELECT rid, coll, ord, changed_seq AS seq, payload, blob_paths FROM items ORDER BY coll, ord, rid').all() as never)
    const state = db.prepare('SELECT key, payload FROM state').all() as unknown as DbStateRow[]
    return { info, rows, state }
  } finally {
    db.exec('COMMIT')
  }
}

/** Builds the thread's data back from loaded rows. */
export function dataFromLoad(load: DbLoad): StoredThreadData {
  const collections = new Map<string, unknown[]>()
  for (const row of load.rows) {
    let list = collections.get(row.coll)
    if (!list) collections.set(row.coll, (list = []))
    list.push(JSON.parse(row.payload))
  }
  const state = new Map<string, unknown>(load.state.map((row) => [row.key, JSON.parse(row.payload)]))
  return compose(collections, state)
}

export class ThreadDbEngine {
  private readonly connections = new Map<string, Connection>()

  constructor(private readonly options: { idleCloseMs: number; checkpointOnClose?: boolean }) {}

  private path(dir: string): string {
    return join(dir, THREAD_DB_FILE)
  }

  private open(dir: string): Connection {
    const path = this.path(dir)
    let stat
    try {
      stat = statSync(path)
    } catch {
      this.close(dir)
      throw new ThreadDbError('missing', `No thread database at ${path}`)
    }
    let connection = this.connections.get(dir)
    if (connection && connection.ino !== stat.ino) {
      this.close(dir)
      connection = undefined
    }
    if (!connection) {
      const db = new DatabaseSync(path)
      try {
        db.exec('PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;')
        let version = Number((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version)
        if (version === 1) {
          // Format 2: a hidden flag for paging, and the message id of removed rows for changesSince.
          db.exec('BEGIN IMMEDIATE')
          try {
            // Another connection may have migrated while this one waited for the write lock.
            version = Number((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version)
            if (version === 1) db.exec("ALTER TABLE items ADD COLUMN hidden INTEGER NOT NULL DEFAULT 0; UPDATE items SET hidden = 1 WHERE coll = 'm' AND json_extract(payload, '$.hidden') = 1; ALTER TABLE removed ADD COLUMN msg_id TEXT; PRAGMA user_version=2;")
            db.exec('COMMIT')
          } catch (error) {
            if (db.isTransaction) db.exec('ROLLBACK')
            throw error
          }
          version = Number((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version)
        }
        if (version !== THREAD_DB_FORMAT) throw new ThreadDbError('format', `Unsupported thread database format ${version} at ${path}`)
      } catch (error) {
        db.close()
        throw error
      }
      connection = { db, ino: stat.ino, statements: new Map() }
      this.connections.set(dir, connection)
    }
    if (connection.timer) clearTimeout(connection.timer)
    if (this.options.idleCloseMs > 0) {
      const timer = setTimeout(() => this.close(dir), this.options.idleCloseMs)
      timer.unref?.()
      connection.timer = timer
    }
    return connection
  }

  private statement(connection: Connection, sql: string): StatementSync {
    let statement = connection.statements.get(sql)
    if (!statement) connection.statements.set(sql, (statement = connection.db.prepare(sql)))
    return statement
  }

  exists(dir: string): boolean {
    return existsSync(this.path(dir))
  }

  /** Closes the connection; the last close checkpoints the WAL and SQLite removes it. */
  close(dir: string): void {
    const connection = this.connections.get(dir)
    if (!connection) return
    this.connections.delete(dir)
    if (connection.timer) clearTimeout(connection.timer)
    if (this.options.checkpointOnClose !== false) try {
      connection.db.exec('PRAGMA wal_checkpoint(TRUNCATE)')
      const free = Number((connection.db.prepare('PRAGMA freelist_count').get() as { freelist_count: number }).freelist_count)
      if (free > 256) connection.db.exec('PRAGMA incremental_vacuum')
    } catch {
      // A checkpoint that cannot run now runs at the next open.
    }
    connection.db.close()
  }

  closeAll(): void {
    for (const dir of [...this.connections.keys()]) this.close(dir)
  }

  /** Closes the search index too (at shutdown; the read worker keeps it open between requests). */
  closeEverything(): void {
    this.closeAll()
    this.searchIndex?.close()
  }

  info(dir: string): DbInfo {
    return readInfo(this.open(dir).db)
  }

  load(dir: string): DbLoad {
    return loadFrom(this.open(dir).db, dir)
  }

  summary(dir: string): ThreadDbSummary {
    const connection = this.open(dir)
    const info = readInfo(connection.db)
    const count = this.statement(connection, "SELECT count(*) AS n FROM items WHERE coll = 'm'").get() as { n: number }
    return { seq: info.seq, messages: Number(count.n) }
  }

  /** Rows, state and removals newer than `since`. A reader behind the removal horizon or another epoch starts over. */
  changes(dir: string, since: number, epoch?: number): DbChanges {
    const { db } = this.open(dir)
    db.exec('BEGIN')
    try {
      const info = readInfo(db)
      if (since < info.horizon || (epoch !== undefined && epoch !== info.epoch)) {
        db.exec('COMMIT')
        const full = loadFrom(db, dir)
        return { ...full, removed: [], removedState: [], reset: true }
      }
      const rows = hydrateRows(dir, db.prepare('SELECT rid, coll, ord, changed_seq AS seq, payload, blob_paths FROM items WHERE changed_seq > ? ORDER BY coll, ord, rid').all(since) as never)
      const state = db.prepare('SELECT key, payload FROM state WHERE changed_seq > ?').all(since) as unknown as DbStateRow[]
      const removedRows = db.prepare('SELECT rid, coll FROM removed WHERE changed_seq > ?').all(since) as Array<{ rid: number; coll: string }>
      const removed = removedRows.filter((row) => !row.coll.startsWith('$state:'))
      const removedState = removedRows.filter((row) => row.coll.startsWith('$state:')).map((row) => row.coll.slice('$state:'.length))
      return { info, rows, state, removed, removedState, reset: false }
    } finally {
      if (db.isTransaction) db.exec('COMMIT')
    }
  }

  save(dir: string, request: SaveRequest): SaveResult {
    const connection = this.open(dir)
    const { db } = connection
    // Blobs first: a row is never committed before what it refers to is on disk.
    for (const blob of request.blobs ?? []) writeBlob(dir, blob)
    db.exec('BEGIN IMMEDIATE')
    try {
      const info = readInfo(db)
      if (info.seq !== request.baseSeq) {
        db.exec('ROLLBACK')
        return { ok: false, conflict: true, info }
      }
      const seq = info.seq + 1
      const remove = this.statement(connection, 'DELETE FROM items WHERE rid = ? AND coll = ?')
      const tombstone = this.statement(connection, 'INSERT INTO removed(rid, coll, changed_seq, msg_id) VALUES (?, ?, ?, ?)')
      const removedId = this.statement(connection, 'SELECT msg_id FROM items WHERE rid = ?')
      for (const entry of request.deletes) {
        const msgId = (removedId.get(entry.rid) as { msg_id: string | null } | undefined)?.msg_id ?? null
        remove.run(entry.rid, entry.coll)
        tombstone.run(entry.rid, entry.coll, seq, msgId)
      }
      const update = this.statement(connection, 'UPDATE items SET ord = ?, msg_id = ?, role = ?, kind = ?, ts = ?, hidden = ?, payload = ?, blob_paths = ?, rev = rev + 1, changed_seq = ? WHERE rid = ?')
      const move = this.statement(connection, 'UPDATE items SET ord = ?, changed_seq = ? WHERE rid = ?')
      for (const entry of request.updates) {
        if (entry.payload === undefined) {
          move.run(entry.ord, seq, entry.rid)
          continue
        }
        const fields = rowFields(entry.coll, JSON.parse(entry.payload))
        update.run(entry.ord, fields.msgId, fields.role, fields.kind, fields.ts, fields.hidden, entry.payload, entry.blobPaths ?? null, seq, entry.rid)
      }
      const insert = this.statement(connection, 'INSERT INTO items(coll, ord, msg_id, role, kind, ts, hidden, changed_seq, payload, blob_paths) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      const rids: number[] = []
      for (const entry of request.inserts) {
        const fields = rowFields(entry.coll, JSON.parse(entry.payload))
        const result = insert.run(entry.coll, entry.ord, fields.msgId, fields.role, fields.kind, fields.ts, fields.hidden, seq, entry.payload, entry.blobPaths ?? null)
        rids[entry.tmp] = Number(result.lastInsertRowid)
      }
      const upsertState = this.statement(connection, 'INSERT INTO state(key, changed_seq, payload) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET payload = excluded.payload, changed_seq = excluded.changed_seq, rev = rev + 1')
      const deleteState = this.statement(connection, 'DELETE FROM state WHERE key = ?')
      for (const entry of request.state) {
        if (entry.payload === null) {
          deleteState.run(entry.key)
          tombstone.run(0, `$state:${entry.key}`, seq)
        } else {
          upsertState.run(entry.key, seq, entry.payload)
        }
      }
      const setInfo = this.statement(connection, 'INSERT INTO info(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      for (const [key, value] of Object.entries(request.info ?? {})) setInfo.run(key, value)
      setInfo.run('seq', String(seq))
      const epoch = request.epochBump ? info.epoch + 1 : info.epoch
      if (request.epochBump) setInfo.run('epoch', String(epoch))
      let horizon = info.horizon
      const removedCount = Number((this.statement(connection, 'SELECT count(*) AS n FROM removed').get() as { n: number }).n)
      if (removedCount > REMOVED_KEEP) {
        const cut = this.statement(connection, 'SELECT changed_seq AS s FROM removed ORDER BY changed_seq LIMIT 1 OFFSET ?').get(Math.floor(REMOVED_KEEP / 2)) as { s: number }
        this.statement(connection, 'DELETE FROM removed WHERE changed_seq < ?').run(cut.s)
        horizon = Number(cut.s) - 1
        setInfo.run('horizon', String(horizon))
      }
      db.exec('COMMIT')
      if (request.collectBlobs) this.collectBlobs(dir)
      return { ok: true, info: { ...info, seq, epoch, horizon }, rids }
    } catch (error) {
      if (db.isTransaction) db.exec('ROLLBACK')
      throw error
    }
  }

  /**
   * A page of the visible transcript, read in one transaction: the newest messages, or those just before or after
   * the cursor `before`/`after`, up to `limit` and `maxBytes` of the JSON returned (UTF-8, blobs put back; always at
   * least one message). A cursor is a message id, with the occurrence appended (`parseCursor`) when the id repeats;
   * a bare repeated id means its last occurrence. `earlier`/`later` say how many visible messages are left on each
   * side. Image data is left out unless `images`; it is fetched one image at a time. `missing` when the cursor
   * message is not in the thread.
   */
  page(dir: string, request: MessagePageRequest): MessagePage {
    const { db } = this.open(dir)
    db.exec('BEGIN')
    try {
      const info = readInfo(db)
      const cursorText = request.before ?? request.after
      let cursor: { ord: number; rid: number } | undefined
      if (cursorText !== undefined) {
        const { id, occurrence } = parseCursor(cursorText)
        // Among visible messages, as a loaded transcript pages; a bare id of a hidden message still finds it.
        cursor = (occurrence === undefined
          ? db.prepare("SELECT ord, rid FROM items WHERE coll = 'm' AND msg_id = ? ORDER BY hidden ASC, ord DESC, rid DESC LIMIT 1").get(id)
          : db.prepare("SELECT ord, rid FROM items WHERE coll = 'm' AND hidden = 0 AND msg_id = ? ORDER BY ord ASC, rid ASC LIMIT 1 OFFSET ?").get(id, occurrence)) as { ord: number; rid: number } | undefined
        if (!cursor) return { info, messages: [], missing: true }
      }
      const forward = request.after !== undefined
      const where = cursor ? (forward ? 'AND (ord > ? OR (ord = ? AND rid > ?))' : 'AND (ord < ? OR (ord = ? AND rid < ?))') : ''
      const order = forward ? 'ORDER BY ord ASC, rid ASC' : 'ORDER BY ord DESC, rid DESC'
      const args = cursor ? [cursor.ord, cursor.ord, cursor.rid] : []
      const statement = db.prepare(`SELECT rid, coll, ord, msg_id, payload, blob_paths FROM items WHERE coll = 'm' AND hidden = 0 ${where} ${order} LIMIT ?`)
      const kept: Array<DbRow & { msg_id: string | null }> = []
      let bytes = 0
      // Measured as returned: blobs put back, in UTF-8.
      for (const raw of statement.iterate(...args, request.limit) as Iterable<DbRow & { msg_id: string | null; blob_paths: string | null }>) {
        const row = hydrateRows(dir, [raw], { images: request.images === true })[0]!
        const size = Buffer.byteLength(row.payload)
        if (kept.length && bytes + size > request.maxBytes) break
        bytes += size
        kept.push({ ...row, msg_id: raw.msg_id })
      }
      if (!forward) kept.reverse()
      const out: MessagePage = { info, messages: kept.map((row) => row.payload) }
      if (kept.length) {
        const first = kept[0]!
        const last = kept[kept.length - 1]!
        const before = db.prepare("SELECT count(*) AS n FROM items WHERE coll = 'm' AND hidden = 0 AND (ord < ? OR (ord = ? AND rid < ?))").get(first.ord, first.ord, first.rid) as { n: number }
        const after = db.prepare("SELECT count(*) AS n FROM items WHERE coll = 'm' AND hidden = 0 AND (ord > ? OR (ord = ? AND rid > ?))").get(last.ord, last.ord, last.rid) as { n: number }
        if (Number(before.n) > 0) out.earlier = { before: rowCursor(db, first), count: Number(before.n) }
        if (Number(after.n) > 0) out.later = { after: rowCursor(db, last), count: Number(after.n) }
      }
      return out
    } finally {
      if (db.isTransaction) db.exec('COMMIT')
    }
  }

  /**
   * The visible transcript messages that changed since `since`, the ids that have no visible message any more
   * (removed or hidden since), and the new sequence. A reader applies `removed` first, then `messages`.
   */
  messageChanges(dir: string, since: number, epoch?: number): MessageChanges {
    const changes = this.changes(dir, since, epoch)
    if (changes.reset) return { info: changes.info, reset: true, messages: [], removed: [] }
    const connection = this.open(dir)
    const transcript = changes.rows.filter((row) => row.coll === 'm')
    const messages: Array<{ ord: number; payload: string }> = []
    const gone = new Set<string>()
    for (const row of transcript) {
      const value = JSON.parse(row.payload) as { id?: unknown; hidden?: unknown }
      if (value.hidden === true) {
        if (typeof value.id === 'string') gone.add(value.id)
      } else {
        messages.push({ ord: row.ord, payload: row.payload })
      }
    }
    const removedIds = this.statement(connection, "SELECT DISTINCT msg_id FROM removed WHERE coll = 'm' AND changed_seq > ? AND msg_id IS NOT NULL").all(since) as Array<{ msg_id: string }>
    for (const row of removedIds) gone.add(row.msg_id)
    // Net of what is there now: an id removed and written again, or hidden in one row and shown in another, stays.
    const visible = this.statement(connection, "SELECT 1 FROM items WHERE coll = 'm' AND hidden = 0 AND msg_id = ? LIMIT 1")
    const removed = [...gone].filter((id) => !visible.get(id))
    return { info: changes.info, reset: false, messages, removed }
  }

  /** One transcript message, whole (images included), by id; its last occurrence when an id repeats. */
  messageById(dir: string, id: string): string | undefined {
    const connection = this.open(dir)
    const row = this.statement(connection, "SELECT rid, coll, ord, payload, blob_paths FROM items WHERE coll = 'm' AND msg_id = ? ORDER BY ord DESC, rid DESC LIMIT 1").get(id) as (DbRow & { blob_paths: string | null }) | undefined
    if (!row) return undefined
    return hydrateRows(dir, [row], { images: true })[0]!.payload
  }

  /** A value kept in `info`, such as the source fingerprint of an import. */
  getInfoValue(dir: string, key: string): string | undefined {
    const row = this.statement(this.open(dir), 'SELECT value FROM info WHERE key = ?').get(key) as { value: string } | undefined
    return row?.value
  }

  /**
   * Transcript messages whose text contains `needle` with JavaScript's case-insensitive comparison
   * (`toLowerCase().includes`), oldest first, as the JSON search read them. Every row is checked: SQLite's own case
   * folding only knows ASCII, so it cannot narrow the scan without losing matches.
   */
  searchTranscript(dir: string, needle: string, limit: number): Array<{ id: string; content: string }> {
    const connection = this.open(dir)
    const lowered = needle.toLowerCase()
    const out: Array<{ id: string; content: string }> = []
    for (const row of this.statement(connection, "SELECT payload, blob_paths FROM items WHERE coll = 'm' ORDER BY ord, rid").iterate() as Iterable<{ payload: string; blob_paths: string | null }>) {
      // Long text lives in blobs; it is put back (image data is not) before the text is compared.
      const payload = row.blob_paths ? hydratePayload(dir, row.payload, row.blob_paths, { images: false }).payload : row.payload
      const message = JSON.parse(payload) as { id?: unknown; content?: unknown }
      const content = typeof message.content === 'string' ? message.content : ''
      if (typeof message.id === 'string' && content.toLowerCase().includes(lowered)) out.push({ id: message.id, content })
      if (out.length >= limit) break
    }
    return out
  }

  /**
   * One record of a thread for the lifecycle code, read without leaving a connection open (a move or purge may follow):
   * `agents.json` (the agents), `mousse-agent-sessions.json` (subagent session headers, without their histories) or
   * `messages.json` (only the transcript rows that mention one of `needles`). `undefined` when the thread has none.
   */
  readRecord(dir: string, name: string, needles: string[] = []): unknown {
    const wasOpen = this.connections.has(dir)
    try {
      const connection = this.open(dir)
      if (name === 'messages.json') {
        const where = needles.map(() => 'instr(payload, ?) > 0').join(' OR ') || '1'
        const rows = connection.db.prepare(`SELECT payload FROM items WHERE coll = 'm' AND (${where}) ORDER BY ord, rid`).all(...needles) as Array<{ payload: string }>
        return rows.map((row) => JSON.parse(row.payload))
      }
      const key = name === 'agents.json' ? 'agents' : name === 'mousse-agent-sessions.json' ? 'sessions' : undefined
      if (!key) throw new Error(`Unknown thread record ${name}`)
      const row = this.statement(connection, 'SELECT payload FROM state WHERE key = ?').get(key) as { payload: string } | undefined
      if (!row) return undefined
      const value = JSON.parse(row.payload) as unknown
      if (key !== 'sessions' || !Array.isArray(value)) return value
      return value.map((header) => {
        const { $history: _history, $context: _context, ...rest } = header as Record<string, unknown>
        return rest
      })
    } finally {
      if (!wasOpen) this.close(dir)
    }
  }

  /** Modification time of the database and its WAL, whichever is later. */
  modifiedAt(dir: string): number {
    let latest = 0
    for (const name of [THREAD_DB_FILE, `${THREAD_DB_FILE}-wal`]) {
      try { latest = Math.max(latest, statSync(join(dir, name)).mtimeMs) } catch { /* absent */ }
    }
    return latest
  }

  /** A new, empty thread database, published only when none exists. */
  create(dir: string): DbInfo {
    const tmpName = `${THREAD_DB_FILE}.create-${process.pid}-${randomUUID()}`
    const tmp = join(dir, tmpName)
    const db = new DatabaseSync(tmp)
    try {
      db.exec('PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL;')
      createSchema(db)
      db.exec('BEGIN')
      insertAll(db, dir, { messages: [], agents: [], tasks: [], llmContext: undefined, mousseAgentSessions: [] }, { createdAt: new Date().toISOString() })
      db.exec('COMMIT')
    } finally {
      db.close()
    }
    try {
      fsyncFile(tmp)
      linkSync(tmp, this.path(dir))
      fsyncDir(dir)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    } finally {
      rmSync(tmp, { force: true })
    }
    return this.info(dir)
  }

  /**
   * Builds `<tmpName>` from the thread's JSON files and checks every row against them. The caller publishes it
   * under the thread's lock, after checking the fingerprint again. A source that changed while it was read
   * comes back as `stale`.
   */
  build(dir: string, request: BuildRequest): BuildResult {
    if (!/^thread\.db\.import-[\w.-]+$/.test(request.tmpName)) throw new Error('Invalid import file name')
    const tmp = join(dir, request.tmpName)
    rmSync(tmp, { force: true })
    // The import's blobs go to a staging folder of its own (`<tmpName>.stage/blobs`), moved into the thread's
    // `blobs/` only when the database is published, under the thread's lock (`publishStagedBlobs`). A failed or stale
    // import removes just its staging folder, so it never touches a blob another import or save has published.
    const stage = join(dir, `${request.tmpName}.stage`)
    rmSync(stage, { recursive: true, force: true })
    const discard = (): void => {
      rmSync(tmp, { force: true })
      rmSync(stage, { recursive: true, force: true })
    }
    try {
      const source = readLegacyThreadData(dir, { transactional: request.transactional })
      const db = new DatabaseSync(tmp)
      let rows: number
      try {
        db.exec('PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL;')
        createSchema(db)
        db.exec('BEGIN')
        rows = insertAll(db, stage, source, {
          importedFrom: JSON.stringify(request.fingerprint),
          importedAt: new Date().toISOString(),
          jsonFingerprint: JSON.stringify(request.fingerprint)
        })
        db.exec('COMMIT')
        const back = dataFromLoad(loadFrom(db, stage))
        if (back.messages.length !== source.messages.length) throw new Error(`Import kept ${back.messages.length} of ${source.messages.length} messages`)
        if (normalizedForCompare(back) !== normalizedForCompare(source)) throw new Error('Imported rows differ from the JSON files')
        const check = db.prepare('PRAGMA quick_check').get() as Record<string, unknown>
        if (Object.values(check)[0] !== 'ok') throw new Error('Imported database failed its integrity check')
      } finally {
        db.close()
      }
      fsyncFile(tmp)
      if (!sameFingerprint(legacyFingerprint(dir), request.fingerprint)) {
        discard()
        return { ok: false, stale: true }
      }
      return { ok: true, tmpName: request.tmpName, messages: source.messages.length, rows }
    } catch (error) {
      discard()
      throw error
    }
  }

  /**
   * Removes blobs no row refers to, once an hour old (so a blob written by a save still running elsewhere is never
   * taken). The caller holds the thread's lock. Returns how many files went.
   */
  collectBlobs(dir: string, minAgeMs = 60 * 60_000): number {
    const referenced = new Set<string>()
    const rows = this.statement(this.open(dir), 'SELECT blob_paths FROM items WHERE blob_paths IS NOT NULL').all() as Array<{ blob_paths: string }>
    for (const row of rows) for (const ref of parseBlobPaths(row.blob_paths)) referenced.add(ref.sha256)
    return collectBlobs(dir, referenced, minAgeMs)
  }

  private searchIndex?: ThreadIndex

  private index(): ThreadIndex {
    return (this.searchIndex ??= new ThreadIndex(this))
  }

  /** Brings the profile's search index up to date for these threads (`threadIndex.ts`). */
  indexUpdate(profileHome: string, targets: IndexTarget[]): number {
    return this.index().update(profileHome, targets)
  }

  /** The search index sweep: catch up changed threads, drop threads no longer listed. */
  indexReconcile(profileHome: string, live: IndexTarget[]): { updated: number; dropped: number } {
    return this.index().reconcile(profileHome, live)
  }

  indexSearch(profileHome: string, request: IndexSearchRequest): IndexHit[] {
    return this.index().search(profileHome, request)
  }

  indexStatus(profileHome: string): Array<{ threadId: string; seq: number }> {
    return this.index().status(profileHome)
  }

  /** Checkpoints and closes the thread's database before its folder is moved or purged. */
  quiesce(dir: string): void {
    this.close(dir)
  }
}
