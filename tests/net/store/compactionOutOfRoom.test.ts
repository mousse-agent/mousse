/**
 * A one-time rewrite of net.db (`NetDatabase.rewriteToReclaim`) that runs out of room is rolled back: the database
 * keeps what it holds and takes writes. The rewrite runs in a child process with SQLite's heap limit lowered.
 */
import { mkdirSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { DatabaseSync } from 'node:sqlite'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { NetDatabase } from '../../../src/mms/net/store/database'
import { profile } from './helpers'
import { crashChild } from '../../support/build'

let executable: string
const roots: string[] = []
beforeAll(async () => {
  executable = await crashChild('tests/net/store/compactionOutOfRoom-child.ts', {
    target: 'node24'
  })
}, 120_000)
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true })
})

it('a rewrite that runs out of room is rolled back: the database keeps what it holds and takes writes', () => {
  const root = profile()
  roots.push(root)
  // A net.db as builds before page reuse made it, with 10 MiB in use and more free.
  mkdirSync(join(root, 'net'), { recursive: true, mode: 0o700 })
  const made = new DatabaseSync(join(root, 'net', 'net.db'))
  made.exec(
    'PRAGMA journal_mode=WAL; CREATE TABLE filler(n INTEGER PRIMARY KEY, data BLOB NOT NULL)'
  )
  const insert = made.prepare('INSERT INTO filler(data) VALUES(randomblob(65536))')
  made.exec('BEGIN')
  for (let n = 0; n < 220; n++) insert.run()
  made.exec('COMMIT')
  made.exec('DELETE FROM filler WHERE n<=60; PRAGMA wal_checkpoint(TRUNCATE)')
  made.close()

  const run = spawnSync(process.execPath, [executable, root], { timeout: 20_000, encoding: 'utf8' })
  expect(run.status, run.stderr).toBe(0)
  const outcome = JSON.parse(readFileSync(join(root, 'outcome.json'), 'utf8'))
  expect(outcome).toMatchObject({
    threw: true,
    message: expect.stringMatching(/out of memory/),
    wroteAfter: true
  })

  const db = new NetDatabase({ profileDir: root })
  try {
    const one = (sql: string) => Object.values(db.database.prepare(sql).get()!)[0]
    expect(one('PRAGMA auto_vacuum')).toBe(0)
    expect(one('SELECT count(*) FROM filler')).toBe(161)
    expect(one('PRAGMA integrity_check')).toBe('ok')
    // Tried again with room, it goes through.
    expect(db.rewriteToReclaim()).toMatchObject({ outcome: 'rewritten' })
    expect(one('SELECT count(*) FROM filler')).toBe(161)
  } finally {
    db.close()
  }
})
