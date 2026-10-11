import { afterEach, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import WebSocket, { WebSocketServer } from 'ws'
import { Duplex } from 'node:stream'
import { ProfileTransports } from '../../../src/mms/net/transports/manager'
import { DirectTransport } from '../../../src/mms/net/transports/direct'
import { generateSelfSignedCert, fingerprint } from '../../../src/mms/net/link/selfSignedCert'
import { openSecureChannel } from '../../../src/mms/net/link/secureChannel'
import type { InboundInfo, TransportAddon } from '../../../src/mms/net/contracts'
import { NetService } from '../../../src/mms/net/NetService'
import { newId } from '../../../src/shared/net'
import { FakeClock } from '../harness/FakeClock'

const cleanup: Array<() => void | Promise<unknown>> = []
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close()
})

function profile(clock?: FakeClock) {
  const path = mkdtempSync(join(tmpdir(), 'mousse-preauth-'))
  const net = new NetService({ profileDir: path, clock })
  cleanup.push(
    () => rmSync(path, { recursive: true, force: true }),
    () => net.shutdown()
  )
  return net
}

async function maliciousRelay() {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 })
  await new Promise<void>((resolve) => server.once('listening', resolve))
  const paired: WebSocket[] = []
  let opened = 0
  let honest = false
  let listener: WebSocket | undefined
  server.on('connection', (ws) => {
    opened++
    ws.send(JSON.stringify({ t: 'challenge', nonce: Buffer.alloc(32, 7).toString('base64url') }))
    ws.once('message', (bytes) => {
      const auth = JSON.parse(bytes.toString()) as { role: string; node: string; target: string }
      ws.send(JSON.stringify({ t: 'ready' }))
      // Bound the broken implementation's reproduction traffic as well.
      if (honest) {
        if (auth.role === 'listen') listener = ws
        else if (auth.role === 'dial' && listener) {
          const target = listener
          listener = undefined
          target.send(JSON.stringify({ t: 'paired', peer: auth.node }))
          ws.send(JSON.stringify({ t: 'paired', peer: auth.target }))
          target.on('message', (data, binary) => {
            if (ws.readyState === WebSocket.OPEN) ws.send(data, { binary })
          })
          ws.on('message', (data, binary) => {
            if (target.readyState === WebSocket.OPEN) target.send(data, { binary })
          })
          target.once('close', () => ws.terminate())
          ws.once('close', () => target.terminate())
        }
      } else if (paired.length < 12) {
        paired.push(ws)
        ws.send(JSON.stringify({ t: 'paired', peer: newId('node') }))
      }
      // Deliberately withhold inner TLS and vary the untrusted advertised peer.
    })
  })
  cleanup.push(async () => {
    for (const ws of server.clients) ws.terminate()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  })
  const address = server.address() as { port: number }
  return {
    address: `ws://127.0.0.1:${address.port}/mousse-relay`,
    paired,
    opened: () => opened,
    allowLegitimate: () => {
      honest = true
    },
    listenerReady: () => listener !== undefined
  }
}

it('bounds a malicious relay before TLS, pauses listener rearming and reuses closed and timed-out slots', async () => {
  const clock = new FakeClock()
  const relay = await maliciousRelay()
  const net = profile(clock)
  await net.request('net.init', {})
  await net.request('net.transport.configure', {
    id: 'relay',
    enabled: true,
    settings: { address: relay.address }
  })
  await vi.waitFor(() => expect(relay.paired.length).toBeGreaterThanOrEqual(4))
  await new Promise((resolve) => setTimeout(resolve, 80))
  expect(relay.paired).toHaveLength(4)
  expect(relay.opened()).toBe(4)
  relay.paired[0].terminate()
  await vi.waitFor(() => expect(relay.paired).toHaveLength(5))
  expect(relay.opened()).toBe(5)
  clock.advance(10_000)
  await vi.waitFor(() => expect(relay.paired).toHaveLength(9))
  expect(relay.paired.filter((ws) => ws.readyState === WebSocket.OPEN)).toHaveLength(4)
  const peer = profile(clock)
  await peer.request('net.init', {})
  const rt = net.runtime(),
    pr = peer.runtime()
  const self = rt.identity.self()!,
    remote = pr.identity.self()!
  rt.identity.pinUser(remote.user, pr.keys.rootKey()!)
  rt.identity.acceptRoster(pr.identity.roster()!, pr.keys.rootKey()!)
  pr.identity.pinUser(self.user, rt.keys.rootKey()!)
  pr.identity.acceptRoster(rt.identity.roster()!, rt.keys.rootKey()!)
  relay.allowLegitimate()
  relay.paired[5].terminate()
  await vi.waitFor(() => expect(relay.listenerReady()).toBe(true))
  const session = await peer.connectDomainSession(
    {
      node: self.node,
      user: self.user,
      transportKey: rt.keys.nodeKeys().transport,
      routes: net.status().routes
    },
    new AbortController().signal
  )
  expect(session.state()).toBe('open')
  await vi.waitFor(() => expect(admission(net).count()).toBe(3))
  net.beginShutdown()
  expect(admission(net).count()).toBe(0)
  await net.shutdown()
  await vi.waitFor(() =>
    expect(relay.paired.every((ws) => ws.readyState === WebSocket.CLOSED)).toBe(true)
  )
})

function admission(net: NetService) {
  return (net as unknown as { transport: ProfileTransports }).transport.admission
}

function silentStream() {
  return new Duplex({
    read() {},
    write(_chunk, _encoding, done) {
      done()
    }
  })
}

it('shares the total and address limits across two carriers before any TLS await, and releases TLS failures, abort and shutdown', async () => {
  const clock = new FakeClock()
  const callbacks = new Map<string, (raw: Duplex, info: InboundInfo) => void>()
  const addon = (id: string): TransportAddon => ({
    manifest: {
      id,
      kind: 'transport',
      displayName: id,
      traits: { canListen: true, canDial: false, readsPlaintext: false, needsAccount: false },
      settingsSchema: { type: 'object', additionalProperties: false },
      setupSteps: []
    },
    create: () => ({
      id,
      traits: { canListen: true, canDial: false, readsPlaintext: false, needsAccount: false },
      provision: async () => {},
      listen: async (accept) => {
        callbacks.set(id, accept)
        return { close: async () => {} }
      },
      dial: async () => {
        throw new Error('unused')
      },
      status: () => ({ state: 'ready', routes: [] }),
      onStatus: () => () => {},
      teardown: async () => {}
    })
  })
  const manager = new ProfileTransports({
    clock,
    profileDir: tmpdir(),
    identity: () => {
      throw new Error('unused')
    },
    addons: [addon('carrier-a'), addon('carrier-b')]
  })
  cleanup.push(() => manager.teardown())
  const credentials = generateSelfSignedCert('preauth-budget')
  const pending: Promise<unknown>[] = []
  const abort = new AbortController()
  let admitted = 0
  await manager.start(
    ['carrier-a', 'carrier-b'].map((id) => ({ id, enabled: true, settings: {} })),
    (raw) => {
      admitted++
      pending.push(
        openSecureChannel(raw, {
          role: 'server',
          credentials,
          deadlineMs: 10_000,
          signal: abort.signal
        }).catch(() => {})
      )
    }
  )
  const streams: Duplex[] = []
  const deliver = (carrier: string, address?: string) => {
    const raw = silentStream()
    streams.push(raw)
    callbacks.get(carrier)!(raw, { transport: carrier, remoteAddress: address })
    return raw
  }
  for (let i = 0; i < 4; i++) deliver(i % 2 ? 'carrier-a' : 'carrier-b', '127.0.0.1')
  expect(deliver('carrier-b', '::ffff:127.0.0.1').destroyed).toBe(true)
  expect(manager.admission.count()).toBe(4)
  for (let i = 0; i < 28; i++) deliver(i % 2 ? 'carrier-a' : 'carrier-b', `192.0.2.${i}`)
  expect(manager.admission.count()).toBe(32)
  expect(admitted).toBe(32)
  expect(deliver('carrier-b').destroyed).toBe(true)
  streams[0].destroy()
  await vi.waitFor(() => expect(manager.admission.count()).toBe(31))
  const bad = deliver('carrier-b', '198.51.100.1')
  bad.push(Buffer.from('invalid TLS record'))
  await vi.waitFor(() => expect(bad.destroyed).toBe(true))
  await vi.waitFor(() => expect(manager.admission.count()).toBe(31))
  abort.abort()
  await Promise.all(pending)
  await vi.waitFor(() => expect(manager.admission.count()).toBe(0))
  // A carrier can close even before TLS installs its close listener.
  const closing = deliver('carrier-a')
  closing.destroy()
  await vi.waitFor(() => expect(manager.admission.count()).toBe(0))
  manager.admission.reserve(silentStream(), 'shutdown')
  expect(manager.admission.count()).toBe(1)
  await manager.teardown()
  expect(manager.admission.count()).toBe(0)
})

it('keeps the lease through TLS/quarantine and gives hello only the original deadline remainder', async () => {
  const clock = new FakeClock()
  const net = profile(clock)
  await net.request('net.init', { listen: true, port: 0 })
  const direct = new DirectTransport()
  cleanup.push(() => direct.teardown())
  await direct.provision()
  const raw = await direct.dial(net.status().routes[0], new AbortController().signal)
  await vi.waitFor(() => expect(admission(net).count()).toBe(1))
  clock.advance(9000)
  const channel = await openSecureChannel(raw, {
    role: 'client',
    credentials: generateSelfSignedCert('late-TLS'),
    deadlineMs: 1000,
    expectedPeerFingerprint: fingerprint(
      Buffer.from(net.runtime().keys.nodeKeys().transport, 'base64url')
    )
  })
  cleanup.push(() => channel.close())
  await vi.waitFor(() =>
    expect((net as unknown as { gateways: Set<unknown> }).gateways.size).toBe(1)
  )
  expect(admission(net).count()).toBe(1)
  clock.advance(999)
  expect(admission(net).count()).toBe(1)
  clock.advance(1)
  expect(admission(net).count()).toBe(0)
  await vi.waitFor(() =>
    expect((net as unknown as { gateways: Set<unknown> }).gateways.size).toBe(0)
  )
  const second = await direct.dial(net.status().routes[0], new AbortController().signal)
  await vi.waitFor(() => expect(admission(net).count()).toBe(1))
  second.destroy()
  await vi.waitFor(() => expect(admission(net).count()).toBe(0))
})
