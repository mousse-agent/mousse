import {
  automaticRoute,
  isLoopbackIp,
  parseRoute,
  routeClass,
  ticketDestinations
} from '../../shared/netEngine/routes'
import { engineControl, packagedBuild } from './limits'

/** 1a's limit on the routes a pairback carries, and on each one's length (1b §1.3 keeps it). */
export const PAIRBACK_MAX_ROUTES = 8
export const PAIRBACK_MAX_ROUTE_BYTES = 255

/**
 * Whether a `tcp://` route is an address in a private range, as the helper reads one (design §5.3, 1b §1.2): 10/8,
 * 172.16/12, 192.168/16, 169.254/16 or fc00::/7 outside the tailnet range, an IPv4-mapped address as its IPv4.
 * Loopback, tailnet (100.64/10) and public addresses are not; nor is a name.
 */
export function privateRoute(route: string): boolean {
  return automaticRoute(route)
}

/**
 * Whether this build's helper dials loopback without approval: an unpackaged build's debug helper does, so checks
 * run on one computer, unless the checks map loopback to another class (`MOUSSE_NET_TEST_CLASS_MAP`, which the
 * debug helper reads too).
 */
function loopbackAutomatic(): boolean {
  return !packagedBuild() && !process.env.MOUSSE_NET_TEST_CLASS_MAP?.trim()
}

/**
 * 1a's automatic rule as this build's helper applies it (1b §1.3): private-range `tcp` literals, and loopback too
 * in an unpackaged build.
 */
export function automatic(route: string): boolean {
  return automaticRoute(route, loopbackAutomatic())
}

/**
 * What Connect approves (§1.3): every dialable hint of the ticket outside the private ranges, as the join's
 * `approved`. Loopback hints of an unpackaged build count too, whatever class the checks map them to; approving an
 * automatic hint changes nothing. A relay hint is approved as its destination, `relay://host:port` (Phase 3
 * §B.11, source `ticket`). Under the `lan-only-candidates` control, none.
 */
export function approvedHints(hints: readonly string[]): string[] {
  if (engineControl('lan-only-candidates')) return []
  return ticketDestinations(hints, !packagedBuild())
    .filter((hint) => !privateRoute(hint.route))
    .map((hint) => hint.destination ?? hint.route)
}

/**
 * The routes a joiner's pairback carries (§1.3): its advertised routes under the automatic rule, then those the
 * owner ticked under "Also share", within 1a's limits. Under the `route-leak` control, its loopback listener first.
 */
export function pairbackRoutes(info: Record<string, unknown>, share: readonly string[]): string[] {
  const advertised = Array.isArray(info.routes)
    ? info.routes.filter((route): route is string => typeof route === 'string')
    : []
  const out: string[] = []
  const push = (route: string) => {
    if (!out.includes(route) && route.length <= PAIRBACK_MAX_ROUTE_BYTES) out.push(route)
  }
  if (engineControl('route-leak') && typeof info.port === 'number')
    push(`tcp://127.0.0.1:${info.port}`)
  for (const route of advertised) if (automatic(route)) push(route)
  for (const route of share) {
    const parsed = parseRoute(route)
    if (parsed && (parsed.kind === 'tcp' || parsed.kind === 'wss')) push(route)
  }
  return out.slice(0, PAIRBACK_MAX_ROUTES)
}

/**
 * The host's reading of a pairback's routes (§1.3): those under the automatic rule go to `peer.add`; other `tcp`
 * and `wss` routes are held as suggestions ("Addresses <B> offered") until the owner taps Use; forbidden literals
 * are dropped. Plain `ws` and `ssh` are refused (undefined).
 */
export function splitPairback(
  routes: readonly string[]
): { automatic: string[]; offered: string[] } | undefined {
  const out = { automatic: [] as string[], offered: [] as string[] }
  for (const route of routes.slice(0, PAIRBACK_MAX_ROUTES)) {
    if (route.length > PAIRBACK_MAX_ROUTE_BYTES) continue
    const parsed = parseRoute(route)
    if (!parsed) continue
    if (parsed.kind === 'ws' || parsed.kind === 'ssh') return undefined
    if (automatic(route)) {
      out.automatic.push(route)
      continue
    }
    const loopback = parsed.literal && isLoopbackIp(parsed.host) && !packagedBuild()
    if (routeClass(parsed) === 'forbidden' && !loopback) continue
    out.offered.push(route)
  }
  return out
}
