import type { NetEngineDevice } from '../../../shared/netEngine/local'
import type { RouteClass } from '../../../shared/netEngine/routes'
import { parseRoute, relayText, routeClass, routeText } from '../../../shared/netEngine/routes'
import { WAY_LABEL } from './ways'

/** What a device's row offers (design §5.2): Access opens the preset control under it. */
export type EngineRowAction = 'access' | 'address' | 'retry' | 'remove'

export interface EngineRowView {
  /** The state, one short line. */
  line: string
  /** The fix or the reason, as the line's tooltip. */
  detail?: string
  /** The line is a problem. */
  warn?: boolean
  actions: EngineRowAction[]
}

/** A route's class as Settings names it, in plain words. */
export const ROUTE_WORDS: Readonly<Record<RouteClass, string>> = Object.freeze({
  lan: 'Same network',
  tailnet: 'Tailscale',
  public: 'Internet',
  tunnel: 'Internet',
  ssh: 'SSH'
})

/** How a device is connected now, for its row ("same network", "via Tailscale"). */
const HOW: Readonly<Record<RouteClass, string>> = Object.freeze({
  lan: 'same network',
  tailnet: 'via Tailscale',
  public: 'over the internet',
  tunnel: 'over the internet',
  ssh: 'over SSH'
})

/** The clock case (a certificate outside its window): it cannot tell a wrong clock from an old pairing. */
export const clockMessage = (name: string): string =>
  `The clock on this computer or ${name} looks wrong. Check the date and time.`

/** The notice when another profile under this OS account has the new networking on too. */
export const SHARED_ACCOUNT_LINE = "Profiles in this account can read each other's files and keys."
export const SHARED_ACCOUNT_DETAIL =
  'Each profile keeps its own pairings and removals, but any app running as this account can read both profiles’ files and keys. Use separate accounts on this computer to keep them private.'

/** A device whose relay info (its signed manifest, Phase 3 §B.11) expired. */
export const RELAY_STALE_LINE = 'Relay info out of date'
export const RELAY_STALE_DETAIL = (name: string): string =>
  `The relay addresses ${name} sent have expired. They're tried last until it sends new ones.`

/**
 * A device past this computer's relay limit (§B.5): its caller key is not listed with the relay. The limit is the
 * one the helper names (`callers_max`).
 */
export const relayLimitLine = (callersMax?: number): string =>
  callersMax === undefined
    ? 'Not reachable through the relay (over its limit)'
    : `Not reachable through the relay (limit ${callersMax})`
export const relayLimitDetail = (callersMax?: number): string =>
  `Your relays list the first ${callersMax ?? 'few hundred'} paired devices. LAN and other addresses still work.`

/** The one line a device's row shows for a relay route waiting for the owner's Allow (§B.11). */
export const relayOfferLine = (name: string, destination: string): string =>
  `${name} can be reached through relay ${relayText(destination)}. Allow?`

/**
 * What to do when one direction to a device does not come up, by the route it uses: the one its connection runs
 * over now, else the first address added for it, else the local network. `in`: it can't reach this computer; `out`:
 * this computer can't reach it.
 */
export function unreachableDetail(device: NetEngineDevice, way: 'in' | 'out'): string {
  const name = device.name
  const added = device.addresses?.map((address) => parseRoute(address)).find(Boolean)
  const cls = device.route ?? (added ? routeClass(added) : device.source === 'ssh' || device.ssh ? 'ssh' : 'lan')
  if (cls === 'tailnet') return 'Keep Tailscale on and online on both computers, then Retry.'
  if (cls === 'ssh') return `Check you can sign in to ${name} over SSH, then Retry.`
  if (cls !== 'lan')
    return way === 'in'
      ? 'Check the address this computer shares, then Retry.'
      : `Check the address ${name} shares, then Retry.`
  return way === 'in'
    ? `${name} can't reach this computer. Let Mousse through this computer's firewall, then Retry.`
    : `This computer can't reach ${name}. Let Mousse through the firewall on ${name}, then Retry.`
}

/** A device's row as Settings → Devices shows it (design §5.2, with the clock case of §8). */
export function engineRow(device: NetEngineDevice): EngineRowView {
  const name = device.name
  if (device.state === 'removing') return { line: 'Removing…', actions: [] }
  // A Send link it consented to that did not finish (design 1b §5.4).
  if (device.unfinished)
    return device.linkValid
      ? {
          line: "Pairing didn't finish",
          detail: 'Retry asks for the code again. Or ask for a new link.',
          warn: true,
          actions: ['retry', 'remove']
        }
      : {
          line: "Pairing didn't finish",
          detail: 'The link has expired. Remove this, then ask for a new link.',
          warn: true,
          actions: ['remove']
        }
  if (device.notAccepted)
    return {
      line: `${name} no longer accepts this computer`,
      detail: `${name} removed this computer. Remove it here, then pair again to use it.`,
      warn: true,
      actions: ['remove']
    }
  // An SSH login only the owner can fix: nothing signs in again until Retry (1b §1.4).
  if (device.sshParked === 'auth_denied')
    return {
      line: `SSH sign-in to ${name} was refused`,
      detail: 'Mousse uses your SSH keys or agent, never a password. Fix the key, then Retry.',
      warn: true,
      actions: ['retry', 'remove']
    }
  if (device.sshParked === 'host_key_changed')
    return {
      line: `${name}'s SSH key changed`,
      detail: `Check the new key with Add over SSH, then Retry. Mousse won't sign in until then.`,
      warn: true,
      actions: ['retry', 'remove']
    }
  if (device.sshParked === 'host_key_unknown')
    return {
      line: `Check ${name}'s SSH key`,
      detail: `Check and trust its key with Add over SSH, then Retry.`,
      warn: true,
      actions: ['retry', 'remove']
    }
  if (device.certificateWindow)
    return {
      line: clockMessage(name),
      detail: `Set both clocks to the right time, then Retry.`,
      warn: true,
      actions: ['retry', 'remove']
    }
  if (device.state === 'finishing')
    return device.stuck
      ? {
          line: 'Finishing pairing…',
          detail: unreachableDetail(device, 'in'),
          warn: true,
          actions: ['retry', 'remove']
        }
      : { line: 'Finishing pairing…', actions: [] }
  if (device.unreachable === 'in')
    return {
      line: `${name} can't reach this computer`,
      detail: unreachableDetail(device, 'in'),
      warn: true,
      actions: ['retry', 'remove']
    }
  if (device.unreachable === 'out')
    return {
      line: `This computer can't reach ${name}`,
      detail: unreachableDetail(device, 'out'),
      warn: true,
      actions: ['retry', 'remove']
    }
  if (device.state === 'connecting')
    return {
      line: 'Connecting…',
      detail: `One direction to ${name} is up; the other is still connecting.`,
      actions: ['access', 'address', 'retry', 'remove']
    }
  if (device.state === 'offline')
    return {
      line: `Can't reach it · open Mousse on ${name}`,
      detail: `Mousse is closed on ${name}, or it is on another network.`,
      actions: ['access', 'address', 'retry', 'remove']
    }
  // Added over SSH: one way only (1b §3.6).
  if (device.direction === 'out')
    return { line: 'Uses ' + name, detail: 'Added over SSH', actions: ['address', 'remove'] }
  if (device.direction === 'in')
    return {
      line: name + ' uses this computer',
      detail: 'Added over SSH from ' + name,
      actions: ['access', 'remove']
    }
  return { line: 'Connected', actions: ['access', 'address', 'remove'] }
}

/** One direction of a pairing: `out`, this computer uses it; `in`, it uses this computer. */
export type EngineSide = 'out' | 'in'

/**
 * The directions a pairing works in: one way, or both. A pairing still being made counts as this computer using it,
 * where it was started.
 */
export function engineSides(device: NetEngineDevice): EngineSide[] {
  if (device.direction) return [device.direction]
  if (device.state === 'finishing' || device.unfinished) return ['out']
  return ['out', 'in']
}

/** Which way a pairing works, as the devices list says it: `both`, `out` (this computer uses it), `in` (it uses this one). */
export type EngineDirection = 'both' | EngineSide

export const directionOf = (sides: readonly EngineSide[]): EngineDirection =>
  sides.includes('out') && sides.includes('in') ? 'both' : sides.includes('in') ? 'in' : 'out'

/** The direction's words in the list, and its tooltip. */
export const DIRECTION_WORDS: Readonly<Record<EngineDirection, { label: string; detail: string }>> = Object.freeze({
  both: { label: 'Both ways', detail: 'You use it, and it uses this computer' },
  out: { label: 'I use it', detail: 'This computer uses it; it can’t use this one' },
  in: { label: 'Uses this computer', detail: 'It uses this computer; this one doesn’t use it' }
})

/**
 * One direction's row: the pairing's own problem where it belongs to this direction, else that direction's state.
 * Access belongs to `in`, routes and Retry to `out`; Remove on either ends only that direction.
 */
export function engineSideRow(device: NetEngineDevice, side: EngineSide): EngineRowView {
  const whole = engineRow(device)
  const name = device.name
  // A problem of the other direction leaves this one working.
  if (device.unreachable && device.unreachable !== side) return sideActions({ line: 'Connected', actions: [] }, side)
  if (device.unreachable || device.state === 'removing' || device.state === 'finishing') return whole
  if (side === 'out' && (device.unfinished || device.notAccepted || device.sshParked || device.certificateWindow))
    return whole
  if (side === 'in' && device.certificateWindow) return whole
  // A level the helper has not applied to its grant yet: a narrower one may still list and remove this computer's
  // devices there.
  if (side === 'in' && device.accessPending)
    return sideActions(
      {
        line: 'Access change not applied yet',
        detail: "Networking hasn't taken the new level. Retrying.",
        warn: true,
        actions: []
      },
      side
    )
  if (device.state === 'connecting')
    return sideActions(
      device.direction
        ? { line: 'Connecting…', actions: [] }
        : { line: 'Connecting…', detail: `One direction to ${name} is up; the other is still connecting.`, actions: [] },
      side
    )
  if (device.state === 'offline')
    return sideActions(
      side === 'out'
        ? {
            line: `Can't reach it · open Mousse on ${name}`,
            detail: `Mousse is closed on ${name}, or it is on another network.`,
            actions: []
          }
        : { line: 'Not connected now', detail: `It connects when Mousse is open on ${name}.`, actions: [] },
      side
    )
  return sideActions(
    {
      line: 'Connected',
      ...(device.source === 'ssh'
        ? { detail: side === 'out' ? 'Added over SSH' : `Added over SSH from ${name}` }
        : {}),
      actions: []
    },
    side
  )
}

function sideActions(view: EngineRowView, side: EngineSide): EngineRowView {
  const live = view.line === 'Connected'
  return {
    ...view,
    actions:
      side === 'in' ? ['access', 'remove'] : live ? ['address', 'remove'] : ['address', 'retry', 'remove']
  }
}

/**
 * How a device is connected, in plain words: the class of the route it is connected on (1b §7 `conn.up.route`),
 * "through relay host:port" on a relay (Phase 3), else "same network". The addresses go in the tooltip.
 */
export function engineWhere(device: NetEngineDevice): string {
  if (device.route === 'relay') return device.via ? `through relay ${device.via}` : 'through a relay'
  return device.route ? HOW[device.route] : HOW.lan
}

/**
 * The way a device's live connection runs, by the name the way picker gives it, for "Connects over <way>, already
 * in use." (as "Connects over Same Wi-Fi" reads when using a computer).
 */
export function engineWay(device: NetEngineDevice): string {
  const route = device.route ?? 'lan'
  if (route === 'relay') return device.via ? `relay ${device.via}` : WAY_LABEL.relay
  return route === 'ssh' ? ROUTE_WORDS.ssh : WAY_LABEL[route]
}

/**
 * The menu item for the missing direction of a pairing made one way, for the direction it holds: "Use <name> from
 * here…" for a computer that uses this one (it asks), "Let <name> use this computer…" for one this computer uses
 * (this owner decides). Disabled, with why, while it can't be done; absent where the pairing can't.
 */
export function otherWayItem(
  device: NetEngineDevice,
  side: EngineSide
): { label: string; disabled?: boolean; title?: string; detail?: string } | undefined {
  const other = device.other
  if (!other || device.state === 'removing') return undefined
  // Unavailable: the reason is the item's second line.
  const blocked = (why: string) => ({ disabled: true, detail: why })
  if (other.offer === 'ask' && side === 'in')
    return {
      label: `Use ${device.name} from here…`,
      ...(other.blocked
        ? blocked(other.blocked)
        : other.asked === 'waiting'
          ? blocked('Waiting for an answer.')
          : { title: `Asks ${device.name} to let this computer in.` })
    }
  if (other.offer === 'let' && side === 'out')
    return {
      label: `Let ${device.name} use this computer…`,
      ...(other.blocked ? blocked(other.blocked) : { title: 'You pick what it may do here.' })
    }
  return undefined
}

/** What a row says under it after this computer asked for the other direction. */
export function askedLine(device: NetEngineDevice): { line: string; detail?: string; waiting?: boolean } | undefined {
  switch (device.other?.asked) {
    case 'waiting':
      return { line: `Waiting for ${device.name} to allow this…`, waiting: true }
    case 'declined':
      return { line: `${device.name} said Not now`, detail: 'Nothing changed. You can ask again from its menu.' }
    case 'expired':
      return { line: `No answer from ${device.name}`, detail: 'The request expired. You can ask again from its menu.' }
    default:
      return undefined
  }
}

/** Every address kept for a device, for the tooltip on how it is connected. */
export const engineAddresses = (device: NetEngineDevice): string | undefined =>
  device.addresses?.map(routeText).join(', ') || undefined

/**
 * Reads a scanned or pasted pairing link: the ticket after `#`, and the host's name from `?n=` when the link has
 * one. Answers undefined for text that is not a pairing link or a bare ticket.
 */
export function readPairingLink(text: string): { ticket: string; host?: string } | undefined {
  const value = text.trim()
  const hash = value.lastIndexOf('#')
  const ticket = hash >= 0 ? value.slice(hash + 1) : value
  if (!/^[A-Za-z0-9_-]{16,}$/.test(ticket)) return undefined
  if (hash >= 0 && !/^mousse:\/\/pair\b/i.test(value)) return undefined
  let host: string | undefined
  const query = hash >= 0 ? value.slice(0, hash).indexOf('?') : -1
  if (query >= 0)
    try {
      host =
        new URLSearchParams(value.slice(query + 1, hash)).get('n')?.trim().slice(0, 80) || undefined
    } catch {
      host = undefined
    }
  return { ticket: value, ...(host ? { host } : {}) }
}

/** The class of a stored route (`tcp://`, `wss://`, `ssh://`), or undefined for one that doesn't read. */
export function classOf(route: string): RouteClass | undefined {
  const parsed = parseRoute(route)
  if (!parsed) return undefined
  const cls = routeClass(parsed)
  return cls === 'forbidden' ? undefined : cls
}

/** A route's kind as the expanded row names it. */
export const ROUTE_KIND: Readonly<Record<RouteClass | 'relay', string>> = Object.freeze({
  lan: 'Same network',
  tailnet: 'Tailscale',
  public: 'Internet',
  tunnel: 'Tunnel',
  ssh: 'SSH',
  relay: 'Relay'
})

/** One route a device has, as its expanded row lists it. */
export interface DeviceRoute {
  key: string
  cls: RouteClass | 'relay'
  /** The address, shortened when long. */
  address?: string
  /** The whole address, for the tooltip when it was shortened. */
  full?: string
  state: 'in use' | 'available' | 'failed'
  /** Why it failed, for the tooltip. */
  reason?: string
  /** How to remove it, where the owner added it. */
  remove?: { method: 'netEngine.address.remove' | 'netEngine.relay.disallow'; params: Record<string, string> }
}

/** Addresses longer than this are shortened, with the whole one in the tooltip. */
const ADDRESS_SHOWN = 32

const shown = (text: string): { address: string; full?: string } =>
  text.length > ADDRESS_SHOWN ? { address: `${text.slice(0, ADDRESS_SHOWN - 1)}…`, full: text } : { address: text }

/**
 * Every route a device has, the one in use first (whatever the engine reports: a relay first, a direct route once
 * it takes over), then the ones it can fall back to, then the ones that failed. Failures come from the row's own
 * state (it can't be reached, its SSH sign-in was refused), with the row's reason.
 */
export function deviceRoutes(device: NetEngineDevice): DeviceRoute[] {
  const routes: DeviceRoute[] = []
  // This computer looks for it on the same network whenever it dials it, one way or both, added over SSH or not.
  // A same-network address it has already is that route: one row, not a second "Found automatically".
  const lanListed = [...(device.addresses ?? []), ...(device.approvedAddresses ?? [])].some(
    (address) => classOf(address) === 'lan'
  )
  if (device.direction !== 'in' && !lanListed)
    routes.push({ key: 'local', cls: 'lan', address: 'Found automatically', state: 'available' })
  for (const address of device.addresses ?? []) {
    routes.push({
      key: address,
      cls: classOf(address) ?? 'public',
      ...shown(routeText(address)),
      state: 'available',
      remove: { method: 'netEngine.address.remove', params: { node: device.node, address } }
    })
  }
  // The pairing ticket's hints approved at Connect: dialled after the same network, not removable here.
  for (const address of device.approvedAddresses ?? [])
    if (!routes.some((route) => route.key === address))
      routes.push({ key: address, cls: classOf(address) ?? 'public', ...shown(routeText(address)), state: 'available' })
  if (device.ssh || device.source === 'ssh')
    routes.push({ key: 'ssh', cls: 'ssh', ...(device.ssh ? shown(device.ssh) : {}), state: 'available' })
  for (const destination of device.relay?.allowed ?? [])
    routes.push({
      key: destination,
      cls: 'relay',
      ...shown(relayText(destination)),
      state: 'available',
      remove: { method: 'netEngine.relay.disallow', params: { node: device.node, destination } }
    })

  // The route in use: the engine names its class (and a relay's host), not the address.
  if (device.route && device.online) {
    const used =
      device.route === 'relay'
        ? (routes.find((route) => route.cls === 'relay' && (!device.via || relayText(route.key) === device.via)) ??
          routes.find((route) => route.cls === 'relay'))
        : (routes.find((route) => route.cls === device.route && route.key !== 'local') ??
          routes.find((route) => route.cls === device.route))
    if (used) used.state = 'in use'
    else
      routes.unshift({
        key: `in-use-${device.route}`,
        cls: device.route,
        ...(device.via ? shown(device.via) : {}),
        state: 'in use'
      })
  }

  // Failures the row knows about.
  const view = engineRow(device)
  const reason = view.detail ?? view.line
  const unreachable =
    device.unreachable === 'out' ||
    device.state === 'offline' ||
    !!device.certificateWindow ||
    (device.state === 'finishing' && !!device.stuck)
  for (const route of routes) {
    if (route.state === 'in use') continue
    if (device.sshParked && route.cls === 'ssh') Object.assign(route, { state: 'failed', reason })
    else if (unreachable) Object.assign(route, { state: 'failed', reason })
  }
  const order = { 'in use': 0, available: 1, failed: 2 }
  return routes.sort((a, b) => order[a.state] - order[b.state])
}
