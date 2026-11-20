import { NetError } from '../../shared/net/errors'
import {
  RELAY_REASON_TEXT,
  type NetEngineDeviceRelay,
  type NetEngineRelay,
  type NetEngineRelays
} from '../../shared/netEngine/local'
import { parseRelayDestination } from '../../shared/netEngine/routes'
import { helperCode } from './helper/appChannel'

/**
 * Relays as the app reads them from its helper (Phase 3 §B.5, §B.9, §B.11): this computer's own relays
 * (`relay.list`, `relay.state`), what each pairing's relays need from the owner (`peers.list[].relay`), and which
 * pairings are past this computer's relay limit (`grants.list[].relay`).
 */

/** One pairing's relays, as `peers.list` says. */
export interface PeerRelayView {
  routes: Array<{ destination: string; approved: boolean; source?: string }>
  /** Its manifest's expiry (seconds since 1970) and whether the helper read it stale. */
  manifest?: { expiresAt: number; stale: boolean }
}

/** What the app knows of relays from the helper running now. */
export interface RelayView {
  available: boolean
  /** Own relays, by id, in the helper's order. */
  relays: Map<string, NetEngineRelay>
  /** Each pairing's relays, by its identity. */
  peers: Map<string, PeerRelayView>
  /** Each caller's relay entry at this host (`listed`, `limit`, `no_key`), by identity. */
  grants: Map<string, string>
}

const STATES = new Set<NetEngineRelay['state']>(['registered', 'connecting', 'retrying', 'refused'])
/** Where an approval of a relay route came from; any other source is not the owner's to take back here. */
const SOURCES = new Set(['ticket', 'owner', 'manifest'])

const num = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) ? value : undefined

/** A `RelayInfo` (`relay.list`, `relay.enroll`, `relay.state`) as the status shows it; `now` dates `retry_ms`. */
export function readRelayInfo(value: unknown, now: number): NetEngineRelay | undefined {
  if (!value || typeof value !== 'object') return undefined
  const info = value as Record<string, unknown>
  if (typeof info.id !== 'string' || typeof info.endpoint !== 'string') return undefined
  const state = STATES.has(info.state as NetEngineRelay['state'])
    ? (info.state as NetEngineRelay['state'])
    : 'connecting'
  const retryMs = num(info.retry_ms)
  const until = num(info.rotating_until)
  return {
    id: info.id,
    endpoint: info.endpoint,
    state,
    ...(typeof info.reason === 'string' && state !== 'registered' ? { reason: info.reason } : {}),
    ...(state === 'retrying' && retryMs !== undefined ? { retryAt: now + retryMs } : {}),
    callers: num(info.callers) ?? 0,
    // The helper names its own limit; none is assumed here.
    ...(num(info.callers_max) !== undefined ? { callersMax: num(info.callers_max) } : {}),
    ...(until !== undefined && until * 1000 > now ? { rotatingUntil: until * 1000 } : {}),
    // `relay.rotate` answers before the relay takes the new key; `rotating_until` comes with a later `relay.state`.
    ...(info.new_key_pending === true ? { newKeyPending: true } : {})
  }
}

/** `relay.list`'s answer. */
export function readRelayList(answer: Record<string, unknown>, now: number): Map<string, NetEngineRelay> {
  const out = new Map<string, NetEngineRelay>()
  for (const item of Array.isArray(answer.relays) ? answer.relays : []) {
    const relay = readRelayInfo(item, now)
    if (relay) out.set(relay.id, relay)
  }
  return out
}

/** `peers.list[].relay` of each pairing, by identity. */
export function readPeerRelays(answer: Record<string, unknown> | undefined): Map<string, PeerRelayView> {
  const out = new Map<string, PeerRelayView>()
  for (const peer of Array.isArray(answer?.peers) ? answer.peers : []) {
    if (!peer || typeof peer.identity !== 'string' || !peer.relay || typeof peer.relay !== 'object')
      continue
    const relay = peer.relay as Record<string, unknown>
    const routes: PeerRelayView['routes'] = []
    for (const route of Array.isArray(relay.routes) ? relay.routes : []) {
      if (!route || typeof route.destination !== 'string') continue
      const destination = parseRelayDestination(route.destination)?.destination
      if (!destination || routes.some((item) => item.destination === destination)) continue
      routes.push({
        destination,
        approved: route.approved === true,
        ...(typeof route.source === 'string' ? { source: route.source } : {})
      })
    }
    const manifest = relay.manifest as Record<string, unknown> | null | undefined
    const expiresAt = num(manifest?.expires_at)
    out.set(peer.identity.toLowerCase(), {
      routes,
      ...(manifest && expiresAt !== undefined
        ? { manifest: { expiresAt, stale: manifest.stale === true } }
        : {})
    })
  }
  return out
}

/** `grants.list[].relay` of each caller, by identity: `limit` wins over the others. */
export function readGrantRelays(answer: Record<string, unknown> | undefined): Map<string, string> {
  const out = new Map<string, string>()
  for (const grant of Array.isArray(answer?.grants) ? answer.grants : []) {
    if (!grant || typeof grant.identity !== 'string' || typeof grant.relay !== 'string') continue
    const identity = grant.identity.toLowerCase()
    if (out.get(identity) !== 'limit') out.set(identity, grant.relay)
  }
  return out
}

/** The key of one pairing's relay destination in the dismissed set (`Not now`, `Stop using relay`). */
export const dismissKey = (identity: string, destination: string): string =>
  `${identity.toLowerCase()} ${destination}`

/**
 * What one pairing's row shows about relays, or undefined when nothing needs showing. `dismissed` holds the
 * destinations the owner said Not now to or stopped using (`dismissKey`): they are not asked about again. At most
 * `offersShown` are asked about at once; the rest wait their turn.
 */
export function deviceRelay(
  view: RelayView | undefined,
  identity: string,
  now: number,
  dismissed: ReadonlySet<string> = new Set(),
  offersShown = Number.POSITIVE_INFINITY
): NetEngineDeviceRelay | undefined {
  if (!view) return undefined
  const key = identity.toLowerCase()
  const peer = view.peers.get(key)
  const offered = (
    peer?.routes
      .filter((route) => !route.approved && !dismissed.has(dismissKey(key, route.destination)))
      .map((route) => route.destination) ?? []
  ).slice(0, offersShown)
  // Approved through a source of this pairing's own; one approved as this computer's own relay has none.
  const allowed =
    peer?.routes
      .filter((route) => route.approved && route.source && SOURCES.has(route.source))
      .map((route) => route.destination) ?? []
  const stale = !!peer?.manifest && (peer.manifest.stale || peer.manifest.expiresAt * 1000 <= now)
  const limit = view.grants.get(key) === 'limit'
  if (!offered.length && !allowed.length && !stale && !limit) return undefined
  // The limit as this computer's relays name it (`callers_max`), the largest when they differ.
  const maxes = [...view.relays.values()].flatMap((relay) =>
    relay.callersMax === undefined ? [] : [relay.callersMax]
  )
  return {
    ...(offered.length ? { offered } : {}),
    ...(allowed.length ? { allowed } : {}),
    ...(stale ? { stale: true } : {}),
    ...(limit ? { limit: maxes.length ? { callersMax: Math.max(...maxes) } : {} } : {})
  }
}

/** Whether `destination` is one of the relay routes `identity`'s relay info offers here, approved or not. */
export function offeredBy(view: RelayView | undefined, identity: string, destination: string): boolean {
  return !!view?.peers.get(identity.toLowerCase())?.routes.some((route) => route.destination === destination)
}

/** When the next pairing's relay info goes stale (ms since 1970), after `now`. */
export function nextStale(view: RelayView | undefined, now: number): number | undefined {
  let next: number | undefined
  for (const peer of view?.peers.values() ?? []) {
    const at = peer.manifest ? peer.manifest.expiresAt * 1000 : undefined
    if (at !== undefined && at > now && (next === undefined || at < next)) next = at
  }
  return next
}

/** The own relays as the status shows them. */
export function relaysStatus(view: RelayView | undefined): NetEngineRelays | undefined {
  if (!view) return undefined
  return { available: view.available, list: [...view.relays.values()] }
}

/** The link `mousse-relay init` and `enroll` print: `mousse-relay://host:port/#<relay id>.<code>` (§B.9). */
export function relayLink(text: string): string | undefined {
  const value = text.trim()
  return /^mousse-relay:\/\/[^\s/#]+\/#[A-Za-z0-9_-]{43}\.[A-Za-z0-9_-]{22}$/.test(value) ? value : undefined
}

/** The error code each refusal of a `relay.*` request becomes; its words are `RELAY_REASON_TEXT`'s. */
const RELAY_ERRORS: Record<string, NetError['code']> = {
  bad_link: 'bad_request',
  already: 'conflict',
  unavailable: 'bad_request',
  relay_unreachable: 'route_unreachable',
  relay_refused: 'route_unreachable',
  relay_key: 'forbidden',
  relay_tls: 'route_unreachable',
  relay_timeout: 'route_unreachable',
  relay_protocol: 'route_unreachable',
  relay_not_authorized: 'forbidden',
  store_failed: 'internal',
  no_relay: 'bad_request',
  not_registered: 'peer_offline'
}

/** What Settings says for a relay refusal it has no words for: the helper's own reason never shows. */
export const RELAY_FAILED = "The relay request didn't go through."

/**
 * A helper's refusal of a relay request, as Settings says it (its code stays in `details.reason`). A code with no
 * words here gets one fixed line; an error that is not the helper's (the app's own `NetError`) passes as it is.
 */
export function relayError(error: unknown): unknown {
  const code = helperCode(error)
  if (!code) return error
  const known = RELAY_ERRORS[code]
  return known
    ? new NetError(known, RELAY_REASON_TEXT[code], { details: { reason: code } })
    : new NetError('internal', RELAY_FAILED, { details: { reason: code } })
}