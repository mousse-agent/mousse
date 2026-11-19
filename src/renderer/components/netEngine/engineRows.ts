import type { NetEngineDevice } from '../../../shared/netEngine/local'
import { ROUTE_CLASS_LABEL, routeText } from '../../../shared/netEngine/routes'

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

/** The neutral message for a certificate outside its window: it cannot tell a wrong clock from an old certificate. */
export const CLOCK_MESSAGE =
  "The certificate is outside its validity window; check this device's clock."

/** The notice when another profile under this OS account has the new networking on too. */
export const SHARED_ACCOUNT_LINE = "Profiles in this account can read each other's files and keys."
export const SHARED_ACCOUNT_DETAIL =
  'Each profile keeps its own pairings and removals, but any app running as this account can read both profiles’ files and keys. Use separate accounts on this computer to keep them private.'

/** A device's row as Settings → Devices shows it (design §5.2, with the clock case of §8). */
export function engineRow(device: NetEngineDevice): EngineRowView {
  const name = device.name
  if (device.state === 'removing') return { line: 'Removing…', actions: [] }
  if (device.notAccepted)
    return {
      line: `${name} no longer accepts this computer`,
      detail: `${name} removed this computer. Remove it here, then pair again to use it.`,
      warn: true,
      actions: ['remove']
    }
  if (device.certificateWindow)
    return {
      line: CLOCK_MESSAGE,
      detail: `A wrong clock here or on ${name}, or an old certificate, gives this. Check both clocks, then Retry.`,
      warn: true,
      actions: ['retry', 'remove']
    }
  if (device.state === 'finishing')
    return device.stuck
      ? {
          line: 'Finishing pairing…',
          detail:
            'Pairing is taking longer than it should. Keep both computers on the same network, then Retry.',
          warn: true,
          actions: ['retry', 'remove']
        }
      : { line: 'Finishing pairing…', actions: [] }
  if (device.unreachable === 'in')
    return {
      line: `${name} can't reach this computer`,
      detail: `Let Mousse through this computer's firewall, and keep both on the same network.`,
      warn: true,
      actions: ['retry', 'remove']
    }
  if (device.unreachable === 'out')
    return {
      line: `This computer can't reach ${name}`,
      detail: `Let Mousse through the firewall on ${name}, and keep both on the same network.`,
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
      line: 'Offline',
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

/**
 * Where a device is found: the class of the route it is connected on (1b §7 `conn.up.route`), else "LAN" or the
 * address added for it.
 */
export function engineWhere(device: NetEngineDevice): string {
  if (device.route) return ROUTE_CLASS_LABEL[device.route]
  const first = device.addresses?.[0]
  if (!first) return 'LAN'
  const address = routeText(first)
  return device.addresses!.length > 1 ? `${address} +${device.addresses!.length - 1}` : address
}

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
