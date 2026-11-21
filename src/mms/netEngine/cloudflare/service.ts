import { randomBytes } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { readdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import type { NetEngineCloudflare } from '../../../shared/netEngine/local'
import { tunnelRoute, WS_PATH_SUFFIX } from '../../../shared/netEngine/routes'
import { atomicWriteJsonSync } from '../../data/AtomicFs'
import { ensurePrivateDirectory } from '../../data/privateAcl'
import { systemClock } from '../../net/clock'
import { ProcessSupervisor } from '../../net/transports/runtime/process'
import { CLOUDFLARE_TUNNEL_ID, CloudflareCli, cloudflareHostname, cloudflareEdge, type CloudflareAccount } from './cli'
import { cloudflaredEnv, resolveCloudflared } from './runtime'

const SIGN_IN_CLEANUP = { recursive: true, force: true, maxRetries: 3, retryDelay: 100 } as const
const CONNECTION_HINT_MS = 90_000
const CONNECTION_HINT = 'Still can’t reach the tunnel. Check that the tunnel and domain are active in Cloudflare.'
const CONNECTOR_CONFIG = 'connector.yml'

interface CloudflareOrigin {
  port: number
  test(route: string): Promise<boolean>
  advertise(route: string | null): Promise<void>
}

type Setup = CloudflareAccount & {
  label: string
  secret: string
  enabled: boolean
}

type Ready = CloudflareAccount & {
  label: string
  tunnelId: string
  hostname: string
  token: string
  enabled: boolean
}

type Settings = Setup | Ready

interface Attempt {
  origin: CloudflareOrigin
  abort: AbortController
  job: Promise<void>
  connector?: ProcessSupervisor
  probe?: AbortController
  advertised?: boolean
  reconnecting?: boolean
  connectionHint?: ReturnType<typeof setTimeout>
}

function valid(value: unknown): value is Settings {
  if (!value || typeof value !== 'object') return false
  const entry = value as Record<string, unknown>
  if (typeof entry.enabled !== 'boolean' || typeof entry.label !== 'string' ||
      !/^mousse-[0-9a-f]{20}$/.test(entry.label) ||
      typeof entry.accountId !== 'string' || !/^[0-9a-f]{32}$/.test(entry.accountId) ||
      typeof entry.zoneId !== 'string' || !/^[0-9a-f]{32}$/.test(entry.zoneId)) return false
  return 'token' in entry
    ? typeof entry.token === 'string' && entry.token.length <= 4096 && /^[A-Za-z0-9+/=]+$/.test(entry.token) &&
        typeof entry.tunnelId === 'string' && CLOUDFLARE_TUNNEL_ID.test(entry.tunnelId) &&
        typeof entry.hostname === 'string' && entry.hostname.startsWith(`${entry.label}.`) && cloudflareHostname(entry.hostname)
    : typeof entry.secret === 'string' && /^[A-Za-z0-9+/]{43}=$/.test(entry.secret)
}

/** A single named connector and setup attempt for one profile's current helper. */
export class ManagedCloudflare {
  private origin?: CloudflareOrigin
  private attempt?: Attempt
  private ending?: Promise<void>
  private readonly startupCleanup: Promise<void>
  private originGeneration = 0
  private settings?: Settings
  private view: NetEngineCloudflare = { state: 'off' }

  constructor(
    private readonly directory: string,
    private readonly runtimeDirectory: string,
    private readonly changed: () => void
  ) {
    this.startupCleanup = this.clearInterruptedSignIns().catch(() => undefined)
  }

  private get stateFile(): string {
    return join(this.directory, 'state.json')
  }

  status(): NetEngineCloudflare | undefined {
    return this.origin ? this.view : undefined
  }

  async useOrigin(origin: CloudflareOrigin | undefined): Promise<void> {
    const generation = ++this.originGeneration
    this.origin = undefined
    this.changed()
    await this.cancel()
    if (generation !== this.originGeneration || !origin) return
    try {
      this.origin = origin
      this.read()
      this.set('off')
      if (this.settings && 'token' in this.settings && this.settings.enabled) this.start()
    } catch (error) {
      if (generation !== this.originGeneration) return
      this.origin = origin
      this.set('failed', error)
    }
  }

  private async clearInterruptedSignIns(): Promise<void> {
    const files = await readdir(this.directory, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error
      return []
    })
    await Promise.all(files
      .filter((entry) => entry.isDirectory() && /^login-[A-Za-z0-9]{6}$/.test(entry.name))
      .map((entry) => rm(join(this.directory, entry.name), SIGN_IN_CLEANUP)))
  }

  start(): void {
    const origin = this.origin
    if (this.ending) throw new Error('Cloudflare is still stopping. Try again in a moment.')
    if (!origin || this.attempt) return
    try {
      this.read()
    } catch (error) {
      this.set('failed', error)
      return
    }
    const attempt: Attempt = { origin, abort: new AbortController(), job: Promise.resolve() }
    this.attempt = attempt
    this.set('preparing')
    attempt.job = this.prepare(attempt).catch((error: unknown) => this.failed(attempt, error))
  }

  async stop(): Promise<void> {
    if (this.settings?.enabled) this.save({ ...this.settings, enabled: false })
    await this.cancel()
    this.set('off')
  }

  async forget(): Promise<void> {
    if (this.settings?.enabled) this.save({ ...this.settings, enabled: false })
    await this.cancel()
    rmSync(join(this.directory, CONNECTOR_CONFIG), { force: true })
    rmSync(this.stateFile, { force: true })
    this.settings = undefined
    this.set('off')
  }

  private read(): void {
    this.settings = undefined
    if (!existsSync(this.stateFile)) return
    let record: unknown
    try { record = JSON.parse(readFileSync(this.stateFile, 'utf8')) } catch { /* No parser details for credentials. */ }
    if (!valid(record)) throw new Error('Mousse could not read this Cloudflare connection.')
    this.settings = record
  }

  private save(record: Settings): void {
    ensurePrivateDirectory(this.directory)
    atomicWriteJsonSync(this.stateFile, record, { mode: 0o600 })
    this.settings = record
  }

  private set(state: NetEngineCloudflare['state'], detail?: unknown, loginUrl?: string): void {
    const message = typeof detail === 'string' ? detail : detail instanceof Error ? detail.message : undefined
    this.view = {
      state,
      ...(this.settings && 'hostname' in this.settings ? { hostname: this.settings.hostname } : {}),
      ...(this.settings || (state === 'failed' && existsSync(this.stateFile)) ? { canForget: true } : {}),
      ...(message ? { message } : {}),
      ...(loginUrl ? { loginUrl } : {})
    }
    this.changed()
  }

  private async prepare(attempt: Attempt): Promise<void> {
    const { signal } = attempt.abort
    await this.startupCleanup
    signal.throwIfAborted()
    const settings = this.settings
    const saved = settings && 'token' in settings ? settings : undefined
    try {
      await this.clearInterruptedSignIns()
    } catch {
      const message = 'Mousse could not remove old Cloudflare sign-in files.'
      if (!saved) throw new Error(`${message} Wait a moment, then try again.`)
      console.warn(message)
    }
    signal.throwIfAborted()
    const runtime = await resolveCloudflared(this.runtimeDirectory, signal)
    signal.throwIfAborted()
    const ready = settings && 'token' in settings ? settings : await this.provision(attempt, runtime, settings)
    signal.throwIfAborted()
    if (!ready.enabled) this.save({ ...ready, enabled: true })
    await this.connect(attempt, runtime, ready)
  }

  private async provision(attempt: Attempt, binary: string, existing?: Setup): Promise<Ready> {
    const { signal } = attempt.abort
    ensurePrivateDirectory(this.directory)
    const scratch = mkdtempSync(join(this.directory, 'login-'))
    try {
      const cli = new CloudflareCli(binary, scratch)
      this.set('sign_in')
      const account = await cli.login(signal, (url) => this.set('sign_in', undefined, url))
      signal.throwIfAborted()
      if (existing && (existing.accountId !== account.accountId || existing.zoneId !== account.zoneId))
        throw new Error('Sign in to the same Cloudflare domain, or forget this setup to use another domain.')
      const setup = existing ?? {
        ...account,
        label: `mousse-${randomBytes(10).toString('hex')}`,
        secret: randomBytes(32).toString('base64'),
        enabled: true
      }
      this.save(setup)
      this.set('connecting')
      const tunnelId = await cli.createOrRecover(setup.label, setup.secret, signal)
      const token = await cli.token(tunnelId, setup.accountId, setup.secret, signal)
      const hostname = await cli.route(tunnelId, setup.label, signal)
      signal.throwIfAborted()
      const ready: Ready = { ...account, label: setup.label, tunnelId, hostname, token, enabled: true }
      this.save(ready)
      return ready
    } finally {
      await rm(scratch, SIGN_IN_CLEANUP).catch(() => {
        throw new Error('Mousse could not remove the Cloudflare sign-in files. Wait a moment, then try again.')
      })
    }
  }

  private async connect(attempt: Attempt, binary: string, ready: Ready): Promise<void> {
    const route = tunnelRoute(`https://${ready.hostname}`)
    if (!route) throw new Error('Cloudflare returned an unusable address.')
    const config = join(this.directory, CONNECTOR_CONFIG)
    await writeFile(config, JSON.stringify({
      ingress: [
        { hostname: ready.hostname, path: `^${WS_PATH_SUFFIX}$`, service: `http://127.0.0.1:${attempt.origin.port}` },
        { service: 'http_status:404' }
      ]
    }), { mode: 0o600 })
    attempt.abort.signal.throwIfAborted()
    const edges = new Set<number>()
    attempt.connector = new ProcessSupervisor({
      binary,
      args: ['tunnel', '--config', config, '--no-autoupdate', '--output', 'json', '--metrics', '127.0.0.1:0', 'run'],
      cwd: this.directory,
      env: { ...cloudflaredEnv(), TUNNEL_TOKEN: ready.token },
      clock: systemClock,
      maxRestarts: Number.POSITIVE_INFINITY,
      state: (state) => {
        if (this.attempt !== attempt) return
        edges.clear()
        this.resetProbe(attempt)
        if (attempt.advertised) void this.withdraw(attempt)
        if (state === 'failed') {
          void this.failed(attempt, new Error('Cloudflare disconnected. Try connecting again.'))
          return
        }
        if (state === 'degraded') attempt.reconnecting = true
        this.waitForRoute(attempt)
      },
      line: (line) => {
        if (this.attempt !== attempt) return
        const edge = cloudflareEdge(line)
        if (!edge) return
        if (!edge.connected) {
          if (edges.delete(edge.index) && !edges.size) {
            this.resetProbe(attempt)
            if (attempt.advertised) void this.withdraw(attempt)
            attempt.reconnecting = true
            this.waitForRoute(attempt)
          }
          return
        }
        const first = edges.size === 0
        edges.add(edge.index)
        if (!first) return
        this.resetProbe(attempt)
        const probe = new AbortController()
        attempt.probe = probe
        void this.verify(attempt, route, probe.signal).catch((error) => {
          if (!probe.signal.aborted) void this.failed(attempt, error)
        })
      }
    })
    attempt.connector.start()
  }

  private async verify(attempt: Attempt, route: string, signal: AbortSignal): Promise<void> {
    for (let wait = 500; ; wait = Math.min(wait * 2, 5_000)) {
      signal.throwIfAborted()
      if (await attempt.origin.test(route)) {
        signal.throwIfAborted()
        attempt.advertised = true
        await attempt.origin.advertise(route)
        signal.throwIfAborted()
        this.clearConnectionHint(attempt)
        this.set('connected')
        return
      }
      await delay(wait, undefined, { signal, ref: false })
    }
  }

  private waitForRoute(attempt: Attempt): void {
    const state = attempt.reconnecting ? 'reconnecting' : 'connecting'
    if (this.view.state !== state) this.set(state, this.view.message)
    attempt.connectionHint ??= setTimeout(() => {
      this.set(attempt.reconnecting ? 'reconnecting' : 'connecting', CONNECTION_HINT)
    }, CONNECTION_HINT_MS).unref()
  }

  private clearConnectionHint(attempt: Attempt): void {
    clearTimeout(attempt.connectionHint)
    attempt.connectionHint = undefined
  }

  private resetProbe(attempt: Attempt): void {
    attempt.probe?.abort()
    attempt.probe = undefined
  }

  private withdraw(attempt: Attempt): Promise<void> {
    attempt.advertised = false
    return attempt.origin.advertise(null).catch(() => {
      console.warn('Mousse could not remove the inactive Cloudflare route from the networking helper.')
    })
  }

  private cancel(): Promise<void> {
    if (this.ending) return this.ending
    return this.attempt ? this.finish(this.attempt, true) : Promise.resolve()
  }

  private finish(attempt: Attempt, waitForPreparation: boolean): Promise<void> {
    this.attempt = undefined
    attempt.abort.abort()
    this.resetProbe(attempt)
    this.clearConnectionHint(attempt)
    this.ending = Promise.all([
      attempt.advertised ? this.withdraw(attempt) : undefined,
      attempt.connector?.stop(),
      waitForPreparation ? attempt.job : undefined
    ]).then(() => undefined).finally(() => { this.ending = undefined })
    return this.ending
  }

  private async failed(attempt: Attempt, error: unknown): Promise<void> {
    if (this.attempt !== attempt) return
    await this.finish(attempt, false)
    if (!this.attempt && this.origin === attempt.origin) this.set('failed', error)
  }
}
