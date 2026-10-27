import { execFile } from 'node:child_process'
import type { Duplex } from 'node:stream'
import { isIP } from 'node:net'
import type {
  Clock,
  InboundInfo,
  Listener,
  Transport,
  TransportAddon,
  TransportAddonAction,
  TransportAddonContext,
  TransportAddonUndo,
  TransportStatus
} from '../contracts'
import type { Route } from '../../../shared/net/identity'
import { NetError, type NetErrorCode } from '../../../shared/net/errors'
import { TAILSCALE_FUNNEL_PORTS } from '../../../shared/net/local'
import { DirectTransport } from './direct'
import { runBinary, cleanEnvironment } from './runtime/process'
import { systemClock } from '../clock'

export interface TailscaleSettings {
  binary?: string
  port?: number
  enabled?: boolean
  /** `bind` listens on the tailnet address. `serve` listens on loopback and lets Tailscale Serve forward to it. */
  mode?: 'bind' | 'serve'
  /** Tailnet port that Tailscale Serve forwards to `port`. */
  servePort?: number
}

/** The tailnet a Serve mapping was approved for. */
export interface TailnetIdentity {
  name: string
  node: string
}

/**
 * What Mousse keeps about its Serve mapping, so it can find and remove exactly that mapping.
 * `pending` is written before the mapping is made, `applied` once it is confirmed, and `removing`
 * before it is removed. Only a `pending` mapping that never completed is finished automatically,
 * once: it is the change the user approved a moment ago. A mapping that was `applied` and later
 * disappeared was removed by someone else (or Tailscale was reset), so the user is asked again.
 */
export interface TailscaleServeRecord {
  servePort: number
  port: number
  tailnet: TailnetIdentity
  state: 'pending' | 'applied' | 'removing'
  /** An automatic completion was already tried for this approval. */
  completionTried?: boolean
}

const STATUS_TIMEOUT_MS = 3500
const SIGNED_IN_TIMEOUT_MS = 5000
const COMMAND_TIMEOUT_MS = 10_000
/** Each group of Tailscale calls shares a budget, so a stuck CLI never holds anything up for long. */
const CHECK_BUDGET_MS = 15_000
const VERIFY_BUDGET_MS = 8000
const OUTPUT_LIMIT_BYTES = 512 * 1024
/** `--tcp=<port> tcp://…` and `serve status --json` are the CLI of Tailscale 1.52 and newer. */
const SERVE_MINIMUM = { major: 1, minor: 52 }
/** The only commands that change Serve. Never `serve reset`, `funnel`, `up` or `set`. */
const serveCli = {
  status: ['serve', 'status', '--json'],
  on: (servePort: number, port: number) => [
    'serve',
    '--bg',
    `--tcp=${servePort}`,
    `tcp://127.0.0.1:${port}`
  ],
  off: (servePort: number) => ['serve', `--tcp=${servePort}`, 'off']
}
const OPERATOR_REMEDY = 'sudo tailscale set --operator=$USER'

/** A Serve problem whose message is safe to show as it is. */
class ServeError extends NetError {
  constructor(code: NetErrorCode, message: string, remedy?: string) {
    super(code, message, remedy ? { details: { remedy } } : undefined)
  }
}

interface CommandFailure {
  stderr: string
  timedOut: boolean
  /** The output was larger than Mousse reads. */
  overflow: boolean
  /** The binary was not found. */
  missing: boolean
}

class CommandError extends Error {
  constructor(readonly failure: CommandFailure) {
    super('The tailscale command failed.')
  }
}

/** A command as the user would type it: the binary quoted when its path needs it. */
export function commandText(
  binary: string,
  args: string[],
  platform: NodeJS.Platform = process.platform
): string {
  const word = (value: string) =>
    /^[A-Za-z0-9_@%+=:,./-]+$/.test(value)
      ? value
      : platform === 'win32'
        ? `"${value.replaceAll('"', '')}"`
        : `'${value.replaceAll("'", `'\\''`)}'`
  return [binary, ...args].map(word).join(' ')
}

/** A failed Tailscale command as a message the user can act on. */
export function serveFailure(
  failure: CommandFailure,
  platform: NodeJS.Platform = process.platform
): ServeError {
  if (failure.missing)
    return new ServeError('route_unreachable', 'Tailscale is not installed, or its path is wrong.')
  if (failure.overflow)
    return new ServeError(
      'too_large',
      'Tailscale returned more output than Mousse reads, so it changed nothing.'
    )
  if (/operator|permission/i.test(failure.stderr))
    // The operator setting is a Linux idea; elsewhere the message stands alone.
    return platform === 'linux'
      ? new ServeError(
          'forbidden',
          'Tailscale needs permission to change Serve for your user. Run the command below once, then try again.',
          OPERATOR_REMEDY
        )
      : new ServeError('forbidden', 'Tailscale did not allow this user to change Serve.')
  if (failure.timedOut)
    return new ServeError('route_unreachable', 'Tailscale did not answer in time.')
  const line = failure.stderr.trim().split('\n')[0]?.slice(0, 200)
  return new ServeError(
    'route_unreachable',
    line ? `Tailscale said: ${line}` : 'Tailscale is not installed or did not respond.'
  )
}

function run(binary: string, args: string[], timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      binary,
      args,
      {
        timeout: timeoutMs,
        maxBuffer: OUTPUT_LIMIT_BYTES,
        windowsHide: true,
        encoding: 'utf8',
        env: cleanEnvironment()
      },
      (error, stdout, stderr) => {
        if (!error) return resolve(stdout)
        const code = (error as NodeJS.ErrnoException).code
        const overflow = code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER'
        reject(
          new CommandError({
            stderr: String(stderr ?? ''),
            // A killed child is a timeout, unless it was killed for writing too much.
            timedOut: !!error.killed && !overflow,
            overflow,
            missing: code === 'ENOENT'
          })
        )
      }
    )
  })
}

/** Runs a Serve command, turning its failure into a message the user can act on. */
async function runServe(binary: string, args: string[], timeoutMs: number): Promise<string> {
  try {
    return await run(binary, args, timeoutMs)
  } catch (error) {
    if (error instanceof CommandError) throw serveFailure(error.failure)
    throw error
  }
}

/** The time left for a group of calls. */
class Deadline {
  private readonly end: number
  constructor(ms: number) {
    this.end = Date.now() + ms
  }
  /** A call's own limit, or what is left of the budget when that is less. */
  slice(limit: number): number {
    const left = this.end - Date.now()
    if (left <= 0) throw new ServeError('route_unreachable', 'Tailscale did not answer in time.')
    return Math.min(limit, left)
  }
}

async function requireServeVersion(binary: string, deadline: Deadline): Promise<void> {
  const match = /^v?(\d+)\.(\d+)/.exec(
    (await runServe(binary, ['version'], deadline.slice(STATUS_TIMEOUT_MS))).trim()
  )
  const older =
    !match ||
    Number(match[1]) < SERVE_MINIMUM.major ||
    (Number(match[1]) === SERVE_MINIMUM.major && Number(match[2]) < SERVE_MINIMUM.minor)
  if (older)
    throw new ServeError(
      'unsupported_version',
      `Tailscale Serve needs Tailscale ${SERVE_MINIMUM.major}.${SERVE_MINIMUM.minor} or newer${match ? ` (this is ${match[1]}.${match[2]})` : ''}.`
    )
}

const plain = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value)

/** What Mousse reads from `tailscale status --json`. */
function parseTailscaleStatus(output: string): {
  running: boolean
  address?: string
  identity?: TailnetIdentity
} {
  let status: unknown
  try {
    status = JSON.parse(output)
  } catch {
    throw new ServeError('unsupported_version', 'Tailscale returned a status Mousse cannot read.')
  }
  if (!plain(status))
    throw new ServeError('unsupported_version', 'Tailscale returned a status Mousse cannot read.')
  const self = plain(status.Self) ? status.Self : {}
  const tailnet = plain(status.CurrentTailnet) ? status.CurrentTailnet : {}
  const addresses = Array.isArray(self.TailscaleIPs) ? self.TailscaleIPs : []
  const address = addresses.find((value) => typeof value === 'string' && isIP(value) === 4)
  const name = typeof tailnet.Name === 'string' && tailnet.Name ? tailnet.Name : undefined
  const node = typeof self.ID === 'string' && self.ID ? self.ID : undefined
  return {
    running: status.BackendState === 'Running',
    ...(typeof address === 'string' ? { address } : {}),
    ...(name && node ? { identity: { name, node } } : {})
  }
}

/** Which tailnet and node this is, read fresh. Serve is never touched without it. */
async function readIdentity(binary: string, deadline: Deadline): Promise<TailnetIdentity> {
  const found = parseTailscaleStatus(
    await runServe(binary, ['status', '--json'], deadline.slice(SIGNED_IN_TIMEOUT_MS))
  )
  if (!found.running)
    throw new ServeError('route_unreachable', 'Tailscale is not running or not signed in.')
  if (!found.identity)
    throw new ServeError(
      'unsupported_version',
      'Tailscale did not report which tailnet this is, so Mousse will not change Serve.'
    )
  return found.identity
}

const sameTailnet = (a: TailnetIdentity, b: TailnetIdentity) =>
  a.name === b.name && a.node === b.node

interface ServeConfig {
  /** TCP handlers by tailnet port. */
  tcp: Record<string, Record<string, unknown>>
  /** `host:port` keys that Funnel is on for. */
  funnel: string[]
}

/**
 * Reads `tailscale serve status --json`. An empty configuration is `{}`; anything Mousse does not
 * recognise is an error, never "no mapping", because a wrong guess here removes or adds the wrong thing.
 */
export function parseServeStatus(output: string): ServeConfig {
  const unreadable = () =>
    new ServeError(
      'unsupported_version',
      'Tailscale returned a Serve status Mousse does not understand, so it changed nothing.'
    )
  let value: unknown
  try {
    value = JSON.parse(output)
  } catch {
    throw unreadable()
  }
  if (!plain(value)) throw unreadable()
  const tcp = value.TCP === undefined ? {} : value.TCP
  if (!plain(tcp) || Object.values(tcp).some((entry) => !plain(entry))) throw unreadable()
  const allow = value.AllowFunnel === undefined ? {} : value.AllowFunnel
  if (!plain(allow)) throw unreadable()
  return {
    tcp: tcp as ServeConfig['tcp'],
    funnel: Object.entries(allow)
      .filter(([, on]) => on === true)
      .map(([key]) => key)
  }
}

async function readServeConfig(binary: string, deadline: Deadline): Promise<ServeConfig> {
  return parseServeStatus(
    await runServe(binary, serveCli.status, deadline.slice(STATUS_TIMEOUT_MS))
  )
}

/** Where a plain TCP handler forwards to, or nothing for an HTTP(S) or TLS-terminating one. */
function forwardTarget(entry: Record<string, unknown>): string | undefined {
  if (typeof entry.TCPForward !== 'string') return undefined
  if (entry.HTTP || entry.HTTPS || entry.TerminateTLS) return undefined
  return entry.TCPForward
}

/** The entry forwards the tailnet port to this device's own loopback port, and nothing else. */
function forwardsTo(entry: Record<string, unknown>, port: number): boolean {
  const target = forwardTarget(entry)
  return target === `127.0.0.1:${port}` || target === `localhost:${port}`
}

function describeEntry(entry: Record<string, unknown>): string {
  const target = forwardTarget(entry)
  if (target) return target.slice(0, 100)
  return entry.HTTPS ? 'an HTTPS handler' : entry.HTTP ? 'an HTTP handler' : 'another handler'
}

function serveRecord(value: unknown): TailscaleServeRecord | undefined {
  if (!plain(value)) return undefined
  const tailnet = value.tailnet
  const valid =
    Number.isInteger(value.servePort) &&
    Number.isInteger(value.port) &&
    plain(tailnet) &&
    typeof tailnet.name === 'string' &&
    typeof tailnet.node === 'string' &&
    (value.state === 'pending' || value.state === 'applied' || value.state === 'removing')
  return valid ? (value as unknown as TailscaleServeRecord) : undefined
}

interface Target {
  binary: string
  port: number
  servePort: number
}

function serveTarget(settings: unknown): Target {
  const value = (settings ?? {}) as TailscaleSettings
  if (value.mode !== 'serve' || !value.port || !value.servePort)
    throw new NetError('bad_request', 'Tailscale Serve needs a daemon port and a Serve port.')
  return { binary: value.binary ?? 'tailscale', port: value.port, servePort: value.servePort }
}

function foreignEntry(target: Target, entry: Record<string, unknown>): ServeError {
  // An entry that already points at this daemon's port is probably a leftover; show how to remove it.
  const remedy = forwardsTo(entry, target.port)
    ? commandText(target.binary, serveCli.off(target.servePort))
    : undefined
  return new ServeError(
    'conflict',
    `Tailscale port ${target.servePort} already forwards to ${describeEntry(entry)}. Mousse did not set that up and leaves it alone; pick another port${remedy ? ', or remove it yourself with the command below' : ''}.`,
    remedy
  )
}

function refuseFunnel(config: ServeConfig, servePort: number): void {
  if (config.funnel.some((key) => key.endsWith(`:${servePort}`)))
    throw new ServeError(
      'conflict',
      `Tailscale Funnel is on for port ${servePort}, which would make Mousse reachable from the internet. Turn Funnel off for that port in Tailscale, or pick another port.`
    )
}

/** One mapping at a time: a second port would leave the first with no record to undo it by. */
function requireOnlyMapping(recorded: TailscaleServeRecord | undefined, target: Target): void {
  if (recorded && (recorded.servePort !== target.servePort || recorded.port !== target.port))
    throw new ServeError(
      'conflict',
      `Mousse already forwards tailnet port ${recorded.servePort} to this device. Turn that off first.`
    )
}

/** A record made on another tailnet is not this tailnet's to change. */
function requireSameTailnet(
  recorded: TailscaleServeRecord | undefined,
  identity: TailnetIdentity
): void {
  if (recorded && !sameTailnet(recorded.tailnet, identity))
    throw new ServeError(
      'conflict',
      `Serve was turned on for the tailnet ${recorded.tailnet.name}, and this device is now on ${identity.name}. Turn it off first.`
    )
}

/** How the tailnet port looks now, against the daemon port Mousse forwards to. */
async function mappingState(
  target: Target,
  deadline: Deadline
): Promise<{ kind: 'ours' | 'absent' } | { kind: 'other'; entry: Record<string, unknown> }> {
  const entry = (await readServeConfig(target.binary, deadline)).tcp[String(target.servePort)]
  if (!entry) return { kind: 'absent' }
  return forwardsTo(entry, target.port) ? { kind: 'ours' } : { kind: 'other', entry }
}

type ServeState =
  | { kind: 'checking' }
  | { kind: 'mapped'; note?: string }
  | { kind: 'idle'; detail: string }
  | { kind: 'failed'; code: NetErrorCode; detail: string }

type RecordStore = Pick<TransportAddonContext, 'record' | 'remember' | 'forget'>

/** Uses an already authenticated tailnet. Never logs in, changes ACLs or enables Funnel. */
export class TailscaleTransport implements Transport {
  readonly id = 'tailscale'
  readonly traits = { canListen: true, canDial: true, readsPlaintext: false, needsAccount: true }
  private direct?: DirectTransport
  private statusValue: TransportStatus = { state: 'disabled', routes: [] }
  private off?: () => void
  private address?: string
  private identity?: TailnetIdentity
  private listening = false
  private serve: ServeState = { kind: 'checking' }
  private epoch = 0
  private queue: Promise<unknown> = Promise.resolve()
  private readonly listeners = new Set<(status: TransportStatus) => void>()
  constructor(
    private readonly settings: TailscaleSettings = {},
    private readonly clock: Clock = systemClock,
    private readonly store?: RecordStore
  ) {
    if (settings.mode === 'serve') {
      if (!settings.port || !settings.servePort)
        throw new NetError('bad_request', 'Serve mode needs a fixed daemon port and a Serve port.')
      if (TAILSCALE_FUNNEL_PORTS.includes(settings.servePort))
        throw new NetError(
          'bad_request',
          `Tailnet ports ${TAILSCALE_FUNNEL_PORTS.join(', ')} are Funnel ports. Pick another Serve port.`
        )
    } else if (settings.servePort !== undefined)
      throw new NetError('bad_request', 'A Serve port needs Serve mode.')
  }
  private get serving(): boolean {
    return this.settings.mode === 'serve'
  }
  async provision(): Promise<void> {
    if (this.direct) return
    this.changed({ state: 'provisioning', routes: [] })
    try {
      const binary = this.settings.binary ?? 'tailscale'
      const found = parseTailscaleStatus(
        await runBinary(binary, ['status', '--json'], { maximumBytes: OUTPUT_LIMIT_BYTES })
      )
      if (!found.running || !found.address) throw new Error()
      if (this.serving && !found.identity)
        throw new ServeError(
          'unsupported_version',
          'Tailscale did not report which tailnet this is, so Mousse will not use Serve.'
        )
      this.address = found.address
      this.identity = found.identity
      // The Serve mapping is only looked at once Mousse holds its loopback port (see `listen`).
      this.direct = new DirectTransport({
        enabled: this.settings.enabled ?? true,
        host: this.serving ? '127.0.0.1' : found.address,
        port: this.settings.port ?? 0,
        clock: this.clock
      })
      this.off = this.direct.onStatus(() => this.publish())
      await this.direct.provision()
    } catch (error) {
      // Without Serve, any failure here still reads as "install Tailscale and sign in".
      const serve = this.serving && error instanceof ServeError ? error : undefined
      this.changed({
        state: 'failed',
        routes: [],
        detail: serve?.message ?? 'Install Tailscale and sign into your tailnet, then retry setup.',
        lastError: {
          code: serve?.code ?? 'route_unreachable',
          message: serve?.message ?? 'Tailscale is unavailable or not connected.'
        }
      })
      throw serve ?? new NetError('route_unreachable', 'Tailscale is unavailable or not connected.')
    }
  }
  async listen(accept: (stream: Duplex, info: InboundInfo) => void): Promise<Listener> {
    if (!this.direct) throw new NetError('route_unreachable')
    const wrapped = (raw: Duplex, info: InboundInfo) => accept(raw, { ...info, transport: this.id })
    if (!this.serving) return this.direct.listen(wrapped)
    let inner: Listener
    try {
      inner = await this.direct.listen(wrapped)
    } catch (error) {
      // Nothing is forwarded to a port Mousse could not take.
      this.serve = {
        kind: 'failed',
        code: error instanceof NetError ? error.code : 'route_unreachable',
        detail: `Mousse could not listen on 127.0.0.1:${this.settings.port}. Something else may be using it, so Serve was not touched.`
      }
      this.publish()
      throw error
    }
    this.listening = true
    this.serve = { kind: 'checking' }
    this.publish()
    void this.refresh()
    return {
      close: async () => {
        this.listening = false
        await inner.close()
      }
    }
  }
  holdsLoopback(port: number): boolean {
    return this.serving && this.listening && this.settings.port === port
  }
  /** Looks at the Serve mapping again. Only runs while Mousse holds its loopback port. */
  refresh(): Promise<void> {
    if (!this.serving || !this.listening) return Promise.resolve()
    const work = async () => {
      const epoch = this.epoch
      let next: ServeState
      try {
        next = await this.reconcile(epoch)
      } catch (error) {
        next =
          error instanceof ServeError
            ? { kind: 'failed', code: error.code, detail: error.message }
            : {
                kind: 'failed',
                code: 'route_unreachable',
                detail: 'Tailscale Serve could not be checked.'
              }
      }
      if (epoch !== this.epoch || !this.listening) return
      this.serve = next
      this.publish()
    }
    const result = this.queue.then(work, work)
    this.queue = result.catch(() => {})
    return result
  }
  /**
   * Decides what the mapping means. The recorded mapping in place is ready. One that Mousse
   * started and never finished is completed once. One that was applied and is now gone, a port
   * that forwards somewhere else, another tailnet and Funnel are all reported and left alone.
   */
  private async reconcile(epoch: number): Promise<ServeState> {
    const binary = this.settings.binary ?? 'tailscale'
    const target: Target = {
      binary,
      port: this.settings.port!,
      servePort: this.settings.servePort!
    }
    const deadline = new Deadline(CHECK_BUDGET_MS)
    const live = () => {
      if (epoch !== this.epoch) throw new NetError('cancelled')
    }
    const stored = serveRecord(this.store?.record?.())
    const record =
      stored && stored.servePort === target.servePort && stored.port === target.port
        ? stored
        : undefined
    const config = await readServeConfig(binary, deadline)
    live()
    refuseFunnel(config, target.servePort)
    if (record && this.identity && !sameTailnet(record.tailnet, this.identity))
      return {
        kind: 'idle',
        detail: `Serve was turned on for the tailnet ${record.tailnet.name}, and this device is now on ${this.identity.name}. Turn Serve on again here, or sign back in to turn it off.`
      }
    const entry = config.tcp[String(target.servePort)]
    if (entry) {
      if (!record || !forwardsTo(entry, target.port)) throw foreignEntry(target, entry)
      if (record.state === 'removing')
        return { kind: 'idle', detail: 'Serve is being turned off. Use Turn off Serve to finish.' }
      if (record.state === 'pending') this.store?.remember?.({ ...record, state: 'applied' })
      return { kind: 'mapped' }
    }
    if (record?.state === 'pending' && !record.completionTried) {
      // Mousse stopped before it finished the change the user approved. Finish exactly that one,
      // now that it holds the loopback port, and never again for this approval.
      this.store?.remember?.({ ...record, completionTried: true })
      await requireServeVersion(binary, deadline)
      live()
      await runServe(binary, serveCli.on(target.servePort, target.port), COMMAND_TIMEOUT_MS)
      const seen = await mappingState(target, new Deadline(VERIFY_BUDGET_MS))
      live()
      if (seen.kind !== 'ours')
        throw new ServeError('route_unreachable', 'Tailscale did not restore the Serve mapping.')
      this.store?.remember?.({ ...record, state: 'applied', completionTried: true })
      return { kind: 'mapped', note: 'Serve mapping restored' }
    }
    if (!record)
      return {
        kind: 'idle',
        detail: 'Serve is not turned on yet. Use “Turn on Serve…” to set it up.'
      }
    return {
      kind: 'idle',
      detail:
        record.state === 'removing'
          ? 'Serve was turned off.'
          : record.state === 'applied'
            ? 'The Serve mapping Mousse added is gone (it was removed, or Tailscale was reset). Turn Serve on again.'
            : 'Mousse could not finish turning Serve on. Turn Serve on again.'
    }
  }
  markAuthenticated(raw: Duplex): void {
    this.direct?.markAuthenticated(raw)
  }
  async dial(route: Route, signal: AbortSignal): Promise<Duplex> {
    if (!this.direct) throw new NetError('route_unreachable')
    return this.direct.dial({ ...route, transport: 'direct' }, signal)
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
  private publish(): void {
    const current = this.direct?.status() ?? { state: 'disabled' as const, routes: [] }
    const advertised = (address: (route: Route) => string): Route[] =>
      current.routes.map((route) => ({
        ...route,
        transport: 'direct',
        priority: 10,
        address: address(route)
      }))
    if (!this.serving) {
      this.changed({ ...current, routes: advertised((route) => route.address) })
      return
    }
    const serve = this.serve
    if (serve.kind === 'failed')
      this.changed({
        state: 'failed',
        routes: [],
        detail: serve.detail,
        lastError: { code: serve.code, message: serve.detail }
      })
    else if (!this.listening) this.changed({ ...current, routes: [] })
    else if (serve.kind === 'checking')
      this.changed({ state: 'provisioning', routes: [], detail: 'Checking Tailscale Serve…' })
    else if (serve.kind === 'idle')
      this.changed({ state: 'degraded', routes: [], detail: serve.detail })
    else
      this.changed({
        ...current,
        // Other devices reach the tailnet port that Serve forwards to the loopback listener.
        routes: advertised(() => `ws://${this.address}:${this.settings.servePort}/mousse-net`),
        ...(serve.note ? { detail: serve.note } : {})
      })
  }
  private changed(status: TransportStatus): void {
    this.statusValue = status
    for (const listener of this.listeners) listener(this.status())
  }
  async teardown(): Promise<void> {
    this.epoch++
    this.listening = false
    this.serve = { kind: 'checking' }
    this.off?.()
    this.off = undefined
    await this.direct?.teardown()
    this.direct = undefined
    this.changed({ state: 'disabled', routes: [] })
  }
}

const budget = () => new Deadline(CHECK_BUDGET_MS)

/** Serve forwards a tailnet port to the loopback listener, so the daemon never binds the tailnet. */
const serveAction: TransportAddonAction = {
  title: 'Serve',
  async describe(settings, context: TransportAddonContext) {
    const target = serveTarget(settings)
    const { binary, port, servePort } = target
    const deadline = budget()
    await requireServeVersion(binary, deadline)
    const identity = await readIdentity(binary, deadline)
    const recorded = serveRecord(context.record?.())
    requireSameTailnet(recorded, identity)
    requireOnlyMapping(recorded, target)
    const config = await readServeConfig(binary, deadline)
    refuseFunnel(config, servePort)
    const entry = config.tcp[String(servePort)]
    if (entry && !(recorded && forwardsTo(entry, port))) throw foreignEntry(target, entry)
    return {
      changes: [
        {
          title: 'Listen on this computer only',
          detail: `Mousse listens on 127.0.0.1:${port} first, and forwards nothing until it holds that port.`
        },
        entry
          ? {
              title: 'Serve is already on for this port',
              detail: `Tailscale already forwards port ${servePort} to this device; nothing more to run.`
            }
          : {
              title: 'Forward a tailnet port to this device',
              detail: `Devices on your tailnet reach Mousse on port ${servePort}. Nothing is exposed to the internet; Funnel stays off.`,
              command: commandText(binary, serveCli.on(servePort, port))
            },
        {
          title: 'Remembered so it can be undone',
          detail: `Mousse records this mapping and the tailnet ${identity.name}. Undo removes only that mapping. Tailscale keeps a mapping like this until it is removed, also while Mousse is not running.`,
          command: commandText(binary, serveCli.off(servePort))
        },
        {
          title: 'Left unchanged',
          detail: 'Your Tailscale sign-in, access rules and Funnel settings are not touched.'
        }
      ]
    }
  },
  async apply(settings, context) {
    const target = serveTarget(settings)
    const { binary, port, servePort } = target
    const deadline = budget()
    await requireServeVersion(binary, deadline)
    const identity = await readIdentity(binary, deadline)
    const recorded = serveRecord(context.record?.())
    requireSameTailnet(recorded, identity)
    requireOnlyMapping(recorded, target)
    // Nothing is forwarded to a loopback port that this daemon does not hold.
    if (!context.listening?.(port))
      throw new ServeError(
        'conflict',
        `Mousse is not listening on 127.0.0.1:${port} yet, so it will not forward a tailnet port to it.`
      )
    const config = await readServeConfig(binary, deadline)
    refuseFunnel(config, servePort)
    const existing = config.tcp[String(servePort)]
    if (existing) {
      // Only an entry that points at this daemon, for a mapping Mousse recorded, is Mousse's.
      if (!recorded || !forwardsTo(existing, port)) throw foreignEntry(target, existing)
      const record: TailscaleServeRecord = { ...recorded, state: 'applied' }
      if (recorded.state !== 'applied') context.remember?.(record)
      return { record }
    }
    // The record goes down first, so a mapping that lands is always findable by Undo.
    const pending: TailscaleServeRecord = {
      servePort,
      port,
      tailnet: identity,
      state: 'pending'
    }
    context.remember?.(pending)
    let failure: unknown
    try {
      await runServe(binary, serveCli.on(servePort, port), COMMAND_TIMEOUT_MS)
    } catch (error) {
      failure = error
    }
    let seen: Awaited<ReturnType<typeof mappingState>>
    try {
      seen = await mappingState(target, new Deadline(VERIFY_BUDGET_MS))
    } catch {
      // Mousse cannot tell whether the change landed. The pending record stays, and Undo or the
      // next check settles it.
      throw (
        failure ??
        new ServeError(
          'route_unreachable',
          'Tailscale ran the command, but Mousse could not read the result. The change is recorded, so Turn off Serve can still remove it.'
        )
      )
    }
    if (seen.kind === 'ours')
      return { record: { ...pending, state: 'applied' } as TailscaleServeRecord }
    // Whatever is there now is not what Mousse wrote, so Mousse claims nothing.
    context.forget?.()
    if (failure) throw failure
    if (seen.kind === 'other') throw foreignEntry(target, seen.entry)
    throw new ServeError('route_unreachable', 'Tailscale did not report the new Serve mapping.')
  },
  async undo(record, settings, context): Promise<TransportAddonUndo> {
    const recorded = serveRecord(record)
    if (!recorded)
      return { outcome: 'already-removed', message: 'Mousse had no Serve mapping recorded.' }
    const binary = (settings as TailscaleSettings | undefined)?.binary ?? 'tailscale'
    const target: Target = { binary, port: recorded.port, servePort: recorded.servePort }
    const deadline = budget()
    // A status Mousse cannot read, or a Tailscale that does not answer, is an error and keeps the record.
    const identity = await readIdentity(binary, deadline)
    if (!sameTailnet(recorded.tailnet, identity))
      return {
        outcome: 'left',
        message: `Serve was turned on for the tailnet ${recorded.tailnet.name}, and this device is now on ${identity.name}, so Mousse changed nothing here. To turn it off there, sign back in to ${recorded.tailnet.name} and run ${commandText(binary, serveCli.off(recorded.servePort))}.`
      }
    const entry = (await readServeConfig(binary, deadline)).tcp[String(recorded.servePort)]
    if (!entry)
      return {
        outcome: 'already-removed',
        message: `Tailnet port ${recorded.servePort} was already off.`
      }
    if (!forwardsTo(entry, recorded.port))
      return {
        outcome: 'left',
        message: `Tailnet port ${recorded.servePort} now forwards to ${describeEntry(entry)}, so Mousse left it alone.`
      }
    context.remember?.({ ...recorded, state: 'removing' })
    await runServe(binary, serveCli.off(recorded.servePort), COMMAND_TIMEOUT_MS)
    const seen = await mappingState(target, new Deadline(VERIFY_BUDGET_MS))
    if (seen.kind === 'ours')
      throw new ServeError('route_unreachable', 'Tailscale did not remove the Serve mapping.')
    return { outcome: 'removed', message: `Tailnet port ${recorded.servePort} is off.` }
  }
}

export const tailscaleAddon: TransportAddon = {
  manifest: {
    id: 'tailscale',
    kind: 'transport',
    displayName: 'Tailscale',
    traits: { canListen: true, canDial: true, readsPlaintext: false, needsAccount: true },
    settingsSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        binary: { type: 'string', minLength: 1, maxLength: 4096 },
        port: { type: 'integer', minimum: 0, maximum: 65535 },
        enabled: { type: 'boolean' },
        mode: { enum: ['bind', 'serve'] },
        servePort: { type: 'integer', minimum: 1, maximum: 65535 }
      }
    },
    setupSteps: [
      {
        title: 'Connect Tailscale',
        detail:
          'Install Tailscale and sign in to your tailnet. Mousse uses its private address and does not enable Funnel.',
        command: 'tailscale up'
      }
    ]
  },
  create: (settings, context) =>
    new TailscaleTransport(settings as TailscaleSettings, context.clock, context),
  actions: { serve: serveAction }
}
