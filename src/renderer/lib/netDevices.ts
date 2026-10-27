import type { NetStatus, NodeCapability, NodeId } from '../../shared/net'
import type { PlusStatus } from '../../shared/net/local'
import type { PlatformRequestMethod } from '../../shared/platform'
import type { TransportManifest } from '../../mms/net/contracts'
import { formatAgo } from '../components/sideCard/lineageLogic'

/** One route this computer knows for a device and how its last attempt went. */
export interface DeviceRouteHealth {
  route: { transport: string; address: string; priority: number }
  state: 'unknown' | 'ok' | 'failing'
  lastError?: string
  lastOkAt?: number
}

export interface Device {
  node: NodeId
  name: string
  caps: NodeCapability[]
  keyEpoch: number
  expiresAt: number
  self: boolean
  revoked: boolean
  state: 'connecting' | 'open' | 'closed'
  /**
   * Everything below is absent from a daemon that predates it, and a newer client must read each
   * field as optional.
   */
  version?: string
  platform?: string
  /** How the device is connected right now; only while it is online. */
  route?: { transport?: string; address?: string; direction: 'in' | 'out' }
  routes?: DeviceRouteHealth[]
  /** Why the last attempt to reach the device failed. */
  error?: string
  lastSeenAt?: number
  /** True for a device on an older version, including one too old to report its version. */
  olderThanThis?: boolean
}

const ROUTE_LABELS: Record<string, string> = {
  direct: 'direct connection',
  tailscale: 'Tailscale',
  cloudflared: 'Cloudflare tunnel',
  relay: 'relay',
  'plus-relay': 'Mousse ID relay',
  ssh: 'SSH',
  'phone-webrtc': 'phone link',
  memory: 'this computer'
}

/** "SSH", "Tailscale", …; an add-on this build does not know keeps its own name. */
export function routeLabel(transport: string | undefined): string {
  if (!transport) return 'unknown route'
  return ROUTE_LABELS[transport] ?? transport
}

/** "last seen 2h ago"; empty when this computer has never seen the device. */
export function lastSeenLabel(lastSeenAt: number | undefined, now: number): string {
  if (lastSeenAt === undefined) return ''
  const ago = formatAgo(lastSeenAt, now)
  return ago ? `last seen ${ago}` : ''
}

const INCOMPATIBLE = new Set(['incompatible_peer', 'unsupported_version'])

export function isIncompatible(device: Device): boolean {
  return device.state !== 'open' && !!device.error && INCOMPATIBLE.has(device.error)
}

/** The version as shown; a device too old to report one says so. */
export function versionLabel(device: Device): string | undefined {
  return device.version ?? (device.olderThanThis ? 'older version' : undefined)
}

/** One line under a device's name, for example `Online · via SSH · 0.1.3 · can read, chat`. */
export function deviceLine(device: Device, now: number): string {
  const parts = [device.state === 'open' ? 'Online' : device.state === 'connecting' ? 'Connecting' : 'Offline']
  if (isIncompatible(device)) parts.push('incompatible version')
  if (device.state === 'open' && device.route?.transport) parts.push(`via ${routeLabel(device.route.transport)}`)
  if (device.state !== 'open') {
    const seen = lastSeenLabel(device.lastSeenAt, now)
    if (seen) parts.push(seen)
  }
  const version = versionLabel(device)
  if (version) parts.push(version)
  if (device.caps.length) parts.push(`can ${device.caps.join(', ')}`)
  return parts.join(' · ')
}

/** Hover text: the connection in use and every known route with its last result. */
export function routeDetails(device: Device): string {
  const lines: string[] = []
  if (device.state === 'open' && device.route) {
    const how = device.route.direction === 'in' ? 'connected to this computer' : 'this computer connected'
    lines.push(`${routeLabel(device.route.transport)}: in use (${how})`)
  }
  for (const health of device.routes ?? []) {
    const inUse =
      device.state === 'open' && device.route?.direction === 'out' && device.route.transport === health.route.transport && device.route.address === health.route.address
    if (inUse) continue
    const result = health.state === 'failing' ? `failing${health.lastError ? ` · ${health.lastError}` : ''}` : health.state === 'ok' ? 'reachable' : 'not tried yet'
    lines.push(`${routeLabel(health.route.transport)}: ${result}`)
  }
  return lines.join('\n')
}

export interface UpdateInstructions {
  summary: string
  /** A shell command to run on the device, when one exists for its platform. */
  command?: string
}

const RELEASES = 'https://github.com/mousse-agent/mousse/releases'

/**
 * What to do to bring `device` to `target` (this device's version): a command for a Linux host,
 * and words for everything else, because a desktop install updates from its own app.
 */
export function updateInstructions(device: Device, target: string): UpdateInstructions {
  switch (device.platform) {
    case 'linux': {
      const file = `mousse-cli-${target}-linux-x86_64.AppImage`
      return {
        summary: `On ${device.name}, download this version, then run mousse-cli service install from the new file and restart the Mousse service.`,
        command: `curl -fL -O ${RELEASES}/download/v${target}/${file} && chmod +x ${file}`
      }
    }
    case 'darwin':
      return { summary: `Open Mousse on ${device.name} and install the update to ${target}.` }
    case 'win32':
      return { summary: `Open Mousse on ${device.name} and install the update to ${target}.` }
    default:
      return { summary: `Update Mousse on ${device.name} to ${target}. Installers are on ${RELEASES}/tag/v${target}.` }
  }
}

/** Devices shown under "My devices": a revoked device is gone from this user's devices. */
export function listedDevices(devices: Device[]): Device[] {
  return devices.filter((device) => !device.revoked)
}

/**
 * Core device state for the Devices screen. Mousse ID status is read only when this build has
 * the service, and a failing read never holds up the rest.
 */
export async function readDevices(withMousseId: boolean) {
  const request = <T>(method: PlatformRequestMethod, params: unknown) =>
    window.mousse.platformRequest.request<T>(method, params)
  const current = await request<NetStatus>('net.status', {})
  const hosted = withMousseId
    ? await request<PlusStatus>('net.plus.status', {}).catch(() => undefined)
    : undefined
  const listed = current.enabled
    ? await request<{ manifests: TransportManifest[] }>('net.transport.list', {})
    : { manifests: [] }
  // The hosted relay add-on is Mousse ID too; it is offered only with the service.
  const addons = withMousseId
    ? listed
    : { manifests: listed.manifests.filter((manifest) => manifest.id !== 'plus-relay') }
  const nodes =
    current.enabled && current.self && current.keystore === 'unlocked'
      ? (await request<{ nodes: Device[] }>('bridge.nodes', {})).nodes
      : []
  return { current, hosted, addons, nodes }
}
