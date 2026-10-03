import { readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { SqliteNetStore } from '../../../src/mms/net/store'
import { FileKeyStore, NetIdentityService } from '../../../src/mms/net/identity'
import { NetError, newId } from '../../../src/shared/net'
import { profile, fixture } from './helpers'

const roots: string[] = []; const stores: SqliteNetStore[] = []
const fresh = (): string => { const path = profile(); roots.push(path); return path }
const open = (path: string, options: Partial<ConstructorParameters<typeof SqliteNetStore>[0]> = {}): SqliteNetStore => { const store = new SqliteNetStore({ profileDir: path, ...options }); stores.push(store); return store }
afterEach(() => { for (const store of stores.splice(0)) store.close(); for (const root of roots.splice(0)) rmSync(root, { force: true, recursive: true }) })

describe('storage failure and migration boundaries', () => {
  it.each([false, true])('physically prevents shared identity writes after corruption (coordinated=%s)', async (coordinated) => {
    const path = fresh(); const f = fixture(); let armed = false
    const store = open(path, { fault(point) { if (armed && point === 'streams.apply.beforeCursorCommit') throw new NetError('storage_corrupt') } })
    const keys = new FileKeyStore(path); await keys.initialize({ asAuthority: true })
    const identity = new NetIdentityService({ database: store.database, keys, clock: f.clock, ...(coordinated ? { coordinator: store } : {}) })
    await identity.bootstrapAuthority('Authority')
    const before = store.database.prepare('SELECT value FROM net_identity_state').get()!.value
    const preparedBeforeFence = store.database.prepare('UPDATE net_identity_state SET value=value')
    store.streams.createStream(f.descriptor, 1); armed = true
    expect(() => store.streams.applyFromAuthority(f.descriptor.id, [f.record(1)])).toThrowError(expect.objectContaining({ code: 'storage_corrupt' }))
    expect(() => identity.issueNodeDelegation({ node: newId('node'), keys: keys.nodeKeys(), name: 'Must not commit', caps: ['read'] })).toThrowError(expect.objectContaining({ code: coordinated ? 'storage_corrupt' : 'internal' }))
    expect(store.database.prepare('SELECT value FROM net_identity_state').get()!.value).toBe(before)
    expect(store.database.prepare('PRAGMA query_only').get()!.query_only).toBe(1)
    expect(() => preparedBeforeFence.run()).toThrowError(expect.objectContaining({ errcode: 8 }))
    expect(() => store.database.exec('BEGIN IMMEDIATE')).toThrowError(expect.objectContaining({ errcode: 8 }))
    expect(store.database.isTransaction).toBe(false)
    store.database.exec('BEGIN')
    try { expect(() => store.database.prepare('UPDATE net_identity_state SET value=value').run()).toThrowError(expect.objectContaining({ errcode: 8 })) } finally { store.database.exec('ROLLBACK') }
    store.close()
    expect(() => open(path)).toThrowError(expect.objectContaining({ code: 'storage_corrupt' }))
  })
  it('fences all writes after runtime corruption and persists the fence through reopen', () => {
    const path = fresh(); const f = fixture(); let armed = false
    const store = open(path, { fault(point) { if (armed && point === 'streams.apply.beforeCursorCommit') throw new NetError('storage_corrupt') } })
    store.streams.createStream(f.descriptor, 1); armed = true
    expect(() => store.streams.applyFromAuthority(f.descriptor.id, [f.record(1)])).toThrowError(expect.objectContaining({ code: 'storage_corrupt' }))
    expect(store.streams.cursor(f.descriptor.id).seq).toBe(0)
    expect(() => store.executions.admit(f.key(), 'a'.repeat(64), 1)).toThrowError(expect.objectContaining({ code: 'storage_corrupt' }))
    expect(store.database.prepare('SELECT count(*) AS n FROM net_executions').get()!.n).toBe(0)
    store.close()
    expect(() => open(path)).toThrowError(expect.objectContaining({ code: 'storage_corrupt' }))
    expect(readdirSync(join(path, 'net'))).toContain('storage-corrupt-fence')
  })
  it('rolls back on storage_full and keeps the profile read-only until reopen', () => {
    const path = fresh(); const f = fixture(); let armed = false
    const store = open(path, { fault(point) { if (armed && point === 'streams.apply.beforeCursorCommit') throw new NetError('storage_full') } })
    store.streams.createStream(f.descriptor, 1); armed = true
    expect(() => store.streams.applyFromAuthority(f.descriptor.id, [f.record(1)])).toThrowError(expect.objectContaining({ code: 'storage_full' }))
    expect(store.streams.cursor(f.descriptor.id).seq).toBe(0)
    expect(() => store.executions.admit(f.key(), 'a'.repeat(64), 1)).toThrowError(expect.objectContaining({ code: 'storage_full' }))
    store.close()
    const restarted = open(path); expect(restarted.streams.cursor(f.descriptor.id).seq).toBe(0)
    restarted.streams.applyFromAuthority(f.descriptor.id, [f.record(1)])
    expect(restarted.streams.cursor(f.descriptor.id).seq).toBe(1)
  })
  it('refuses a future schema without replacing its data', () => {
    const path = fresh(); const store = open(path); store.close()
    const database = new DatabaseSync(join(path, 'net', 'net.db')); database.exec('PRAGMA user_version=2'); database.close()
    expect(() => open(path)).toThrowError(expect.objectContaining({ code: 'downgrade_unsupported' }))
    const intact = new DatabaseSync(join(path, 'net', 'net.db')); expect(intact.prepare('PRAGMA user_version').get()!.user_version).toBe(2); intact.close()
  })
  it('rolls back an interrupted schema migration and can initialize it on retry', () => {
    const path = fresh()
    expect(() => open(path, { fault(point) { if (point === 'database.migration.beforeCommit') throw new Error('migration interruption') } })).toThrow('migration interruption')
    const database = new DatabaseSync(join(path, 'net', 'net.db'))
    expect(database.prepare('PRAGMA user_version').get()!.user_version).toBe(0)
    expect(database.prepare("SELECT name FROM sqlite_master WHERE name='net_executions'").get()).toBeUndefined(); database.close()
    const store = open(path); expect(store.database.prepare('SELECT version FROM net_schema_migrations').get()!.version).toBe(1)
  })
  it('quarantines an actually corrupt database and surfaces ledger recovery', () => {
    const path = fresh(); const store = open(path); store.close()
    writeFileSync(join(path, 'net', 'net.db'), Buffer.alloc(4096, 13))
    expect(() => open(path)).toThrowError(expect.objectContaining({ code: 'storage_corrupt' }))
    expect(readdirSync(join(path, 'net')).some((name) => name.startsWith('net.db.quarantine-'))).toBe(true)
    expect(() => open(path)).toThrowError(expect.objectContaining({ code: 'storage_corrupt' }))
  })
  it('rejects profile-owned storage roots redirected through a symlink', () => {
    const path = fresh(); const foreign = fresh(); symlinkSync(foreign, join(path, 'net'))
    expect(() => open(path)).toThrowError(expect.objectContaining({ code: 'forbidden' }))
  })
})
