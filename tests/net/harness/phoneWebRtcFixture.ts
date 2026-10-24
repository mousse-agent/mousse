import { afterEach, expect, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer, connect, type Socket } from 'node:net'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Duplex } from 'node:stream'
import { NetService } from '../../../src/mms/net/NetService'
import type { HostedNet, HostedNetHost, HostedNetModule } from '../../../src/mms/net/hosted'
import type { InboundInfo, SyncSession, Transport } from '../../../src/mms/net/contracts'
import type {
  DirectPathConfig,
  PeerConnectionFactory
} from '../../../src/mms/net/transports/phoneWebRtc'
import { openSecureChannel } from '../../../src/mms/net/link/secureChannel'
import { newId } from '../../../src/shared/net'

export const cleanups: Array<() => Promise<void> | void> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

/** A stand-in for the Mousse ID relay listener: it reports a route and hands in test connections. */
export class FakeHostedRelay implements Transport {
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

export function fakeMousseId() {
  const relays: FakeHostedRelay[] = []
  let host: HostedNetHost | undefined
  let direct: DirectPathConfig = { webrtc: true, stun: [] }
  const module: HostedNetModule = {
    create: (given) => {
      host = given
      return {
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
        membershipChanged: () => {},
        directPath: () => direct
      } as unknown as HostedNet
    }
  }
  return {
    module,
    relay: () => relays.at(-1)!,
    /** Mousse ID configuration changed, as the module reports it after a refresh. */
    setDirect: (next: DirectPathConfig) => {
      direct = next
      host!.directPathChanged()
    }
  }
}

export const RELAY = 'wss://relay.test/v1/net/relay'

export function profile(
  options: ConstructorParameters<typeof NetService>[0] extends infer T ? Partial<T> : never = {}
) {
  const path = mkdtempSync(join(tmpdir(), 'mousse-net-phone-webrtc-')),
    net = new NetService({ profileDir: path, ...options })
  cleanups.push(
    () => rmSync(path, { recursive: true, force: true }),
    () => net.shutdown()
  )
  return { path, net }
}

/** The computer (signed in to a fake Mousse ID) and a phone of the same user. */
export async function fixture(
  webrtc: { factory?: PeerConnectionFactory; hostAddresses?: () => ReadonlySet<string> } = {}
) {
  const mousseId = fakeMousseId()
  const computer = profile({
    hosted: mousseId.module,
    phoneWebRtc: { ...webrtc, ownAddresses: () => new Set() }
  })
  const phone = profile()
  await computer.net.request('net.init', { listen: true, port: 0 })
  await computer.net.request('net.protect', { passphrase: 'phone webrtc test protection' })
  const invite = (await computer.net.request('bridge.invite', {})) as { invite: string }
  await phone.net.request('bridge.join', { invite: invite.invite })
  const computerNode = computer.net.runtime().identity.self()!.node
  await vi.waitFor(() => expect(phone.net.session(computerNode).state()).toBe('open'), {
    timeout: 10_000
  })
  await computer.net.request('net.transport.configure', {
    id: 'plus-relay',
    enabled: true,
    settings: { address: RELAY }
  })
  return { computer, phone, computerNode, mousseId }
}

/** Opens a full session from `from` to the computer over a raw byte stream. */
export async function sessionOver(
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

/** A connected loopback socket pair, standing in for a relay circuit. */
export async function socketPair(): Promise<[Socket, Socket]> {
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

export async function relayedSession(
  phone: NetService,
  computer: NetService,
  mousseId: ReturnType<typeof fakeMousseId>
): Promise<SyncSession> {
  const [near, far] = await socketPair()
  mousseId.relay().accept!(far, { transport: 'plus-relay' })
  return sessionOver(phone, near, computer)
}

export const rpc = (session: SyncSession, method: string, params: unknown) =>
  session.rpc(method, params, { id: newId('rpc'), deadlineMs: 6000 }) as Promise<
    Record<string, unknown>
  >
