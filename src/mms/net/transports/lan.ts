import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { createSocket, type Socket } from 'node:dgram'
import { networkInterfaces } from 'node:os'
import type { NodeId, Route } from '../../../shared/net'
import type { Clock, InboundInfo } from '../contracts'
import type { Duplex } from 'node:stream'
import { DirectTransport } from './direct'

const GROUP = '239.255.77.77'
const PORT = 47777
const MAGIC = Buffer.from('MLN1')
const INTERVAL = 5_000
const TTL = 30_000
export interface LanPeer {
  node: NodeId
  sendKey: Buffer
  receiveKey: Buffer
}

/** Pairwise encrypted, short-lived LAN hints. Neither identities nor routes leave the LAN.
 * Discovery is only a hint: the normal pinned TLS and signed hello still authenticate every dial.
 */
export class LanDiscovery {
  private direct: DirectTransport
  private socket?: Socket
  private timer?: { cancel(): void }
  private stopped = false
  private peers: LanPeer[] = []
  private memberships = new Set<string>()
  private hints = new Map<NodeId, Map<string, { route: Route; expires: number; nonce: string }>>()
  private budget = 0
  private port = 0
  constructor(
    private readonly options: {
      clock: Clock
      peers(): LanPeer[]
      changed(): void
      /** The port kept from the last start; another is chosen when it is taken. */
      port?: number
    }
  ) {
    this.direct = this.listener(options.port)
  }
  async start(accept: (raw: Duplex, info: InboundInfo) => void): Promise<void> {
    try {
      await this.direct.provision()
      await this.direct.listen(accept)
    } catch (error) {
      if (!this.options.port) throw error
      // The kept port is taken (or no longer bindable): take a new one; peers learn it by beacon or the next link.
      await this.direct.teardown()
      this.direct = this.listener(0)
      await this.direct.provision()
      await this.direct.listen(accept)
    }
    this.port = Number(new URL(this.direct.status().routes[0].address).port)
    this.tick()
  }
  /** The port the listener is on, once started. */
  listeningPort(): number | undefined {
    return this.port || undefined
  }
  private listener(port: number | undefined): DirectTransport {
    return new DirectTransport({
      enabled: true,
      host: '0.0.0.0',
      ...(port ? { port } : {}),
      clock: this.options.clock
    })
  }
  markAuthenticated(raw: Duplex): void {
    this.direct.markAuthenticated(raw)
  }
  routes(node: NodeId): Route[] {
    return [...(this.hints.get(node)?.values() ?? [])]
      .filter((hint) => hint.expires > this.options.clock.now())
      .map((hint) => hint.route)
  }
  private tick(): void {
    if (this.stopped) return
    try {
      this.peers = this.options.peers().slice(0, 64)
    } catch {
      this.peers = []
    }
    const allowed = new Set(this.peers.map((peer) => peer.node))
    for (const [node, hints] of this.hints) {
      for (const [address, hint] of hints)
        if (hint.expires <= this.options.clock.now()) hints.delete(address)
      if (!allowed.has(node) || !hints.size) this.hints.delete(node)
    }
    this.budget = 128
    if (!this.socket) this.bind()
    else this.announce()
    this.timer = this.options.clock.setTimeout(() => this.tick(), INTERVAL)
  }
  private bind(): void {
    const socket = createSocket({ type: 'udp4', reuseAddr: true })
    this.socket = socket
    socket.on('error', () => {
      if (this.socket === socket) {
        this.socket = undefined
        this.memberships.clear()
      }
      try {
        socket.close()
      } catch {
        /* already closed */
      }
    })
    socket.on('message', (bytes, source) => this.receive(bytes, source.address))
    socket.bind(PORT, '0.0.0.0', () => {
      if (this.stopped || this.socket !== socket) return
      socket.setMulticastTTL(1)
      socket.setMulticastLoopback(true)
      this.announce()
    })
  }
  private announce(): void {
    const socket = this.socket
    if (!socket) return
    const addresses = Object.values(networkInterfaces()).flatMap((rows) =>
      (rows ?? []).filter((row) => row.family === 'IPv4' && !row.internal).map((row) => row.address)
    )
    for (const prior of this.memberships)
      if (!addresses.includes(prior)) {
        try {
          socket.dropMembership(GROUP, prior)
        } catch {
          /* interface gone */
        }
        this.memberships.delete(prior)
      }
    for (const address of addresses) {
      try {
        if (!this.memberships.has(address)) {
          socket.addMembership(GROUP, address)
          this.memberships.add(address)
        }
        socket.setMulticastInterface(address)
        for (const peer of this.peers) {
          const nonce = randomBytes(12),
            plain = randomBytes(16)
          plain.writeDoubleBE(this.options.clock.now(), 0)
          plain.writeUInt16BE(this.port, 8)
          const cipher = createCipheriv('aes-256-gcm', peer.sendKey, nonce)
          cipher.setAAD(MAGIC)
          const encrypted = Buffer.concat([cipher.update(plain), cipher.final()])
          socket.send(Buffer.concat([MAGIC, nonce, encrypted, cipher.getAuthTag()]), PORT, GROUP)
        }
      } catch {
        /* Discovery is best effort; relay and configured routes remain usable. */
      }
    }
  }
  private receive(bytes: Buffer, address: string): void {
    if (
      this.stopped ||
      bytes.length !== 48 ||
      !bytes.subarray(0, 4).equals(MAGIC) ||
      this.budget-- <= 0
    )
      return
    // The source is supplied by the local UDP socket, never by the advertisement.
    if (
      !/^\d+\.\d+\.\d+\.\d+$/.test(address) ||
      address === '0.0.0.0' ||
      Number(address.split('.')[0]) >= 224
    )
      return
    for (const peer of this.peers) {
      try {
        const decipher = createDecipheriv('aes-256-gcm', peer.receiveKey, bytes.subarray(4, 16))
        decipher.setAAD(MAGIC)
        decipher.setAuthTag(bytes.subarray(32))
        const plain = Buffer.concat([decipher.update(bytes.subarray(16, 32)), decipher.final()])
        const issued = plain.readDoubleBE(0),
          port = plain.readUInt16BE(8),
          now = this.options.clock.now()
        if (!Number.isFinite(issued) || Math.abs(now - issued) > TTL || !port) return
        const nonce = bytes.subarray(4, 16).toString('hex'),
          hints = this.hints.get(peer.node) ?? new Map(),
          prior = hints.get(address)
        if (prior?.nonce === nonce) return
        const route = {
          transport: 'direct',
          address: `ws://${address}:${port}/mousse-net`,
          priority: -10
        }
        if (!prior && hints.size >= 8) hints.delete(hints.keys().next().value!)
        hints.set(address, { route, expires: now + TTL, nonce })
        this.hints.set(peer.node, hints)
        if (prior?.route.address !== route.address) this.options.changed()
        return
      } catch {
        /* Not addressed to this paired computer, or forged. */
      }
    }
  }
  async teardown(): Promise<void> {
    this.stopped = true
    this.timer?.cancel()
    try {
      this.socket?.close()
    } catch {
      /* not bound */
    }
    this.socket = undefined
    this.peers = []
    this.hints.clear()
    await this.direct.teardown()
  }
}
