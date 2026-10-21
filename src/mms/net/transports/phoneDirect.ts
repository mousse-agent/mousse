import { createHash } from 'node:crypto'
import { isIP } from 'node:net'
import { networkInterfaces, type NetworkInterfaceInfo } from 'node:os'
import type { Duplex } from 'node:stream'
import type { Clock, InboundInfo, Listener } from '../contracts'
import { NetError } from '../../../shared/net/errors'
import { DirectTransport } from './direct'

/** The RPC a phone calls, over a session that came through Mousse ID, to learn the endpoints. */
export const PHONE_ENDPOINTS_METHOD = 'net.direct.endpoints'
/** The carrier name a session reached through the phone listener reports. */
export const PHONE_DIRECT_TRANSPORT = 'phone-direct'
/** How often the computer's addresses are read again, so a new Wi-Fi network is picked up. */
export const PHONE_DIRECT_RESCAN_MS = 15_000
const PORT_BASE = 41_000
const PORT_SPAN = 8_000
const MAX_ADDRESSES = 8

export type PhoneAddressKind = 'lan' | 'tailscale'
export interface PhoneAddress {
  address: string
  kind: PhoneAddressKind
}
/** A direct address a signed-in phone may try instead of the Mousse ID relay. */
export interface PhoneEndpoint {
  url: string
  kind: PhoneAddressKind
}

/** Virtual bridges for containers and VMs: the phone can never reach them. */
const VIRTUAL_INTERFACE = /^(docker|br-|veth|virbr|vboxnet|vmnet|lxc|lxd|cni|flannel|podman)/i

function ipv4Kind(address: string): PhoneAddressKind | undefined {
  const [a, b] = address.split('.').map(Number)
  if (a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)) return 'lan'
  // Tailscale hands out addresses from the carrier-grade NAT block.
  if (a === 100 && b >= 64 && b <= 127) return 'tailscale'
  return undefined
}

function ipv6Kind(address: string): PhoneAddressKind | undefined {
  const lower = address.toLowerCase()
  if (lower.startsWith('fd7a:115c:a1e0:')) return 'tailscale'
  // Unique local addresses stay inside the network. Global and link-local ones are left out:
  // global addresses can be reachable from the internet, link-local ones need a scope.
  if (/^f[cd][0-9a-f]{2}:/.test(lower)) return 'lan'
  return undefined
}

/**
 * The computer's private addresses a phone on the same network (or tailnet) can reach. Loopback,
 * public, link-local and virtual-bridge addresses are never offered or bound.
 */
export function phoneAddresses(
  interfaces: NodeJS.Dict<NetworkInterfaceInfo[]> = networkInterfaces()
): PhoneAddress[] {
  const found: PhoneAddress[] = []
  for (const [name, rows] of Object.entries(interfaces)) {
    if (!rows || VIRTUAL_INTERFACE.test(name)) continue
    for (const row of rows) {
      if (row.internal || isIP(row.address) === 0) continue
      const kind = row.family === 'IPv4' ? ipv4Kind(row.address) : ipv6Kind(row.address)
      if (kind && !found.some((entry) => entry.address === row.address))
        found.push({ address: row.address, kind })
    }
  }
  // LAN first: the phone tries the endpoints in this order.
  return found
    .sort((a, b) => (a.kind === b.kind ? 0 : a.kind === 'lan' ? -1 : 1))
    .slice(0, MAX_ADDRESSES)
}

/** A port derived from the node id: the same on every start, different between computers. */
export function phoneDirectPort(node: string): number {
  return PORT_BASE + (createHash('sha256').update(node).digest().readUInt16BE(0) % PORT_SPAN)
}

interface Bound {
  address: PhoneAddress
  transport: DirectTransport
  listener: Listener
}

/**
 * Direct WebSocket listeners for the user's signed-in phones, one per private address of this
 * computer, on a stable port. Each carries the same pinned inner TLS as every other carrier; the
 * owner authenticates sessions exactly as it does for the relay.
 */
export class PhoneDirectListener {
  private readonly bound = new Map<string, Bound>()
  private accept?: (raw: Duplex, info: InboundInfo) => void
  private timer?: { cancel(): void }
  private work: Promise<void> = Promise.resolve()
  private stopped = true

  constructor(
    private readonly options: {
      clock: Clock
      port: number
      addresses?: () => PhoneAddress[]
      rescanMs?: number
    }
  ) {}

  running(): boolean {
    return !this.stopped
  }

  /** Starts listening, or keeps the current listeners. */
  start(accept: (raw: Duplex, info: InboundInfo) => void): Promise<void> {
    this.accept = accept
    if (!this.stopped) return this.work
    this.stopped = false
    return this.reconcile()
  }

  stop(): Promise<void> {
    this.stopped = true
    this.timer?.cancel()
    this.timer = undefined
    return this.queue(async () => {
      const bound = [...this.bound.values()]
      this.bound.clear()
      await Promise.allSettled(bound.map((entry) => entry.transport.teardown()))
    })
  }

  endpoints(): PhoneEndpoint[] {
    if (this.stopped) return []
    return [...this.bound.values()].flatMap(({ address, transport }) =>
      transport.status().routes.map((route) => ({ url: route.address, kind: address.kind }))
    )
  }

  markAuthenticated(raw: Duplex): void {
    for (const { transport } of this.bound.values()) transport.markAuthenticated(raw)
  }

  private queue(work: () => Promise<void>): Promise<void> {
    const next = this.work.then(work, work)
    this.work = next.catch(() => {})
    return next
  }

  private reconcile(): Promise<void> {
    return this.queue(async () => {
      if (this.stopped) return
      let wanted: PhoneAddress[]
      try {
        wanted = (this.options.addresses ?? phoneAddresses)()
      } catch {
        wanted = []
      }
      const keep = new Set(wanted.map((row) => row.address))
      for (const [address, entry] of this.bound)
        if (!keep.has(address)) {
          this.bound.delete(address)
          await entry.transport.teardown().catch(() => {})
        }
      for (const address of wanted) {
        if (this.stopped || this.bound.has(address.address)) continue
        const entry = await this.bind(address).catch(() => undefined)
        if (!entry) continue
        if (this.stopped) await entry.transport.teardown().catch(() => {})
        else this.bound.set(address.address, entry)
      }
      if (!this.stopped) {
        this.timer?.cancel()
        this.timer = this.options.clock.setTimeout(
          () => void this.reconcile(),
          this.options.rescanMs ?? PHONE_DIRECT_RESCAN_MS
        )
      }
    })
  }

  /** Binds the stable port, or any free port when another program holds it. */
  private async bind(address: PhoneAddress): Promise<Bound> {
    let last: unknown
    for (const port of [this.options.port, 0]) {
      const transport = new DirectTransport({
        enabled: true,
        host: address.address,
        port,
        clock: this.options.clock
      })
      try {
        await transport.provision()
        const listener = await transport.listen((raw, info) => {
          const accept = this.accept
          if (this.stopped || !accept) {
            raw.destroy()
            return
          }
          accept(raw, { transport: PHONE_DIRECT_TRANSPORT, remoteAddress: info.remoteAddress })
        })
        return { address, transport, listener }
      } catch (error) {
        last = error
        await transport.teardown().catch(() => {})
      }
    }
    throw last instanceof NetError ? last : new NetError('route_unreachable')
  }
}
