import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer, connect, type Socket } from 'node:net'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Duplex } from 'node:stream'
import { NetService } from '../../../src/mms/net/NetService'
import type { HostedNet, HostedNetModule } from '../../../src/mms/net/hosted'
import type { InboundInfo, SyncSession, Transport } from '../../../src/mms/net/contracts'
import { DirectTransport } from '../../../src/mms/net/transports/direct'
import {
  PHONE_ENDPOINTS_METHOD,
  PhoneDirectListener,
  phoneAddresses,
  phoneDirectPort,
  type PhoneAddress
} from '../../../src/mms/net/transports/phoneDirect'
import { openSecureChannel } from '../../../src/mms/net/link/secureChannel'
import { systemClock } from '../../../src/mms/net/clock'
import { newId, type NodeId } from '../../../src/shared/net'

const cleanups: Array<() => Promise<void> | void> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

describe('phone listener addresses', () => {
  it('offers private LAN and Tailscale addresses, never loopback, public, link-local or container bridges', () => {
    const row = (address: string, family: 'IPv4' | 'IPv6', internal = false) =>
      ({ address, family, internal, netmask: '', mac: '', cidr: null }) as never
    expect(
      phoneAddresses({
        lo: [row('127.0.0.1', 'IPv4', true), row('::1', 'IPv6', true)],
        wlan0: [
          row('192.168.1.5', 'IPv4'),
          row('fe80::1', 'IPv6'),
          row('2401:4900::5', 'IPv6'),
          row('fd12:3456::5', 'IPv6')
        ],
        eth0: [row('8.8.8.8', 'IPv4'), row('10.0.0.7', 'IPv4'), row('172.20.1.2', 'IPv4')],
        docker0: [row('172.17.0.1', 'IPv4')],
        tailscale0: [row('100.101.1.2', 'IPv4'), row('fd7a:115c:a1e0::1', 'IPv6')]
      })
    ).toEqual([
      { address: '192.168.1.5', kind: 'lan' },
      { address: 'fd12:3456::5', kind: 'lan' },
      { address: '10.0.0.7', kind: 'lan' },
      { address: '172.20.1.2', kind: 'lan' },
      { address: '100.101.1.2', kind: 'tailscale' },
      { address: 'fd7a:115c:a1e0::1', kind: 'tailscale' }
    ])
  })

  it('derives one stable port per computer', () => {
    const port = phoneDirectPort('node_abc')
    expect(port).toBe(phoneDirectPort('node_abc'))
    expect(port).toBeGreaterThanOrEqual(41_000)
    expect(port).toBeLessThan(49_000)
    expect(phoneDirectPort('node_abd')).not.toBe(port)
  })
})

describe('phone listener', () => {
  it('binds each address on the stable port, follows address changes and falls back when the port is taken', async () => {
    let addresses: PhoneAddress[] = [{ address: '127.0.0.1', kind: 'lan' }]
    const taken = createServer()
    await new Promise<void>((resolve) => taken.listen(0, '127.0.0.3', resolve))
    cleanups.push(() => new Promise<void>((resolve) => taken.close(() => resolve())))
    const port = (taken.address() as { port: number }).port
    const listener = new PhoneDirectListener({
      clock: systemClock,
      port,
      addresses: () => addresses,
      rescanMs: 20
    })
    cleanups.push(() => listener.stop())
    const accepted: InboundInfo[] = []
    await listener.start((raw, info) => {
      accepted.push(info)
      raw.destroy()
    })
    expect(listener.endpoints()).toEqual([
      { url: `ws://127.0.0.1:${port}/mousse-net`, kind: 'lan' }
    ])
    addresses = [
      { address: '127.0.0.3', kind: 'lan' },
      { address: '127.0.0.2', kind: 'tailscale' }
    ]
    await vi.waitFor(() => expect(listener.endpoints()).toHaveLength(2))
    const [lan, tailscale] = listener.endpoints()
    // 127.0.0.3 already has a program on the stable port, so that address gets another port.
    expect(lan.url).toMatch(/^ws:\/\/127\.0\.0\.3:\d+\/mousse-net$/)
    expect(lan.url).not.toContain(`:${port}/`)
    expect(tailscale).toEqual({ url: `ws://127.0.0.2:${port}/mousse-net`, kind: 'tailscale' })
    const client = new DirectTransport()
    await client.provision()
    cleanups.push(() => client.teardown())
    const raw = await client.dial(
      { transport: 'direct', address: tailscale.url, priority: 0 },
      new AbortController().signal
    )
    raw.destroy()
    await vi.waitFor(() => expect(accepted).toHaveLength(1))
    expect(accepted[0]).toMatchObject({ transport: 'phone-direct', remoteAddress: '127.0.0.1' })
    await listener.stop()
    expect(listener.endpoints()).toEqual([])
    await expect(
      client.dial(
        { transport: 'direct', address: tailscale.url, priority: 0 },
        new AbortController().signal
      )
    ).rejects.toMatchObject({ code: 'route_unreachable' })
  })
})

/** A stand-in for the Mousse ID relay listener: it reports a route and hands in test connections. */
class FakeHostedRelay implements Transport {
  readonly id = 'plus-relay'
  readonly traits = { canListen: true, canDial: true, readsPlaintext: true, needsAccount: true }
  accept?: (raw: Duplex, info: InboundInfo) => void
  private listening = false
  constructor(private readonly address: string) {}
  async provision(): Promise<void> {}
  status() {
    return {
      state: 'ready' as const,
      routes: this.listening ? [{ transport: this.id, address: this.address, priority: 20 }] : []
    }
  }
  onStatus(): () => void {
    return () => {}
  }
  async listen(accept: (raw: Duplex, info: InboundInfo) => void) {
    this.accept = accept
    this.listening = true
    return {
      close: async () => {
        this.listening = false
      }
    }
  }
  async dial(): Promise<Duplex> {
    throw new Error('not used')
  }
  async teardown(): Promise<void> {
    this.listening = false
  }
}

function fakeMousseId() {
  const relays: FakeHostedRelay[] = []
  const module: HostedNetModule = {
    create: () =>
      ({
        transports: {
          addon: () => ({
            manifest: {
              id: 'plus-relay',
              kind: 'transport',
              displayName: 'Mousse ID',
              traits: { canListen: true, canDial: true, readsPlaintext: true, needsAccount: true },
              settingsSchema: {
                type: 'object',
                additionalProperties: false,
                required: ['address'],
                properties: { address: { type: 'string' } }
              },
              setupSteps: []
            },
            create: (settings: unknown) => {
              const relay = new FakeHostedRelay((settings as { address: string }).address)
              relays.push(relay)
              return relay
            }
          }),
          rendezvousTransport: () => {
            throw new Error('not used')
          },
          prepareRendezvous: async () => {
            throw new Error('not used')
          }
        },
        status: () => ({ configured: true, connected: true }),
        connected: () => true,
        consentFenced: () => false,
        cancelLogin: () => ({ cancelled: true }),
        enrollmentRequests: () => ({ requests: [] }),
        request: async () => undefined,
        recoverLease: async () => {},
        resumeRenewal: () => {},
        spaceJoined: async () => {},
        prepareSpaceRendezvous: async () => undefined,
        membershipChanged: () => {}
      }) as unknown as HostedNet
  }
  return { module, relay: () => relays.at(-1)! }
}

const RELAY = 'wss://relay.test/v1/net/relay'

function profile(
  options: ConstructorParameters<typeof NetService>[0] extends infer T ? Partial<T> : never = {}
) {
  const path = mkdtempSync(join(tmpdir(), 'mousse-net-phone-direct-')),
    net = new NetService({ profileDir: path, ...options })
  cleanups.push(
    () => rmSync(path, { recursive: true, force: true }),
    () => net.shutdown()
  )
  return { path, net }
}

/** The computer (signed in to a fake Mousse ID) and a second node of the same user. */
async function fixture() {
  const mousseId = fakeMousseId()
  const computer = profile({
    hosted: mousseId.module,
    phoneDirect: { addresses: () => [{ address: '127.0.0.1', kind: 'lan' }], port: 0 }
  })
  const phone = profile()
  await computer.net.request('net.init', { listen: true, port: 0 })
  await computer.net.request('net.protect', { passphrase: 'phone direct test protection' })
  const invite = (await computer.net.request('bridge.invite', {})) as { invite: string }
  await phone.net.request('bridge.join', { invite: invite.invite })
  const computerNode = computer.net.runtime().identity.self()!.node
  await vi.waitFor(() => expect(phone.net.session(computerNode).state()).toBe('open'), {
    timeout: 10_000
  })
  const signIn = async (enabled: boolean) => {
    await computer.net.request('net.transport.configure', {
      id: 'plus-relay',
      enabled,
      settings: { address: RELAY }
    })
    await computer.net.phoneDirectSettled()
  }
  return { computer, phone, computerNode, mousseId, signIn }
}

function endpointsOf(computer: NetService): Array<{ url: string; kind: string }> {
  return (
    computer as unknown as { transport: { phoneEndpoints(): Array<{ url: string; kind: string }> } }
  ).transport.phoneEndpoints()
}

/** Opens a full session from `from` to the computer over a raw byte stream. */
async function sessionOver(
  from: NetService,
  raw: Duplex,
  computer: NetService
): Promise<SyncSession> {
  const transportKey = computer.runtime().keys.nodeKeys().transport
  const channel = await openSecureChannel(raw, {
    role: 'client',
    credentials: from.runtime().keys.tlsCredentials(),
    expectedPeerFingerprint: createHash('sha256')
      .update(Buffer.from(transportKey, 'base64url'))
      .digest('base64url'),
    deadlineMs: 5000
  })
  const session = (
    from as unknown as { makeSession(channel: unknown): SyncSession & { opened: Promise<void> } }
  ).makeSession(channel)
  cleanups.push(() => session.close())
  await session.opened
  return session
}

async function dialPhoneListener(computer: NetService): Promise<Duplex> {
  const client = new DirectTransport()
  await client.provision()
  cleanups.push(() => client.teardown())
  const [endpoint] = endpointsOf(computer)
  return client.dial(
    { transport: 'direct', address: endpoint.url, priority: 0 },
    new AbortController().signal
  )
}

/** The computer refuses the session: before it opens, or by closing it at once. */
async function refused(opening: Promise<SyncSession>): Promise<void> {
  const outcome = await opening.catch((error: unknown) => error)
  if (outcome instanceof Error) return
  const session = outcome as SyncSession
  await vi.waitFor(() => expect(session.state()).toBe('closed'), { timeout: 5000 })
  await expect(Promise.resolve().then(() => endpoints(session))).rejects.toBeDefined()
}

const endpoints = (session: SyncSession) =>
  session.rpc(PHONE_ENDPOINTS_METHOD, {}, { id: newId('rpc'), deadlineMs: 5000 }) as Promise<{
    endpoints: Array<{ url: string; kind: string }>
  }>

/** A connected loopback socket pair, standing in for a relay circuit. */
async function socketPair(): Promise<[Socket, Socket]> {
  const server = createServer()
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as { port: number }).port
  const accepted = new Promise<Socket>((resolve) => server.once('connection', resolve))
  const client = connect(port, '127.0.0.1')
  const inbound = await accepted
  server.close()
  cleanups.push(() => {
    client.destroy()
    inbound.destroy()
  })
  return [client, inbound]
}

describe('phone listener in the Net service', () => {
  it('runs only while Mousse ID is connected and tells endpoints only to sessions that came through Mousse ID', async () => {
    const { computer, phone, computerNode, mousseId, signIn } = await fixture()
    expect(endpointsOf(computer.net)).toEqual([])
    // A session over the ordinary direct listener learns nothing.
    expect(await endpoints(phone.net.session(computerNode))).toEqual({ endpoints: [] })

    await signIn(true)
    const [endpoint] = endpointsOf(computer.net)
    expect(endpoint).toMatchObject({ kind: 'lan' })
    expect(endpoint.url).toMatch(/^ws:\/\/127\.0\.0\.1:\d+\/mousse-net$/)
    // Reconfiguring transports restarts every session; ask again once the ordinary one is back.
    await vi.waitFor(
      async () =>
        expect(await endpoints(phone.net.session(computerNode))).toEqual({ endpoints: [] }),
      { timeout: 10_000, interval: 100 }
    )

    // Through the Mousse ID relay.
    const [near, far] = await socketPair()
    mousseId.relay().accept!(far, { transport: 'plus-relay' })
    const relayed = await sessionOver(phone.net, near, computer.net)
    expect(await endpoints(relayed)).toEqual({ endpoints: [endpoint] })

    // Over the phone listener itself: the same checks and the same answer.
    const direct = await sessionOver(phone.net, await dialPhoneListener(computer.net), computer.net)
    expect(direct.peer.node).toBe(computerNode)
    expect(await endpoints(direct)).toEqual({ endpoints: [endpoint] })

    // Signing out of Mousse ID stops the listener.
    const url = endpoint.url
    await signIn(false)
    expect(endpointsOf(computer.net)).toEqual([])
    const client = new DirectTransport()
    await client.provision()
    cleanups.push(() => client.teardown())
    await expect(
      client.dial({ transport: 'direct', address: url, priority: 0 }, new AbortController().signal)
    ).rejects.toMatchObject({ code: 'route_unreachable' })
  }, 30_000)

  it('refuses a revoked node on the phone listener', async () => {
    const { computer, phone, signIn } = await fixture()
    await signIn(true)
    const phoneNode = phone.net.runtime().identity.self()!.node as NodeId
    await computer.net.request('bridge.revoke', { node: phoneNode })
    await refused(sessionOver(phone.net, await dialPhoneListener(computer.net), computer.net))
    expect(
      computer.net.status().peers.filter((peer) => peer.node === phoneNode && peer.state === 'open')
    ).toEqual([])
  }, 30_000)

  it('refuses another user on the phone listener even when that user is trusted for Spaces', async () => {
    const { computer, signIn } = await fixture()
    await signIn(true)
    const stranger = profile()
    await stranger.net.request('net.init', { listen: true, port: 0 })
    const ar = computer.net.runtime(),
      br = stranger.net.runtime()
    ar.identity.pinUser(br.identity.self()!.user, br.keys.rootKey()!)
    ar.identity.acceptRoster(br.identity.roster()!, br.keys.rootKey()!)
    br.identity.pinUser(ar.identity.self()!.user, ar.keys.rootKey()!)
    br.identity.acceptRoster(ar.identity.roster()!, ar.keys.rootKey()!)
    await refused(sessionOver(stranger.net, await dialPhoneListener(computer.net), computer.net))
  }, 30_000)
})
