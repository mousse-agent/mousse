import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { systemClock } from '../../../src/mms/net/clock'
import { NetDatabase } from '../../../src/mms/net/store/database'
import { SqliteNodePolicy } from '../../../src/mms/net/store/nodePolicy'
import { newId, type NodeId } from '../../../src/shared/net'

const cleanups: Array<() => void> = []
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup()
})

function profile(): string {
  const path = realpathSync(mkdtempSync(join(tmpdir(), 'net-policy-migration-')))
  cleanups.push(() => rmSync(path, { recursive: true, force: true }))
  return path
}

/** The table as builds before the editor switch made it, with one row per kind of device. */
const OLD_TABLE =
  'CREATE TABLE net_node_policy(node TEXT PRIMARY KEY, blocked INTEGER NOT NULL CHECK(blocked IN (0,1)), max_permission_mode TEXT NOT NULL, terminal INTEGER NOT NULL CHECK(terminal IN (0,1)), created_at INTEGER NOT NULL) STRICT'

function writeOldDatabase(profileDir: string, rows: Array<[NodeId, number, string, number]>): void {
  const directory = join(profileDir, 'net')
  mkdirSync(directory, { recursive: true })
  const old = new DatabaseSync(join(directory, 'net.db'))
  old.exec(OLD_TABLE)
  for (const [node, blocked, mode, terminal] of rows)
    old
      .prepare('INSERT INTO net_node_policy VALUES(?,?,?,?,?)')
      .run(node, blocked, mode, terminal, 1_700_000_000_000)
  old.exec('PRAGMA user_version=1')
  old.close()
}

const columns = (db: NetDatabase) =>
  db.database.prepare('PRAGMA table_info(net_node_policy)').all() as Array<{
    name: string
    notnull: number
    dflt_value: string | null
  }>
const userVersion = (db: NetDatabase) =>
  Number(db.database.prepare('PRAGMA user_version').get()!.user_version)

describe('the editor switch in net_node_policy', () => {
  it('adds the column to a database from before it, with every device off and what was stored kept', () => {
    const dir = profile()
    const blocked = newId('node'),
      plain = newId('node')
    writeOldDatabase(dir, [
      [blocked, 1, 'full', 1],
      [plain, 0, 'ask', 0]
    ])
    const db = new NetDatabase({ profileDir: dir })
    cleanups.push(() => db.close())
    const policy = new SqliteNodePolicy(db, systemClock)
    expect(columns(db).find((column) => column.name === 'editor')).toMatchObject({
      notnull: 1,
      dflt_value: '0'
    })
    expect(policy.get(blocked)).toMatchObject({
      blocked: true,
      maxPermissionMode: 'full',
      terminal: true,
      editor: false,
      createdAt: 1_700_000_000_000
    })
    expect(policy.get(plain)).toMatchObject({
      blocked: false,
      maxPermissionMode: 'ask',
      terminal: false,
      editor: false
    })
    expect(policy.isBlocked(blocked)).toBe(true)
    // Listed by creation time, then by id (both rows were made at the same moment).
    expect(policy.list().map((row) => [row.node, row.editor])).toEqual(
      [blocked, plain].sort().map((node) => [node, false])
    )
  })

  it('leaves the schema version where it was, so an older build can still open the database', () => {
    const dir = profile()
    writeOldDatabase(dir, [[newId('node'), 0, 'accept_edits', 0]])
    const db = new NetDatabase({ profileDir: dir })
    cleanups.push(() => db.close())
    expect(userVersion(db)).toBe(1)
  })

  it('can be turned on for one device, kept across a restart, and does not touch the other switches', () => {
    const dir = profile()
    const node = newId('node'),
      other = newId('node')
    writeOldDatabase(dir, [[node, 0, 'full', 1]])
    let db = new NetDatabase({ profileDir: dir })
    let policy = new SqliteNodePolicy(db, systemClock)
    const seen: Array<[boolean, boolean]> = []
    policy.onChange((event) => seen.push([event.before.editor, event.after.editor]))
    expect(policy.set(node, { editor: true })).toMatchObject({
      editor: true,
      terminal: true,
      maxPermissionMode: 'full',
      blocked: false
    })
    expect(policy.set(other, { editor: true })).toMatchObject({
      editor: true,
      terminal: false,
      maxPermissionMode: 'accept_edits'
    })
    expect(seen).toEqual([
      [false, true],
      [false, true]
    ])
    db.close()

    db = new NetDatabase({ profileDir: dir })
    cleanups.push(() => db.close())
    policy = new SqliteNodePolicy(db, systemClock)
    expect(policy.get(node).editor).toBe(true)
    expect(policy.set(node, { editor: false })).toMatchObject({ editor: false, terminal: true })
    expect(policy.get(other).editor).toBe(true)
    expect(() => policy.set(node, { editor: 'yes' as never })).toThrow()
    expect(policy.get(node).editor).toBe(false)
  })

  it('is applied once: opening the database again changes nothing', () => {
    const dir = profile()
    const node = newId('node')
    writeOldDatabase(dir, [[node, 0, 'accept_edits', 0]])
    for (let round = 0; round < 3; round++) {
      const db = new NetDatabase({ profileDir: dir })
      const policy = new SqliteNodePolicy(db, systemClock)
      expect(columns(db).filter((column) => column.name === 'editor')).toHaveLength(1)
      // Off after the migration, and whatever was set afterwards is not reset by opening the database again.
      expect(policy.get(node).editor).toBe(round > 0)
      if (round === 0) policy.set(node, { editor: true })
      db.close()
    }
  })

  it('starts a new database with the column, and stores nothing but 0 or 1', () => {
    const db = new NetDatabase({ profileDir: profile() })
    cleanups.push(() => db.close())
    expect(columns(db).filter((column) => column.name === 'editor')).toHaveLength(1)
    const node = newId('node')
    new SqliteNodePolicy(db, systemClock).set(node, { blocked: false })
    expect(() =>
      db.database.prepare('UPDATE net_node_policy SET editor=2 WHERE node=?').run(node)
    ).toThrow()
    expect(() =>
      db.database.prepare('UPDATE net_node_policy SET editor=NULL WHERE node=?').run(node)
    ).toThrow()
  })

  it('is still written by a build that does not know it: the column takes its default and is not overwritten', () => {
    const dir = profile()
    const node = newId('node'),
      fresh = newId('node')
    writeOldDatabase(dir, [[node, 0, 'accept_edits', 0]])
    const db = new NetDatabase({ profileDir: dir })
    cleanups.push(() => db.close())
    new SqliteNodePolicy(db, systemClock).set(node, { editor: true })
    // The statements an earlier build runs, word for word.
    db.database
      .prepare(
        'INSERT INTO net_node_policy(node,blocked,max_permission_mode,terminal,created_at) VALUES(?,?,?,?,?) ' +
          'ON CONFLICT(node) DO UPDATE SET blocked=excluded.blocked,max_permission_mode=excluded.max_permission_mode,terminal=excluded.terminal'
      )
      .run(node, 1, 'ask', 1, 5)
    db.database
      .prepare(
        'INSERT INTO net_node_policy(node,blocked,max_permission_mode,terminal,created_at) VALUES(?,?,?,?,?) ' +
          'ON CONFLICT(node) DO UPDATE SET blocked=excluded.blocked,max_permission_mode=excluded.max_permission_mode,terminal=excluded.terminal'
      )
      .run(fresh, 0, 'accept_edits', 0, 6)
    expect(
      db.database
        .prepare(
          'SELECT node,blocked,max_permission_mode,terminal,created_at FROM net_node_policy ORDER BY created_at,node'
        )
        .all()
    ).toHaveLength(2)
    const policy = new SqliteNodePolicy(db, systemClock)
    expect(policy.get(node)).toMatchObject({
      blocked: true,
      maxPermissionMode: 'ask',
      terminal: true,
      editor: true
    })
    expect(policy.get(fresh).editor).toBe(false)
  })
})
