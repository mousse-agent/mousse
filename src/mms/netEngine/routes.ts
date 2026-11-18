import { isIPv4, isIPv6 } from 'node:net'

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
