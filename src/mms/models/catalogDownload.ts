/**
 * Downloads the published model catalog between releases (docs/providers/model-catalog.md,
 * "Downloads"): `models-1.json` and its signature from the `models` GitHub release, at most every
 * 6 hours. A copy is used only when its signature checks, it reads as a catalog of a known format
 * and its revision is higher than the catalog in use. The last good copy is cached in Mousse's home
 * folder and checked again the same way when Mousse starts.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseModelCatalog, type ModelCatalog } from '../../shared/modelCatalog'
import { atomicWriteFileSync, atomicWriteJsonSync } from '../data/AtomicFs'
import { fetchWithAllowedRedirects, RedirectRefusedError } from '../net/allowedRedirects'
import { MODEL_CATALOG_PUBLIC_KEYS, verifyModelCatalogSignature } from './catalogSignature'
import { readModelCatalog, setDownloadedModelCatalog } from './modelCatalog'

export const MODEL_CATALOG_URL = 'https://github.com/mousse-agent/mousse/releases/download/models/models-1.json'
export const MODEL_CATALOG_SIGNATURE_URL = `${MODEL_CATALOG_URL}.sig`
/** How often GitHub is asked at most. */
export const MODEL_CATALOG_CHECK_INTERVAL_MS = 6 * 60 * 60_000
/** One check, both files together, gives up after this long. */
export const MODEL_CATALOG_TIMEOUT_MS = 15_000
export const MAX_MODEL_CATALOG_BYTES = 256 * 1024
/** A signature is 64 bytes; anything much larger is not one. */
export const MAX_MODEL_CATALOG_SIGNATURE_BYTES = 1024

/** The cached copy, in Mousse's home folder; its signature is this name plus `.sig`. */
export const MODEL_CATALOG_CACHE_FILE = 'model-catalog.json'
/** When GitHub was last asked, so a restart does not ask again within the interval. */
const CHECKED_FILE = 'model-catalog-checked.json'

/** A copy that is not used, for a reason found in the copy or GitHub's answer (not a network failure). */
class NotUsed extends Error {}

export interface ModelCatalogDownloadOptions {
  fetch?: typeof fetch
  now?: () => number
  /** The public keys signatures are checked with (default `MODEL_CATALOG_PUBLIC_KEYS`; tests). */
  keys?: readonly string[]
  /** Where the quiet notes go (default `console.info`). */
  log?: (message: string) => void
}

export class ModelCatalogDownload {
  private readonly cachePath: string
  private readonly signaturePath: string
  private readonly checkedPath: string
  private readonly fetchImpl: typeof fetch
  private readonly now: () => number
  private readonly keys: readonly string[]
  private readonly log: (message: string) => void
  private checkedAt: number | undefined
  private checkedRead = false
  private running: Promise<boolean> | undefined
  private saidNoKey = false

  constructor(home: string, options: ModelCatalogDownloadOptions = {}) {
    this.cachePath = join(home, MODEL_CATALOG_CACHE_FILE)
    this.signaturePath = `${this.cachePath}.sig`
    this.checkedPath = join(home, CHECKED_FILE)
    this.fetchImpl = options.fetch ?? ((...args) => globalThis.fetch(...args))
    this.now = options.now ?? Date.now
    this.keys = options.keys ?? MODEL_CATALOG_PUBLIC_KEYS
    this.log = options.log ?? ((message) => console.info(`[models] ${message}`))
  }

  /**
   * Uses the cached copy when its signature still checks and it still reads; otherwise it is ignored
   * and the bundled copy stays in use. Reads no network.
   */
  loadCache(): void {
    if (!this.hasKey()) return
    let bytes: Buffer
    let signature: Buffer
    try {
      bytes = readFileSync(this.cachePath)
      signature = readFileSync(this.signaturePath)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') this.log(`The cached model catalog could not be read; the bundled one is used. ${errorText(error)}`)
      return
    }
    try {
      setDownloadedModelCatalog(this.accept(bytes, signature))
    } catch (error) {
      this.log(`The cached model catalog is not used: ${errorText(error)}`)
    }
  }

  /**
   * Asks GitHub for the published catalog when the last check is 6 hours old (or `force`), and uses
   * it when it qualifies. Resolves true when the catalog in use changed. Never rejects: a failure
   * leaves the catalog in use as it is. A network failure or timeout is tried again on the next
   * call; any answer from GitHub, a refused copy included, waits for the interval.
   */
  refresh(options: { signal?: AbortSignal; force?: boolean } = {}): Promise<boolean> {
    this.running ??= this.check(options).finally(() => {
      this.running = undefined
    })
    return this.running
  }

  private async check(options: { signal?: AbortSignal; force?: boolean }): Promise<boolean> {
    if (!this.hasKey()) return false
    if (!options.force && !this.due()) return false
    const timeout = AbortSignal.timeout(MODEL_CATALOG_TIMEOUT_MS)
    const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout
    try {
      const bytes = await this.download(MODEL_CATALOG_URL, MAX_MODEL_CATALOG_BYTES, signal)
      // Nothing published yet.
      if (!bytes) return this.checked(false)
      const signature = await this.download(MODEL_CATALOG_SIGNATURE_URL, MAX_MODEL_CATALOG_SIGNATURE_BYTES, signal)
      if (!signature) throw new NotUsed('it has no signature.')
      const catalog = this.accept(bytes, signature)
      if (catalog.revision <= readModelCatalog().revision) return this.checked(false)
      try {
        atomicWriteFileSync(this.cachePath, bytes)
        atomicWriteFileSync(this.signaturePath, signature)
      } catch (error) {
        // The copy is still used until Mousse quits.
        this.log(`The downloaded model catalog could not be cached. ${errorText(error)}`)
      }
      setDownloadedModelCatalog(catalog)
      this.log(`Using model catalog revision ${catalog.revision}, downloaded.`)
      return this.checked(true)
    } catch (error) {
      if (error instanceof NotUsed) {
        this.log(`The downloaded model catalog is not used: ${error.message}`)
        return this.checked(false)
      }
      return false
    }
  }

  /**
   * The body of `url`, or undefined when GitHub has no such file (404). Rejects with `NotUsed` for
   * any other refusal: another status, a body over `max` bytes, a redirect Mousse does not follow.
   */
  private async download(url: string, max: number, signal: AbortSignal): Promise<Buffer | undefined> {
    const response = await fetchWithAllowedRedirects(url, { fetch: this.fetchImpl, signal, label: 'model catalog', from: 'model catalogs' }).then(
      (answer) => answer.response,
      (error: unknown) => {
        throw error instanceof RedirectRefusedError ? new NotUsed(error.message) : error
      }
    )
    if (response.status === 404) {
      void response.body?.cancel().catch(() => undefined)
      return undefined
    }
    if (!response.ok || !response.body) {
      void response.body?.cancel().catch(() => undefined)
      throw new NotUsed(`GitHub answered ${response.status}.`)
    }
    const declared = Number(response.headers.get('content-length'))
    if (Number.isFinite(declared) && declared > max) {
      void response.body.cancel().catch(() => undefined)
      throw new NotUsed(`it is larger than ${max} bytes.`)
    }
    const reader = response.body.getReader()
    const chunks: Uint8Array[] = []
    let received = 0
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        received += value.byteLength
        if (received > max) throw new NotUsed(`it is larger than ${max} bytes.`)
        chunks.push(value)
      }
    } catch (error) {
      void reader.cancel().catch(() => undefined)
      throw error
    }
    return Buffer.concat(chunks)
  }

  /**
   * The catalog in `bytes` when it may be used: within the size cap, signed by a listed key, and a
   * catalog of a known format. Throws `NotUsed` otherwise.
   */
  private accept(bytes: Uint8Array, signature: Uint8Array): ModelCatalog {
    if (bytes.length > MAX_MODEL_CATALOG_BYTES) throw new NotUsed(`it is larger than ${MAX_MODEL_CATALOG_BYTES} bytes.`)
    if (!verifyModelCatalogSignature(bytes, signature, this.keys)) throw new NotUsed('its signature does not check.')
    try {
      return parseModelCatalog(Buffer.from(bytes).toString('utf8'))
    } catch (error) {
      throw new NotUsed(errorText(error))
    }
  }

  /** Without a public key nothing downloaded can be checked, so nothing is fetched or used. */
  private hasKey(): boolean {
    if (this.keys.length) return true
    if (!this.saidNoKey) {
      this.saidNoKey = true
      this.log('Model catalog downloads are off: this build has no key to check them with.')
    }
    return false
  }

  private due(): boolean {
    if (!this.checkedRead) {
      this.checkedRead = true
      try {
        const saved = (JSON.parse(readFileSync(this.checkedPath, 'utf8')) as { checkedAt?: unknown }).checkedAt
        if (typeof saved === 'number' && Number.isFinite(saved)) this.checkedAt = saved
      } catch {
        // Never checked, or an unreadable note: check now.
      }
    }
    if (this.checkedAt === undefined) return true
    const elapsed = this.now() - this.checkedAt
    // A clock set back counts as due rather than waiting out the difference.
    return elapsed < 0 || elapsed >= MODEL_CATALOG_CHECK_INTERVAL_MS
  }

  /** Records that GitHub answered now, and returns `changed`. */
  private checked(changed: boolean): boolean {
    this.checkedAt = this.now()
    this.checkedRead = true
    try {
      atomicWriteJsonSync(this.checkedPath, { checkedAt: this.checkedAt })
    } catch {
      // The interval still holds until Mousse quits.
    }
    return changed
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
