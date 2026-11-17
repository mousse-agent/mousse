import type { NetStatus, NodeCapability, NodeId } from '../../shared/net'
import type { BridgeAccessMine, BridgeAccessThere, BridgeNodeConnection, BridgeNodePolicy, NetAddonRecords, NetStartOverCheck, PlusStatus, SshRecordView } from '../../shared/net/local'
import type { PlatformRequestMethod } from '../../shared/platform'
import type { TransportManifest } from '../../mms/net/contracts'
import { formatAgo } from './formatAgo'
import { parseVersion } from '../../shared/net/version'
import { describePermissionMode, type PermissionMode } from '../../shared/permissionMode'
import { accessPreset, accessPresetOf } from '../../shared/net/accessPresets'
import { NODE_DELEGATION_TTL_MS } from '../../shared/net/limits'

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
  /**
   * What the authority recorded for the device. `unknown` is a device it never recorded a kind
   * for; it is not treated as a computer. Absent from a daemon that predates the field.
   */
  kind?: 'computer' | 'phone' | 'unknown'
  self: boolean
  revoked: boolean
  state: 'connecting' | 'open' | 'closed'
  /**
   * Everything below is absent from a daemon that predates it, and a newer client must read each
   * field as optional.
   */
  version?: string
  platform?: string
  arch?: string
  /** How the device is connected right now; only while it is online. */
  route?: { transport?: string; address?: string; direction: 'in' | 'out' }
  routes?: DeviceRouteHealth[]
  /** Why the last attempt to reach the device failed. */
  error?: string
  lastSeenAt?: number
  /** True for a device on an older version, including one too old to report its version. */
  olderThanThis?: boolean
  /** A route over SSH this device advertises and this computer has not approved yet. */
  sshOffer?: { endpoint: string }
  /** What this computer lets the device do here. Absent from a daemon that predates it. */
  policy?: BridgeNodePolicy
  /** Whether the device is connected here. Absent from a daemon that predates it, where every device is. */
  connection?: BridgeNodeConnection
  /** This computer holds the device's routes, so Connect can reach it. */
  routeHeld?: boolean
  /** The device keeps the list: it signs every device's pass and its renewals. Absent from a daemon that predates it. */
  keeper?: boolean
}

/** The device is connected here (a daemon from before the record connects every device). */
export function connectedHere(device: Pick<Device, 'connection'>): boolean {
  return device.connection === undefined || device.connection === 'connected'
}
/**
 * How a device that is not connected here gets connected from its row: Connect when this computer holds its routes,
 * otherwise a link from it. Undefined for a connected device.
 */
export function connectStep(device: Pick<Device, 'connection' | 'routeHeld' | 'name'>): { connect: true } | { hint: string } | undefined {
  if (connectedHere(device)) return undefined
  return device.routeHeld ? { connect: true } : { hint: `Paste a link from ${device.name}` }
}

/** The capability that lets a computer work on this one's threads is stored as `settings`. */
export const WORKS_ON_THREADS: NodeCapability = 'settings'

/**
 * What pairing a computer opens, in both directions, said where a person pairs one (Add device, an SSH setup).
 * The numbers are the defaults a new computer starts with; they are limits, not promises, and are changed per device.
 */
export const PAIRING_DISCLOSURE =
  'Once paired, each computer can run and change threads on the other, up to Auto-accept edits. Terminals stay off. You can limit or block either one in Devices.'

/**
 * What turning on "Works on threads" for a computer, or marking a device as a computer, opens. This computer
 * holds the grant itself when it manages the devices, so the reach is in both directions.
 */
export function workOnThreadsDisclosure(name: string, mode: PermissionMode = 'accept_edits'): string {
  return `${name} will be able to run and change threads on this computer, up to ${describePermissionMode(mode)}: it can read their transcripts, files and Git state, start turns, answer approvals, and commit and push with this computer's sign-ins. This computer can do the same on ${name}. Terminals stay off. You can limit or block ${name} in Devices.`
}

const NET_ERROR_WORDS: Record<string, string> = {
  route_unreachable: 'none of your other devices can be reached right now',
  peer_offline: 'a device is offline',
  keystore_locked: 'the network keys are locked',
  deadline_exceeded: 'a device did not answer in time',
  // This computer's device pass lapsed; the computer that manages your devices renews it once they meet.
  bad_delegation: 'waiting for your other computer to reconnect this one'
}

/** A Net error code in words a person can read; a code this build does not know has its underscores taken out. */
export function netErrorWords(code: string): string {
  return NET_ERROR_WORDS[code] ?? code.replaceAll('_', ' ')
}

/**
 * Why a join failed, with the one thing to do next. The daemon names the reason and the other
 * computer in the error's details; a daemon from before them sends only the code.
 */
export function joinErrorWords(error: { code?: unknown; details?: unknown; message?: unknown }): string {
  const details = (error.details ?? {}) as { reason?: unknown; label?: unknown }
  const other = typeof details.label === 'string' ? details.label : 'the other computer'
  switch (details.reason) {
    case 'unreachable':
      return `Couldn’t reach ${other}. Check that it’s on and that both computers are on the same network or tailnet, then try again.`
    case 'clock':
      return `The clocks on this computer and ${other} are too far apart. Set both to the correct time, then try again.`
    case 'cancelled':
      return `This connection was cancelled on ${other}. Start again with a new link from ${other}.`
    case 'join_unfinished':
      return `Couldn’t finish connecting to ${other}. Retry, or give up and start again.`
  }
  switch (error.code) {
    case 'invite_invalid':
      return 'This link isn’t valid or has expired. Make a new one on the other computer.'
    case 'keystore_locked':
      return 'The system keychain refused to protect this computer’s keys. Set a passphrase to continue.'
    case 'conflict':
      return 'This computer is already set up with its own devices, so it can’t join another set.'
  }
  return String(error.message ?? error.code ?? 'The connection failed.')
}

/** Why this computer can't start over now, naming what stands in the way; undefined when it can. */
export function startOverRefusal(check: NetStartOverCheck): string | undefined {
  const names = (list?: string[]) => (list ?? []).join(', ')
  switch (check.refused) {
    case 'space_host':
      return `This computer hosts ${names(check.hosted)}. Its members would lose it, so this computer can’t start over.`
    case 'mousse_id':
      return 'This computer is signed in to Mousse ID. Sign out first, then start over.'
    case 'live_devices':
      return check.keeper
        ? `${names(check.live)} still rely on this computer. Remove them first, then start over.`
        : `This computer still belongs with ${names(check.live)}. Remove it there first, then start over.`
  }
  return undefined
}

/** Words for a capability in the device line; `settings` is "work on threads". */
export function capabilityLabel(cap: NodeCapability): string {
  return cap === WORKS_ON_THREADS ? 'work on threads' : cap
}

/** Whether the device holds the signed grant to work on threads. */
export function worksOnThreads(device: Pick<Device, 'caps'>): boolean {
  return device.caps.includes(WORKS_ON_THREADS)
}

/** The phone API is all a phone gets; computer limits do not apply to it. */
export function isComputer(device: Pick<Device, 'kind'>): boolean {
  return device.kind !== 'phone'
}

/** Only a device recorded as a computer can be given "Works on threads". */
export function canWorkOnThreads(device: Pick<Device, 'kind'>): boolean {
  return device.kind === 'computer'
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
  if (device.caps.length) parts.push(`can ${device.caps.map(capabilityLabel).join(', ')}`)
  // What this computer lets the device do here: shown for a computer that works on threads, so the defaults are not a secret.
  if (device.policy && !device.policy.blocked && isComputer(device) && worksOnThreads(device))
    parts.push(`highest mode here: ${describePermissionMode(device.policy.maxPermissionMode)}`, device.policy.terminal ? 'terminals on' : 'terminals off')
  // Editor connections are shell access too, so when they are on the line says so (off is the default and stays unsaid).
  if (device.policy && !device.policy.blocked && isComputer(device) && worksOnThreads(device) && device.policy.editor)
    parts.push('editor connections on')
  if (device.policy?.blocked) parts.push('blocked on this computer')
  return parts.join(' · ')
}

/**
 * This computer's device pass lapsed (it was away too long): its own connections fail with
 * `bad_delegation`, or another computer refuses it for that. It comes back by itself once the
 * computer that manages your devices renews it, so the page says "Reconnecting", not an error.
 */
export function passLapsed(status?: Pick<NetStatus, 'error' | 'peers'>): boolean {
  if (!status) return false
  return status.error === 'bad_delegation' || (status.peers ?? []).some((peer) => peer.error === 'bad_delegation')
}

/**
 * A device's state on this computer, for its row: connected here or not. A daemon from before the record sends none.
 * One more state is planned (a device that came in by a connect link and waits for Allow); it gets its words here.
 */
export type DeviceConnectionState = 'connected' | 'not_connected'
const CONNECTION_WORDS: Record<DeviceConnectionState, string> = {
  connected: 'connected here',
  not_connected: 'not connected here'
}
export function connectionState(device: Pick<Device, 'connection'>): DeviceConnectionState | undefined {
  if (device.connection === undefined) return undefined
  return device.connection === 'connected' ? 'connected' : 'not_connected'
}

/**
 * The preset name of what a connected computer may do here ("Work on threads", "Custom"), or undefined where the
 * detail shows no preset: a phone, a device not connected here, blocked, without Works on threads, or a daemon that
 * does not report every field.
 */
export function presetLabel(device: Device): string | undefined {
  const policy = device.policy
  if (!policy || policy.blocked || !connectedHere(device) || !isComputer(device) || !worksOnThreads(device)) return undefined
  const preset = accessPresetOf(policy)
  if (!preset) return undefined
  return preset === 'custom' ? 'Custom' : accessPreset(preset).label
}

/**
 * The short line under a device's name in the device list: online or last seen, the route in use, whether it is
 * connected here and, for a connected computer, its preset, then only what needs attention. Signed out of Mousse ID,
 * devices reach each other only nearby, so it says that.
 */
export function deviceListLine(device: Device, now: number, { signedOut = false }: { signedOut?: boolean } = {}): string {
  const online = device.state === 'open'
  const parts = [online ? (signedOut ? 'Nearby' : 'Online') : device.state === 'connecting' ? 'Connecting' : signedOut ? 'Not nearby' : 'Offline']
  if (!online) {
    const seen = lastSeenLabel(device.lastSeenAt, now)
    if (seen) parts.push(seen)
  }
  if (online && device.route?.transport) parts.push(`via ${routeLabel(device.route.transport)}`)
  const connection = connectionState(device)
  if (connection) parts.push(CONNECTION_WORDS[connection])
  const preset = presetLabel(device)
  if (preset) parts.push(preset)
  if (isIncompatible(device)) parts.push('incompatible version')
  else if (device.olderThanThis) parts.push('older version')
  if (device.policy?.blocked) parts.push('blocked on this computer')
  if (device.sshOffer) parts.push('offers an SSH route')
  return parts.join(' · ')
}

const DAY_MS = 86_400_000
/** The keeper unseen this long gets a warning on its row: passes last `NODE_DELEGATION_TTL_MS` (7 days) without it. */
export const KEEPER_AWAY_WARN_MS = 3 * DAY_MS
/** The tooltip on the keeper's words. */
export const KEEPER_DETAIL = `Signs every device's pass. Passes last ${NODE_DELEGATION_TTL_MS / DAY_MS} days and renew while this device is reachable.`

/**
 * The warning on the keeper's row when this computer has not reached it for days: every pass it signed runs out unless
 * it renews them. Undefined while it is reachable, recently seen, never seen, or this computer is the keeper.
 */
export function keeperAway(keeper: Device, devices: Device[], now: number): string | undefined {
  if (keeper.self || keeper.state === 'open' || keeper.lastSeenAt === undefined) return undefined
  const away = now - keeper.lastSeenAt
  if (away < KEEPER_AWAY_WARN_MS) return undefined
  const ends = devices.filter((device) => device.node !== keeper.node && !device.revoked && device.expiresAt > now).map((device) => device.expiresAt)
  const end = ends.length ? `passes end ${passEndLabel(Math.min(...ends))}` : 'passes have ended'
  return `Not reachable for ${Math.floor(away / DAY_MS)} days · ${end}`
}
/** "Wed, Nov 25" in the person's own format. */
export const passEndLabel = (at: number): string => new Date(at).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })

/** What one device may do on one computer, in either direction. */
export type DeviceAccess = Pick<BridgeAccessMine, 'threads' | 'work' | 'terminal' | 'editor' | 'bots'> & { maxPermissionMode?: PermissionMode }

/**
 * What this computer lets `device` do here, from what it knows: connected here, the block, the grant, this computer's
 * own switches ("Let my other devices work here", Share bots) and the device's switches. A phone keeps the phone API.
 * A string says why it may do nothing; undefined for a daemon that sends no policy.
 */
export function accessHere(device: Device, switches: { workOnThreads: boolean; shareBots: boolean }): DeviceAccess | 'not_connected' | 'blocked' | undefined {
  const policy = device.policy
  if (!policy) return undefined
  if (!connectedHere(device)) return 'not_connected'
  if (policy.blocked) return 'blocked'
  const bots = policy.bots !== false && switches.shareBots
  if (!isComputer(device)) {
    const threads = device.caps.includes('read')
    return { threads, work: threads && device.caps.includes('write') && policy.work !== false, terminal: false, editor: false, bots }
  }
  const threads = worksOnThreads(device) && switches.workOnThreads
  return {
    threads,
    work: threads && policy.work !== false,
    terminal: threads && policy.terminal,
    editor: threads && policy.editor,
    bots,
    maxPermissionMode: policy.maxPermissionMode
  }
}

/**
 * One short line for what a device may do, and every item on or off for its tooltip. A phone keeps the phone API, so
 * its work on threads is not called Works on threads (the grant it never holds).
 */
export function accessWords(access: DeviceAccess, { phone = false }: { phone?: boolean } = {}): { line: string; detail: string } {
  const work = phone ? 'Uses threads' : 'Works on threads'
  const parts = [access.work ? work : access.threads ? 'Reads threads' : '', access.terminal ? 'terminals' : '', access.editor ? 'editor' : '', access.bots ? 'bots' : ''].filter(Boolean)
  const mode = access.work && access.maxPermissionMode ? `, up to ${describePermissionMode(access.maxPermissionMode)}` : ''
  const detail = [
    `Threads: ${access.work ? `${phone ? 'starts and sends to them' : 'works on them'}${mode}` : access.threads ? 'reads them' : 'none'}`,
    `Terminals: ${access.terminal ? 'on' : 'off'}`,
    `Editor connections: ${access.editor ? 'on' : 'off'}`,
    `Bots: ${access.bots ? 'on' : 'off'}`
  ].join('\n')
  return { line: parts.length ? parts.join(' · ') : 'Nothing', detail }
}

/** A `bridge.access.there` answer, or undefined for anything else (a daemon here from before the call). */
export function readAccessThere(value: unknown): BridgeAccessThere | undefined {
  const answer = value as BridgeAccessThere | undefined
  if (answer?.state === 'known' && answer.access && typeof answer.access === 'object') return answer
  if (answer?.state === 'not_connected') return answer
  if (answer?.state === 'unknown' && (answer.reason === 'offline' || answer.reason === 'older')) return answer
  return undefined
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

/** The steps for a headless Linux x86_64 host: verify the download, install the service, restart it. */
function headlessLinuxScript(version: string): string {
  const file = `mousse-cli-${version}-linux-x86_64.AppImage`
  return [
    'set -e',
    `mkdir -p ~/.local/share/mousse/cli/${version} && cd ~/.local/share/mousse/cli/${version}`,
    `curl -fLO ${RELEASES}/download/v${version}/${file}`,
    `curl -fLO ${RELEASES}/download/v${version}/SHA256SUMS-${version}.txt`,
    `sha256sum -c --ignore-missing SHA256SUMS-${version}.txt`,
    `chmod +x ${file}`,
    `./${file} --appimage-extract > /dev/null`,
    // The packaged CLI needs the Chromium sandbox off on a host without a SUID helper, both when
    // it runs here and when systemd starts it.
    'export ELECTRON_DISABLE_SANDBOX=1',
    './squashfs-root/mousse-cli service install',
    'mkdir -p ~/.config/systemd/user/mousse-mms.service.d',
    "printf '[Service]\\nEnvironment=ELECTRON_DISABLE_SANDBOX=1\\n' > ~/.config/systemd/user/mousse-mms.service.d/sandbox.conf",
    'systemctl --user daemon-reload',
    'systemctl --user restart mousse-mms'
  ].join('\n')
}

/**
 * What to do to bring `device` to `target` (this device's version). Only a headless Linux x86_64
 * host gets a command; every other platform gets words that match how it really updates.
 */
export function updateInstructions(device: Device, target: string): UpdateInstructions {
  const name = device.name
  if (!parseVersion(target)) return { summary: `Update Mousse on ${name} to match this device. Releases are on ${RELEASES}.` }
  const page = `${RELEASES}/tag/v${target}`
  switch (device.platform) {
    case 'linux':
      if (device.arch === 'x64')
        return {
          summary: `For ${name} running the headless mousse-cli as a service, run this on it. It checks the download against the published checksums, installs it, and restarts the service, which interrupts threads running there. If ${name} runs the Mousse desktop app instead, open the app there: a copy started from its AppImage updates itself.`,
          command: headlessLinuxScript(target)
        }
      return {
        summary: `If ${name} runs the Mousse desktop app, open the app there: a copy started from its AppImage updates itself. There is no headless download for ${device.arch ? `${device.arch} ` : 'this kind of '}Linux hosts yet; releases are on ${page}.`
      }
    case 'darwin': {
      const dmg = device.arch === 'arm64' ? `Mousse-${target}-arm64.dmg` : device.arch === 'x64' ? `Mousse-${target}-x64.dmg` : `Mousse-${target}-arm64.dmg (Apple silicon) or Mousse-${target}-x64.dmg (Intel)`
      return { summary: `Mousse for macOS can't update itself yet. On ${name}, download ${dmg} from ${page} and replace the app.` }
    }
    case 'win32':
      return { summary: `Mousse for Windows updates itself: open Mousse on ${name} and let it install ${target}. To do it by hand, run Mousse.Setup.${target}.exe from ${page}.` }
    default:
      return { summary: `Update Mousse on ${name} to ${target}. Installers and the headless CLI are on ${page}.` }
  }
}

/** The remote machine record that set up or approved a device, if any. */
export function sshRecordFor(device: Device, records: SshRecordView[]): SshRecordView | undefined {
  return records.find((record) => record.node === device.node)
}

/** Devices shown under "My devices": a revoked device is gone from this user's devices. */
export function listedDevices(devices: Device[]): Device[] {
  return devices.filter((device) => !device.revoked)
}

/** `net.transport.list`: the add-ons, what their actions changed, and the saved settings. */
export interface AddonListing {
  manifests: TransportManifest[]
  records?: NetAddonRecords
  settings?: Record<string, unknown>
}

const asSettings = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {}

/** Tailscale settings for Serve, keeping what is saved (a custom binary path). */
export function serveSettings(saved: unknown, port: number, servePort: number): Record<string, unknown> {
  return { ...asSettings(saved), mode: 'serve', port, servePort }
}

/** Tailscale settings without Serve: the saved ones, listening on the tailnet address again. */
export function bindSettings(saved: unknown): Record<string, unknown> {
  const { mode: _mode, servePort: _servePort, ...rest } = asSettings(saved)
  return rest
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
  // What an add-on changed outside Mousse stays listed while networking is off, so it can be undone.
  const list = () => request<AddonListing>('net.transport.list', {})
  const listed: AddonListing = current.enabled
    ? await list()
    : await list().catch((): AddonListing => ({ manifests: [], records: {}, settings: {} }))
  // The hosted relay add-on is Mousse ID too; it is offered only with the service.
  const addons: AddonListing = withMousseId
    ? listed
    : { ...listed, manifests: listed.manifests.filter((manifest) => manifest.id !== 'plus-relay') }
  const nodes =
    current.enabled && current.self && current.keystore === 'unlocked'
      ? (await request<{ nodes: Device[] }>('bridge.nodes', {})).nodes
      : []
  // Remote machines set up over SSH; an older daemon without the methods has none.
  const ssh = await request<{ records: SshRecordView[] }>('net.ssh.list', {}).then((value) => value?.records ?? [], () => [])
  return { current, hosted, addons, nodes, ssh }
}
