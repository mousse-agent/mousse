import { isIPv4, isIPv6 } from 'node:net'
import type { NetEngineRouteClass } from '../../shared/netEngine/local'

/**
 * Whether a `tcp://` route is an address in a private range, as the helper reads one (design §5.3): 10/8,
 * 172.16/12, 192.168/16, 169.254/16 or fc00::/7, an IPv4-mapped address as its IPv4. Loopback, CGNAT and tailnet
 * (100.64/10) and public addresses are not; nor is a name.
 */
export function privateRoute(route: string): boolean {
  const match = /^tcp:\/\/(?:\[([0-9A-Fa-f:.]+)\]|([0-9.]+)):[0-9]{1,5}$/.exec(route.trim())
  if (!match) return false
  return match[1] !== undefined ? privateIpv6(match[1]) : privateIpv4(match[2]!)
}

function privateIpv4(ip: string): boolean {
  if (!isIPv4(ip)) return false
  const [a, b] = ip.split('.').map(Number) as [number, number]
  return (
    a === 10 ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 169 && b === 254)
  )
}

function privateIpv6(ip: string): boolean {
  if (!isIPv6(ip)) return false
  const mapped = /^::ffff:([0-9.]+)$/i.exec(ip)
  if (mapped) return privateIpv4(mapped[1]!)
  const first = ip.startsWith(':') ? 0 : parseInt(ip.split(':')[0]!, 16)
  return (first & 0xfe00) === 0xfc00
}

/** Where a destination is, as the join dialog labels it (design 1b §1.2, §1.3). */
export type DestinationClass = NetEngineRouteClass

/**
 * The class of a route a ticket names, or undefined for one the helper skips (plain `ws`, `ssh`, a reserved kind)
 * or never dials (a forbidden address: loopback, multicast, documentation ranges...). `tcp` to a name is `public`:
 * the helper classifies what it resolves to and drops forbidden addresses then.
 */
export function destinationClass(route: string): DestinationClass | undefined {
  const text = route.trim()
  if (/^wss:\/\/[A-Za-z0-9.-]+(?::[0-9]{1,5})?\/[A-Za-z0-9._~/-]*\/mousse-net\/1$/.test(text))
    return 'tunnel'
  const match = /^tcp:\/\/(?:\[([0-9A-Fa-f:.]+)\]|([^:/\s]+)):([0-9]{1,5})$/.exec(text)
  if (!match) return undefined
  if (match[1] !== undefined) return ipv6Class(match[1])
  const host = match[2]!
  if (isIPv4(host)) return ipv4Class(host)
  return /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)*$/.test(
    host
  )
    ? 'public'
    : undefined
}

function ipv4Class(ip: string): DestinationClass | undefined {
  const [a, b, c] = ip.split('.').map(Number) as [number, number, number]
  if (privateIpv4(ip)) return 'lan'
  if (a === 100 && b >= 64 && b <= 127) return 'tailnet'
  const forbidden =
    a === 0 ||
    a === 127 ||
    a >= 224 ||
    (a === 192 && b === 0 && (c === 0 || c === 2)) ||
    (a === 198 && (b === 18 || b === 19)) ||
    (a === 198 && b === 51 && c === 100) ||
    (a === 203 && b === 0 && c === 113) ||
    (a === 192 && b === 88 && c === 99)
  return forbidden ? undefined : 'public'
}

function ipv6Class(ip: string): DestinationClass | undefined {
  if (!isIPv6(ip)) return undefined
  const mapped = /^::ffff:([0-9.]+)$/i.exec(ip)
  if (mapped) return isIPv4(mapped[1]!) ? ipv4Class(mapped[1]!) : undefined
  const lower = ip.toLowerCase()
  if (lower.startsWith('fd7a:115c:a1e0:')) return 'tailnet'
  if (privateIpv6(ip)) return 'lan'
  const first = lower.startsWith(':') ? 0 : parseInt(lower.split(':')[0]!, 16)
  if ((first & 0xe000) !== 0x2000) return undefined
  // Documentation, 6to4 and NAT64 ranges inside 2000::/3.
  if (lower.startsWith('2001:db8:') || lower.startsWith('2002:') || first === 0x64) return undefined
  return 'public'
}
