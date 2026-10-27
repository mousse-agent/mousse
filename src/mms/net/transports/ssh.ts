import { spawn, type ChildProcess } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { Duplex } from 'node:stream'
import WebSocket, { type ClientOptions } from 'ws'
import type {
  Clock,
  InboundInfo,
  Listener,
  Transport,
  TransportAddon,
  TransportDialContext,
  TransportStatus
} from '../contracts'
import type { NodeId, Route } from '../../../shared/net'
import { NetError } from '../../../shared/net/errors'
import { MAX_FRAME_BYTES } from '../../../shared/net/limits'
import { DirectTransport } from './direct'
import { cleanEnvironment } from './runtime/process'
import { boundedWebSocketBytes } from './runtime/websocket'
import { systemClock } from '../clock'

/**
 * Mousse only ever opens SSH to an endpoint this device approved for that peer.
 * A peer's signed route proves who advertised it, not that this device may log in
 * to it, so the spawn uses the approved endpoint from `net/ssh/approvals.json` and
 * takes nothing from the route but a loopback port number. Host keys must already
 * be trusted, in Mousse's own known_hosts file or the user's.
 */

/** `[user@]host[:sshPort]`: no spaces, no `/`, no leading `-`, so `ssh` can never read it as an option. */
const ENDPOINT_PATTERN =
  '^(?:[A-Za-z0-9_][A-Za-z0-9._-]{0,63}@)?(?:[A-Za-z0-9][A-Za-z0-9._-]*|\\[[0-9A-Fa-f:.]+\\])(?::[0-9]{1,5})?$'
const ENDPOINT = new RegExp(ENDPOINT_PATTERN, 'u')
const ROUTE_ADDRESS = /^ssh:\/\/([^/]+)\/127\.0\.0\.1:([1-9][0-9]{0,4})$/u
const ROUTE_PRIORITY = 40
/** Each spawn is a login on the host; `ufw limit` blocks after six in 30 seconds. */
const SPAWN_FLOOR_MS = 10_000
/** A refused key or host key does not fix itself. */
const REFUSED_FLOOR_MS = 60_000
const STDERR_TAIL_BYTES = 2048
const APPROVALS_MAX_BYTES = 256 * 1024

export interface SshSettings {
  endpoint: string
  port: number
  binary?: string
}
export interface SshEndpoint {
  user?: string
  host: string
  port?: number
}
export interface SshApproval {
  endpoint: string
  fingerprint: string
  approvedAt: number
}

export function parseSshEndpoint(value: unknown): SshEndpoint | undefined {
  if (typeof value !== 'string' || value.length > 253 || !ENDPOINT.test(value)) return undefined
  const at = value.indexOf('@')
  const user = at < 0 ? undefined : value.slice(0, at)
  let host = value.slice(at + 1),
    port: number | undefined
  const colon = host.endsWith(']') ? -1 : host.lastIndexOf(':')
  if (colon >= 0) {
    port = Number(host.slice(colon + 1))
    host = host.slice(0, colon)
    if (!Number.isInteger(port) || port < 1 || port > 65535) return undefined
  }
  if (host.startsWith('[')) host = host.slice(1, -1)
  return { ...(user ? { user } : {}), host, ...(port !== undefined ? { port } : {}) }
}

/** The loopback port a host's daemon listens on, from `ssh://<endpoint>/127.0.0.1:<port>`. */
export function parseSshRoute(
  address: string
): { endpoint: SshEndpoint; port: number } | undefined {
  const match = ROUTE_ADDRESS.exec(address)
  if (!match) return undefined
  const endpoint = parseSshEndpoint(match[1]),
    port = Number(match[2])
  return endpoint && port <= 65535 ? { endpoint, port } : undefined
}

export function sshApprovalsPath(profileDir: string): string {
  return join(profileDir, 'net', 'ssh', 'approvals.json')
}
export function sshKnownHostsPath(profileDir: string): string {
  return join(profileDir, 'net', 'ssh_known_hosts')
}

/** Read per dial so an approval written by setup applies without a restart. Anything malformed is no approval. */
export async function readSshApproval(
  profileDir: string,
  node: NodeId
): Promise<SshApproval | undefined> {
  let document: unknown
  try {
    const bytes = await readFile(sshApprovalsPath(profileDir))
    if (bytes.length > APPROVALS_MAX_BYTES) return undefined
    document = JSON.parse(bytes.toString('utf8'))
  } catch {
    return undefined
  }
  if (!document || typeof document !== 'object' || Array.isArray(document)) return undefined
  if (!Object.hasOwn(document, node)) return undefined
  const row = (document as Record<string, unknown>)[node] as Partial<SshApproval> | null
  if (
    !row ||
    typeof row !== 'object' ||
    !parseSshEndpoint(row.endpoint) ||
    typeof row.fingerprint !== 'string' ||
    !row.fingerprint ||
    row.fingerprint.length > 256 ||
    typeof row.approvedAt !== 'number' ||
    !Number.isFinite(row.approvedAt)
  )
    return undefined
  return { endpoint: row.endpoint!, fingerprint: row.fingerprint, approvedAt: row.approvedAt }
}

/**
 * Paths go inside a quoted `ssh_config` argument. Forward slashes avoid its backslash escapes on
 * Windows; `%` is doubled because ssh expands `%d`-style tokens, and `${` would expand a variable.
 */
function configPath(path: string): string {
  const value = process.platform === 'win32' ? path.replace(/\\/g, '/') : path
  if (/["\\\r\n]|\$\{/u.test(value)) throw new NetError('bad_request')
  return value.replace(/%/g, '%%')
}

export function sshDialArguments(input: {
  endpoint: SshEndpoint
  port: number
  knownHosts: string
  userKnownHosts: string
}): string[] {
  const { endpoint } = input
  return [
    '-o',
    'BatchMode=yes',
    '-o',
    'StrictHostKeyChecking=yes',
    '-o',
    `UserKnownHostsFile="${configPath(input.knownHosts)}" "${configPath(input.userKnownHosts)}"`,
    '-o',
    'UpdateHostKeys=no',
    '-o',
    'PasswordAuthentication=no',
    '-o',
    'KbdInteractiveAuthentication=no',
    '-o',
    'ForwardAgent=no',
    '-o',
    'ForwardX11=no',
    '-o',
    'PermitLocalCommand=no',
    '-o',
    'ClearAllForwardings=yes',
    // One ssh process per session, and never a mux client that skips the checks above.
    '-o',
    'ControlMaster=no',
    '-o',
    'ControlPersist=no',
    '-o',
    'ControlPath=none',
    '-o',
    'LogLevel=ERROR',
    '-o',
    'ConnectTimeout=10',
    '-o',
    'ServerAliveInterval=15',
    '-o',
    'ServerAliveCountMax=3',
    '-T',
    ...(endpoint.user ? ['-l', endpoint.user] : []),
    ...(endpoint.port !== undefined ? ['-p', String(endpoint.port)] : []),
    '-W',
    `127.0.0.1:${input.port}`,
    '--',
    endpoint.host
  ]
}

/** What the last lines `ssh` printed mean for the person reading the device row. */
export function describeSshFailure(stderr: string, endpoint: string, port: number): string {
  const text = stderr.replace(/[^\x20-\x7e\n]/g, ' ')
  const url = /https:\/\/[^\s"'<>]+/.exec(text)?.[0]
  let detail: string
  if (/Host key verification failed|REMOTE HOST IDENTIFICATION HAS CHANGED/i.test(text))
    detail = `Host key verification failed for ${endpoint}. Confirm its host key under Devices.`
  else if (/Permission denied/i.test(text))
    detail = `Permission denied by ${endpoint}: no SSH key or agent identity was accepted.`
  else if (/Connection timed out|Operation timed out/i.test(text))
    detail = `Connection timed out reaching ${endpoint}.`
  else if (/Could not resolve hostname/i.test(text))
    detail = `Could not resolve the host name of ${endpoint}.`
  // OpenSSH prefixes both channel failures with `open failed`, so only the reason tells them apart.
  else if (/administratively prohibited/i.test(text))
    detail = `sshd on ${endpoint} does not allow TCP forwarding (AllowTcpForwarding).`
  else if (/connect failed/i.test(text))
    detail = `The daemon on ${endpoint} is not listening on port ${port}.`
  else {
    const last = text
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .pop()
    detail = last
      ? `SSH to ${endpoint} failed: ${last.slice(0, 200)}`
      : `SSH to ${endpoint} closed before the daemon answered.`
  }
  return url && !detail.includes(url) ? `${detail} ${url}` : detail
}

/** ws only needs a duplex byte stream, plus the socket knobs it calls unconditionally. */
class SshStream extends Duplex {
  constructor(private readonly child: ChildProcess) {
    super({ highWaterMark: MAX_FRAME_BYTES })
    const { stdin, stdout } = child
    this.on('error', () => {})
    stdin!.on('error', () => {})
    stdout!.on('error', () => {})
    stdout!.on('data', (chunk: Buffer) => {
      if (!this.push(chunk)) stdout!.pause()
    })
    stdout!.on('end', () => this.push(null))
    child.once('error', (error) => this.destroy(error))
    child.once('close', () => {
      this.push(null)
      if (!this.writableEnded) this.end()
    })
  }
  setNoDelay(): this {
    return this
  }
  setKeepAlive(): this {
    return this
  }
  setTimeout(): this {
    return this
  }
  ref(): this {
    return this
  }
  unref(): this {
    return this
  }
  override _read(): void {
    this.child.stdout!.resume()
  }
  override _write(chunk: Buffer, _encoding: BufferEncoding, done: (error?: Error | null) => void) {
    const { stdin } = this.child
    if (!stdin || stdin.destroyed || stdin.writableEnded) done(new Error('ssh closed'))
    else stdin.write(chunk, done)
  }
  override _final(done: (error?: Error | null) => void): void {
    const { stdin } = this.child
    if (!stdin || stdin.destroyed || stdin.writableEnded) done()
    else stdin.end(() => done())
  }
  override _destroy(error: Error | null, done: (error?: Error | null) => void): void {
    stopChild(this.child)
    done(error)
  }
}

function stopChild(child: ChildProcess): void {
  child.stdin?.destroy()
  if (child.exitCode !== null || child.signalCode !== null) return
  child.kill()
  const timer = setTimeout(() => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
  }, 2000)
  timer.unref()
  child.once('exit', () => clearTimeout(timer))
}

export interface SshDialerOptions {
  clock?: Clock
  /** The `ssh` executable; tests substitute a fake. */
  binary?: string | (() => string | undefined)
  /** Mousse's own known_hosts file, kept complete for every approved endpoint. */
  knownHosts: string
  /** Hosts the user already trusts in a terminal need no second prompt. */
  userKnownHosts?: string
  approval(node: NodeId): Promise<SshApproval | undefined>
}

/** Dials a peer's daemon through `ssh -W`, only over an endpoint approved locally for that peer. */
export class SshDialer {
  private readonly clock: Clock
  /** Earliest next spawn per approved endpoint, on the monotonic clock. */
  private readonly floor = new Map<string, number>()
  constructor(private readonly options: SshDialerOptions) {
    this.clock = options.clock ?? systemClock
  }
  async dial(route: Route, signal: AbortSignal, context?: TransportDialContext): Promise<Duplex> {
    if (signal.aborted) throw new NetError('cancelled', undefined, { cause: signal.reason })
    // A peer's signed route is untrusted input to ssh: it supplies the port and nothing else.
    const advertised = route.transport === 'ssh' ? parseSshRoute(route.address) : undefined
    if (!advertised) throw new NetError('route_unreachable', 'Invalid SSH route.')
    const approval = context?.peer ? await this.options.approval(context.peer) : undefined
    const endpoint = approval && parseSshEndpoint(approval.endpoint)
    if (!approval || !endpoint)
      throw new NetError('route_unreachable', 'This device has not approved SSH for that device.')
    if (signal.aborted) throw new NetError('cancelled', undefined, { cause: signal.reason })
    const now = this.clock.monotonic()
    if (now < (this.floor.get(approval.endpoint) ?? 0))
      throw new NetError(
        'route_unreachable',
        `Waiting before trying SSH to ${approval.endpoint} again.`
      )
    if (this.floor.size >= 64)
      for (const [key, until] of this.floor) if (until <= now) this.floor.delete(key)
    this.floor.set(approval.endpoint, now + SPAWN_FLOOR_MS)
    return this.open(approval.endpoint, endpoint, advertised.port, signal)
  }
  private open(
    name: string,
    endpoint: SshEndpoint,
    port: number,
    signal: AbortSignal
  ): Promise<Duplex> {
    const args = sshDialArguments({
      endpoint,
      port,
      knownHosts: this.options.knownHosts,
      userKnownHosts: this.options.userKnownHosts ?? join(homedir(), '.ssh', 'known_hosts')
    })
    const { binary } = this.options
    // Mousse never asks for a password: no askpass helper may be reached from a background dial.
    const env = cleanEnvironment()
    for (const key of Object.keys(env))
      if (key.toUpperCase().startsWith('SSH_ASKPASS')) delete env[key]
    const child = spawn((typeof binary === 'function' ? binary() : binary) ?? 'ssh', args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      env
    })
    let tail = '',
      missing = false
    child.stderr!.on('data', (chunk: Buffer) => {
      tail = (tail + chunk.toString('utf8')).slice(-STDERR_TAIL_BYTES)
    })
    child.stderr!.on('error', () => {})
    const exited = new Promise<void>((resolve) => {
      child.once('close', () => resolve())
      child.once('error', (error: NodeJS.ErrnoException) => {
        missing = error.code === 'ENOENT'
        resolve()
      })
    })
    const stream = new SshStream(child)
    return new Promise<Duplex>((resolve, reject) => {
      let settled = false
      const ws = new WebSocket(`ws://127.0.0.1:${port}/mousse-net`, {
        createConnection: (() => stream) as unknown as ClientOptions['createConnection'],
        maxPayload: MAX_FRAME_BYTES,
        perMessageDeflate: false,
        handshakeTimeout: 10_000,
        followRedirects: false
      })
      const failure = (): NetError => {
        if (/Permission denied|Host key verification failed|HOST IDENTIFICATION/i.test(tail))
          this.floor.set(name, this.clock.monotonic() + REFUSED_FLOOR_MS)
        return new NetError(
          'route_unreachable',
          missing
            ? 'The ssh command was not found. Install OpenSSH to reach this device.'
            : describeSshFailure(tail, name, port)
        )
      }
      const finish = (error?: NetError) => {
        if (settled) return
        settled = true
        signal.removeEventListener('abort', abort)
        ws.terminate()
        stream.destroy()
        if (error) {
          reject(error)
          return
        }
        // The reason is on stderr, which can trail the stream closing.
        let reported = false
        const report = () => {
          if (reported) return
          reported = true
          clearTimeout(grace)
          reject(failure())
        }
        const grace = setTimeout(report, 1000)
        void exited.then(report)
      }
      const abort = () => finish(new NetError('cancelled', undefined, { cause: signal.reason }))
      ws.once('open', () => {
        if (settled) return
        settled = true
        signal.removeEventListener('abort', abort)
        ws.on('message', (_bytes, binary) => {
          if (!binary) ws.terminate()
        })
        const raw = boundedWebSocketBytes(ws)
        raw.once('close', () => stopChild(child))
        resolve(raw)
      })
      ws.on('error', () => finish())
      ws.once('close', () => finish())
      child.once('error', () => finish())
      signal.addEventListener('abort', abort, { once: true })
      if (signal.aborted) abort()
    })
  }
}

/**
 * Listens on a fixed loopback port and advertises it as an `ssh://` route. Other
 * devices reach it with `ssh -W` (see `SshDialer`); sshd is the only way in.
 */
export class SshTransport implements Transport {
  readonly id = 'ssh'
  readonly traits = { canListen: true, canDial: true, readsPlaintext: false, needsAccount: false }
  private direct?: DirectTransport
  private statusValue: TransportStatus = { state: 'disabled', routes: [] }
  private off?: () => void
  private readonly listeners = new Set<(status: TransportStatus) => void>()
  constructor(
    private readonly settings: SshSettings,
    private readonly clock: Clock = systemClock
  ) {
    if (
      !parseSshEndpoint(settings.endpoint) ||
      !Number.isInteger(settings.port) ||
      settings.port < 1 ||
      settings.port > 65535
    )
      throw new NetError('bad_request', 'Invalid SSH settings.')
  }
  async provision(): Promise<void> {
    if (this.direct) return
    this.direct = new DirectTransport({
      enabled: true,
      host: '127.0.0.1',
      port: this.settings.port,
      clock: this.clock
    })
    this.off = this.direct.onStatus((current) =>
      this.changed({
        ...current,
        routes: current.routes.map(() => ({
          transport: 'ssh',
          address: `ssh://${this.settings.endpoint}/127.0.0.1:${this.settings.port}`,
          priority: ROUTE_PRIORITY
        }))
      })
    )
    await this.direct.provision()
  }
  async listen(accept: (stream: Duplex, info: InboundInfo) => void): Promise<Listener> {
    if (!this.direct) throw new NetError('route_unreachable')
    return this.direct.listen((raw, info) => accept(raw, { ...info, transport: this.id }))
  }
  markAuthenticated(raw: Duplex): void {
    this.direct?.markAuthenticated(raw)
  }
  /** Dials go through the profile's `SshDialer`, which owns the approvals and the spawn floor. */
  async dial(): Promise<Duplex> {
    throw new NetError('route_unreachable', 'SSH routes are dialed by the profile transports.')
  }
  status(): TransportStatus {
    return structuredClone(this.statusValue)
  }
  onStatus(listener: (status: TransportStatus) => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }
  private changed(status: TransportStatus): void {
    this.statusValue = status
    for (const listener of this.listeners) listener(this.status())
  }
  async teardown(): Promise<void> {
    this.off?.()
    this.off = undefined
    await this.direct?.teardown()
    this.direct = undefined
    this.changed({ state: 'disabled', routes: [] })
  }
}

export const sshAddon: TransportAddon = {
  manifest: {
    id: 'ssh',
    kind: 'transport',
    displayName: 'SSH',
    traits: { canListen: true, canDial: true, readsPlaintext: false, needsAccount: false },
    settingsSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['endpoint', 'port'],
      properties: {
        endpoint: { type: 'string', minLength: 1, maxLength: 253, pattern: ENDPOINT_PATTERN },
        port: { type: 'integer', minimum: 1, maximum: 65535 },
        binary: { type: 'string', minLength: 1, maxLength: 4096 }
      }
    },
    setupSteps: [
      {
        title: 'Reachable over SSH',
        detail:
          'A device that can `ssh <endpoint>` with a key or agent approves this endpoint under Devices. Mousse only opens SSH to endpoints approved there, with host keys you have confirmed.'
      }
    ]
  },
  create: (settings, context) => new SshTransport(settings as SshSettings, context.clock)
}
