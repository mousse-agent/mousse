import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { atomicWriteJsonSync } from '../data/AtomicFs'

/**
 * The newest version of an agent CLI that is known to be published. An npm package is looked up in
 * the registry (at most daily, never while a probe waits); a pinned version is Mousse's own release.
 */
export type LatestVersionSource = { kind: 'npm'; package: string } | { kind: 'pinned'; version: string }

/** A published version is looked up again after this long. */
export const LATEST_TTL_MS = 24 * 60 * 60_000
/** After a failed lookup (offline, registry down) the next one waits this long. */
export const LATEST_RETRY_MS = 30 * 60_000
const REQUEST_TIMEOUT_MS = 5_000

interface Entry {
  version: string
  checkedAt: string
}

interface LatestFile {
  version: 1
  entries: Record<string, Entry>
}

export interface LatestVersionCacheOptions {
  fetchImpl?: typeof fetch
  now?: () => number
}

const VERSION = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/

/** Tests never reach the network; they inject `fetchImpl`. */
const defaultFetch: typeof fetch = (...args) =>
  process.env.NODE_ENV === 'test' ? Promise.reject(new Error('The registry is not reachable from tests.')) : globalThis.fetch(...args)

/**
 * Latest published versions, kept in `<profileHome>/harness/latest-versions.json`. `get` reads
 * memory and disk only. `refresh` is the only call that touches the network; it keeps the last good
 * value on any failure and runs once at a time per package.
 */
export class LatestVersionCache {
  private readonly path: string
  private readonly fetchImpl: typeof fetch
  private readonly now: () => number
  private file?: LatestFile
  private readonly inFlight = new Map<string, Promise<boolean>>()
  /** Packages whose last lookup failed, with the time the next one may start (not persisted). */
  private readonly retryAt = new Map<string, number>()

  constructor(profileHome: string, options: LatestVersionCacheOptions = {}) {
    this.path = join(profileHome, 'harness', 'latest-versions.json')
    this.fetchImpl = options.fetchImpl ?? defaultFetch
    this.now = options.now ?? Date.now
  }

  /** The latest version known for `source`, without any lookup. */
  get(source: LatestVersionSource | undefined): string | undefined {
    if (!source) return undefined
    if (source.kind === 'pinned') return source.version
    return this.read().entries[source.package]?.version
  }

  /**
   * Looks the version up when the stored one is older than a day; true when it changed. A pinned
   * source never fetches.
   */
  refresh(source: LatestVersionSource | undefined, signal?: AbortSignal): Promise<boolean> {
    if (source?.kind !== 'npm') return Promise.resolve(false)
    const name = source.package
    const running = this.inFlight.get(name)
    if (running) return running
    const entry = this.read().entries[name]
    const checkedAtMs = entry ? Date.parse(entry.checkedAt) : Number.NaN
    // A check dated in the future (clock set back, file from another machine) counts as expired.
    const age = this.now() - checkedAtMs
    if (Number.isFinite(age) && age >= 0 && age < LATEST_TTL_MS) return Promise.resolve(false)
    if (this.now() < (this.retryAt.get(name) ?? 0)) return Promise.resolve(false)
    const lookup = this.lookup(name, signal).finally(() => this.inFlight.delete(name))
    this.inFlight.set(name, lookup)
    return lookup
  }

  private async lookup(name: string, signal?: AbortSignal): Promise<boolean> {
    try {
      const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS)
      const response = await this.fetchImpl(`https://registry.npmjs.org/${name.replace('/', '%2F')}/latest`, {
        headers: { Accept: 'application/json' },
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout
      })
      if (!response.ok) {
        void response.body?.cancel().catch(() => {})
        throw new Error(`HTTP ${response.status}`)
      }
      const body: unknown = await response.json()
      const version = body && typeof body === 'object' ? (body as { version?: unknown }).version : undefined
      if (typeof version !== 'string' || !VERSION.test(version)) throw new Error('The registry answered without a version.')
      const state = this.read()
      const changed = state.entries[name]?.version !== version
      this.write({ version: 1, entries: { ...state.entries, [name]: { version, checkedAt: new Date(this.now()).toISOString() } } })
      this.retryAt.delete(name)
      return changed
    } catch {
      this.retryAt.set(name, this.now() + LATEST_RETRY_MS)
      return false
    }
  }

  private read(): LatestFile {
    if (this.file) return this.file
    const file: LatestFile = { version: 1, entries: {} }
    try {
      const raw = JSON.parse(readFileSync(this.path, 'utf8')) as { entries?: Record<string, unknown> }
      for (const [name, value] of Object.entries(raw.entries ?? {})) {
        const entry = value && typeof value === 'object' ? (value as Partial<Entry>) : undefined
        if (name === '__proto__' || typeof entry?.version !== 'string' || !VERSION.test(entry.version) || typeof entry.checkedAt !== 'string') continue
        file.entries[name] = { version: entry.version, checkedAt: entry.checkedAt }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
        console.warn('[harness] could not read latest versions; looking them up again', error instanceof Error ? error.message : String(error))
    }
    return (this.file = file)
  }

  private write(file: LatestFile): void {
    this.file = file
    try {
      atomicWriteJsonSync(this.path, file)
    } catch (error) {
      console.warn('[harness] could not save latest versions', error instanceof Error ? error.message : String(error))
    }
  }
}
