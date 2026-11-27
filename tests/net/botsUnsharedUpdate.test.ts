import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { NetService } from '../../src/mms/net/NetService'
import { NetIdentityService } from '../../src/mms/net/identity/NetIdentityService'
import { EnginePeerStore } from '../../src/mms/netEngine/store'
import { newId, type NodeId } from '../../src/shared/net'
import { DatabaseSync } from 'node:sqlite'
import { accessPreset } from '../../src/shared/net/accessPresets'

/**
 * "Share bots with other devices" is gone. A computer that had it off keeps every device it knows out of its bots on
 * update, through each device's own "Bots on this computer" switch, once; one that had it on (or never set it) changes
 * nothing. Real Net stores, restarted between steps, as an update is.
 */
const cleanups: Array<() => Promise<void> | void> = []
afterEach(async () => {
  vi.restoreAllMocks()
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

function directory(): string {
  const path = realpathSync(mkdtempSync(join(tmpdir(), 'bots-unshared-')))
  cleanups.push(() => rmSync(path, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 }))
  return path
}
function service(path: string): NetService {
  const net = new NetService({ profileDir: path })
  cleanups.push(() => net.shutdown())
  return net
}

/**
 * A set-up computer that knows a device by each way one is recorded here: a per-device policy row (View and chat), a
 * connection record only, an engine pairing only, and its user's signed list only (a computer that joined it, whose
 * records here are then removed). Its stored configuration then gets `shareBots` as an earlier build wrote it (or none).
 */
async function computer(shareBots: boolean | undefined) {
  const path = directory()
  const net = service(path)
  await net.request('net.init', { name: 'Studio Mac', listen: true, port: 0 })
  await net.request('net.protect', { passphrase: 'bots-unshared-keeper' })
  const joiner = service(directory())
  const { invite } = (await net.request('bridge.invite', {})) as { invite: string }
  const { node: listed } = (await joiner.request('bridge.join', { invite, name: 'Laptop' })) as { node: NodeId }
  await joiner.shutdown()
  const rt = net.runtime()
  const devices = {
    policy: newId('node') as NodeId,
    connection: newId('node') as NodeId,
    engine: newId('node') as NodeId,
    listed
  }
  rt.db.database.prepare('DELETE FROM net_connections WHERE node=?').run(listed)
  rt.db.database.prepare('DELETE FROM net_node_policy WHERE node=?').run(listed)
  rt.policy.set(devices.policy, { work: false })
  rt.connections.set(devices.connection, 'connected', 'invite')
  new EnginePeerStore(rt.db).add({
    localId: devices.engine,
    endpoint: 'engine-endpoint',
    fingerprint: 'engine-fingerprint',
    grant: '',
    name: 'Desk PC',
    state: 'connected',
    pairedAt: Date.now()
  })
  const row = rt.db.database.prepare('SELECT value FROM net_service_config').get()!
  const config = JSON.parse(String(row.value)) as Record<string, unknown>
  if (shareBots !== undefined) config.shareBots = shareBots
  rt.db.database.prepare('UPDATE net_service_config SET value=?').run(JSON.stringify(config))
  await net.shutdown()
  return { path, devices }
}

const stored = (net: NetService): Record<string, unknown> =>
  JSON.parse(String(net.runtime().db.database.prepare('SELECT value FROM net_service_config').get()!.value))
const bots = (net: NetService, node: NodeId) => net.runtime().policy.get(node).bots

/**
 * The stored policy as the last build with the on/off bots switch keeps it (schema 1): Off is 0, any level 1. What a
 * profile looks like when that build stopped and this one is installed over it.
 */
function switchBuild(path: string): void {
  const raw = new DatabaseSync(join(path, 'net', 'net.db'))
  raw.exec(
    "ALTER TABLE net_node_policy RENAME TO levels; CREATE TABLE net_node_policy(node TEXT PRIMARY KEY, blocked INTEGER NOT NULL CHECK(blocked IN (0,1)), max_permission_mode TEXT NOT NULL, terminal INTEGER NOT NULL CHECK(terminal IN (0,1)), editor INTEGER NOT NULL DEFAULT 0 CHECK(editor IN (0,1)), bots INTEGER NOT NULL DEFAULT 1 CHECK(bots IN (0,1)), agent_reach TEXT NOT NULL DEFAULT 'launched', work INTEGER NOT NULL DEFAULT 1 CHECK(work IN (0,1)), created_at INTEGER NOT NULL) STRICT; " +
      "INSERT INTO net_node_policy SELECT node,blocked,max_permission_mode,terminal,editor,CASE bots WHEN 'off' THEN 0 ELSE 1 END,agent_reach,work,created_at FROM levels; DROP TABLE levels; " +
      'DELETE FROM net_schema_migrations WHERE version > 1; PRAGMA user_version=1'
  )
  raw.close()
}

describe('updating from a build with "Share bots with other devices"', () => {
  it('off: every device it knows, its list too, gets its Bots switch off, nothing else moves, and it happens once', async () => {
    const { path, devices } = await computer(false)
    const updated = service(path)
    for (const [way, node] of Object.entries(devices)) expect(bots(updated, node), way).toBe('off')
    // The device that was View and chat stays so; the other switches keep their defaults.
    expect(updated.runtime().policy.get(devices.policy)).toMatchObject({ work: false, terminal: false, editor: false, blocked: false })
    expect(updated.runtime().policy.get(devices.connection)).toMatchObject({ work: true })
    expect(stored(updated)).not.toHaveProperty('shareBots')
    expect(updated.status()).not.toHaveProperty('shareBots')

    // Once: the owner turns one device back on, and the next start leaves it on.
    updated.runtime().policy.set(devices.connection, { bots: 'use' })
    await updated.shutdown()
    const again = service(path)
    expect(bots(again, devices.connection)).toBe('use')
    expect(bots(again, devices.policy)).toBe('off')
  }, 60_000)

  it('off, with a list that cannot be read: the devices known otherwise now, the listed ones at a later start', async () => {
    const { path, devices } = await computer(false)
    const unreadable = vi.spyOn(NetIdentityService.prototype, 'pinnedRootKey').mockImplementation(() => {
      throw new Error('list unreadable')
    })
    const first = service(path)
    for (const way of ['policy', 'connection', 'engine'] as const) expect(bots(first, devices[way]), way).toBe('off')
    expect(unreadable).toHaveBeenCalled()
    expect(bots(first, devices.listed)).toBe('use')
    // The old switch stays stored for the next start, through any other save.
    ;(first as unknown as { saveConfig(): void }).saveConfig()
    expect(stored(first)).toMatchObject({ shareBots: false })
    // Meanwhile the owner turns one device back on: a later start does not take that back.
    first.runtime().policy.set(devices.connection, { bots: 'use' })
    await first.shutdown()

    // Still unreadable at the next start: nothing changes, and it waits on.
    const second = service(path)
    expect(bots(second, devices.listed)).toBe('use')
    expect(stored(second)).toMatchObject({ shareBots: false })
    await second.shutdown()

    unreadable.mockRestore()
    const readable = service(path)
    expect(bots(readable, devices.listed)).toBe('off')
    expect(bots(readable, devices.connection)).toBe('use')
    expect(bots(readable, devices.policy)).toBe('off')
    expect(stored(readable)).not.toHaveProperty('shareBots')
    await readable.shutdown()
    // And then never again.
    const later = service(path)
    later.runtime().policy.set(devices.listed, { bots: 'use' })
    await later.shutdown()
    expect(bots(service(path), devices.listed)).toBe('use')
  }, 90_000)

  it('off, and stopped by a build with the bots switch before the list could be read: the update to levels keeps it, and finishes it', async () => {
    const { path, devices } = await computer(false)
    const unreadable = vi.spyOn(NetIdentityService.prototype, 'pinnedRootKey').mockImplementation(() => {
      throw new Error('list unreadable')
    })
    const first = service(path)
    first.runtime().policy.set(devices.connection, { bots: 'use' })
    // A Full control device the owner kept on: the update makes it Full, not Use.
    first.runtime().policy.set(devices.engine, { ...accessPreset('full').fields, bots: 'use' })
    await first.shutdown()
    unreadable.mockRestore()
    switchBuild(path)

    const updated = service(path)
    expect(Object.fromEntries(Object.entries(devices).map(([way, node]) => [way, bots(updated, node)]))).toEqual({
      policy: 'off',
      connection: 'use',
      engine: 'full',
      // Listed, with no row: the marker the earlier build left still switches it off, once the list reads.
      listed: 'off'
    })
    expect(stored(updated)).not.toHaveProperty('shareBots')
    expect(Number(updated.runtime().db.database.prepare('PRAGMA user_version').get()!.user_version)).toBe(2)
  }, 90_000)

  for (const shareBots of [true, undefined])
    it(`${shareBots === undefined ? 'never set' : 'on'}: every device keeps its Bots switch`, async () => {
      const { path, devices } = await computer(shareBots)
      const updated = service(path)
      for (const [way, node] of Object.entries(devices)) expect(bots(updated, node), way).toBe('use')
      expect(updated.status()).not.toHaveProperty('shareBots')
    }, 60_000)
})
