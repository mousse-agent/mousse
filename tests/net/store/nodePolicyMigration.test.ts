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

/** The table as the last build with the on/off bots switch made it (schema 1). */
const SWITCH_TABLE =
  "CREATE TABLE net_node_policy(node TEXT PRIMARY KEY, blocked INTEGER NOT NULL CHECK(blocked IN (0,1)), max_permission_mode TEXT NOT NULL, terminal INTEGER NOT NULL CHECK(terminal IN (0,1)), editor INTEGER NOT NULL DEFAULT 0 CHECK(editor IN (0,1)), bots INTEGER NOT NULL DEFAULT 1 CHECK(bots IN (0,1)), agent_reach TEXT NOT NULL DEFAULT 'launched', work INTEGER NOT NULL DEFAULT 1 CHECK(work IN (0,1)), created_at INTEGER NOT NULL) STRICT"

interface SwitchRow {
  node: NodeId
  bots: 0 | 1
  blocked?: 0 | 1
  mode?: string
  terminal?: 0 | 1
  editor?: 0 | 1
  reach?: string
  work?: 0 | 1
}

function writeSwitchDatabase(profileDir: string, rows: SwitchRow[]): void {
  const directory = join(profileDir, 'net')
  mkdirSync(directory, { recursive: true })
  const old = new DatabaseSync(join(directory, 'net.db'))
  old.exec(SWITCH_TABLE)
  for (const row of rows)
    old
      .prepare('INSERT INTO net_node_policy VALUES(?,?,?,?,?,?,?,?,?)')
      .run(row.node, row.blocked ?? 0, row.mode ?? 'accept_edits', row.terminal ?? 0, row.editor ?? 0, row.bots, row.reach ?? 'launched', row.work ?? 1, 1_700_000_000_000)
  old.exec('PRAGMA user_version=1')
  old.close()
}

/** Full control's switches, as the last build with the bots switch stored them. */
const FULL_CONTROL = { mode: 'full', terminal: 1, editor: 1, reach: 'all', work: 1 } as const

describe('bot levels in net_node_policy (schema 2)', () => {
  it('turns the switch into a level: off stays off, on is Full only for a Full control device, Use for any other', () => {
    const dir = profile()
    const off = newId('node'),
      offFull = newId('node'),
      full = newId('node'),
      blockedFull = newId('node'),
      work = newId('node'),
      view = newId('node'),
      nearlyFull = newId('node')
    writeSwitchDatabase(dir, [
      { node: off, bots: 0 },
      { node: offFull, bots: 0, ...FULL_CONTROL },
      { node: full, bots: 1, ...FULL_CONTROL },
      // Blocked is not one of the preset's fields: unblocking gives back what it had.
      { node: blockedFull, bots: 1, blocked: 1, ...FULL_CONTROL },
      { node: work, bots: 1 },
      { node: view, bots: 1, work: 0, mode: 'ask', reach: 'none' },
      { node: nearlyFull, bots: 1, ...FULL_CONTROL, reach: 'launched' }
    ])
    const db = new NetDatabase({ profileDir: dir })
    cleanups.push(() => db.close())
    const policy = new SqliteNodePolicy(db, systemClock)
    expect(Object.fromEntries([off, offFull, full, blockedFull, work, view, nearlyFull].map((node) => [node, policy.get(node).bots]))).toEqual({
      [off]: 'off',
      [offFull]: 'off',
      [full]: 'full',
      [blockedFull]: 'full',
      [work]: 'use',
      [view]: 'use',
      [nearlyFull]: 'use'
    })
    // Every other field comes across as it was.
    expect(policy.get(full)).toMatchObject({ blocked: false, maxPermissionMode: 'full', terminal: true, editor: true, agentReach: 'all', work: true, createdAt: 1_700_000_000_000 })
    expect(policy.get(blockedFull).blocked).toBe(true)
    expect(policy.get(view)).toMatchObject({ work: false, maxPermissionMode: 'ask', agentReach: 'none' })
    // A device with no row starts at Use.
    expect(policy.get(newId('node')).bots).toBe('use')
    expect(columns(db).find((column) => column.name === 'bots')).toMatchObject({ notnull: 1, dflt_value: "'use'" })
    expect(userVersion(db)).toBe(2)
    expect(db.database.prepare('SELECT version FROM net_schema_migrations ORDER BY version').all().map((row) => row.version)).toEqual([1, 2])
  })

  it('runs once: a level set afterwards survives opening the database again', () => {
    const dir = profile()
    const node = newId('node')
    writeSwitchDatabase(dir, [{ node, bots: 1 }])
    for (let round = 0; round < 3; round++) {
      const db = new NetDatabase({ profileDir: dir })
      const policy = new SqliteNodePolicy(db, systemClock)
      expect(policy.get(node).bots).toBe(round === 0 ? 'use' : 'full')
      if (round === 0) policy.set(node, { bots: 'full' })
      db.close()
    }
  })

  it('takes a database from before the bots switch: every device had its bots, so each gets Use or Full', () => {
    const dir = profile()
    const plain = newId('node')
    writeOldDatabase(dir, [[plain, 0, 'full', 1]])
    const db = new NetDatabase({ profileDir: dir })
    cleanups.push(() => db.close())
    // Editor and agent reach take their defaults there, so it is not Full control.
    expect(new SqliteNodePolicy(db, systemClock).get(plain).bots).toBe('use')
    expect(userVersion(db)).toBe(2)
  })

  it('stores nothing but off, use or full, refuses any other level, and reads an unknown stored one as off', () => {
    const dir = profile()
    const node = newId('node')
    let db = new NetDatabase({ profileDir: dir })
    const seen: Array<[string, string]> = []
    const first = new SqliteNodePolicy(db, systemClock)
    first.onChange((event) => seen.push([event.before.bots, event.after.bots]))
    expect(first.set(node, { bots: 'off' })).toMatchObject({ bots: 'off', work: true, terminal: false })
    expect(seen).toEqual([['use', 'off']])
    db.close()
    db = new NetDatabase({ profileDir: dir })
    cleanups.push(() => db.close())
    const policy = new SqliteNodePolicy(db, systemClock)
    expect(policy.get(node).bots).toBe('off')
    for (const bad of [true, false, 1, 'on', 'manage'])
      expect(() => policy.set(node, { bots: bad as never }), String(bad)).toThrow()
    expect(() => db.database.prepare('UPDATE net_node_policy SET bots=1 WHERE node=?').run(node)).toThrow()
    expect(() => db.database.prepare("UPDATE net_node_policy SET bots='on' WHERE node=?").run(node)).toThrow()
    expect(policy.get(node).bots).toBe('off')
  })

  it('a database a newer build moved past schema 2 is refused, not misread', () => {
    const dir = profile()
    new NetDatabase({ profileDir: dir }).close()
    const raw = new DatabaseSync(join(dir, 'net', 'net.db'))
    raw.exec('PRAGMA user_version=3')
    raw.close()
    expect(() => new NetDatabase({ profileDir: dir })).toThrow(expect.objectContaining({ code: 'downgrade_unsupported' }))
  })
})

describe('agent reach in net_node_policy (issue #1160)', () => {
  it('adds the column with every device at "launched"', () => {
    const dir = profile()
    const node = newId('node')
    writeOldDatabase(dir, [[node, 0, 'full', 1]])
    const db = new NetDatabase({ profileDir: dir })
    cleanups.push(() => db.close())
    expect(columns(db).find((column) => column.name === 'agent_reach')).toMatchObject({ notnull: 1, dflt_value: "'launched'" })
    const policy = new SqliteNodePolicy(db, systemClock)
    expect(policy.get(node)).toMatchObject({ agentReach: 'launched', maxPermissionMode: 'full', terminal: true })
    expect(policy.get(newId('node')).agentReach).toBe('launched')
  })

  it('keeps what is set across a restart, refuses a value it does not know, and reads an unknown stored one as none', () => {
    const dir = profile()
    const node = newId('node')
    let db = new NetDatabase({ profileDir: dir })
    new SqliteNodePolicy(db, systemClock).set(node, { agentReach: 'all' })
    db.close()
    db = new NetDatabase({ profileDir: dir })
    cleanups.push(() => db.close())
    const policy = new SqliteNodePolicy(db, systemClock)
    expect(policy.get(node).agentReach).toBe('all')
    expect(() => policy.set(node, { agentReach: 'everything' as never })).toThrow()
    db.database.prepare("UPDATE net_node_policy SET agent_reach='later' WHERE node=?").run(node)
    expect(policy.get(node).agentReach).toBe('none')
  })
})

describe('"Work on threads from this device" in net_node_policy', () => {
  it('adds the column with every device on, an earlier build\'s write leaves it, and only a stored 1 is on', () => {
    const dir = profile()
    const node = newId('node')
    writeOldDatabase(dir, [[node, 0, 'full', 1]])
    let db = new NetDatabase({ profileDir: dir })
    expect(columns(db).find((column) => column.name === 'work')).toMatchObject({ notnull: 1, dflt_value: '1' })
    const first = new SqliteNodePolicy(db, systemClock)
    expect(first.get(node)).toMatchObject({ work: true, maxPermissionMode: 'full', terminal: true })
    expect(first.get(newId('node')).work).toBe(true)
    expect(first.set(node, { work: false })).toMatchObject({ work: false, terminal: true, maxPermissionMode: 'full' })
    db.close()
    db = new NetDatabase({ profileDir: dir })
    cleanups.push(() => db.close())
    const policy = new SqliteNodePolicy(db, systemClock)
    expect(policy.get(node).work).toBe(false)
    // An earlier build's write names only its own columns: the switch stays off.
    db.database
      .prepare(
        'INSERT INTO net_node_policy(node,blocked,max_permission_mode,terminal,editor,agent_reach,created_at) VALUES(?,?,?,?,?,?,?) ' +
          'ON CONFLICT(node) DO UPDATE SET blocked=excluded.blocked,max_permission_mode=excluded.max_permission_mode,terminal=excluded.terminal'
      )
      .run(node, 0, 'ask', 0, 0, 'launched', 5)
    expect(policy.get(node)).toMatchObject({ work: false, maxPermissionMode: 'ask' })
    expect(() => db.database.prepare('UPDATE net_node_policy SET work=2 WHERE node=?').run(node)).toThrow()
    expect(() => policy.set(node, { work: 'no' as never })).toThrow()
  })
})
