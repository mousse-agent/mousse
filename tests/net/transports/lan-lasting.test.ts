import { mkdtempSync, rmSync } from 'node:fs'
import { createServer, type Server } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { NetService } from '../../../src/mms/net/NetService'
import { newId, type NodeId, type Route } from '../../../src/shared/net'
import type { LanPeer } from '../../../src/mms/net/transports/lan'

// Real multicast, TCP/WebSocket, pinned TLS and sessions on loopback, no relay. Beacons are switched off by giving
// discovery no interface to send or listen on, as on a network that blocks multicast.
const beacons = vi.hoisted(() => ({ on: true }))
vi.mock('node:os', async (original) => ({
  ...(await original<typeof import('node:os')>()),
  networkInterfaces: () =>
    beacons.on ? { test: [{ family: 'IPv4', internal: false, address: '127.0.0.1' }] } : {}
}))

const cleanups: Array<() => void | Promise<void>> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
  beacons.on = true
})

type Lan = {
  transport?: {
    lanRoutes(node: NodeId): Route[]
    lanPort(): number | undefined
    options: { lanPeers(): LanPeer[] }
  }
}
const lan = (net: NetService) => (net as unknown as Lan).transport!
const PASSPHRASE = 'lan-lasting-protection'
const address = (port: number) => `ws://127.0.0.1:${port}/mousse-net`

function directory(): string {
  const path = mkdtempSync(join(tmpdir(), 'mousse-lan-lasting-'))
  cleanups.push(() =>
    rmSync(path, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 })
  )
  return path
}
function service(path: string): NetService {
  const net = new NetService({ profileDir: path })
  cleanups.push(() => net.shutdown())
  return net
}
/** What a profile keeps on disk, read or changed while its service is shut down. */
function store(path: string) {
  const open = () => new DatabaseSync(join(path, 'net', 'net.db'))
  return {
    port(): number | undefined {
      const db = open()
      try {
        const row = db.prepare('SELECT port FROM net_lan_port').get()
        return row ? Number(row.port) : undefined
      } finally {
        db.close()
      }
    },
    lastAddress(node: NodeId): string | undefined {
      const db = open()
      try {
        const row = db.prepare('SELECT address FROM net_lan_last_address WHERE node=?').get(node)
        return row ? String(row.address) : undefined
      } finally {
        db.close()
      }
    },
    /** The address changed while away: what is remembered no longer answers. */
    setLastAddress(node: NodeId, value: string | undefined): void {
      const db = open()
      try {
        if (value === undefined)
          db.prepare('DELETE FROM net_lan_last_address WHERE node=?').run(node)
        else db.prepare('UPDATE net_lan_last_address SET address=? WHERE node=?').run(value, node)
      } finally {
        db.close()
      }
    }
  }
}
const open = (on: NetService, node: NodeId) => {
  try {
    return on.session(node).state() === 'open'
  } catch {
    return false
  }
}
/** A normal call over the session: the other computer answers `net.info`. */
const call = (on: NetService, node: NodeId) =>
  on.session(node).rpc('net.info', {}, { id: newId('rpc'), deadlineMs: 10_000 })

/**
 * Two paired computers whose only route is the LAN: the configured listener is off and there is no relay. Both
 * restarted once with beacons on, so each opened a session over the LAN and remembered the other.
 */
async function pairedOverLan() {
  const aPath = directory(),
    bPath = directory()
  const a = service(aPath),
    b = service(bPath)
  await a.request('net.init', { listen: true, port: 0 })
  await a.request('net.protect', { passphrase: PASSPHRASE })
  const invite = (await a.request('bridge.invite', {})) as { invite: string }
  const paired = (await b.request('bridge.join', { invite: invite.invite })) as {
    authority: NodeId
    node: NodeId
  }
  await a.request('net.transport.configure', {
    id: 'direct',
    enabled: false,
    settings: { port: 0 }
  })
  await a.shutdown()
  await b.shutdown()
  const computers = { aPath, bPath, aNode: paired.authority, bNode: paired.node }
  const pair = await restart(computers)
  const ports = { a: lan(pair.a).lanPort()!, b: lan(pair.b).lanPort()! }
  await vi.waitFor(() => {
    expect(store(aPath).lastAddress(paired.node)).toBe(address(ports.b))
    expect(store(bPath).lastAddress(paired.authority)).toBe(address(ports.a))
  })
  await pair.a.shutdown()
  await pair.b.shutdown()
  expect(store(aPath).port()).toBe(ports.a)
  expect(store(bPath).port()).toBe(ports.b)
  return { ...computers, ports }
}
/** Both computers start again; resolves once a session is open on each side and a call goes through both ways. */
async function restart(computers: { aPath: string; bPath: string; aNode: NodeId; bNode: NodeId }) {
  const a = service(computers.aPath),
    b = service(computers.bPath)
  await a.start()
  await b.start()
  await a.request('net.unlock', { passphrase: PASSPHRASE })
  expect(a.status().routes).toEqual([])
  expect(b.status().routes).toEqual([])
  await vi.waitFor(
    () => {
      expect(open(a, computers.bNode)).toBe(true)
      expect(open(b, computers.aNode)).toBe(true)
    },
    { timeout: 25_000, interval: 100 }
  )
  await expect(call(b, computers.aNode)).resolves.toMatchObject({ version: expect.any(String) })
  await expect(call(a, computers.bNode)).resolves.toMatchObject({ version: expect.any(String) })
  return { a, b }
}

describe('a lasting route on the local network', () => {
  // Inputs: which side dials (the one that dialled before, or the one that only accepted), beacons on/off, the kept
  // port free or taken, the remembered address live or stale.
  it('carries a call after both restart with beacons off, whichever side has to dial', async () => {
    const pair = await pairedOverLan()
    beacons.on = false

    // B dials A at its last address; A's kept port still answers. A remembered nothing, so it only accepts.
    store(pair.aPath).setLastAddress(pair.bNode, undefined)
    let running = await restart(pair)
    expect(lan(running.a).lanPort()).toBe(pair.ports.a)
    await running.a.shutdown()
    await running.b.shutdown()
    // A only accepted: it holds B's address from B's source address and the port B told it.
    expect(store(pair.aPath).lastAddress(pair.bNode)).toBe(address(pair.ports.b))

    // Now B remembers nothing: A dials B from that told port alone.
    store(pair.bPath).setLastAddress(pair.aNode, undefined)
    running = await restart(pair)
    expect(lan(running.b).lanPort()).toBe(pair.ports.b)
  }, 90_000)

  it('reconnects by beacon when the remembered addresses no longer answer', async () => {
    const pair = await pairedOverLan()
    const gone = await closedPort()
    store(pair.aPath).setLastAddress(pair.bNode, address(gone))
    store(pair.bPath).setLastAddress(pair.aNode, address(gone))
    const running = await restart(pair)
    // The new address is remembered once a session opens over it.
    await running.a.shutdown()
    await running.b.shutdown()
    expect(store(pair.aPath).lastAddress(pair.bNode)).toBe(address(pair.ports.b))
    expect(store(pair.bPath).lastAddress(pair.aNode)).toBe(address(pair.ports.a))
  }, 90_000)

  it('chooses and keeps a new port when the kept one is taken, and peers find it by beacon', async () => {
    const pair = await pairedOverLan()
    // Something else took B's port while it was off; it drops whatever connects.
    const squatter = createServer((socket) => socket.destroy())
    await listen(squatter, pair.ports.b)
    cleanups.push(() => new Promise<void>((resolve) => squatter.close(() => resolve())))
    const running = await restart(pair)
    const moved = lan(running.b).lanPort()!
    expect(moved).not.toBe(pair.ports.b)
    await running.a.shutdown()
    await running.b.shutdown()
    expect(store(pair.bPath).port()).toBe(moved)
    expect(store(pair.aPath).lastAddress(pair.bNode)).toBe(address(moved))
  }, 90_000)
})

describe('LAN beacons follow the connected-here record', () => {
  it('leave out a member not connected here, and include it once connected', async () => {
    const keeper = service(directory())
    await keeper.request('net.init', { listen: true, port: 0 })
    await keeper.request('net.protect', { passphrase: PASSPHRASE })
    const join = async () => {
      const net = service(directory())
      const link = (await keeper.request('bridge.invite', {})) as { invite: string }
      const joined = (await net.request('bridge.join', { invite: link.invite })) as { node: NodeId }
      return { net, node: joined.node }
    }
    const b = await join(),
      c = await join()
    const keeperNode = keeper.runtime().identity.self()!.node
    const peers = (on: NetService) =>
      lan(on)
        .options.lanPeers()
        .map((peer) => peer.node)
    await vi.waitFor(() => {
      // Both members list each other and the keeper, which each always admits.
      expect(b.net.runtime().identity.roster()).toEqual(c.net.runtime().identity.roster())
      expect(peers(b.net)).toContain(keeperNode)
      expect(peers(c.net)).toContain(keeperNode)
    })
    expect(peers(b.net)).not.toContain(c.node)
    expect(peers(c.net)).not.toContain(b.node)

    // B connects C: B now beacons to C and accepts C's beacons; C, which has not connected B, still does neither.
    await b.net.request('bridge.connect', { node: c.node })
    expect(peers(b.net)).toContain(c.node)
    expect(peers(c.net)).not.toContain(b.node)

    // Once C connects B too, each finds the other on the LAN.
    await c.net.request('bridge.connect', { node: b.node })
    await vi.waitFor(
      () => {
        expect(lan(b.net).lanRoutes(c.node)).not.toEqual([])
        expect(lan(c.net).lanRoutes(b.node)).not.toEqual([])
      },
      { timeout: 20_000, interval: 100 }
    )
  }, 60_000)
})

function listen(server: Server, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, '0.0.0.0', () => resolve())
  })
}
async function closedPort(): Promise<number> {
  const server = createServer()
  await listen(server, 0)
  const port = (server.address() as { port: number }).port
  await new Promise<void>((resolve) => server.close(() => resolve()))
  return port
}
