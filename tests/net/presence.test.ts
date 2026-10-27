import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { NetService } from '../../src/mms/net/NetService'
import { SyncSupervisor } from '../../src/mms/net/sync/supervisor'
import { parsePeerInfo } from '../../src/mms/net/presence'
import { NetError } from '../../src/shared/net'
import { FakeClock } from './harness/FakeClock'

const cleanups: Array<() => Promise<void> | void> = []
let savedVersion: string | undefined
beforeEach(() => {
  savedVersion = process.env.MOUSSE_VERSION
  process.env.MOUSSE_VERSION = '0.1.3'
})
afterEach(async () => {
  if (savedVersion === undefined) delete process.env.MOUSSE_VERSION
  else process.env.MOUSSE_VERSION = savedVersion
  vi.restoreAllMocks()
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

interface Row {
  node: string
  self: boolean
  state: string
  version?: string
  platform?: string
  route?: { transport?: string; address?: string; direction: string }
  routes: Array<{ route: { transport: string }; state: string; lastError?: string }>
  error?: string
  lastSeenAt?: number
  olderThanThis: boolean
}

function service(path = mkdtempSync(join(tmpdir(), 'net-presence-'))): { net: NetService; path: string } {
  const net = new NetService({ profileDir: path })
  cleanups.push(
    () => rmSync(path, { recursive: true, force: true }),
    () => net.shutdown()
  )
  return { net, path }
}
const nodes = async (net: NetService): Promise<Row[]> =>
  ((await net.request('bridge.nodes', {})) as { nodes: Row[] }).nodes
const rowFor = async (net: NetService, node: string): Promise<Row> =>
  (await nodes(net)).find((row) => row.node === node)!

/** An authority listening on loopback and a follower enrolled through it. */
async function pair(patchAuthority?: (rpc: { registry: Map<string, { handle: unknown }> }) => void) {
  const a = service(),
    b = service()
  await a.net.request('net.init', { name: 'authority', listen: true, port: 0 })
  await a.net.request('net.protect', { passphrase: 'test-authority-protection' })
  // The rpc dispatcher is shared by every session, so a change here is what a peer sees.
  patchAuthority?.(a.net.runtime().rpc as unknown as { registry: Map<string, { handle: unknown }> })
  const invite = (await a.net.request('bridge.invite', {})) as { invite: string }
  const joined = (await b.net.request('bridge.join', { invite: invite.invite, name: 'follower' })) as {
    node: string
    authority: string
  }
  await vi.waitFor(() => expect(a.net.status().peers).toContainEqual({ node: joined.node, state: 'open' }))
  return { a, b, follower: joined.node, authority: joined.authority }
}

it('reports each device its peer version, platform and how it is connected', async () => {
  const { a, b, follower, authority } = await pair()
  await vi.waitFor(async () => {
    expect((await rowFor(a.net, follower)).version).toBe('0.1.3')
    expect((await rowFor(b.net, authority)).version).toBe('0.1.3')
  })
  const seenByAuthority = await rowFor(a.net, follower)
  expect(seenByAuthority).toMatchObject({
    state: 'open',
    platform: process.platform,
    olderThanThis: false,
    route: { transport: 'direct', direction: 'in' }
  })
  expect(typeof seenByAuthority.lastSeenAt).toBe('number')
  const seenByFollower = await rowFor(b.net, authority)
  expect(seenByFollower).toMatchObject({
    state: 'open',
    olderThanThis: false,
    route: { transport: 'direct', direction: 'out', address: a.net.status().routes[0].address }
  })
  expect(seenByFollower.routes).toEqual([
    expect.objectContaining({ route: expect.objectContaining({ transport: 'direct' }), state: 'ok' })
  ])
  // This device's own row carries its own version and never calls itself old.
  expect(await rowFor(a.net, a.net.status().self!.node)).toMatchObject({
    self: true,
    version: '0.1.3',
    olderThanThis: false
  })
}, 30000)

it('reads a peer whose daemon has no net.info as older, with the other fields absent', async () => {
  const { a, b, follower, authority } = await pair((rpc) => rpc.registry.delete('net.info'))
  // The follower still asks the authority, and that answer is what marks the authority as old.
  await vi.waitFor(async () => expect((await rowFor(b.net, authority)).olderThanThis).toBe(true))
  const old = await rowFor(b.net, authority)
  expect(old.state).toBe('open')
  expect(old.version).toBeUndefined()
  expect(old.platform).toBeUndefined()
  expect(old.route).toMatchObject({ transport: 'direct', direction: 'out' })
  // The follower is current, and the old authority can still read it.
  await vi.waitFor(async () => expect((await rowFor(a.net, follower)).version).toBe('0.1.3'))
  expect((await rowFor(a.net, follower)).olderThanThis).toBe(false)
}, 30000)

it('compares the version a peer reports with this device', async () => {
  const report = (version: string) => (rpc: { registry: Map<string, { handle: unknown }> }) => {
    rpc.registry.get('net.info')!.handle = async () => ({
      v: 1,
      version,
      platform: 'linux',
      arch: 'x64',
      protoMinor: 0
    })
  }
  const older = await pair(report('0.1.1'))
  await vi.waitFor(async () => expect((await rowFor(older.b.net, older.authority)).version).toBe('0.1.1'))
  expect(await rowFor(older.b.net, older.authority)).toMatchObject({ platform: 'linux', olderThanThis: true })

  const nightly = await pair(report('0.1.3-nightly.20261022.17'))
  await vi.waitFor(async () =>
    expect((await rowFor(nightly.b.net, nightly.authority)).version).toBe('0.1.3-nightly.20261022.17')
  )
  expect((await rowFor(nightly.b.net, nightly.authority)).olderThanThis).toBe(true)

  const newer = await pair(report('0.2.0'))
  await vi.waitFor(async () => expect((await rowFor(newer.b.net, newer.authority)).version).toBe('0.2.0'))
  expect((await rowFor(newer.b.net, newer.authority)).olderThanThis).toBe(false)
}, 60000)

it('never calls a peer old from a development build', async () => {
  process.env.MOUSSE_VERSION = '0.0.0'
  const { b, authority } = await pair((rpc) => {
    rpc.registry.delete('net.info')
  })
  await vi.waitFor(async () => expect((await rowFor(b.net, authority)).state).toBe('open'))
  expect((await rowFor(b.net, authority)).olderThanThis).toBe(false)
}, 30000)

it('keeps the version and last seen time of a device after both services restart', async () => {
  const started = Date.now()
  const { a, b, authority } = await pair()
  await vi.waitFor(async () => expect((await rowFor(b.net, authority)).version).toBe('0.1.3'))
  await a.net.shutdown()
  await b.net.shutdown()
  // Only the follower comes back, so the authority is offline.
  const resumed = service(b.path)
  await resumed.net.start()
  const row = await rowFor(resumed.net, authority)
  expect(row.state).not.toBe('open')
  expect(row.version).toBe('0.1.3')
  expect(row.route).toBeUndefined()
  expect(row.lastSeenAt).toBeGreaterThanOrEqual(started)
  expect(row.lastSeenAt).toBeLessThanOrEqual(Date.now())
  expect(row.olderThanThis).toBe(false)
}, 30000)

it('reports every route tried for a device, with the one in use and the one that fails', async () => {
  const { b, authority } = await pair()
  await vi.waitFor(async () => expect((await rowFor(b.net, authority)).state).toBe('open'))
  const routes = (b.net as unknown as { routes: { health(node: string): unknown[] } }).routes
  vi.spyOn(routes, 'health').mockReturnValue([
    { route: { transport: 'direct', address: 'ws://127.0.0.1:1/mousse-net', priority: 0 }, state: 'ok' },
    {
      route: { transport: 'tailscale', address: 'ws://100.64.0.9:1/mousse-net', priority: 10 },
      state: 'failing',
      lastError: 'route_unreachable'
    }
  ])
  const row = await rowFor(b.net, authority)
  expect(row.routes).toHaveLength(2)
  expect(row.routes[1]).toMatchObject({ route: { transport: 'tailscale' }, state: 'failing', lastError: 'route_unreachable' })
}, 30000)

it('surfaces a refused session as the device error until it connects', async () => {
  const { a, b, authority } = await pair()
  await vi.waitFor(async () => expect((await rowFor(b.net, authority)).state).toBe('open'))
  expect((await rowFor(b.net, authority)).error).toBeUndefined()
  await a.net.shutdown()
  await vi.waitFor(async () => expect((await rowFor(b.net, authority)).state).not.toBe('open'))
  const supervisor = (b.net as unknown as { supervisors: Map<string, SyncSupervisor> }).supervisors.get(authority)!
  vi.spyOn(supervisor, 'lastError').mockReturnValue('incompatible_peer')
  expect((await rowFor(b.net, authority)).error).toBe('incompatible_peer')
}, 30000)

it('a supervisor remembers why its last attempt failed and forgets it once connected', async () => {
  const identity = { onRosterChanged: () => () => {}, renewExpiring: () => {} }
  const clock = new FakeClock()
  const refused = new SyncSupervisor({
    identity: identity as never,
    clock,
    connect: async () => {
      throw new NetError('incompatible_peer')
    }
  })
  await refused.opened.catch(() => {})
  expect(refused.lastError()).toBe('incompatible_peer')
  refused.close()

  let attempts = 0
  const flaky = new SyncSupervisor({
    identity: identity as never,
    clock,
    connect: async () => {
      attempts++
      if (attempts === 1) throw new NetError('route_unreachable')
      const handlers = new Set<(error?: Error) => void>()
      return {
        state: () => 'open',
        peer: { node: 'nod_x', user: 'usr_x' },
        clockOffsetMs: () => 0,
        onClosed: (listener: (error?: Error) => void) => {
          handlers.add(listener)
          return () => handlers.delete(listener)
        },
        onEphemeral: () => () => {},
        close: () => {}
      } as never
    }
  })
  await vi.waitFor(() => expect(flaky.lastError()).toBe('route_unreachable'))
  clock.advance(60_000)
  await flaky.opened
  expect(flaky.lastError()).toBeUndefined()
  flaky.close()
})

it('reads what a peer reports and ignores anything malformed', () => {
  expect(parsePeerInfo({ v: 1, version: '0.1.3', platform: 'linux', arch: 'x64', protoMinor: 0 })).toEqual({
    v: 1,
    version: '0.1.3',
    platform: 'linux',
    arch: 'x64',
    protoMinor: 0
  })
  expect(parsePeerInfo({ version: '0.1.3' })).toMatchObject({ version: '0.1.3', platform: '', arch: '' })
  expect(parsePeerInfo(null)).toBeUndefined()
  expect(parsePeerInfo([])).toBeUndefined()
  expect(parsePeerInfo({ version: 7 })).toBeUndefined()
  expect(parsePeerInfo({ version: 'x'.repeat(200) })).toBeUndefined()
  expect(parsePeerInfo({ version: '0.1.3 <script>' })).toBeUndefined()
})
