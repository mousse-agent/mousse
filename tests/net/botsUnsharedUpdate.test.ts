import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { NetService } from '../../src/mms/net/NetService'
import { EnginePeerStore } from '../../src/mms/netEngine/store'
import { newId, type NodeId } from '../../src/shared/net'

/**
 * "Share bots with other devices" is gone. A computer that had it off keeps every device it knows out of its bots on
 * update, through each device's own "Bots on this computer" switch, once; one that had it on (or never set it) changes
 * nothing. Real Net store, restarted between steps, as an update is.
 */
const cleanups: Array<() => Promise<void> | void> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

function service(path: string): NetService {
  const net = new NetService({ profileDir: path })
  cleanups.push(() => net.shutdown())
  return net
}

/**
 * A set-up computer that knows a device by each way one is recorded here: a per-device policy row (View and chat), a
 * connection record only, and an engine pairing only. Its stored configuration then gets `shareBots` as an earlier
 * build wrote it (or none).
 */
async function computer(shareBots: boolean | undefined) {
  const path = realpathSync(mkdtempSync(join(tmpdir(), 'bots-unshared-')))
  cleanups.push(() => rmSync(path, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 }))
  const net = service(path)
  await net.request('net.init', { name: 'Studio Mac', listen: true, port: 0 })
  const rt = net.runtime()
  const devices = { policy: newId('node') as NodeId, connection: newId('node') as NodeId, engine: newId('node') as NodeId }
  rt.policy.set(devices.policy, { work: false })
  rt.connections.set(devices.connection, 'connected', 'invite')
  new EnginePeerStore(rt.db).add({
    localId: devices.engine,
    endpoint: 'engine-endpoint',
    fingerprint: 'engine-fingerprint',
    grant: '',
    name: 'Laptop',
    state: 'paired',
    pairedAt: Date.now()
  } as Parameters<EnginePeerStore['add']>[0])
  const row = rt.db.database.prepare('SELECT value FROM net_service_config').get()!
  const config = JSON.parse(String(row.value)) as Record<string, unknown>
  if (shareBots !== undefined) config.shareBots = shareBots
  rt.db.database.prepare('UPDATE net_service_config SET value=?').run(JSON.stringify(config))
  await net.shutdown()
  return { path, devices: Object.values(devices) }
}

const stored = (net: NetService): Record<string, unknown> =>
  JSON.parse(String(net.runtime().db.database.prepare('SELECT value FROM net_service_config').get()!.value))

describe('updating from a build with "Share bots with other devices"', () => {
  it('off: every device it knows gets its Bots switch off, nothing else moves, and it happens once', async () => {
    const { path, devices } = await computer(false)
    const updated = service(path)
    for (const node of devices) expect(updated.runtime().policy.get(node).bots, node).toBe(false)
    // The device that was View and chat stays so; the other switches keep their defaults.
    expect(updated.runtime().policy.get(devices[0]!)).toMatchObject({ work: false, terminal: false, editor: false, blocked: false })
    expect(updated.runtime().policy.get(devices[1]!)).toMatchObject({ work: true })
    expect(stored(updated)).not.toHaveProperty('shareBots')
    expect(updated.status()).not.toHaveProperty('shareBots')

    // Once: the owner turns one device back on, and the next start leaves it on.
    updated.runtime().policy.set(devices[1]!, { bots: true })
    await updated.shutdown()
    const again = service(path)
    expect(again.runtime().policy.get(devices[1]!).bots).toBe(true)
    expect(again.runtime().policy.get(devices[0]!).bots).toBe(false)
  }, 60_000)

  for (const shareBots of [true, undefined])
    it(`${shareBots === undefined ? 'never set' : 'on'}: every device keeps its Bots switch`, async () => {
      const { path, devices } = await computer(shareBots)
      const updated = service(path)
      for (const node of devices) expect(updated.runtime().policy.get(node).bots, node).toBe(true)
      expect(updated.status()).not.toHaveProperty('shareBots')
    }, 60_000)
})
