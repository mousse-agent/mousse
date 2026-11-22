import { mkdtempSync, rmSync } from 'node:fs'
import { createSocket } from 'node:dgram'
import { connect, createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, expect, it, vi } from 'vitest'
import { NetService } from '../../../src/mms/net/NetService'
import type { NodeId } from '../../../src/shared/net'

// The phone app's own network code (mousse-client), run in Node against a real computer profile:
// its LAN discovery, WebSocket and TLS 1.3 client and session, over loopback TCP and multicast.
// Only the native socket plugin is replaced, by Node sockets. Set MOUSSE_CLIENT_ROOT to a
// mousse-client checkout with its dependencies installed.
const CLIENT = process.env.MOUSSE_CLIENT_ROOT

// Keep real multicast/TCP/TLS while avoiding the host WiFi firewall and unrelated LAN peers.
vi.mock('node:os', async (original) => ({
  ...(await original<typeof import('node:os')>()),
  networkInterfaces: () => ({ test: [{ family: 'IPv4', internal: false, address: '127.0.0.1' }] })
}))

const cleanups: Array<() => void | Promise<void>> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

/* eslint-disable @typescript-eslint/no-explicit-any -- the phone's modules load from another checkout */
const phone = async (path: string): Promise<any> =>
  import(/* @vite-ignore */ pathToFileURL(resolve(CLIENT!, path)).href)

/** The phone's native LAN plugin, played by Node: TCP sockets and the multicast receiver. */
function nodeLan(StreamEndpoint: any) {
  const dials: string[] = []
  return {
    dials,
    native: {
      dial: (host: string, port: number, timeoutMs: number) =>
        new Promise((done, fail) => {
          dials.push(`${host}:${port}`)
          const socket = connect({ host, port, timeout: timeoutMs })
          const stream = new StreamEndpoint(
            (bytes: Uint8Array) => socket.write(bytes),
            () => socket.destroy()
          )
          socket.once('connect', () => {
            socket.setTimeout(0)
            done(stream)
          })
          socket.once('timeout', () => socket.destroy(new Error('timeout')))
          socket.on('data', (bytes) => stream.deliver(new Uint8Array(bytes)))
          socket.once('error', (error) => fail(error))
          socket.once('close', () => stream.end())
          cleanups.push(() => void socket.destroy())
        }),
      advertisements: (() => {
        let socket: ReturnType<typeof createSocket> | undefined
        return {
          async start(onPacket: (packet: Uint8Array, source: string) => void) {
            socket?.close()
            const next = createSocket({ type: 'udp4', reuseAddr: true })
            socket = next
            next.on('message', (bytes, from) => onPacket(new Uint8Array(bytes), from.address))
            await new Promise<void>((done) => next.bind(47777, '0.0.0.0', done))
            next.addMembership('239.255.77.77', '127.0.0.1')
            cleanups.push(() => {
              try {
                next.close()
              } catch {
                /* closed */
              }
            })
          },
          async stop() {
            socket?.close()
            socket = undefined
          }
        }
      })()
    }
  }
}

function profile() {
  const path = mkdtempSync(join(tmpdir(), 'mousse-lan-phone-'))
  const net = new NetService({ profileDir: path })
  cleanups.push(
    () => rmSync(path, { recursive: true, force: true }),
    () => net.shutdown()
  )
  return { path, net }
}

// Inputs: no relay and no configured listener; first connection; the computer restarts on a new
// port (its kept one taken) while the session is open; the phone app restarts (no hints); a revoked phone.
it.skipIf(!CLIENT)(
  'the phone app reaches its computer over the LAN with no relay, across a computer restart',
  async () => {
    const [
      { generateNodeKeys },
      { newId },
      { verifyRoster },
      { LeafSession },
      stream,
      lan,
      paths,
      signals,
      { NetError }
    ] = await Promise.all([
      phone('src/net/keys.ts'),
      phone('src/net/canonical.ts'),
      phone('src/net/identity.ts'),
      phone('src/net/session.ts'),
      phone('src/net/stream.ts'),
      phone('src/connection/lan.ts'),
      phone('src/connection/pathSession.ts'),
      phone('src/connection/networkSignals.ts'),
      phone('src/net/errors.ts')
    ])
    const computer = profile()
    await computer.net.request('net.init', {})
    const rt = computer.net.runtime(),
      self = rt.identity.self()!
    // Enrollment is not under test: the authority admits the phone's keys directly.
    const keys = generateNodeKeys()
    const node = newId('node') as NodeId
    const delegation = rt.identity.issueNodeDelegation({
      node,
      keys: keys.public,
      name: 'Phone',
      caps: ['read', 'chat']
    })
    // As redeeming an invitation would: the phone is connected here.
    rt.connections.set(node, 'connected', 'invite')
    const rootKey = rt.keys.rootKey()!
    // What the phone holds: the roster that admitted it.
    const held = { user: self.user, rootKey, node, roster: rt.identity.roster()!, delegation }
    const identity = () => ({ ...held })
    const enrollment = () => ({
      stored: { enrollment: { node } },
      keys,
      roster: verifyRoster(held.roster, rootKey)
    })
    const expectedSpki = Buffer.from(rt.keys.nodeKeys().transport, 'base64url')
    const openLeaf = async (connector: any, current: () => ReturnType<typeof identity>) => {
      const channel = await connector.open(self.node, keys.transport, expectedSpki)
      if (!channel) return undefined
      const leaf = new LeafSession(channel, { identity: current(), peerNode: self.node })
      cleanups.push(() => leaf.close())
      await leaf.opened
      return leaf
    }
    const app = () => {
      const plugin = nodeLan(stream.StreamEndpoint)
      const connector = new lan.LanConnector({
        native: plugin.native,
        lifecycle: { onPause() {}, onResume() {} }
      })
      connector.update([enrollment()])
      return { plugin, connector }
    }

    // First connection: the computer is found on the network and the session opens over it.
    const first = app()
    expect(await first.connector.waitFor(self.node, 15_000)).toBe(true)
    const relay = vi.fn(async () => {
      throw new NetError('route_unreachable', 'No internet.')
    })
    const session = new paths.PathSession({
      first: (await openLeaf(first.connector, identity))!,
      firstKind: 'direct',
      network: signals.manualNetworkSignals(),
      autoProbe: false,
      recoveryDelaysMs: [0, 1_000, 1_000, 1_000, 1_000, 1_000, 1_000, 1_000],
      recoveryWindowMs: 15_000,
      open: { relay, lan: () => openLeaf(first.connector, identity) }
    })
    cleanups.push(() => session.close())
    expect(session.path).toBe('direct')
    expect(await session.rpc('net.direct.endpoints', {}, { deadlineMs: 5_000 })).toEqual({
      endpoints: []
    })
    const before = first.plugin.dials.at(-1)

    // The computer restarts and its kept port is taken, so it listens on a new one; the session
    // moves to it on its own.
    await computer.net.shutdown()
    const squatter = createServer((socket) => socket.destroy())
    await new Promise<void>((done) =>
      squatter.listen(Number(before!.split(':')[1]), '0.0.0.0', done)
    )
    cleanups.push(() => new Promise<void>((done) => squatter.close(() => done())))
    const resumed = new NetService({ profileDir: computer.path })
    cleanups.push(() => resumed.shutdown())
    await resumed.start()
    expect(await session.rpc('net.direct.endpoints', {}, { deadlineMs: 15_000 })).toEqual({
      endpoints: []
    })
    expect(session.state).toBe('open')
    expect(session.path).toBe('direct')
    expect(first.plugin.dials.at(-1)).not.toBe(before)
    expect(relay).toHaveBeenCalled()

    // The phone app restarts: no hints yet, and the next advertisement finds the computer again.
    session.close()
    const second = app()
    expect(second.connector.seen(self.node)).toBe(false)
    expect(await second.connector.waitFor(self.node, 15_000)).toBe(true)
    const again = await openLeaf(second.connector, identity)
    await expect(again!.probe(5_000)).resolves.toBeGreaterThanOrEqual(0)
    again!.close()

    // A hint authenticates nothing: once revoked, the phone still knows where the computer
    // listens, but the computer's session checks refuse it.
    resumed.runtime().identity.revoke(node)
    expect(second.connector.seen(self.node)).toBe(true)
    await expect(openLeaf(second.connector, identity)).rejects.toThrow()
  },
  60_000
)
