import { randomBytes } from 'node:crypto'
import { isIP } from 'node:net'
import { networkInterfaces, type NetworkInterfaceInfo } from 'node:os'
import { Duplex } from 'node:stream'
import type { NodeId, UserId } from '../../../shared/net'
import { NetError } from '../../../shared/net/errors'
import {
  WEBRTC_CHUNK_BYTES,
  WEBRTC_GATHER_MS,
  WEBRTC_INBOUND_MAX_BYTES,
  WEBRTC_LIVE_MAX,
  WEBRTC_LIVE_PER_NODE,
  WEBRTC_MAX_CANDIDATES,
  WEBRTC_OFFERS_PER_MINUTE,
  WEBRTC_PENDING_MAX,
  WEBRTC_PENDING_PER_NODE,
  WEBRTC_PORT_RANGE,
  WEBRTC_PREAUTH_MAX_BYTES,
  WEBRTC_SDP_MAX_BYTES,
  WEBRTC_SDP_MAX_LINES,
  WEBRTC_TICKET_TTL_MS
} from '../../../shared/net/limits'
import type { Clock } from '../contracts'

/** The RPC a phone calls, over a session that came through Mousse ID, to learn the direct paths. */
export const PHONE_ENDPOINTS_METHOD = 'net.direct.endpoints'
/** The RPC that carries the phone's WebRTC offer and returns the computer's answer. */
export const PHONE_WEBRTC_OFFER_METHOD = 'net.direct.webrtc.offer'
/** The carrier name a session reached over a WebRTC DataChannel reports. */
export const PHONE_WEBRTC_TRANSPORT = 'phone-webrtc'
/** The only DataChannel the computer accepts: ordered and reliable. */
export const PHONE_WEBRTC_LABEL = 'mousse-net/1'

// ---------------------------------------------------------------- addresses

/**
 * Where an address may sit for the direct path. Everything else (loopback, link-local,
 * multicast, unspecified, broadcast, IPv4-mapped, documentation and benchmark ranges) has
 * no class and is never used.
 */
export type AddressClass = 'private4' | 'tailscale4' | 'ula' | 'tailscale6' | 'global6' | 'public4'

const HOST_CLASSES: ReadonlySet<AddressClass> = new Set([
  'private4',
  'tailscale4',
  'ula',
  'tailscale6',
  'global6'
])
const SRFLX_CLASSES: ReadonlySet<AddressClass> = new Set(['public4', 'global6'])

function ipv4Bytes(address: string): number[] {
  return address.split('.').map(Number)
}

/** The 16 bytes of an IPv6 literal (without a zone), or undefined. */
export function ipv6Bytes(address: string): number[] | undefined {
  if (isIP(address) !== 6 || address.includes('%')) return undefined
  let text = address.toLowerCase()
  const tail: number[] = []
  const dotted = text.match(/^(.*:)(\d+\.\d+\.\d+\.\d+)$/)
  if (dotted) {
    tail.push(...ipv4Bytes(dotted[2]))
    text = dotted[1].endsWith('::') ? dotted[1] : dotted[1].slice(0, -1)
  }
  const [head, rest] = text.includes('::') ? text.split('::') : [text, undefined]
  const words = (part: string) => (part ? part.split(':').map((word) => parseInt(word, 16)) : [])
  const left = words(head),
    right = rest === undefined ? [] : words(rest)
  const missing = 8 - tail.length / 2 - left.length - right.length
  if (missing < 0 || (rest === undefined && missing !== 0)) return undefined
  const all = [...left, ...Array<number>(missing).fill(0), ...right]
  return [...all.flatMap((word) => [word >> 8, word & 0xff]), ...tail]
}

function classify4(address: string): AddressClass | undefined {
  const [a, b, c] = ipv4Bytes(address)
  if (a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)) return 'private4'
  // Tailscale (and carrier-grade NAT) addresses.
  if (a === 100 && b >= 64 && b <= 127) return 'tailscale4'
  if (
    a === 0 ||
    a === 127 ||
    a >= 224 ||
    (a === 169 && b === 254) ||
    (a === 192 && b === 0 && (c === 0 || c === 2)) ||
    (a === 192 && b === 88 && c === 99) ||
    (a === 198 && (b === 18 || b === 19)) ||
    (a === 198 && b === 51 && c === 100) ||
    (a === 203 && b === 0 && c === 113)
  )
    return undefined
  return 'public4'
}

function classify6(address: string): AddressClass | undefined {
  const bytes = ipv6Bytes(address)
  if (!bytes) return undefined
  const [a, b, c, d, e, f] = bytes
  if ((a & 0xfe) === 0xfc)
    return a === 0xfd && b === 0x7a && c === 0x11 && d === 0x5c && e === 0xa1 && f === 0xe0
      ? 'tailscale6'
      : 'ula'
  if ((a & 0xe0) !== 0x20) return undefined
  // Documentation (2001:db8::/32, 3fff::/20) and benchmarking (2001:2::/48).
  if (a === 0x20 && b === 0x01 && c === 0x0d && d === 0xb8) return undefined
  if (a === 0x3f && b === 0xff && (c & 0xf0) === 0) return undefined
  if (a === 0x20 && b === 0x01 && c === 0x00 && d === 0x02 && e === 0 && f === 0) return undefined
  return 'global6'
}

/** The class of an IP literal; undefined for host names and every address the path never uses. */
export function classifyAddress(address: string): AddressClass | undefined {
  const family = isIP(address)
  if (family === 4) return classify4(address)
  if (family === 6) return classify6(address)
  return undefined
}

/** Containers' and VMs' virtual bridges: a phone can never reach them. */
const VIRTUAL_INTERFACE = /^(docker|br-|veth|virbr|vboxnet|vmnet|lxc|lxd|cni|flannel|podman)/i

/**
 * This computer's addresses a phone may reach directly: private LAN, Tailscale, unique local
 * and global IPv6 addresses, never loopback, link-local or virtual-bridge addresses.
 */
export function directHostAddresses(
  interfaces: NodeJS.Dict<NetworkInterfaceInfo[]> = networkInterfaces()
): Set<string> {
  const found = new Set<string>()
  for (const [name, rows] of Object.entries(interfaces)) {
    if (!rows || VIRTUAL_INTERFACE.test(name)) continue
    for (const row of rows) {
      if (row.internal) continue
      const kind = classifyAddress(row.address)
      if (kind && HOST_CLASSES.has(kind)) found.add(normalizeAddress(row.address))
    }
  }
  return found
}

/** Every address of this computer, of any kind; a phone candidate may never point at one. */
export function ownAddresses(
  interfaces: NodeJS.Dict<NetworkInterfaceInfo[]> = networkInterfaces()
): Set<string> {
  const found = new Set<string>()
  for (const rows of Object.values(interfaces))
    for (const row of rows ?? []) found.add(normalizeAddress(row.address.split('%')[0]))
  return found
}

/** A canonical spelling, so IPv6 literals compare equal however they are written. */
export function normalizeAddress(address: string): string {
  const bytes = ipv6Bytes(address)
  if (!bytes) return address
  const words: string[] = []
  for (let index = 0; index < 16; index += 2)
    words.push(((bytes[index] << 8) | bytes[index + 1]).toString(16))
  return words.join(':')
}

// ---------------------------------------------------------------- configuration

/** Mousse ID's settings for the direct path, from its configuration document. */
export interface DirectPathConfig {
  /** `configuration.directWebrtc`; only an explicit `false` turns the path off. */
  webrtc: boolean
  /** `configuration.stun`: STUN servers for ICE; empty for host candidates only. */
  stun: string[]
}

export const DEFAULT_DIRECT_PATH: DirectPathConfig = Object.freeze({
  webrtc: true,
  stun: []
}) as DirectPathConfig

const STUN_URL =
  /^stuns?:(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,62}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,62}[A-Za-z0-9])?)*|\d{1,3}(?:\.\d{1,3}){3}|\[[0-9A-Fa-f:.]{2,45}\])(?::\d{1,5})?$/

/**
 * Reads the direct-path fields of Mousse ID's configuration document. Missing fields keep the
 * defaults; a malformed STUN list is ignored as a whole, so only host candidates are used.
 * `stuns:` (STUN over TLS) entries are valid but dropped: the computer's ICE agent speaks plain
 * STUN only.
 */
export function parseDirectPathConfig(document: unknown): DirectPathConfig {
  const value = (document && typeof document === 'object' ? document : {}) as {
    directWebrtc?: unknown
    stun?: unknown
  }
  const stun =
    Array.isArray(value.stun) &&
    value.stun.length <= 4 &&
    value.stun.every(
      (entry) => typeof entry === 'string' && entry.length <= 256 && STUN_URL.test(entry)
    )
      ? (value.stun as string[]).filter((entry) => entry.startsWith('stun:'))
      : []
  return { webrtc: value.directWebrtc !== false, stun }
}

// ---------------------------------------------------------------- SDP

/** What the validator learned from an offer it accepted. */
export interface ValidatedOffer {
  /** The SDP handed to the native stack: rebuilt from checked lines only. */
  sdp: string
  /** The offer's DTLS certificate fingerprint: lowercase hex without separators. */
  fingerprint: string
  candidates: Array<{ address: string; port: number; type: 'host' | 'srflx' }>
}

export interface OfferPolicy {
  /** STUN is configured, so server-reflexive candidates may be used. */
  stun: boolean
  /** This computer's own addresses. */
  own?: ReadonlySet<string>
  /** The relay and STUN servers' addresses. */
  blocked?: ReadonlySet<string>
}

const SESSION_ATTRIBUTES = new Set([
  'group',
  'msid-semantic',
  'ice-ufrag',
  'ice-pwd',
  'ice-options',
  'fingerprint',
  'setup',
  'mid',
  'sctp-port',
  'max-message-size',
  'candidate',
  'end-of-candidates',
  'extmap-allow-mixed',
  // A direction attribute; libdatachannel writes it on application sections.
  'sendrecv'
])
const CANDIDATE_EXTENSIONS = new Set([
  'raddr',
  'rport',
  'generation',
  'network-id',
  'network-cost',
  'ufrag'
])
const ICE_CHARS = /^[A-Za-z0-9+/]+$/

function bad(): NetError {
  return new NetError('bad_request', 'The WebRTC offer is not accepted.')
}

function ipLiteral(address: string): boolean {
  return isIP(address) !== 0 && !address.includes('%')
}

/** Parses one `candidate:` attribute value; throws on anything malformed. */
function parseCandidate(value: string): {
  address: string
  port: number
  type: string
  transport: string
} {
  const match = value.match(
    /^candidate:([A-Za-z0-9+/]{1,32}) (\d{1,3}) ([A-Za-z]{1,8}) (\d{1,10}) (\S{1,64}) (\d{1,5}) typ ([a-z]{1,8})((?: \S{1,64} \S{1,64}){0,8})$/
  )
  if (!match) throw bad()
  const [, , component, transport, , address, port, type, extensions] = match
  if (component !== '1') throw bad()
  // Only UDP is used; TCP candidates carry a `tcptype` extension, so they return before it.
  if (transport.toLowerCase() !== 'udp') {
    return { address, port: Number(port), type, transport: transport.toLowerCase() }
  }
  const parts = extensions.trim() ? extensions.trim().split(' ') : []
  for (let index = 0; index < parts.length; index += 2) {
    const name = parts[index],
      option = parts[index + 1]
    if (!CANDIDATE_EXTENSIONS.has(name)) throw bad()
    if (name === 'raddr' && !ipLiteral(option)) throw bad()
    if (
      (name === 'rport' || name === 'generation' || name === 'network-cost') &&
      !/^\d{1,10}$/.test(option)
    )
      throw bad()
  }
  return { address, port: Number(port), type, transport: transport.toLowerCase() }
}

/** Whether an offer candidate may reach the native stack. */
function candidateAllowed(
  candidate: { address: string; port: number; type: string; transport: string },
  policy: OfferPolicy
): boolean {
  if (candidate.transport !== 'udp') return false
  if (candidate.port < 1024 || candidate.port > 65535) return false
  const kind = classifyAddress(candidate.address)
  if (!kind) return false
  if (candidate.type === 'host') {
    if (!HOST_CLASSES.has(kind)) return false
  } else if (candidate.type === 'srflx') {
    if (!policy.stun || !SRFLX_CLASSES.has(kind)) return false
  } else return false
  const address = normalizeAddress(candidate.address)
  return !policy.own?.has(address) && !policy.blocked?.has(address)
}

/**
 * The trust boundary in front of the native SDP parser and ICE agent. Only a single
 * application section with the allowlisted attributes passes. Candidates must name IP
 * literals (never host names, so the native resolver never runs); candidates outside the
 * allowed address classes are dropped before the native stack sees them.
 */
export function validateOffer(sdp: unknown, policy: OfferPolicy): ValidatedOffer {
  if (typeof sdp !== 'string' || Buffer.byteLength(sdp) > WEBRTC_SDP_MAX_BYTES) throw bad()
  if (/[^\x20-\x7e\r\n]/.test(sdp)) throw bad()
  const lines = sdp.split(/\r?\n/)
  if (lines.at(-1) === '') lines.pop()
  if (lines.length > WEBRTC_SDP_MAX_LINES || lines[0] !== 'v=0') throw bad()
  const out: string[] = []
  const once = new Map<string, number>()
  const count = (key: string) => once.set(key, (once.get(key) ?? 0) + 1)
  const candidates: ValidatedOffer['candidates'] = []
  let fingerprint = ''
  let media = false
  for (const line of lines) {
    const match = line.match(/^([a-z])=(.*)$/)
    if (!match) throw bad()
    const [, type, value] = match
    switch (type) {
      case 'v':
        count('v')
        break
      case 'o': {
        const origin = value.match(/^\S{1,64} \d{1,20} \d{1,20} IN IP[46] (\S+)$/)
        if (!origin || !ipLiteral(origin[1]) || media) throw bad()
        count('o')
        break
      }
      case 's':
        if (value.length > 256 || media) throw bad()
        count('s')
        break
      case 't':
        if (!/^\d{1,20} \d{1,20}$/.test(value) || media) throw bad()
        count('t')
        break
      case 'm':
        if (!/^application \d{1,5} UDP\/DTLS\/SCTP webrtc-datachannel$/.test(value)) throw bad()
        media = true
        count('m')
        break
      case 'c': {
        const connection = value.match(/^IN IP([46]) (\S+)$/)
        if (!connection || isIP(connection[2]) !== Number(connection[1])) throw bad()
        count('c')
        break
      }
      case 'a': {
        const separator = value.indexOf(':')
        const name = separator < 0 ? value : value.slice(0, separator),
          option = separator < 0 ? '' : value.slice(separator + 1)
        if (!SESSION_ATTRIBUTES.has(name)) throw bad()
        if (name === 'candidate') {
          if (!media) throw bad()
          const candidate = parseCandidate(value)
          // Lines the policy drops do not count; extra usable candidates are dropped too.
          if (!candidateAllowed(candidate, policy) || candidates.length >= WEBRTC_MAX_CANDIDATES)
            continue
          candidates.push({
            address: candidate.address,
            port: candidate.port,
            type: candidate.type as 'host' | 'srflx'
          })
          break
        }
        if (name === 'fingerprint') {
          const hash = option.match(/^sha-256 ((?:[0-9A-Fa-f]{2}:){31}[0-9A-Fa-f]{2})$/)
          if (!hash) throw bad()
          fingerprint = hash[1].replaceAll(':', '').toLowerCase()
        } else if (name === 'setup') {
          if (option !== 'actpass') throw bad()
        } else if (name === 'ice-ufrag') {
          if (option.length < 4 || option.length > 256 || !ICE_CHARS.test(option)) throw bad()
        } else if (name === 'ice-pwd') {
          if (option.length < 22 || option.length > 256 || !ICE_CHARS.test(option)) throw bad()
        } else if (name === 'group') {
          if (!/^BUNDLE( [A-Za-z0-9_-]{1,32}){0,1}$/.test(option)) throw bad()
        } else if (name === 'mid') {
          if (!/^[A-Za-z0-9_-]{1,32}$/.test(option)) throw bad()
        } else if (name === 'sctp-port' || name === 'max-message-size') {
          if (!/^\d{1,10}$/.test(option)) throw bad()
        } else if (
          name === 'end-of-candidates' ||
          name === 'extmap-allow-mixed' ||
          name === 'sendrecv'
        ) {
          if (separator >= 0) throw bad()
        } else if (option.length > 256) throw bad()
        count(`a=${name}`)
        break
      }
      default:
        throw bad()
    }
    out.push(line)
  }
  for (const key of [
    'v',
    'o',
    's',
    't',
    'm',
    'a=fingerprint',
    'a=ice-ufrag',
    'a=ice-pwd',
    'a=setup'
  ])
    if (once.get(key) !== 1) throw bad()
  if ((once.get('a=mid') ?? 0) > 1 || (once.get('c') ?? 0) > 2) throw bad()
  if (!candidates.length) throw new NetError('route_unreachable')
  return { sdp: out.join('\r\n') + '\r\n', fingerprint, candidates }
}

/**
 * Removes every answer candidate a phone must not learn or use: only this computer's direct
 * host addresses and, with STUN, its public server-reflexive addresses remain.
 */
export function stripAnswer(
  sdp: string,
  allowed: { hosts: ReadonlySet<string>; stun: boolean }
): { sdp: string; candidates: number } {
  let candidates = 0
  const kept = sdp
    .split(/\r?\n/)
    .filter((line) => line !== '')
    .filter((line) => {
      if (!line.startsWith('a=candidate:')) return true
      let candidate: ReturnType<typeof parseCandidate>
      try {
        candidate = parseCandidate(line.slice(2))
      } catch {
        return false
      }
      if (candidate.transport !== 'udp') return false
      const kind = classifyAddress(candidate.address)
      const keep =
        candidate.type === 'host'
          ? allowed.hosts.has(normalizeAddress(candidate.address))
          : candidate.type === 'srflx' && allowed.stun && !!kind && SRFLX_CLASSES.has(kind)
      if (keep) candidates++
      return keep
    })
  return { sdp: kept.join('\r\n') + '\r\n', candidates }
}

/** The fingerprint spelling used for comparisons: lowercase hex without separators. */
export function normalizeFingerprint(value: string): string {
  return value.replaceAll(':', '').toLowerCase()
}

// ---------------------------------------------------------------- native seam

/** A DataChannel, as the acceptor needs it. */
export interface WebRtcChannel {
  label(): string
  protocol(): string
  isOpen(): boolean
  send(bytes: Uint8Array): void
  bufferedAmount(): number
  setBufferedAmountLowThreshold(bytes: number): void
  onOpen(callback: () => void): void
  onClosed(callback: () => void): void
  onError(callback: (message: string) => void): void
  onBufferedAmountLow(callback: () => void): void
  onMessage(callback: (data: Buffer | string) => void): void
  close(): void
}

/** A PeerConnection, as the acceptor needs it. */
export interface WebRtcPeer {
  setRemoteOffer(sdp: string): void
  /** Creates the answer; ICE checks toward the offer's candidates start from here. */
  setLocalAnswer(): void
  localSdp(): string | undefined
  gatheringComplete(): boolean
  onGatheringComplete(callback: () => void): void
  onStateChange(callback: (state: string) => void): void
  onDataChannel(callback: (channel: WebRtcChannel) => void): void
  /** The remote DTLS certificate fingerprint once DTLS completed, normalized. */
  remoteFingerprint(): string | undefined
  close(): void
}

export interface PeerConnectionConfig {
  iceServers: string[]
  portRange: readonly [number, number]
}

/** The native WebRTC stack behind one interface, so another library can replace it. */
export interface PeerConnectionFactory {
  create(config: PeerConnectionConfig): Promise<WebRtcPeer>
}

type NdcModule = typeof import('node-datachannel')
let ndcModule: Promise<NdcModule> | undefined

function loadNodeDataChannel(): Promise<NdcModule> {
  return (ndcModule ??= import('node-datachannel').then((loaded) => {
    const module = ((loaded as unknown as { default?: NdcModule }).default ?? loaded) as NdcModule
    // The receive window bounds what an unread channel can queue inside the native stack.
    module.setSctpSettings({ recvBufferSize: 1024 * 1024 })
    return module
  }))
}

/** `PeerConnectionFactory` over node-datachannel (libdatachannel): UDP only, no TCP. */
export function nodeDataChannelFactory(): PeerConnectionFactory {
  return {
    async create(config) {
      const ndc = await loadNodeDataChannel()
      const pc = new ndc.PeerConnection('mousse-phone', {
        iceServers: config.iceServers,
        enableIceTcp: false,
        enableIceUdpMux: false,
        disableAutoNegotiation: true,
        portRangeBegin: config.portRange[0],
        portRangeEnd: config.portRange[1]
      })
      const gathered = new Set<() => void>()
      pc.onGatheringStateChange((state) => {
        if (state === 'complete') for (const callback of gathered) callback()
      })
      return {
        setRemoteOffer: (sdp) => pc.setRemoteDescription(sdp, 'offer'),
        setLocalAnswer: () => pc.setLocalDescription('answer'),
        localSdp: () => pc.localDescription()?.sdp,
        gatheringComplete: () => pc.gatheringState() === 'complete',
        onGatheringComplete: (callback) => gathered.add(callback),
        onStateChange: (callback) => pc.onStateChange(callback),
        onDataChannel: (callback) =>
          pc.onDataChannel((dc) =>
            callback({
              label: () => dc.getLabel(),
              protocol: () => dc.getProtocol(),
              isOpen: () => dc.isOpen(),
              send: (bytes) => {
                dc.sendMessageBinary(bytes)
              },
              bufferedAmount: () => dc.bufferedAmount(),
              setBufferedAmountLowThreshold: (bytes) => dc.setBufferedAmountLowThreshold(bytes),
              onOpen: (cb) => dc.onOpen(cb),
              onClosed: (cb) => dc.onClosed(cb),
              onError: (cb) => dc.onError(cb),
              onBufferedAmountLow: (cb) => dc.onBufferedAmountLow(cb),
              onMessage: (cb) =>
                dc.onMessage((data) =>
                  cb(typeof data === 'string' || Buffer.isBuffer(data) ? data : Buffer.from(data))
                ),
              close: () => {
                try {
                  dc.close()
                } catch {
                  // Already closed.
                }
              }
            })
          ),
        remoteFingerprint: () => {
          try {
            const value = pc.remoteFingerprint()?.value
            return value ? normalizeFingerprint(value) : undefined
          } catch {
            return undefined
          }
        },
        close: () => {
          gathered.clear()
          try {
            pc.close()
          } catch {
            // Already closed.
          }
        }
      }
    }
  }
}

// ---------------------------------------------------------------- byte stream

const SEND_HIGH_WATER = 1024 * 1024
const SEND_LOW_WATER = 256 * 1024

/**
 * A DataChannel as a `Duplex`. Writes go out in messages of at most 64 KiB and wait for the
 * channel's buffer to drain past 1 MiB. Reads cannot pause the native stack, so a reader that
 * falls more than 8 MiB behind closes the stream; before `secured()`, the peer may send at most
 * 64 KiB.
 */
export class DataChannelDuplex extends Duplex {
  private preauthBytes: number | undefined = 0
  private waiting?: () => void
  constructor(
    private readonly channel: WebRtcChannel,
    private readonly limits: { preauthMaxBytes?: number; inboundMaxBytes?: number } = {}
  ) {
    super({ highWaterMark: WEBRTC_CHUNK_BYTES, allowHalfOpen: false })
    channel.setBufferedAmountLowThreshold(SEND_LOW_WATER)
    channel.onMessage((data) => {
      if (this.destroyed) return
      if (typeof data === 'string') {
        this.destroy(new NetError('bad_request'))
        return
      }
      if (data.length > WEBRTC_CHUNK_BYTES) {
        this.destroy(new NetError('too_large'))
        return
      }
      if (this.preauthBytes !== undefined) {
        this.preauthBytes += data.length
        if (this.preauthBytes > (limits.preauthMaxBytes ?? WEBRTC_PREAUTH_MAX_BYTES)) {
          this.destroy(new NetError('too_large'))
          return
        }
      }
      if (
        this.readableLength + data.length >
        (limits.inboundMaxBytes ?? WEBRTC_INBOUND_MAX_BYTES)
      ) {
        this.destroy(new NetError('too_large'))
        return
      }
      this.push(data)
    })
    channel.onClosed(() => {
      if (this.destroyed) return
      this.push(null)
      this.destroy()
    })
    channel.onError(() => this.destroy(new NetError('peer_offline')))
    channel.onBufferedAmountLow(() => {
      const waiting = this.waiting
      this.waiting = undefined
      waiting?.()
    })
  }
  /** Inner TLS completed: the pre-authentication byte budget no longer applies. */
  secured(): void {
    this.preauthBytes = undefined
  }
  override _read(): void {}
  override _write(
    chunk: Buffer,
    _encoding: BufferEncoding,
    done: (error?: Error | null) => void
  ): void {
    try {
      for (let offset = 0; offset < chunk.length; offset += WEBRTC_CHUNK_BYTES)
        this.channel.send(chunk.subarray(offset, offset + WEBRTC_CHUNK_BYTES))
    } catch {
      done(new NetError('peer_offline'))
      return
    }
    if (this.channel.bufferedAmount() > SEND_HIGH_WATER) this.waiting = () => done()
    else done()
  }
  override _final(done: (error?: Error | null) => void): void {
    done()
  }
  override _destroy(error: Error | null, done: (error?: Error | null) => void): void {
    this.waiting = undefined
    this.channel.close()
    done(error)
  }
}

// ---------------------------------------------------------------- acceptor

/** One accepted offer: bound to the authenticated caller and the offer's DTLS certificate. */
export interface WebRtcTicket {
  readonly id: string
  readonly node: NodeId
  readonly user: UserId
  readonly fingerprint: string
  /** `pending` until the session hello authenticated the ticket's node; then `live`. */
  state(): 'pending' | 'live' | 'closed'
}

/** A DataChannel that opened for a ticket; the owner runs inner TLS and the session on it. */
export interface AcceptedWebRtc {
  raw: DataChannelDuplex
  ticket: WebRtcTicket
  /** The session hello authenticated the ticket's node. */
  authenticated(): void
}

interface TicketState {
  id: string
  node: NodeId
  user: UserId
  fingerprint: string
  state: 'pending' | 'live' | 'closed'
  peer?: WebRtcPeer
  channel?: WebRtcChannel
  raw?: DataChannelDuplex
  timer: { cancel(): void }
}

export interface PhoneWebRtcOptions {
  clock: Clock
  factory: PeerConnectionFactory
  /** STUN servers from Mousse ID configuration; empty for host candidates only. */
  iceServers(): string[]
  /** The DataChannel opened; the pre-authentication deadline starts now. */
  onChannel(accepted: AcceptedWebRtc): void
  /** This computer's direct host addresses (answer candidates). */
  hostAddresses?(): ReadonlySet<string>
  /** Every address of this computer (rejected as offer candidates). */
  ownAddresses?(): ReadonlySet<string>
  /** The relay and STUN servers' addresses (rejected as offer candidates). */
  blockedAddresses?(): ReadonlySet<string>
  gatherMs?: number
  ticketTtlMs?: number
  portRange?: readonly [number, number]
}

/**
 * Accepts WebRTC offers from the user's own phones. Each offer is checked, ticketed and
 * answered by a fresh PeerConnection; the computer sets the remote offer and its own answer
 * before it replies, so its ICE checks leave first and every check from the phone arrives on a
 * flow the computer opened. No socket outlives its ticket.
 */
export class PhoneWebRtcAcceptor {
  private readonly tickets = new Map<string, TicketState>()
  private readonly offers = new Map<NodeId, number[]>()
  private closed = false

  constructor(private readonly options: PhoneWebRtcOptions) {}

  counts(node?: NodeId): { pending: number; live: number } {
    let pending = 0,
      live = 0
    for (const ticket of this.tickets.values()) {
      if (node && ticket.node !== node) continue
      if (ticket.state === 'pending') pending++
      else if (ticket.state === 'live') live++
    }
    return { pending, live }
  }

  /** Answers one offer from an authenticated same-user node. */
  async offer(caller: { node: NodeId; user: UserId }, sdp: unknown): Promise<{ sdp: string }> {
    if (this.closed) throw new NetError('disabled')
    this.admitOffer(caller.node)
    const iceServers = this.options.iceServers()
    const stun = iceServers.length > 0
    const offer = validateOffer(sdp, {
      stun,
      own: this.options.ownAddresses?.() ?? ownAddresses(),
      blocked: this.options.blockedAddresses?.()
    })
    const ticket: TicketState = {
      id: randomBytes(16).toString('base64url'),
      node: caller.node,
      user: caller.user,
      fingerprint: offer.fingerprint,
      state: 'pending',
      timer: this.options.clock.setTimeout(() => {
        if (ticket.state === 'pending') this.close(ticket)
      }, this.options.ticketTtlMs ?? WEBRTC_TICKET_TTL_MS)
    }
    this.tickets.set(ticket.id, ticket)
    try {
      const peer = await this.options.factory.create({
        iceServers,
        portRange: this.options.portRange ?? WEBRTC_PORT_RANGE
      })
      if (ticket.state === 'closed') {
        peer.close()
        throw new NetError('cancelled')
      }
      ticket.peer = peer
      peer.onStateChange((state) => {
        if (state === 'failed' || state === 'closed') this.close(ticket)
      })
      peer.onDataChannel((channel) => this.channel(ticket, channel))
      let gatherTimer: { cancel(): void } | undefined
      const gathered = new Promise<void>((resolve) => {
        peer.onGatheringComplete(resolve)
        gatherTimer = this.options.clock.setTimeout(
          resolve,
          this.options.gatherMs ?? WEBRTC_GATHER_MS
        )
      }).finally(() => gatherTimer?.cancel())
      try {
        // The computer sends first: with the remote offer and the local answer set, its ICE
        // checks toward the phone's candidates start before the phone has the answer.
        peer.setRemoteOffer(offer.sdp)
        peer.setLocalAnswer()
      } catch {
        throw new NetError('bad_request', 'The WebRTC offer is not accepted.')
      }
      if (!peer.gatheringComplete()) await gathered
      if ((ticket.state as TicketState['state']) === 'closed') throw new NetError('cancelled')
      const local = peer.localSdp()
      if (!local) throw new NetError('route_unreachable')
      const answer = stripAnswer(local, {
        hosts: this.options.hostAddresses?.() ?? directHostAddresses(),
        stun
      })
      if (!answer.candidates || Buffer.byteLength(answer.sdp) > WEBRTC_SDP_MAX_BYTES)
        throw new NetError('route_unreachable')
      return { sdp: answer.sdp }
    } catch (error) {
      this.close(ticket)
      // Native errors may quote the SDP; never pass them on.
      throw error instanceof NetError ? new NetError(error.code) : new NetError('route_unreachable')
    }
  }

  /** Nodes that hold a ticket. */
  nodes(): NodeId[] {
    return [...new Set([...this.tickets.values()].map((ticket) => ticket.node))]
  }

  /** Closes every ticket and connection of a node (revocation). */
  closeNode(node: NodeId): void {
    for (const ticket of [...this.tickets.values()]) if (ticket.node === node) this.close(ticket)
  }

  /** Closes every ticket and connection; later offers start again unless `stop` was used. */
  closeAll(): void {
    for (const ticket of [...this.tickets.values()]) this.close(ticket)
  }

  /** Closes everything and refuses later offers. */
  stop(): void {
    this.closed = true
    this.closeAll()
    this.offers.clear()
  }

  private admitOffer(node: NodeId): void {
    const now = this.options.clock.monotonic()
    const recent = (this.offers.get(node) ?? []).filter((at) => now - at < 60_000)
    if (recent.length >= WEBRTC_OFFERS_PER_MINUTE) {
      this.offers.set(node, recent)
      throw new NetError('rate_limited')
    }
    const mine = this.counts(node),
      all = this.counts()
    // A pending ticket becomes a live session when it authenticates, so it holds a live slot.
    if (
      mine.pending >= WEBRTC_PENDING_PER_NODE ||
      all.pending >= WEBRTC_PENDING_MAX ||
      mine.live + mine.pending >= WEBRTC_LIVE_PER_NODE ||
      all.live + all.pending >= WEBRTC_LIVE_MAX
    ) {
      this.offers.set(node, recent)
      throw new NetError('rate_limited')
    }
    recent.push(now)
    this.offers.set(node, recent)
    for (const [other, times] of this.offers)
      if (other !== node && times.every((at) => now - at >= 60_000)) this.offers.delete(other)
  }

  private channel(ticket: TicketState, channel: WebRtcChannel): void {
    if (
      ticket.state !== 'pending' ||
      ticket.channel ||
      channel.label() !== PHONE_WEBRTC_LABEL ||
      channel.protocol() !== ''
    ) {
      channel.close()
      this.close(ticket)
      return
    }
    ticket.channel = channel
    const raw = new DataChannelDuplex(channel)
    ticket.raw = raw
    raw.once('close', () => this.close(ticket))
    const opened = () => {
      if (ticket.state !== 'pending' || raw.destroyed) return
      const remote = ticket.peer?.remoteFingerprint()
      if (remote !== undefined && remote !== ticket.fingerprint) {
        this.close(ticket)
        return
      }
      const view: WebRtcTicket = {
        id: ticket.id,
        node: ticket.node,
        user: ticket.user,
        fingerprint: ticket.fingerprint,
        state: () => ticket.state
      }
      try {
        this.options.onChannel({
          raw,
          ticket: view,
          authenticated: () => {
            if (ticket.state !== 'pending') return
            ticket.state = 'live'
            ticket.timer.cancel()
          }
        })
      } catch {
        this.close(ticket)
      }
    }
    if (channel.isOpen()) opened()
    else channel.onOpen(opened)
  }

  private close(ticket: TicketState): void {
    if (ticket.state === 'closed') return
    ticket.state = 'closed'
    ticket.timer.cancel()
    this.tickets.delete(ticket.id)
    ticket.raw?.destroy()
    ticket.channel?.close()
    ticket.peer?.close()
  }
}
