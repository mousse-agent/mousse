/**
 * net.db gives the space it frees back to the file system: a new database from its start, an older one once it has
 * been rewritten. Real SQLite files on disk; sizes are what the file system reports.
 */
import { mkdirSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, expect, it } from 'vitest'
import { NetDatabase } from '../../../src/mms/net/store/database'
import { profile } from './helpers'

const cleanups: Array<() => void> = []
afterEach(() => {
  for (const clean of cleanups.splice(0).reverse()) clean()
})

/** A profile folder, and with `older` a net.db made as builds before this one made it (no page reuse set). */
function database(older = false): NetDatabase {
  const dir = profile()
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  if (older) {
    mkdirSync(join(dir, 'net'), { recursive: true, mode: 0o700 })
    const made = new DatabaseSync(join(dir, 'net', 'net.db'))
    made.exec('PRAGMA journal_mode=WAL; CREATE TABLE made_before(x INTEGER)')
    made.close()
  }
  const db = new NetDatabase({ profileDir: dir })
  cleanups.push(() => db.close())
  db.database.exec('CREATE TABLE IF NOT EXISTS filler(n INTEGER PRIMARY KEY, data BLOB NOT NULL)')
  return db
}
const pragma = (db: NetDatabase, name: string): number =>
  Number(Object.values(db.database.prepare(`PRAGMA ${name}`).get()!)[0])
/** Writes `mib` MiB of rows, then deletes all but the first. */
function fillAndFree(db: NetDatabase, mib: number): void {
  const insert = db.database.prepare('INSERT INTO filler(data) VALUES(?)')
  db.database.exec('BEGIN')
  for (let n = 0; n < mib * 16; n++) insert.run(Buffer.alloc(64 * 1024, n % 251))
  db.database.exec('COMMIT')
  db.database.exec('DELETE FROM filler WHERE n>1')
  db.database.exec('PRAGMA wal_checkpoint(TRUNCATE)')
}
const fileBytes = (db: NetDatabase): number => statSync(db.path).size
const rows = (db: NetDatabase): number =>
  Number(db.database.prepare('SELECT count(*) AS n FROM filler').get()!.n)

it('a new database gives back what a delete frees, a bounded step at a time', () => {
  const db = database()
  expect(pragma(db, 'auto_vacuum')).toBe(2)
  fillAndFree(db, 16)
  const before = fileBytes(db)
  expect(before).toBeGreaterThan(16 * 2 ** 20)
  const steps: number[] = []
  for (let freed; (freed = db.reclaim(1024));) steps.push(freed)
  expect(steps.length).toBeGreaterThan(1)
  expect(Math.max(...steps)).toBeLessThanOrEqual(1024)
  db.database.exec('PRAGMA wal_checkpoint(TRUNCATE)')
  expect(fileBytes(db)).toBeLessThan(2 * 2 ** 20)
  expect(rows(db)).toBe(1)
  // A few free pages are left for SQLite to reuse.
  db.database.exec(
    'INSERT INTO filler(data) VALUES(randomblob(8192)); DELETE FROM filler WHERE n>1'
  )
  expect(db.reclaim(1024)).toBe(0)
})

it('an older database is rewritten once to give back its space, and keeps what it holds', () => {
  const db = database(true)
  expect(pragma(db, 'auto_vacuum')).toBe(0)
  fillAndFree(db, 16)
  // Not set to give pages back yet: nothing goes.
  expect(db.reclaim(1024)).toBe(0)
  const before = fileBytes(db)
  const first = db.rewriteToReclaim()
  expect(first).toMatchObject({ outcome: 'rewritten' })
  expect(first.freeBytes).toBeGreaterThan(15 * 2 ** 20)
  expect(pragma(db, 'auto_vacuum')).toBe(2)
  expect(fileBytes(db)).toBeLessThan(before / 8)
  expect(rows(db)).toBe(1)
  expect(
    db.database.prepare("SELECT 1 FROM sqlite_master WHERE name='made_before'").get()
  ).toBeTruthy()
  expect(db.rewriteToReclaim()).toMatchObject({ outcome: 'already' })
  // From now on what a delete frees goes back a step at a time.
  fillAndFree(db, 4)
  expect(db.reclaim(4096)).toBeGreaterThan(0)
})

it('a rewrite while a copy is being read does not wait on the reader, and leaves its view and writes intact', () => {
  const db = database(true)
  fillAndFree(db, 2)
  // A snapshot reader holds the file open mid-read, as a copy being displayed does.
  const reader = new DatabaseSync(db.path, { readOnly: true })
  cleanups.push(() => reader.close())
  reader.exec('BEGIN')
  const seen = () => Number(reader.prepare('SELECT count(*) AS n FROM filler').get()!.n)
  expect(seen()).toBe(1)
  const started = Date.now()
  expect(db.rewriteToReclaim()).toMatchObject({ outcome: 'rewritten' })
  // Not the five seconds a write waits for a lock.
  expect(Date.now() - started).toBeLessThan(2_500)
  expect(seen()).toBe(1)
  reader.exec('COMMIT')
  db.transaction(() => db.database.exec("INSERT INTO filler(data) VALUES(x'00')"))
  expect(rows(db)).toBe(2)
})

it('does nothing inside a transaction', () => {
  const db = database()
  expect(() => db.transaction(() => db.reclaim(10))).toThrow(/during a transaction/)
  expect(() => db.transaction(() => db.rewriteToReclaim())).toThrow(/during a transaction/)
})

it('a rewrite that runs out of room is rolled back: the database keeps what it holds and takes writes', () => {
  const db = database(true)
  fillAndFree(db, 4)
  // 10 MiB in use, more than the rewrite may hold below.
  const insert = db.database.prepare('INSERT INTO filler(data) VALUES(randomblob(65536))')
  for (let n = 0; n < 160; n++) insert.run()
  const held = rows(db)
  // The rewrite builds its copy in memory: a limit below what it needs stands in for a disk with no room. SQLite
  // only ever lowers this limit, for the whole process: so this test runs last in its file.
  db.database.exec('PRAGMA shrink_memory')
  db.database.exec(`PRAGMA hard_heap_limit=${4 * 2 ** 20}`)
  expect(() => db.rewriteToReclaim()).toThrow(/out of memory/)
  expect(pragma(db, 'auto_vacuum')).toBe(0)
  expect(rows(db)).toBe(held)
  expect(db.database.prepare('PRAGMA integrity_check').get()).toEqual({ integrity_check: 'ok' })
  db.transaction(() => db.database.exec("INSERT INTO filler(data) VALUES(x'00')"))
  expect(rows(db)).toBe(held + 1)
})
