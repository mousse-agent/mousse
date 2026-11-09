/**
 * The profile's search index, `<profile>/thread-index.db`: the transcript text of every thread kept in
 * `thread.db`, with a full-text (FTS5, trigram) index over it. It is a cache. It is rebuilt from the thread
 * databases when it is missing, damaged or of another version, a thread is indexed again from scratch when its
 * database was replaced or renumbered, and the app never treats it as the record of anything.
 *
 * It runs in the read worker, which handles requests in order: an index notice the daemon sends after a save is
 * applied before any search sent after it.
 */
import { DatabaseSync } from 'node:sqlite'
import { rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { ThreadDbEngine } from './threadDbEngine'
import { THREAD_DB_FILE } from './threadDbEngine'

export const INDEX_FILE = 'thread-index.db'
const INDEX_VERSION = 1

const SCHEMA = `
CREATE TABLE info(key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE indexed(thread_id TEXT PRIMARY KEY, db_id TEXT NOT NULL, epoch INTEGER NOT NULL, seq INTEGER NOT NULL, mtime REAL NOT NULL);
CREATE TABLE msg(id INTEGER PRIMARY KEY, thread_id TEXT NOT NULL, rid INTEGER NOT NULL, message_id TEXT NOT NULL, body TEXT NOT NULL);
CREATE UNIQUE INDEX msg_row ON msg(thread_id, rid);
CREATE VIRTUAL TABLE msg_fts USING fts5(body, content='msg', content_rowid='id', tokenize='trigram');
CREATE TRIGGER msg_ai AFTER INSERT ON msg BEGIN INSERT INTO msg_fts(rowid, body) VALUES (new.id, new.body); END;
CREATE TRIGGER msg_ad AFTER DELETE ON msg BEGIN INSERT INTO msg_fts(msg_fts, rowid, body) VALUES ('delete', old.id, old.body); END;
`

export interface IndexTarget { threadId: string; dir: string }
export interface IndexSearchRequest {
  query: string
  /**
   * The threads that may match, already filtered by who may see them, in the order results should come in, with
   * their folders: any whose database changed since it was indexed is caught up before the search runs.
   */
  threads: Array<{ id: string; name: string; dir: string }>
  limit: number
}
export interface IndexHit { threadId: string; messageId: string; body: string }

/** The newest modification time of a thread's database files: a change since the last look means another writer. */
function dbMtime(dir: string): number {
  let latest = 0
  for (const name of [THREAD_DB_FILE, `${THREAD_DB_FILE}-wal`]) {
    try { latest = Math.max(latest, statSync(join(dir, name)).mtimeMs) } catch { /* absent */ }
  }
  return latest
}

function escapeLike(text: string): string {
  return text.replace(/[\\%_]/g, (char) => `\\${char}`)
}

export class ThreadIndex {
  private db?: DatabaseSync
  private path?: string

  constructor(private readonly engine: ThreadDbEngine) {}

  /** Opens the index, rebuilding it when it is missing, damaged or of another version. */
  private open(profileHome: string): DatabaseSync {
    const path = join(profileHome, INDEX_FILE)
    if (this.db && this.path === path) return this.db
    this.close()
    const tryOpen = (): DatabaseSync => {
      const db = new DatabaseSync(path)
      try {
        // A cache: losing the last writes on power loss costs a catch-up, never data.
        db.exec('PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL;')
        const hasInfo = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'info'").get()
        if (!hasInfo) {
          db.exec('PRAGMA auto_vacuum=INCREMENTAL')
          db.exec(SCHEMA)
          db.prepare('INSERT INTO info(key, value) VALUES (?, ?)').run('version', String(INDEX_VERSION))
        }
        const version = (db.prepare("SELECT value FROM info WHERE key = 'version'").get() as { value: string } | undefined)?.value
        const check = db.prepare('PRAGMA quick_check').get() as Record<string, unknown>
        if (version !== String(INDEX_VERSION) || Object.values(check)[0] !== 'ok') throw new Error('stale index')
        return db
      } catch (error) {
        db.close()
        throw error
      }
    }
    let db: DatabaseSync
    try {
      db = tryOpen()
    } catch {
      // Missing tables, another version or damage: start over; every thread is indexed again from its database.
      for (const suffix of ['', '-wal', '-shm']) rmSync(path + suffix, { force: true })
      db = tryOpen()
    }
    this.db = db
    this.path = path
    return db
  }

  close(): void {
    this.db?.close()
    this.db = undefined
    this.path = undefined
  }

  /** Brings each thread's rows up to date with its database: the changes since the last look, or all of it. */
  update(profileHome: string, targets: IndexTarget[]): number {
    const db = this.open(profileHome)
    let updated = 0
    for (const target of targets) {
      try {
        if (this.updateThread(db, target)) updated += 1
      } catch {
        // A thread that cannot be read now (moved, being imported) is caught up by the next sweep.
      }
    }
    return updated
  }

  private updateThread(db: DatabaseSync, { threadId, dir }: IndexTarget): boolean {
    const mtime = dbMtime(dir)
    if (!mtime) {
      this.drop(db, threadId)
      return false
    }
    const known = db.prepare('SELECT db_id, epoch, seq FROM indexed WHERE thread_id = ?').get(threadId) as { db_id: string; epoch: number; seq: number } | undefined
    const info = this.engine.info(dir)
    if (known && known.db_id === info.dbId && known.epoch === info.epoch && known.seq === info.seq) {
      db.prepare('UPDATE indexed SET mtime = ? WHERE thread_id = ?').run(mtime, threadId)
      return false
    }
    const fresh = !known || known.db_id !== info.dbId
    const changes = fresh ? { ...this.engine.load(dir), removed: [], reset: true } : this.engine.changes(dir, known.seq, known.epoch)
    const remove = db.prepare('DELETE FROM msg WHERE thread_id = ? AND rid = ?')
    const insert = db.prepare('INSERT INTO msg(thread_id, rid, message_id, body) VALUES (?, ?, ?, ?)')
    db.exec('BEGIN IMMEDIATE')
    try {
      if (changes.reset) db.prepare('DELETE FROM msg WHERE thread_id = ?').run(threadId)
      for (const removed of changes.removed) if (removed.coll === 'm') remove.run(threadId, removed.rid)
      for (const row of changes.rows) {
        if (row.coll !== 'm') continue
        remove.run(threadId, row.rid)
        const message = JSON.parse(row.payload) as { id?: unknown; content?: unknown; hidden?: unknown }
        if (typeof message.id !== 'string' || typeof message.content !== 'string' || !message.content) continue
        insert.run(threadId, row.rid, message.id, message.content)
      }
      db.prepare('INSERT INTO indexed(thread_id, db_id, epoch, seq, mtime) VALUES (?, ?, ?, ?, ?) ON CONFLICT(thread_id) DO UPDATE SET db_id = excluded.db_id, epoch = excluded.epoch, seq = excluded.seq, mtime = excluded.mtime')
        .run(threadId, changes.info.dbId, changes.info.epoch, changes.info.seq, mtime)
      db.exec('COMMIT')
    } catch (error) {
      if (db.isTransaction) db.exec('ROLLBACK')
      throw error
    }
    return true
  }

  private drop(db: DatabaseSync, threadId: string): void {
    db.exec('BEGIN IMMEDIATE')
    try {
      db.prepare('DELETE FROM msg WHERE thread_id = ?').run(threadId)
      db.prepare('DELETE FROM indexed WHERE thread_id = ?').run(threadId)
      db.exec('COMMIT')
    } catch (error) {
      if (db.isTransaction) db.exec('ROLLBACK')
      throw error
    }
  }

  /**
   * The sweep: threads whose database files changed since they were indexed (another process wrote, or the index
   * missed a notice) are caught up, and threads that are no longer listed are dropped.
   */
  private indexedMtimes(db: DatabaseSync): Map<string, number> {
    return new Map((db.prepare('SELECT thread_id, mtime FROM indexed').all() as Array<{ thread_id: string; mtime: number }>).map((row) => [row.thread_id, row.mtime]))
  }

  reconcile(profileHome: string, live: IndexTarget[]): { updated: number; dropped: number } {
    const db = this.open(profileHome)
    const known = this.indexedMtimes(db)
    const stale = live.filter((target) => known.get(target.threadId) !== dbMtime(target.dir))
    const liveIds = new Set(live.map((target) => target.threadId))
    let dropped = 0
    for (const threadId of known.keys()) {
      if (liveIds.has(threadId)) continue
      this.drop(db, threadId)
      dropped += 1
    }
    return { updated: this.update(profileHome, stale), dropped }
  }

  /** Messages whose text contains the query, case-insensitively, in the given threads and their order. */
  search(profileHome: string, request: IndexSearchRequest): IndexHit[] {
    const db = this.open(profileHome)
    const query = request.query.trim()
    if (!query || !request.threads.length) return []
    // Fresh answers whatever wrote last (this process, another one, or nothing since a rebuild): a thread whose
    // files moved since it was indexed is caught up first. That costs a stat per thread when nothing changed.
    const known = this.indexedMtimes(db)
    const stale = request.threads.filter((thread) => known.get(thread.id) !== dbMtime(thread.dir))
    if (stale.length) this.update(profileHome, stale.map((thread) => ({ threadId: thread.id, dir: thread.dir })))
    const threads = JSON.stringify(request.threads.map((thread, order) => ({ id: thread.id, order })))
    const scope = 'WITH scope AS (SELECT json_extract(value, \'$.id\') AS id, json_extract(value, \'$.order\') AS ord FROM json_each(?))'
    const rows = [...query].length >= 3
      ? db.prepare(`${scope} SELECT m.thread_id AS threadId, m.message_id AS messageId, m.body AS body FROM msg_fts JOIN msg m ON m.id = msg_fts.rowid JOIN scope s ON s.id = m.thread_id WHERE msg_fts MATCH ? ORDER BY s.ord, m.rid LIMIT ?`)
        .all(threads, `"${query.replace(/"/g, '""')}"`, request.limit)
      : db.prepare(`${scope} SELECT m.thread_id AS threadId, m.message_id AS messageId, m.body AS body FROM msg m JOIN scope s ON s.id = m.thread_id WHERE m.body LIKE ? ESCAPE '\\' ORDER BY s.ord, m.rid LIMIT ?`)
        .all(threads, `%${escapeLike(query)}%`, request.limit)
    return rows as unknown as IndexHit[]
  }

  /** Thread ids the index holds, with the sequence each was indexed at (for tests and the storage status). */
  status(profileHome: string): Array<{ threadId: string; seq: number }> {
    const db = this.open(profileHome)
    return (db.prepare('SELECT thread_id AS threadId, seq FROM indexed ORDER BY thread_id').all() as unknown as Array<{ threadId: string; seq: number }>)
  }
}
