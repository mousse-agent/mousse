import { afterEach, describe, expect, it } from 'vitest'
import { Duplex } from 'node:stream'
import type {
  OpenSecureChannel,
  PeerRef,
  SecureChannel,
  Transport,
  TransportStatus
} from '../../../src/mms/net/contracts'
import { RouteManagerImpl } from '../../../src/mms/net/link/routeManager'
import { DirectTransport } from '../../../src/mms/net/transports/direct'
import { MemoryNetwork, MemoryTransport, memoryPair } from '../../../src/mms/net/transports/memory'
import { generateSelfSignedCert, fingerprint } from '../../../src/mms/net/link/selfSignedCert'
import { openSecureChannel } from '../../../src/mms/net/link/secureChannel'
import { FakeClock } from '../harness/FakeClock'
import { NetError } from '../../../src/shared/net'

const cleanup: Array<() => void | Promise<void>> = []
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close()
})
const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve))
const user = 'usr_00000000000000000000000000' as const,
  node = 'nod_00000000000000000000000000' as const
const credentials = generateSelfSignedCert('route-test')
const peer = (
  transportKey = Buffer.from(credentials.publicKeySpki).toString('base64url')
): PeerRef => ({
  node,
  user,
  transportKey,
  routes: [{ transport: 'memory', address: 'target', priority: 0 }]
})
const fakeChannel = (stream: Duplex, key: string): SecureChannel => ({
  stream,
  peerTransportKey: key,
  close: () => stream.destroy(),
  exporter: () => new Uint8Array(32)
})
const fakeTransport = (
  dial: Transport['dial'],
  resolve?: (signal: AbortSignal) => Promise<void>
): Transport & { resolve?: (route: unknown, signal: AbortSignal) => Promise<void> } => ({
  id: 'memory',
  traits: { canListen: true, canDial: true, readsPlaintext: false, needsAccount: false },
  provision: async () => {},
  listen: async () => ({ close: async () => {} }),
  teardown: async () => {},
  status: () => ({ state: 'ready', routes: [] }),
  onStatus: () => () => {},
  dial,
  ...(resolve ? { resolve: (_route: unknown, signal: AbortSignal) => resolve(signal) } : {})
})

describe('RouteManager real transport/TLS paths', () => {
  it('falls back from an unreachable memory route to a real pinned memory TLS peer and cleans loser timers', async () => {
    const clock = new FakeClock(),
      network = new MemoryNetwork(clock),
      client = new MemoryTransport(network, 'client'),
      server = new MemoryTransport(network, 'target')
    cleanup.push(async () => {
      await client.teardown()
      await server.teardown()
      network.dispose()
    })
    await client.provision()
    await server.provision()
    let resolve!: (channel: SecureChannel) => void, reject!: (error: unknown) => void
    const accepted = new Promise<SecureChannel>((res, rej) => {
      resolve = res
      reject = rej
    })
    await server.listen((raw) => {
      void openSecureChannel(raw, {
        role: 'server',
        credentials,
        expectedPeerFingerprint: fingerprint(credentials.publicKeySpki),
        deadlineMs: 2000
      }).then(resolve, reject)
    })
    const manager = new RouteManagerImpl({
      node,
      transports: [client],
      credentials,
      clock,
      staggerMs: 250,
      random: () => 0.5
    })
    const target = peer()
    target.routes.unshift({ transport: 'memory', address: 'missing', priority: -1 })
    const connected = manager.connect(target, new AbortController().signal)
    await tick()
    clock.advance(250)
    const opened = await connected,
      remote = await accepted
    cleanup.push(() => {
      opened.channel.close()
      remote.close()
    })
    expect(opened.route.address).toBe('target')
    expect(manager.health(node).map((route) => route.state)).toEqual(['failing', 'ok'])
    expect(clock.pending()).toBe(0)
    manager.markSessionOpen(opened.channel)
    clock.advance(30000)
    expect(clock.pending()).toBe(0)
  })
  it('uses a resolved real WebSocket route and refuses a mismatched certificate', async () => {
    const client = new DirectTransport(),
      server = new DirectTransport({ enabled: true }),
      serverKeys = generateSelfSignedCert('route-server')
    await client.provision()
    await server.provision()
    cleanup.push(async () => {
      await client.teardown()
      await server.teardown()
    })
    let inbound: Promise<SecureChannel> | undefined
    await server.listen((raw) => {
      inbound = openSecureChannel(raw, {
        role: 'server',
        credentials: serverKeys,
        expectedPeerFingerprint: fingerprint(credentials.publicKeySpki),
        deadlineMs: 2000
      })
      void inbound.catch(() => {})
    })
    const manager = new RouteManagerImpl({ node, transports: [client], credentials })
    const target = peer(Buffer.from(serverKeys.publicKeySpki).toString('base64url'))
    target.routes = server.status().routes.map((route) => ({
      ...route,
      address: route.address.replace('127.0.0.1', 'localhost')
    }))
    const opened = await manager.connect(target, new AbortController().signal),
      remote = await inbound!
    cleanup.push(() => {
      opened.channel.close()
      remote.close()
    })
    expect(opened.route.address).toContain('localhost')
    const wrong = peer()
    wrong.routes = target.routes
    await expect(manager.connect(wrong, new AbortController().signal)).rejects.toMatchObject({
      code: 'peer_key_mismatch'
    })
    expect(manager.health(node)[0].lastError).toBe('peer_key_mismatch')
  })
})

describe('RouteManager bounded phases and cancellation', () => {
  it.each(['resolve', 'connect', 'tls'] as const)(
    'budgets %s phase independently and cancels late work',
    async (phase) => {
      const clock = new FakeClock(),
        raw = memoryPair(clock)
      cleanup.push(() => raw.cut())
      let lateResolve: ((value: Duplex) => void) | undefined,
        lateTls: ((value: SecureChannel) => void) | undefined
      const transport = fakeTransport(
        async () =>
          phase === 'connect'
            ? new Promise<Duplex>((resolve) => {
                lateResolve = resolve
              })
            : raw.a,
        phase === 'resolve' ? async () => new Promise<void>(() => {}) : undefined
      )
      const opener: OpenSecureChannel = async (stream) =>
        phase === 'tls'
          ? new Promise<SecureChannel>((resolve) => {
              lateTls = resolve
            })
          : fakeChannel(stream, peer().transportKey)
      const manager = new RouteManagerImpl({
        node,
        transports: [transport],
        credentials,
        clock,
        openChannel: opener,
        random: () => 0.5
      })
      const pending = manager.connect(peer(), new AbortController().signal).catch((error) => error)
      await tick()
      clock.advance(phase === 'resolve' ? 5000 : 10000)
      expect(await pending).toMatchObject({ code: 'deadline_exceeded' })
      expect(manager.health(node)[0].lastError).toBe('deadline_exceeded')
      lateResolve?.(raw.a)
      lateTls?.(fakeChannel(raw.a, peer().transportKey))
      await tick()
      if (phase !== 'resolve') expect(raw.a.destroyed).toBe(true)
      expect(clock.pending()).toBe(0)
    }
  )
  it('cancels a connecting attempt and prevents adoption/leaks when an opener ignores cancellation', async () => {
    const clock = new FakeClock(),
      raw = memoryPair(clock),
      controller = new AbortController()
    cleanup.push(() => raw.cut())
    let late!: (channel: SecureChannel) => void
    const manager = new RouteManagerImpl({
      node,
      transports: [fakeTransport(async () => raw.a)],
      credentials,
      clock,
      openChannel: async () =>
        new Promise<SecureChannel>((resolve) => {
          late = resolve
        })
    })
    const pending = manager.connect(peer(), controller.signal).catch((error) => error)
    await tick()
    controller.abort('stop')
    expect(await pending).toMatchObject({ code: 'cancelled' })
    late(fakeChannel(raw.a, peer().transportKey))
    await tick()
    expect(raw.a.destroyed).toBe(true)
    expect(clock.pending()).toBe(0)
  })
  it('honors deterministic jittered backoff and resets only after an explicitly authenticated stable session', async () => {
    const clock = new FakeClock(),
      raw = memoryPair(clock)
    cleanup.push(() => raw.cut())
    let dials = 0
    const transport = fakeTransport(async () => {
      if (++dials === 1) throw new NetError('route_unreachable', 'offline')
      return raw.a
    })
    const manager = new RouteManagerImpl({
      node,
      transports: [transport],
      credentials,
      clock,
      random: () => 0.5,
      openChannel: async (stream) => fakeChannel(stream, peer().transportKey)
    })
    await expect(manager.connect(peer(), new AbortController().signal)).rejects.toMatchObject({
      code: 'route_unreachable'
    })
    const retry = manager.connect(peer(), new AbortController().signal)
    await tick()
    clock.advance(999)
    await tick()
    expect(dials).toBe(1)
    clock.advance(1)
    await tick()
    const opened = await retry
    expect(dials).toBe(2)
    manager.markSessionOpen(opened.channel)
    clock.advance(29999)
    expect(clock.pending()).toBe(1)
    clock.advance(1)
    expect(clock.pending()).toBe(0)
  })
  it('never bypasses pinning with an injected opener and returns immutable monotonic local route records', async () => {
    const clock = new FakeClock(),
      raw = memoryPair(clock)
    cleanup.push(() => raw.cut())
    let routes: TransportStatus['routes'] = [{ transport: 'memory', address: 'self', priority: 0 }]
    const transport = fakeTransport(async () => raw.a)
    transport.status = () => ({ state: 'ready', routes })
    const manager = new RouteManagerImpl({
      node,
      transports: [transport],
      credentials,
      clock,
      routesVersion: 7,
      openChannel: async (stream) => fakeChannel(stream, 'wrong')
    })
    await expect(manager.connect(peer(), new AbortController().signal)).rejects.toMatchObject({
      code: 'peer_key_mismatch'
    })
    expect(raw.a.destroyed).toBe(true)
    const first = manager.localRoutes()
    expect(first.version).toBe(8)
    first.routes[0].address = 'tampered'
    expect(manager.localRoutes().routes[0].address).toBe('self')
    clock.advance(1)
    expect(manager.localRoutes()).toMatchObject({ version: 8, issuedAt: first.issuedAt })
    routes = [{ transport: 'memory', address: 'new', priority: 0 }]
    expect(manager.localRoutes().version).toBe(9)
  })
})
