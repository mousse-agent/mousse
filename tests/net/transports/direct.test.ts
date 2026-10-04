import { afterEach, describe, expect, it } from 'vitest'
import type { Duplex } from 'node:stream'
import { connect } from 'node:net'
import WebSocket from 'ws'
import { DirectTransport } from '../../../src/mms/net/transports/direct'
import { generateSelfSignedCert, fingerprint } from '../../../src/mms/net/link/selfSignedCert'
import { openSecureChannel } from '../../../src/mms/net/link/secureChannel'
import { createMux } from '../../../src/mms/net/link/mux'
import { FakeClock } from '../harness/FakeClock'

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close()
})
const transport = (options: ConstructorParameters<typeof DirectTransport>[0] = {}) => {
  const value = new DirectTransport(options)
  cleanup.push(() => value.teardown())
  return value
}
const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve))
const until = async (guard: () => boolean): Promise<void> => {
  for (let i = 0; i < 100 && !guard(); i++) await new Promise((resolve) => setTimeout(resolve, 2))
  expect(guard()).toBe(true)
}

describe('direct production WebSocket transport', () => {
  it('defaults listening off and advertises only the actual loopback listener', async () => {
    const disabled = transport()
    await disabled.provision()
    expect(disabled.status().routes).toEqual([])
    await expect(disabled.listen(() => {})).rejects.toMatchObject({ code: 'forbidden' })
    const enabled = transport({ enabled: true })
    await enabled.provision()
    const listener = await enabled.listen(() => {})
    expect(enabled.status().routes[0].address).toMatch(/^ws:\/\/127\.0\.0\.1:\d+\/mousse-net$/)
    await listener.close()
    expect(enabled.status().routes).toEqual([])
  })
  it('runs real pinned mutual TLS and mux over loopback WebSocket byte streams', async () => {
    const client = transport(),
      server = transport({ enabled: true }),
      a = generateSelfSignedCert('direct-client'),
      b = generateSelfSignedCert('direct-server')
    await client.provision()
    await server.provision()
    let rawServer!: Duplex
    let resolve!: (value: Awaited<ReturnType<typeof openSecureChannel>>) => void,
      reject!: (error: unknown) => void
    const inbound = new Promise<Awaited<ReturnType<typeof openSecureChannel>>>((res, rej) => {
      resolve = res
      reject = rej
    })
    await server.listen((raw) => {
      rawServer = raw
      void openSecureChannel(raw, {
        role: 'server',
        credentials: b,
        expectedPeerFingerprint: fingerprint(a.publicKeySpki),
        deadlineMs: 2000
      }).then(resolve, reject)
    })
    const route = server.status().routes[0]
    await client.resolve(route, new AbortController().signal)
    const raw = await client.dial(route, new AbortController().signal)
    const [secureA, secureB] = await Promise.all([
      openSecureChannel(raw, {
        role: 'client',
        credentials: a,
        expectedPeerFingerprint: fingerprint(b.publicKeySpki),
        deadlineMs: 2000
      }),
      inbound
    ])
    // This isolated link test verifies a mutually pre-pinned TLS peer; production
    // composition releases quarantine only after its additional hello gate.
    server.markAuthenticated(rawServer)
    const muxA = createMux(secureA.stream),
      muxB = createMux(secureB.stream)
    cleanup.push(async () => {
      muxA.close()
      muxB.close()
      secureA.close()
      secureB.close()
    })
    const received = new Promise<unknown>((res) =>
      muxB.onMessage((_lane, message) => res(message.header))
    )
    await muxA.send('control', { header: { t: 'ping', n: 123, now: 0 }, parts: [] })
    expect(await received).toEqual({ t: 'ping', n: 123, now: 0 })
    expect(
      Buffer.from(secureA.exporter('EXPORTER-mousse-net-enroll', 32)).equals(
        Buffer.from(secureB.exporter('EXPORTER-mousse-net-enroll', 32))
      )
    ).toBe(true)
    const records = Array.from({ length: 14 }, (_, i) => ({ seq: i + 1, epoch: 1, recvTs: i }))
    const parts = records.flatMap(() => [new Uint8Array(65536).fill(197), new Uint8Array(64)])
    const large = new Promise<number>((res) =>
      muxB.onMessage((_lane, message) => {
        if (message.header.t === 'events') res(message.parts[26][65535])
      })
    )
    await muxA.send('control', {
      header: {
        t: 'events',
        stream: 'str_00000000000000000000000000',
        records,
        replay: false,
        parts: parts.map((part) => part.length)
      },
      parts
    })
    expect(await large).toBe(197)
  })
  it('limits unauthenticated connections per address and releases slots only after explicit authentication', async () => {
    const server = transport({ enabled: true }),
      raws: Duplex[] = [],
      clients: WebSocket[] = []
    await server.provision()
    await server.listen((raw) => raws.push(raw))
    const address = server.status().routes[0].address
    for (let i = 0; i < 4; i++) {
      const ws = new WebSocket(address)
      ws.on('error', () => {})
      clients.push(ws)
      await new Promise<void>((resolve) => ws.once('open', resolve))
    }
    const fifth = new WebSocket(address)
    fifth.on('error', () => {})
    clients.push(fifth)
    await new Promise<void>((resolve) => fifth.once('close', () => resolve()))
    expect(raws).toHaveLength(4)
    server.markAuthenticated(raws[0])
    const sixth = new WebSocket(address)
    sixth.on('error', () => {})
    clients.push(sixth)
    await new Promise<void>((resolve) => sixth.once('open', resolve))
    expect(raws).toHaveLength(5)
    for (const ws of clients) ws.terminate()
  })
  it('bounds pre-upgrade TCP connections and expires incomplete authentication with the injected clock', async () => {
    const clock = new FakeClock(),
      server = transport({ enabled: true, clock })
    await server.provision()
    await server.listen(() => {})
    const url = new URL(server.status().routes[0].address),
      sockets: ReturnType<typeof connect>[] = []
    for (let i = 0; i < 4; i++) {
      const socket = connect(Number(url.port), url.hostname)
      socket.on('error', () => {})
      sockets.push(socket)
      await new Promise<void>((resolve) => socket.once('connect', resolve))
    }
    const excess = connect(Number(url.port), url.hostname)
    excess.on('error', () => {})
    sockets.push(excess)
    await new Promise<void>((resolve) => excess.once('close', () => resolve()))
    clock.advance(10000)
    await until(() => sockets.every((socket) => socket.destroyed))
    expect(clock.pending()).toBe(0)
  })
  it('rejects text, oversize binary frames and cancelled/invalid routes without leaking listeners', async () => {
    const server = transport({ enabled: true }),
      client = transport()
    await server.provision()
    await client.provision()
    await server.listen((raw) => raw.resume())
    for (const data of ['plaintext is invalid', Buffer.alloc(65537)]) {
      const ws = new WebSocket(server.status().routes[0].address)
      ws.on('error', () => {})
      await new Promise<void>((resolve) => ws.once('open', resolve))
      ws.send(data)
      await new Promise<void>((resolve) => ws.once('close', () => resolve()))
      expect(ws.readyState).toBe(WebSocket.CLOSED)
    }
    const controller = new AbortController()
    controller.abort('test abort')
    await expect(client.dial(server.status().routes[0], controller.signal)).rejects.toMatchObject({
      code: 'cancelled'
    })
    await expect(
      client.dial(
        { transport: 'direct', address: 'http://127.0.0.1/mousse-net', priority: 0 },
        new AbortController().signal
      )
    ).rejects.toMatchObject({ code: 'bad_request' })
    await tick()
  })
})
