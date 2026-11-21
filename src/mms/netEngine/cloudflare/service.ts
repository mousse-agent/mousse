import { randomBytes } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
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

const PROBE_MS = 90_000
const REGISTER_MS = 60_000

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
  registration?: ReturnType<typeof setTimeout>
  probe?: AbortController
  advertised?: boolean
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
  private cleanedSignIns?: Promise<void>
  private originGeneration = 0
  private settings?: Settings
  private view: NetEngineCloudflare = { state: 'off' }

  constructor(
    private readonly directory: string,
    private readonly runtimeDirectory: string,
    private readonly changed: () => void
  ) {}

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
      this.cleanedSignIns ??= this.clearInterruptedSignIns()
      await this.cleanedSignIns
      if (generation !== this.originGeneration) return
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
      .map((entry) => rm(join(this.directory, entry.name), { recursive: true, force: true })))
  }

  start(): void {
    const origin = this.origin
    if (!origin || this.attempt || this.ending) return
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

  private read(): void {
    const file = join(this.directory, 'state.json')
    this.settings = undefined
    if (!existsSync(file)) return
    let record: unknown
    try { record = JSON.parse(readFileSync(file, 'utf8')) } catch { /* No parser details for credentials. */ }
    if (!valid(record)) throw new Error('Mousse could not read this Cloudflare connection.')
    this.settings = record
  }

  private save(record: Settings): void {
    ensurePrivateDirectory(this.directory)
    atomicWriteJsonSync(join(this.directory, 'state.json'), record, { mode: 0o600 })
    this.settings = record
  }

  private set(state: NetEngineCloudflare['state'], error?: unknown, loginUrl?: string): void {
    this.view = {
      state,
      ...(this.settings && 'hostname' in this.settings ? { hostname: this.settings.hostname } : {}),
      ...(state === 'failed' && error instanceof Error ? { message: error.message } : {}),
      ...(loginUrl ? { loginUrl } : {})
    }
    this.changed()
  }

  private async prepare(attempt: Attempt): Promise<void> {
    const { signal } = attempt.abort
    const runtime = await resolveCloudflared(this.runtimeDirectory, signal)
    signal.throwIfAborted()
    const settings = this.settings
    const ready = settings && 'token' in settings
      ? settings
      : await this.provision(attempt, runtime, settings)
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
        throw new Error('Sign in to the Cloudflare account and domain you chose before.')
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
      await rm(scratch, { recursive: true, force: true })
    }
  }

  private async connect(attempt: Attempt, binary: string, ready: Ready): Promise<void> {
    const route = tunnelRoute(`https://${ready.hostname}`)
    if (!route) throw new Error('Cloudflare returned an unusable address.')
    const config = join(this.directory, 'connector.yml')
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
      state: (state) => {
        if (this.attempt !== attempt) return
        edges.clear()
        this.resetProbe(attempt)
        if (attempt.advertised) void this.withdraw(attempt)
        if (state === 'failed') {
          void this.failed(attempt, new Error('Cloudflare disconnected. Try connecting again.'))
          return
        }
        this.set('connecting')
        if (state === 'provisioning') this.waitForEdge(attempt)
      },
      line: (line) => {
        if (this.attempt !== attempt) return
        const edge = cloudflareEdge(line)
        if (!edge) return
        if (!edge.connected) {
          if (edges.delete(edge.index) && !edges.size) {
            this.resetProbe(attempt)
            if (attempt.advertised) void this.withdraw(attempt)
            this.set('connecting')
            this.waitForEdge(attempt)
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
    const until = Date.now() + PROBE_MS
    for (let wait = 500; Date.now() < until; wait = Math.min(wait * 2, 5_000)) {
      signal.throwIfAborted()
      if (await attempt.origin.test(route)) {
        signal.throwIfAborted()
        attempt.advertised = true
        await attempt.origin.advertise(route)
        signal.throwIfAborted()
        this.set('connected')
        return
      }
      await delay(wait, undefined, { signal })
    }
    throw new Error('Cloudflare connected, but Mousse could not reach its address. Try again.')
  }

  private waitForEdge(attempt: Attempt): void {
    attempt.registration = setTimeout(() => {
      void this.failed(attempt, new Error('Cloudflare did not connect. Try again.'))
    }, REGISTER_MS)
    attempt.registration.unref()
  }

  private resetProbe(attempt: Attempt): void {
    if (attempt.registration) clearTimeout(attempt.registration)
    attempt.registration = undefined
    attempt.probe?.abort()
    attempt.probe = undefined
  }

  private withdraw(attempt: Attempt): Promise<void> {
    attempt.advertised = false
    return attempt.origin.advertise(null).catch(() => undefined)
  }

  private cancel(): Promise<void> {
    if (this.ending) return this.ending
    return this.attempt ? this.finish(this.attempt, true) : Promise.resolve()
  }

  private finish(attempt: Attempt, waitForPreparation: boolean): Promise<void> {
    this.attempt = undefined
    attempt.abort.abort()
    this.resetProbe(attempt)
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
