/**
 * The profile's search index, `<profile>/thread-index.db`: the transcript text of every thread kept in
 * `thread.db`, with a full-text (FTS5, trigram) index over it. It is a cache. It is rebuilt from the thread
 * databases when it is missing, damaged or of another version, a thread is indexed again from scratch when its
 * database was replaced or renumbered, and the app never treats it as the record of anything.
 *
 * Matching is JavaScript's `toLowerCase().includes()`, as search always was: the index holds each message's text
 * lowercased by JavaScript, the trigram index is case-sensitive over it, and queries are lowercased the same way.
 *
 * It runs in a worker of its own. A search first catches up every thread whose database files changed since they
 * were indexed, so it answers for what is on disk whoever wrote it; the minute sweep also compares each database's
 * own sequence, which catches a change its file stamp did not show.
 */
import { DatabaseSync } from 'node:sqlite'
import { existsSync, renameSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { ThreadDbEngine } from './threadDbEngine'
import { THREAD_DB_FILE } from './threadDbEngine'

export const INDEX_FILE = 'thread-index.db'
const INDEX_VERSION = '2'

const TABLES = ['msg_fts', 'msg', 'indexed', 'info']
const SCHEMA = `
CREATE TABLE info(key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE indexed(thread_id TEXT PRIMARY KEY, db_id TEXT NOT NULL, epoch INTEGER NOT NULL, seq INTEGER NOT NULL, stamp TEXT NOT NULL);
CREATE TABLE msg(id INTEGER PRIMARY KEY, thread_id TEXT NOT NULL, rid INTEGER NOT NULL, ord INTEGER NOT NULL, message_id TEXT NOT NULL, body TEXT NOT NULL, folded TEXT NOT NULL);
CREATE UNIQUE INDEX msg_row ON msg(thread_id, rid);
CREATE INDEX msg_order ON msg(thread_id, ord, rid);
CREATE VIRTUAL TABLE msg_fts USING fts5(folded, content='msg', content_rowid='id', tokenize='trigram case_sensitive 1');
CREATE TRIGGER msg_ai AFTER INSERT ON msg BEGIN INSERT INTO msg_fts(rowid, folded) VALUES (new.id, new.folded); END;
CREATE TRIGGER msg_ad AFTER DELETE ON msg BEGIN INSERT INTO msg_fts(msg_fts, rowid, folded) VALUES ('delete', old.id, old.folded); END;
`

export interface IndexTarget { threadId: string; dir: string }
export interface IndexSearchRequest {
  /** Lowercased by the caller with JavaScript's `toLowerCase`. */
  query: string
  /**
   * The threads that may match, already filtered by who may see them, in the order results should come in, with
   * their folders: any whose database changed since it was indexed is caught up before the search runs.
   */
  threads: Array<{ id: string; name: string; dir: string }>
  limit: number
  /** Matches to skip, for a caller that needs more than one batch. */
  offset?: number
}
export interface IndexHit { threadId: string; messageId: string; body: string }

/** What a thread's database files look like on disk; a different stamp means a write happened since. */
function stampOf(dir: string): string {
  const parts: string[] = []
  for (const name of [THREAD_DB_FILE, `${THREAD_DB_FILE}-wal`]) {
    try {
      const stat = statSync(join(dir, name))
      parts.push(`${stat.ino}:${stat.size}:${stat.mtimeMs}`)
    } catch {
      parts.push('-')
    }
  }
  return parts.join('/')
}

/** SQLite's primary result code of an error from `node:sqlite`, when it has one. */
function sqliteCode(error: unknown): number | undefined {
  const code = (error as { errcode?: unknown })?.errcode
  return typeof code === 'number' ? code & 0xff : undefined
}

/** The file is damaged or not a database at all (as opposed to busy or locked). */
function isDamage(error: unknown): boolean {
  const code = sqliteCode(error)
  return code === 11 /* SQLITE_CORRUPT */ || code === 26 /* SQLITE_NOTADB */
}

export class ThreadIndex {
  private db?: DatabaseSync
  private path?: string

  constructor(private readonly engine: ThreadDbEngine) {}

  /**
   * Opens the index. Missing or outdated tables are (re)created inside the database, in one transaction, so another
   * process with it open keeps a valid file. A file that is not a database, or is damaged, is set aside and a new
   * one made. A busy or locked database is an error for this request only: it is never taken for damage.
   */
  private open(profileHome: string): DatabaseSync {
    const path = join(profileHome, INDEX_FILE)
    if (this.db && this.path === path) return this.db
    this.close()
    let db: DatabaseSync
    try {
      db = this.prepare(path)
    } catch (error) {
      if (!isDamage(error)) throw error
      if (existsSync(path)) renameSync(path, `${path}.damaged-${Date.now()}`)
      db = this.prepare(path)
    }
    this.db = db
    this.path = path
    return db
  }

  private prepare(path: string): DatabaseSync {
    const db = new DatabaseSync(path)
    try {
      // A cache: losing the last writes on power loss costs a catch-up, never data.
      db.exec('PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL;')
      const check = db.prepare('PRAGMA quick_check').get() as Record<string, unknown>
      if (Object.values(check)[0] !== 'ok') throw Object.assign(new Error('index damaged'), { errcode: 11 })
      if (!this.current(db)) {
        db.exec('BEGIN IMMEDIATE')
        try {
          // Checked again under the write lock: another process may have just built it.
          if (!this.current(db)) {
            for (const table of TABLES) db.exec(`DROP TABLE IF EXISTS ${table}`)
            db.exec(SCHEMA)
            db.prepare('INSERT INTO info(key, value) VALUES (?, ?)').run('version', INDEX_VERSION)
          }
          db.exec('COMMIT')
        } catch (error) {
          if (db.isTransaction) db.exec('ROLLBACK')
          throw error
        }
      }
      return db
    } catch (error) {
      db.close()
      throw error
    }
  }

  /** The schema this build writes, every table of it present. */
  private current(db: DatabaseSync): boolean {
    const tables = new Set((db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>).map((row) => row.name))
    if (!TABLES.every((table) => tables.has(table))) return false
    const version = (db.prepare("SELECT value FROM info WHERE key = 'version'").get() as { value: string } | undefined)?.value
    return version === INDEX_VERSION
  }

  close(): void {
    this.db?.close()
    this.db = undefined
    this.path = undefined
  }

  /** Runs `work` on the open index; an error closes it, so the next request opens (and checks) it again. */
  private withIndex<T>(profileHome: string, work: (db: DatabaseSync) => T): T {
    const db = this.open(profileHome)
    try {
      return work(db)
    } catch (error) {
      this.close()
      throw error
    }
  }

  /** Brings each thread's rows up to date with its database: the changes since the last look, or all of it. */
  update(profileHome: string, targets: IndexTarget[], options: { verify?: boolean } = {}): number {
    return this.withIndex(profileHome, (db) => {
      let updated = 0
      // Only a thread that cannot be read now (moved, being imported) is skipped, to be caught up later. Any error
      // writing the index (busy, locked, damaged) stops the update, so the search falls back instead of answering
      // from rows it could not bring up to date.
      for (const target of targets) if (this.updateThread(db, target, options.verify === true)) updated += 1
      return updated
    })
  }

  private updateThread(db: DatabaseSync, { threadId, dir }: IndexTarget, verify: boolean): boolean {
    if (!existsSync(join(dir, THREAD_DB_FILE))) {
      this.drop(db, threadId)
      return false
    }
    const stamp = stampOf(dir)
    const known = db.prepare('SELECT db_id, epoch, seq, stamp FROM indexed WHERE thread_id = ?').get(threadId) as { db_id: string; epoch: number; seq: number; stamp: string } | undefined
    if (known && known.stamp === stamp && !verify) return false
    let changes: ReturnType<ThreadDbEngine['changes']> | undefined
    try {
      const info = this.engine.info(dir)
      if (!(known && known.db_id === info.dbId && known.epoch === info.epoch && known.seq === info.seq)) {
        const fresh = !known || known.db_id !== info.dbId
        changes = fresh ? { ...this.engine.load(dir), removed: [], removedState: [], reset: true } : this.engine.changes(dir, known.seq, known.epoch)
      }
    } catch {
      // The thread's own database cannot be read now; the index is left as it is for this thread.
      return false
    }
    if (!changes) {
      db.prepare('UPDATE indexed SET stamp = ? WHERE thread_id = ?').run(stamp, threadId)
      return false
    }
    const remove = db.prepare('DELETE FROM msg WHERE thread_id = ? AND rid = ?')
    const insert = db.prepare('INSERT INTO msg(thread_id, rid, ord, message_id, body, folded) VALUES (?, ?, ?, ?, ?, ?)')
    db.exec('BEGIN IMMEDIATE')
    try {
      if (changes.reset) db.prepare('DELETE FROM msg WHERE thread_id = ?').run(threadId)
      for (const removed of changes.removed) if (removed.coll === 'm') remove.run(threadId, removed.rid)
      for (const row of changes.rows) {
        if (row.coll !== 'm') continue
        remove.run(threadId, row.rid)
        const message = JSON.parse(row.payload) as { id?: unknown; content?: unknown }
        if (typeof message.id !== 'string' || typeof message.content !== 'string' || !message.content) continue
        insert.run(threadId, row.rid, row.ord, message.id, message.content, message.content.toLowerCase())
      }
      db.prepare('INSERT INTO indexed(thread_id, db_id, epoch, seq, stamp) VALUES (?, ?, ?, ?, ?) ON CONFLICT(thread_id) DO UPDATE SET db_id = excluded.db_id, epoch = excluded.epoch, seq = excluded.seq, stamp = excluded.stamp')
        .run(threadId, changes.info.dbId, changes.info.epoch, changes.info.seq, stamp)
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

  private indexedStamps(db: DatabaseSync): Map<string, string> {
    return new Map((db.prepare('SELECT thread_id, stamp FROM indexed').all() as Array<{ thread_id: string; stamp: string }>).map((row) => [row.thread_id, row.stamp]))
  }

  /**
   * The sweep: every listed thread is checked against its database's own identity and sequence (not only its file
   * stamp) and caught up, and threads that are no longer listed are dropped.
   */
  reconcile(profileHome: string, live: IndexTarget[]): { updated: number; dropped: number } {
    const dropped = this.withIndex(profileHome, (db) => {
      const liveIds = new Set(live.map((target) => target.threadId))
      let count = 0
      for (const threadId of this.indexedStamps(db).keys()) {
        if (liveIds.has(threadId)) continue
        this.drop(db, threadId)
        count += 1
      }
      return count
    })
    return { updated: this.update(profileHome, live, { verify: true }), dropped }
  }

  /** Messages whose text contains the query, in the given threads' order and then transcript order. */
  search(profileHome: string, request: IndexSearchRequest): IndexHit[] {
    const query = request.query
    if (!query.trim() || !request.threads.length) return []
    // A thread whose files changed since it was indexed (this process, another one, or nothing since a rebuild) is
    // caught up first. That costs a stat per thread when nothing changed.
    const known = this.withIndex(profileHome, (db) => this.indexedStamps(db))
    const stale = request.threads.filter((thread) => known.get(thread.id) !== stampOf(thread.dir))
    if (stale.length) this.update(profileHome, stale.map((thread) => ({ threadId: thread.id, dir: thread.dir })))
    return this.withIndex(profileHome, (db) => {
      const threads = JSON.stringify(request.threads.map((thread, order) => ({ id: thread.id, order })))
      const scope = 'WITH scope AS (SELECT json_extract(value, \'$.id\') AS id, json_extract(value, \'$.order\') AS ord FROM json_each(?))'
      const select = 'SELECT m.thread_id AS threadId, m.message_id AS messageId, m.body AS body'
      const page = 'ORDER BY s.ord, m.ord, m.rid LIMIT ? OFFSET ?'
      const offset = request.offset ?? 0
      const rows = [...query].length >= 3
        ? db.prepare(`${scope} ${select} FROM msg_fts JOIN msg m ON m.id = msg_fts.rowid JOIN scope s ON s.id = m.thread_id WHERE msg_fts MATCH ? ${page}`)
          .all(threads, `"${query.replace(/"/g, '""')}"`, request.limit, offset)
        : db.prepare(`${scope} ${select} FROM msg m JOIN scope s ON s.id = m.thread_id WHERE instr(m.folded, ?) > 0 ${page}`)
          .all(threads, query, request.limit, offset)
      return rows as unknown as IndexHit[]
    })
  }

  /** Thread ids the index holds, with the sequence each was indexed at (for tests and the storage status). */
  status(profileHome: string): Array<{ threadId: string; seq: number }> {
    return this.withIndex(profileHome, (db) => db.prepare('SELECT thread_id AS threadId, seq FROM indexed ORDER BY thread_id').all() as unknown as Array<{ threadId: string; seq: number }>)
  }
}
