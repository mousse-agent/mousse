/**
 * Routes as the app reads them (Phase 1b design §1.1, §1.2): the four kinds, their grammar, and the class of the
 * address each one reaches. The helper is the authority on every route it dials; the app reads routes to show
 * them, to say which need the owner's approval, and to refuse a typo before asking the helper. Pure, so a window
 * can use it too.
 */

/** A route kind (§1.1). `ws` is plain WebSocket to a tunnel client on this computer; `ssh` never crosses the wire. */
export type RouteKind = 'tcp' | 'wss' | 'ws' | 'ssh'

/** The class of an address (§1.2), plus the two route kinds that are a class of their own on a device's row. */
export type RouteClass = 'lan' | 'tailnet' | 'public' | 'tunnel' | 'ssh'

/** What `classifyIp` says of an address: one of the three dialable classes, or `forbidden`. */
export type AddressClass = 'lan' | 'tailnet' | 'public' | 'forbidden'

export interface ParsedRoute {
  kind: RouteKind
  /** Lower-case host: an IPv4 literal, an IPv6 literal without brackets, or a DNS name (an SSH alias for `ssh`). */
  host: string
  /** The port, explicit or the kind's default (443 for `wss`, 22 for `ssh` when none is given). */
  port: number
  /** Whether the text named the port. */
  explicitPort: boolean
  /** `ws` and `wss`: the path, ending in `/mousse-net/1`. */
  path?: string
  /** `ssh`: the user part, when given. */
  user?: string
  /** Whether `host` is an IP literal (not a name). */
  literal: boolean
  /** The canonical form: scheme, lower-case host, explicit port and path (`wss://x.example:443/mousse-net/1`). */
  canonical: string
}

export const WS_PATH_SUFFIX = '/mousse-net/1'
const PATH_MAX_BYTES = 200

// ---------------------------------------------------------------- addresses

/** Four decimal parts 0 to 255 with no leading zeros, or undefined (wire 10.2.1). */
export function parseIpv4(text: string): [number, number, number, number] | undefined {
  const parts = text.split('.')
  if (parts.length !== 4) return undefined
  const out: number[] = []
  for (const part of parts) {
    if (!/^(0|[1-9][0-9]{0,2})$/.test(part)) return undefined
    const value = Number(part)
    if (value > 255) return undefined
    out.push(value)
  }
  return out as [number, number, number, number]
}

/** An RFC 4291 §2.2 text form (an embedded IPv4 part allowed, no zone id) as its 16 bytes, or undefined. */
export function parseIpv6(text: string): Uint8Array | undefined {
  if (!text || /[^0-9A-Fa-f:.]/.test(text)) return undefined
  let head = text,
    tail4: number[] = []
  const lastColon = text.lastIndexOf(':')
  if (text.includes('.')) {
    const v4 = parseIpv4(text.slice(lastColon + 1))
    if (!v4) return undefined
    tail4 = v4
    head = text.slice(0, lastColon + 1)
    // `::1.2.3.4` leaves `::`; `a::1.2.3.4` leaves `a::`; `a:b:...:1.2.3.4` leaves a trailing single colon.
    if (head.endsWith(':') && !head.endsWith('::')) head = head.slice(0, -1)
  }
  const groupsWanted = tail4.length ? 6 : 8
  const halves = head.split('::')
  if (halves.length > 2) return undefined
  const read = (part: string): number[] | undefined => {
    if (part === '') return []
    const groups = part.split(':')
    const out: number[] = []
    for (const group of groups) {
      if (!/^[0-9A-Fa-f]{1,4}$/.test(group)) return undefined
      out.push(parseInt(group, 16))
    }
    return out
  }
  const left = read(halves[0]!)
  const right = halves.length === 2 ? read(halves[1]!) : []
  if (!left || !right) return undefined
  let groups: number[]
  if (halves.length === 2) {
    const missing = groupsWanted - left.length - right.length
    if (missing < 1) return undefined
    groups = [...left, ...new Array<number>(missing).fill(0), ...right]
  } else {
    if (left.length !== groupsWanted) return undefined
    groups = left
  }
  const bytes = new Uint8Array(16)
  groups.forEach((group, i) => {
    bytes[i * 2] = group >> 8
    bytes[i * 2 + 1] = group & 0xff
  })
  if (tail4.length) bytes.set(tail4, 12)
  return bytes
}

const inV4 = (ip: number[], base: number[], bits: number): boolean => {
  for (let i = 0; i < 4; i++) {
    const take = Math.max(0, Math.min(8, bits - i * 8))
    if (!take) return true
    const mask = (0xff << (8 - take)) & 0xff
    if ((ip[i]! & mask) !== (base[i]! & mask)) return false
  }
  return true
}

const inV6 = (ip: Uint8Array, base: number[], bits: number): boolean => {
  for (let i = 0; i < 16; i++) {
    const take = Math.max(0, Math.min(8, bits - i * 8))
    if (!take) return true
    const mask = (0xff << (8 - take)) & 0xff
    if ((ip[i]! & mask) !== ((base[i] ?? 0) & mask)) return false
  }
  return true
}

/** IPv4 ranges that are never dialled (§1.2): unspecified, loopback, multicast, reserved, documentation, benchmarking. */
const V4_FORBIDDEN: Array<[number[], number]> = [
  [[0, 0, 0, 0], 8],
  [[127, 0, 0, 0], 8],
  [[224, 0, 0, 0], 4],
  [[240, 0, 0, 0], 4],
  [[192, 0, 0, 0], 24],
  [[192, 0, 2, 0], 24],
  [[198, 51, 100, 0], 24],
  [[203, 0, 113, 0], 24],
  [[198, 18, 0, 0], 15]
]

function classifyV4(ip: number[]): AddressClass {
  if (inV4(ip, [100, 64, 0, 0], 10)) return 'tailnet'
  if (
    inV4(ip, [10, 0, 0, 0], 8) ||
    inV4(ip, [172, 16, 0, 0], 12) ||
    inV4(ip, [192, 168, 0, 0], 16) ||
    inV4(ip, [169, 254, 0, 0], 16)
  )
    return 'lan'
  if (V4_FORBIDDEN.some(([base, bits]) => inV4(ip, base, bits))) return 'forbidden'
  return 'public'
}

/**
 * The class of an IP literal (§1.2): an allowlist, so an address in no listed range is `forbidden`. An IPv4-mapped
 * IPv6 address takes the class of its IPv4 address. Undefined for text that is not an IP literal.
 */
export function classifyIp(text: string): AddressClass | undefined {
  const bare = text.startsWith('[') && text.endsWith(']') ? text.slice(1, -1) : text
  const v4 = parseIpv4(bare)
  if (v4) return classifyV4(v4)
  const v6 = parseIpv6(bare)
  if (!v6) return undefined
  // ::ffff:a.b.c.d
  if (v6.subarray(0, 10).every((byte) => byte === 0) && v6[10] === 0xff && v6[11] === 0xff)
    return classifyV4([...v6.subarray(12)])
  if (inV6(v6, [0xfd, 0x7a, 0x11, 0x5c, 0xa1, 0xe0], 48)) return 'tailnet'
  if (inV6(v6, [0xfc], 7)) return 'lan'
  if (
    inV6(v6, [0x20, 0x01, 0x0d, 0xb8], 32) ||
    inV6(v6, [0x20, 0x02], 16) ||
    inV6(v6, [0, 0x64, 0xff, 0x9b], 96) ||
    inV6(v6, [0, 0x64, 0xff, 0x9b, 0, 1], 48)
  )
    return 'forbidden'
  if (inV6(v6, [0x20], 3)) return 'public'
  return 'forbidden'
}

/** Whether an IP literal is loopback (`127.0.0.0/8` or `::1`). */
export function isLoopbackIp(text: string): boolean {
  const bare = text.startsWith('[') && text.endsWith(']') ? text.slice(1, -1) : text
  const v4 = parseIpv4(bare)
  if (v4) return v4[0] === 127
  const v6 = parseIpv6(bare)
  return !!v6 && v6.subarray(0, 15).every((byte) => byte === 0) && v6[15] === 1
}

// ---------------------------------------------------------------- routes

/** A DNS name as wire 10.2.1 reads one: labels of letters, digits and `-`, at most 253 bytes, the last not all digits. */
function dnsName(text: string): string | undefined {
  if (!text || text.length > 253 || text.endsWith('.')) return undefined
  const labels = text.split('.')
  for (const label of labels)
    if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/.test(label)) return undefined
  if (/^[0-9]+$/.test(labels[labels.length - 1]!)) return undefined
  return text.toLowerCase()
}

/** `<host>` and `:<port>` of an authority, as wire 10.2.1 reads them; `port` undefined when none was given. */
function authority(
  text: string,
  portRequired: boolean
): { host: string; port?: number; literal: boolean; v6: boolean } | undefined {
  let host: string,
    rest: string
  if (text.startsWith('[')) {
    const close = text.indexOf(']')
    if (close < 0) return undefined
    host = text.slice(1, close)
    rest = text.slice(close + 1)
    if (!parseIpv6(host)) return undefined
  } else {
    const colon = text.lastIndexOf(':')
    host = colon >= 0 ? text.slice(0, colon) : text
    rest = colon >= 0 ? text.slice(colon) : ''
  }
  let port: number | undefined
  if (rest) {
    const match = /^:([1-9][0-9]{0,4})$/.exec(rest)
    if (!match || Number(match[1]) > 65535) return undefined
    port = Number(match[1])
  } else if (portRequired) return undefined
  if (text.startsWith('[')) return { host: host.toLowerCase(), port, literal: true, v6: true }
  if (/^[0-9.]+$/.test(host))
    return parseIpv4(host) ? { host, port, literal: true, v6: false } : undefined
  const name = dnsName(host)
  return name ? { host: name, port, literal: false, v6: false } : undefined
}

const bracket = (host: string, v6: boolean) => (v6 ? `[${host}]` : host)

/** Reads a route (§1.1); undefined for text that breaks its kind's grammar or names another scheme. */
export function parseRoute(text: string): ParsedRoute | undefined {
  const value = text.trim()
  const scheme = /^(tcp|wss|ws|ssh):\/\//.exec(value)?.[1] as RouteKind | undefined
  if (!scheme) return undefined
  const rest = value.slice(scheme.length + 3)
  if (scheme === 'tcp') {
    const parsed = authority(rest, true)
    if (!parsed) return undefined
    return {
      kind: 'tcp',
      host: parsed.host,
      port: parsed.port!,
      explicitPort: true,
      literal: parsed.literal,
      canonical: `tcp://${bracket(parsed.host, parsed.v6)}:${parsed.port}`
    }
  }
  if (scheme === 'ws' || scheme === 'wss') {
    const slash = rest.indexOf('/')
    if (slash < 0) return undefined
    const path = rest.slice(slash)
    if (
      path.length > PATH_MAX_BYTES ||
      !/^\/[A-Za-z0-9._~/-]*$/.test(path) ||
      !path.endsWith(WS_PATH_SUFFIX)
    )
      return undefined
    const parsed = authority(rest.slice(0, slash), scheme === 'ws')
    if (!parsed) return undefined
    // A plain `ws` host is a loopback literal: the local hop of a tunnel client on this computer.
    if (scheme === 'ws' && !(parsed.literal && isLoopbackIp(parsed.host))) return undefined
    const port = parsed.port ?? 443
    return {
      kind: scheme,
      host: parsed.host,
      port,
      explicitPort: parsed.port !== undefined,
      path,
      literal: parsed.literal,
      canonical: `${scheme}://${bracket(parsed.host, parsed.v6)}:${port}${path}`
    }
  }
  // ssh://[<user>@]<target>[:<port>]
  const at = rest.lastIndexOf('@')
  const user = at >= 0 ? rest.slice(0, at) : undefined
  if (user !== undefined && !/^[A-Za-z0-9._][A-Za-z0-9._-]{0,63}$/.test(user)) return undefined
  if (user !== undefined && user.length > 64) return undefined
  const target = at >= 0 ? rest.slice(at + 1) : rest
  const ssh = sshTarget(target)
  if (!ssh) return undefined
  return {
    kind: 'ssh',
    host: ssh.host,
    port: ssh.port ?? 22,
    explicitPort: ssh.port !== undefined,
    ...(user ? { user } : {}),
    literal: ssh.literal,
    canonical: `ssh://${user ? `${user}@` : ''}${bracket(ssh.host, ssh.v6)}${ssh.port ? `:${ssh.port}` : ''}`
  }
}

/** An SSH target: an IP literal, or a name of 1 to 253 bytes of `[A-Za-z0-9._-]` not starting with `-` (aliases too). */
function sshTarget(
  text: string
): { host: string; port?: number; literal: boolean; v6: boolean } | undefined {
  if (text.startsWith('[')) return authority(text, false)
  const colon = text.lastIndexOf(':')
  const host = colon >= 0 ? text.slice(0, colon) : text
  let port: number | undefined
  if (colon >= 0) {
    const match = /^([1-9][0-9]{0,4})$/.exec(text.slice(colon + 1))
    if (!match || Number(match[1]) > 65535) return undefined
    port = Number(match[1])
  }
  if (parseIpv4(host)) return { host, port, literal: true, v6: false }
  if (!/^[A-Za-z0-9._][A-Za-z0-9._-]{0,252}$/.test(host)) return undefined
  return { host: host.toLowerCase(), port, literal: false, v6: false }
}

/** What an SSH target typed by the owner reads as: `user@host`, an alias, or either with `:port`. */
export function parseSshTarget(text: string): { user?: string; host: string; port?: number } | undefined {
  const value = text.trim().replace(/^ssh:\/\//, '')
  if (!value || value.startsWith('-')) return undefined
  const parsed = parseRoute(`ssh://${value}`)
  if (!parsed) return undefined
  return {
    ...(parsed.user ? { user: parsed.user } : {}),
    host: parsed.host,
    ...(parsed.explicitPort ? { port: parsed.port } : {})
  }
}

/**
 * The class a route reaches (§1.2, §7 `conn.up.route.class`): an IP literal's class, `public` for a `tcp` name,
 * `tunnel` for `ws` and `wss`, `ssh` for `ssh`. `forbidden` for a literal no route may dial.
 */
export function routeClass(route: ParsedRoute): RouteClass | 'forbidden' {
  if (route.kind === 'ssh') return 'ssh'
  if (route.kind === 'ws' || route.kind === 'wss') return 'tunnel'
  if (!route.literal) return 'public'
  return classifyIp(route.host) ?? 'forbidden'
}

/** The short label a class reads as on a row or in a list. */
export const ROUTE_CLASS_LABEL: Readonly<Record<RouteClass, string>> = Object.freeze({
  lan: 'LAN',
  tailnet: 'Tailnet',
  public: 'Internet',
  tunnel: 'Tunnel',
  ssh: 'SSH'
})

/** A route as a person reads it: the host and port without the scheme, the path left off. */
export function routeText(route: string): string {
  const parsed = parseRoute(route)
  if (!parsed) return route
  if (parsed.kind === 'tcp') return parsed.canonical.slice('tcp://'.length)
  if (parsed.kind === 'ssh') return parsed.canonical.slice('ssh://'.length)
  const host = parsed.host.includes(':') ? `[${parsed.host}]` : parsed.host
  return parsed.kind === 'wss' && !parsed.explicitPort ? host : `${host}:${parsed.port}`
}

/**
 * 1a's automatic rule (§1.3): a `tcp` route to a private-range IP literal is dialled without asking. Loopback
 * counts too where `loopback` is set (debug builds, so checks run on one computer).
 */
export function automaticRoute(route: string, loopback = false): boolean {
  const parsed = parseRoute(route)
  if (!parsed || parsed.kind !== 'tcp' || !parsed.literal) return false
  if (loopback && isLoopbackIp(parsed.host)) return true
  return classifyIp(parsed.host) === 'lan'
}

/**
 * A ticket's route hints as the Connect dialog lists them (§1.3): each dialable hint with its class, in the
 * ticket's order. `ws`, `ssh`, other schemes, broken hints and forbidden literals are skipped (loopback is kept
 * where `loopback` is set). `automatic` hints need no approval; the rest are what Connect approves.
 */
export function ticketDestinations(
  hints: readonly string[],
  loopback = false
): Array<{ route: string; label: string; cls: RouteClass; automatic: boolean }> {
  const out: Array<{ route: string; label: string; cls: RouteClass; automatic: boolean }> = []
  for (const hint of hints) {
    const parsed = parseRoute(hint)
    if (!parsed || (parsed.kind !== 'tcp' && parsed.kind !== 'wss')) continue
    let cls = routeClass(parsed)
    if (cls === 'forbidden') {
      if (!(loopback && parsed.literal && isLoopbackIp(parsed.host))) continue
      cls = 'lan'
    }
    out.push({ route: hint, label: routeText(hint), cls, automatic: automaticRoute(hint, loopback) })
  }
  return out
}

/**
 * What an owner typed for Add address, as a route (§1.3: every owner kind but `ssh`, which Add over SSH sets up):
 * `host:port` and `tcp://` are `tcp`; `https://x[/path]` is the tunnel `wss://x/…/mousse-net/1`; `wss://` and a
 * loopback `ws://` are taken as they are. Undefined when it is none of these.
 */
export function ownerRoute(text: string): string | undefined {
  const value = text.trim()
  if (!value) return undefined
  if (/^https:\/\//i.test(value)) return tunnelRoute(value)
  if (/^(wss|ws):\/\//.test(value)) {
    const parsed = parseRoute(value)
    return parsed ? parsed.canonical : undefined
  }
  const bare = value.startsWith('tcp://') ? value : `tcp://${value}`
  const parsed = parseRoute(bare)
  return parsed?.kind === 'tcp' ? parsed.canonical : undefined
}

/**
 * A tunnel's public URL as the route peers dial (§4.3): `https://x` is stored as `wss://x/mousse-net/1`, a path
 * given is kept with the suffix added when missing. Undefined for anything that does not make a valid `wss` route.
 */
export function tunnelRoute(url: string): string | undefined {
  const value = url.trim()
  const match = /^(https|wss):\/\/([^/?#]+)(\/[^?#]*)?$/i.exec(value)
  if (!match) return undefined
  let path = (match[3] ?? '').replace(/\/+$/, '')
  if (!path.endsWith(WS_PATH_SUFFIX)) path = `${path}${WS_PATH_SUFFIX}`
  const parsed = parseRoute(`wss://${match[2]}${path}`)
  if (!parsed) return undefined
  // Stored as given (default port left off), so the same URL is the same entry.
  return parsed.explicitPort ? parsed.canonical : `wss://${match[2]!.toLowerCase()}${path}`
}
