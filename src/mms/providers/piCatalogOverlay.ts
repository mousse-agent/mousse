/**
 * Keeps built-in provider catalogs current between app releases.
 *
 * The static catalogs ship inside `@earendil-works/pi-ai`, so new models (e.g.
 * GPT-6 Sol) would otherwise only appear after a Pi bump and a new build. This
 * overlay reads the latest published pi-ai catalog data, caches it on disk, and
 * adds models the bundled catalog lacks. Bundled definitions stay authoritative;
 * a model is added only when its API is one the provider already streams.
 */
import { readFileSync } from 'node:fs'
import type { Api, Model, ModelThinkingLevel, Provider } from '@earendil-works/pi-ai'
import { atomicWriteJsonSync } from '../data/AtomicFs'

const PI_AI_PACKAGE = '@earendil-works/pi-ai'
const LATEST_VERSION_URL = `https://registry.npmjs.org/${PI_AI_PACKAGE}/latest`
const FILE_VERSION = 1
const CHECK_INTERVAL_MS = 6 * 60 * 60_000
const FETCH_CONCURRENCY = 6
const THINKING_LEVELS = new Set<ModelThinkingLevel>(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'])

export function piCatalogDataUrl(version: string, providerId: string): string {
  return `https://cdn.jsdelivr.net/npm/${PI_AI_PACKAGE}@${version}/dist/providers/data/${providerId}.json`
}

interface CatalogOverlayFile {
  version: typeof FILE_VERSION
  piVersion: string
  checkedAt: number
  providers: Record<string, Model<Api>[]>
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return isRecord(value) && Object.values(value).every((entry) => typeof entry === 'string')
}

/** Validate one catalog entry; returns a sanitized model or undefined. */
function parseModel(raw: unknown, providerId: string, supportedApis: ReadonlySet<string>): Model<Api> | undefined {
  if (!isRecord(raw)) return undefined
  const { id, name, api, provider, baseUrl, reasoning, input, cost, contextWindow, maxTokens } = raw
  if (typeof id !== 'string' || !id || id.length > 200) return undefined
  if (typeof name !== 'string' || typeof api !== 'string' || !supportedApis.has(api)) return undefined
  if (provider !== providerId || typeof baseUrl !== 'string' || !/^https?:\/\//.test(baseUrl)) return undefined
  if (typeof reasoning !== 'boolean') return undefined
  if (!Array.isArray(input) || input.length === 0 || !input.every((kind) => kind === 'text' || kind === 'image')) {
    return undefined
  }
  if (!isRecord(cost) || !['input', 'output', 'cacheRead', 'cacheWrite'].every((key) => isFiniteNumber(cost[key]))) {
    return undefined
  }
  if (!isFiniteNumber(contextWindow) || contextWindow <= 0 || !isFiniteNumber(maxTokens) || maxTokens <= 0) {
    return undefined
  }
  if ('headers' in raw && raw.headers !== undefined && !isStringRecord(raw.headers)) return undefined

  const model = { ...raw } as unknown as Model<Api> & Record<string, unknown>
  if (isRecord(raw.thinkingLevelMap)) {
    // Newer catalogs may introduce levels this pi-ai build cannot map.
    model.thinkingLevelMap = Object.fromEntries(
      Object.entries(raw.thinkingLevelMap).filter(
        ([level, value]) => THINKING_LEVELS.has(level as ModelThinkingLevel) && (typeof value === 'string' || value === null)
      )
    )
  } else {
    delete model.thinkingLevelMap
  }
  return model
}

/** Parse a pi-ai `providers/data/<id>.json` file (`{ [api]: { [modelId]: Model } }`). */
export function parseProviderCatalog(
  providerId: string,
  raw: unknown,
  supportedApis: ReadonlySet<string>
): Model<Api>[] {
  if (!isRecord(raw)) return []
  const models: Model<Api>[] = []
  const seen = new Set<string>()
  for (const group of Object.values(raw)) {
    if (!isRecord(group)) continue
    for (const entry of Object.values(group)) {
      const model = parseModel(entry, providerId, supportedApis)
      if (!model || seen.has(model.id)) continue
      seen.add(model.id)
      models.push(model)
    }
  }
  return models
}

/** Bundled/live models win; overlay entries only fill in missing ids. */
export function mergeCatalogOverlay(
  current: readonly Model<Api>[],
  overlay: readonly Model<Api>[]
): readonly Model<Api>[] {
  if (overlay.length === 0) return current
  const known = new Set(current.map((model) => model.id))
  const additions = overlay.filter((model) => !known.has(model.id))
  return additions.length === 0 ? current : [...current, ...additions]
}

export interface PiCatalogOverlayOptions {
  fetchImpl?: typeof fetch
  now?: () => number
}

export class PiCatalogOverlay {
  private file: CatalogOverlayFile | null = null
  private readonly parsed = new Map<string, readonly Model<Api>[]>()
  private readonly supportedApis = new Map<string, ReadonlySet<string>>()
  private readonly attached = new WeakSet<Provider>()
  private readonly fetchImpl: typeof fetch
  private readonly now: () => number

  constructor(private readonly path: string, options: PiCatalogOverlayOptions = {}) {
    this.fetchImpl = options.fetchImpl ?? ((...args) => globalThis.fetch(...args))
    this.now = options.now ?? Date.now
  }

  private load(): CatalogOverlayFile | null {
    if (this.file) return this.file
    try {
      const parsed = JSON.parse(readFileSync(this.path, 'utf8')) as Partial<CatalogOverlayFile>
      if (
        parsed.version === FILE_VERSION &&
        typeof parsed.piVersion === 'string' &&
        isFiniteNumber(parsed.checkedAt) &&
        isRecord(parsed.providers)
      ) {
        this.file = parsed as CatalogOverlayFile
      }
    } catch {
      // Missing or corrupt cache: fall back to the bundled catalog until the next check.
    }
    return this.file
  }

  /** Cached overlay models for a provider, re-validated against what it can stream. */
  modelsFor(providerId: string): readonly Model<Api>[] {
    const memo = this.parsed.get(providerId)
    if (memo) return memo
    const apis = this.supportedApis.get(providerId)
    const cached = this.load()?.providers[providerId]
    const models =
      apis && Array.isArray(cached)
        ? parseProviderCatalog(providerId, { cached: Object.fromEntries(cached.map((m) => [m?.id, m])) }, apis)
        : []
    this.parsed.set(providerId, models)
    return models
  }

  /** Wrap a static provider's `getModels()` so overlay models appear in every lookup. */
  attach(provider: Provider): void {
    if (this.attached.has(provider)) return
    const original = provider.getModels.bind(provider)
    let baseline: readonly Model<Api>[] = []
    try {
      baseline = original()
    } catch {
      return
    }
    const apis = new Set(baseline.map((model) => model.api))
    if (apis.size === 0) return
    this.supportedApis.set(provider.id, apis)
    this.attached.add(provider)
    provider.getModels = () => mergeCatalogOverlay(original(), this.modelsFor(provider.id))
  }

  /**
   * Check the latest published catalog (at most every few hours unless forced)
   * and cache it. Returns true when the cached overlay changed.
   */
  async refresh(options: { signal?: AbortSignal; force?: boolean } = {}): Promise<boolean> {
    const previous = this.load()
    if (!options.force && previous && this.now() - previous.checkedAt < CHECK_INTERVAL_MS) return false

    const latest = await this.fetchJson(LATEST_VERSION_URL, options.signal)
    const piVersion = isRecord(latest) && typeof latest.version === 'string' ? latest.version : undefined
    if (!piVersion || !/^[0-9A-Za-z.+-]+$/.test(piVersion)) return false

    let providers: Record<string, Model<Api>[]>
    if (previous?.piVersion === piVersion) {
      providers = previous.providers
    } else {
      providers = {}
      const ids = [...this.supportedApis.keys()]
      for (let index = 0; index < ids.length; index += FETCH_CONCURRENCY) {
        await Promise.all(
          ids.slice(index, index + FETCH_CONCURRENCY).map(async (providerId) => {
            try {
              const raw = await this.fetchJson(piCatalogDataUrl(piVersion, providerId), options.signal)
              const models = parseProviderCatalog(providerId, raw, this.supportedApis.get(providerId)!)
              if (models.length > 0) providers[providerId] = models
            } catch {
              // Provider missing from this release or transient failure: keep bundled models.
            }
          })
        )
        options.signal?.throwIfAborted()
      }
    }

    options.signal?.throwIfAborted()
    const next: CatalogOverlayFile = { version: FILE_VERSION, piVersion, checkedAt: this.now(), providers }
    const changed = previous?.piVersion !== piVersion
    this.file = next
    this.parsed.clear()
    try {
      atomicWriteJsonSync(this.path, next)
    } catch {
      // Best-effort cache; the in-memory overlay still applies for this run.
    }
    return changed
  }

  private async fetchJson(url: string, signal?: AbortSignal): Promise<unknown> {
    const response = await this.fetchImpl(url, { headers: { Accept: 'application/json' }, signal })
    if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}`)
    return response.json()
  }
}
