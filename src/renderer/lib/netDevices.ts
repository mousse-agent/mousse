import type { NetStatus, NodeCapability, NodeId } from '../../shared/net'
import type { AgentReach, BridgeAccessMine, BridgeNodeConnection, BridgeNodePolicy, NetAddonRecords, PlusStatus, SshRecordView } from '../../shared/net/local'
import type { PlatformRequestMethod } from '../../shared/platform'
import type { TransportManifest } from '../../mms/net/contracts'
import { formatAgo } from './formatAgo'
import { serviceFailureLine } from './errorText'
import { describePermissionMode, type PermissionMode } from '../../shared/permissionMode'
import { accessPreset, accessPresetOf } from '../../shared/net/accessPresets'
import { channelForVersion, type SelfUpdateReport } from '../../shared/updates'
import { compareVersions, isDevBuild } from '../../shared/net/version'

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
  /** True for a device on a newer version than this computer. */
  newerThanThis?: boolean
  /** On another update channel (nightly or stable) than this computer, so neither is simply behind. */
  otherChannel?: boolean
  /** Its update channel and whether it updates itself; absent from a computer that does not say. */
  update?: SelfUpdateReport
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
  /** An engine pairing (the new networking), not one of the old networking's devices. */
  source?: 'engine'
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
  // A held device is connected with Allow, which also sets what it may do here.
  if (connectedHere(device) || device.connection === 'held') return undefined
  return device.routeHeld ? { connect: true } : { hint: `Paste a link from ${device.name}` }
}

/** The capability that lets a computer work on this one's threads is stored as `settings`. */
export const WORKS_ON_THREADS: NodeCapability = 'settings'

/**
 * What pairing a computer opens, in both directions, said where a person pairs one (Let a device in, Use another computer, an SSH setup).
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
  return serviceFailureLine(error) ?? String(error.message ?? error.code ?? 'The connection failed.')
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

/**
 * "Behind" or "Newer" for a computer whose Mousse differs from this computer's, or its channel ("Nightly", "Stable")
 * when it follows another one, with the details for its tooltip: both versions, its channel, and whether it updates
 * itself. Undefined when they match or either is unknown.
 */
export function versionTag(
  device: Pick<Device, 'name' | 'version' | 'olderThanThis' | 'newerThanThis' | 'otherChannel' | 'update'>,
  current?: string
): { label: 'Behind' | 'Newer' | 'Nightly' | 'Stable'; detail: string } | undefined {
  const label = device.otherChannel
    ? (device.update?.channel ?? (device.version ? channelForVersion(device.version) : undefined)) === 'nightly'
      ? 'Nightly'
      : 'Stable'
    : device.olderThanThis
      ? 'Behind'
      : device.newerThanThis
        ? 'Newer'
        : undefined
  if (!label) return undefined
  const runs = device.version
    ? `${device.name} runs ${device.version}${device.update ? ` (${device.update.channel})` : ''}`
    : `${device.name} runs a Mousse too old to say its version`
  const here = current ? `, this computer ${current}` : ''
  const update = device.update
  const how = !update
    ? ''
    : update.self
      ? ' It updates itself.'
      : ` It can't update itself${update.reason ? `: ${update.reason.replace(/\.$/, '')}` : ''}.`
  return { label, detail: `${runs}${here}.${how}` }
}

/** The user's other computers that are online now and run an older Mousse than this one, each once. */
export function computersBehind(devices: readonly Device[], target?: string): Device[] {
  const seen = new Set<string>()
  return devices.filter((device) => {
    if (device.self || device.revoked || device.kind === 'phone' || device.state !== 'open' || device.otherChannel) return false
    if (!isBehind(device, target)) return false
    if (seen.has(device.node)) return false
    seen.add(device.node)
    return true
  })
}

/**
 * Behind the version this computer updates to (the one offered to it, or its own when it is up to date), not only
 * behind the version it runs now: a computer between the two is behind as well. One too old to report a version is
 * behind when it is behind this one; a development build never is.
 */
export function isBehind(device: Pick<Device, 'version' | 'olderThanThis'>, target?: string): boolean {
  if (!device.version || !target || isDevBuild(target)) return device.olderThanThis === true
  return !isDevBuild(device.version) && compareVersions(device.version, target) === -1
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
 * A device's state on this computer, for its row: connected here, held (it came in by a connect link and waits for
 * Allow), or not connected. A daemon from before the record sends none.
 */
export type DeviceConnectionState = 'connected' | 'held' | 'not_connected'
const CONNECTION_WORDS: Record<DeviceConnectionState, string> = {
  connected: 'connected here',
  held: 'waits for Allow',
  not_connected: 'not connected here'
}
export function connectionState(device: Pick<Device, 'connection'>): DeviceConnectionState | undefined {
  if (device.connection === undefined) return undefined
  return device.connection === 'connected' || device.connection === 'held' ? device.connection : 'not_connected'
}

/** The held devices, each with which side this computer is on: it made the link (`maker`) or joined through it. */
export function heldDevices(devices: Device[]): Array<{ device: Device; side: 'maker' | 'joiner' }> {
  return devices
    .filter((device) => !device.self && !device.revoked && device.connection === 'held')
    // Only a computer that joined holds the one that keeps the list.
    .map((device) => ({ device, side: device.keeper ? 'joiner' as const : 'maker' as const }))
}

/** What Allow does, for its tooltip; the maker's adds that Mousse ID connects the device elsewhere on its own. */
export function allowDetail(name: string, side: 'maker' | 'joiner'): string {
  const work = accessPreset('work')
  const access = `Allow connects ${name} here with ${work.label}: ${work.detail}`
  return side === 'maker' ? `${access} Your other computers signed in to Mousse ID connect it on their own.` : access
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

/** What one device may do on one computer, in either direction. */
export type DeviceAccess = Pick<BridgeAccessMine, 'threads' | 'work' | 'terminal' | 'editor' | 'bots'> & {
  maxPermissionMode?: PermissionMode
  /** Which threads its agents may change; a person's own calls are not limited by it. */
  agentReach?: AgentReach
}
/** Which threads a device's agents may change, as Limits names it. */
const AGENT_REACH_WORDS: Record<AgentReach, string> = { none: 'none', launched: 'only threads they started', all: 'all threads' }

/**
 * What this computer lets `device` do here, from what it knows: connected here, the block, the grant, this computer's
 * own switch ("Let my other devices work here") and the device's switches. A phone keeps the phone API.
 * A string says why it may do nothing; undefined for a daemon that sends no policy.
 */
export function accessHere(device: Device, switches: { workOnThreads: boolean }): DeviceAccess | 'not_connected' | 'blocked' | undefined {
  const policy = device.policy
  if (!policy) return undefined
  if (!connectedHere(device)) return 'not_connected'
  if (policy.blocked) return 'blocked'
  // Each item also needs the signed grant its calls check: reads need read, sends chat, terminals write.
  const has = (cap: NodeCapability) => device.caps.includes(cap)
  const bots = has('read') && policy.bots !== false
  if (!isComputer(device)) {
    const threads = device.caps.includes('read')
    return { threads, work: threads && device.caps.includes('write') && policy.work !== false, terminal: false, editor: false, bots }
  }
  const threads = worksOnThreads(device) && has('read') && switches.workOnThreads
  return {
    threads,
    work: threads && has('chat') && policy.work !== false,
    terminal: threads && has('write') && policy.terminal,
    editor: threads && policy.editor,
    bots,
    maxPermissionMode: policy.maxPermissionMode,
    ...(policy.agentReach ? { agentReach: policy.agentReach } : {})
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
    ...(access.work && access.agentReach ? [`Agents change: ${AGENT_REACH_WORDS[access.agentReach]}`] : []),
    `Terminals: ${access.terminal ? 'on' : 'off'}`,
    `Editor connections: ${access.editor ? 'on' : 'off'}`,
    `Bots: ${access.bots ? 'on' : 'off'}`
  ].join('\n')
  // Agents that may change no thread is the one limit a person working there would not expect.
  if (access.work && access.agentReach === 'none') parts.push('agents read only')
  return { line: parts.length ? parts.join(' · ') : 'Nothing', detail }
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
