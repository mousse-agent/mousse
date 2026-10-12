import { AppError } from './errors'

/**
 * Provider instances (docs/run-engine/SPEC.md §13.8). A driver is the kind of runtime that serves a
 * turn (the in-process pi loop, Claude Code, Antigravity, Codex); an instance is one configured use
 * of a driver with a stable id. Every caller that picks an agent selects `{ instanceId, model }`.
 * In v1 each vendor driver has exactly one instance, and each pi-ai provider is its own instance.
 */
export type ProviderDriverKind = 'pi' | 'claude' | 'antigravity' | 'codex'

export const PROVIDER_DRIVER_KINDS: readonly ProviderDriverKind[] = ['pi', 'claude', 'antigravity', 'codex']

export interface ProviderInstanceConfig {
  driver: ProviderDriverKind
  /** A disabled instance is never selected; a turn that names it fails with `provider_instance_disabled`. */
  enabled: boolean
  /** Driver-specific settings, read by the driver factory (not used by any v1 driver). */
  config?: Record<string, unknown>
}

/** Per-profile instance map, keyed by instance id (`providers.instances` in the profile config). */
export type ProviderInstanceMap = Record<string, ProviderInstanceConfig>

/** What a caller picks to run an agent. */
export interface ProviderSelection {
  instanceId: string
  model: string
}

/**
 * A stored model selection (thread and channel-session `modelOverride`). `instanceId` is
 * authoritative; `llmProvider` is derived from the instance and kept so the current GUI and older
 * daemons can still read the record. Records written before instances existed carry only
 * `llmProvider` and are mapped with `instanceIdForLegacyProvider` when read.
 */
export interface ModelOverride {
  instanceId?: string
  /** @deprecated Derived from `instanceId`; kept for readers that predate provider instances. */
  llmProvider: string
  model: string
}

export const CLAUDE_INSTANCE_ID = 'claude'
export const ANTIGRAVITY_INSTANCE_ID = 'antigravity'
export const CODEX_INSTANCE_ID = 'codex'
const PI_INSTANCE_PREFIX = 'pi:'

/** The `llmProvider` name each vendor driver used before instances existed. */
const LEGACY_PROVIDER_BY_DRIVER: Record<Exclude<ProviderDriverKind, 'pi'>, string> = {
  claude: 'claude-subscription',
  antigravity: 'antigravity',
  codex: 'codex'
}

/**
 * Vendor `llmProvider` names (what the GUI's provider lists use as ids) and the seeded instance
 * each maps to.
 */
const LEGACY_VENDOR_INSTANCES: Readonly<Record<string, string>> = {
  'claude-subscription': CLAUDE_INSTANCE_ID,
  antigravity: ANTIGRAVITY_INSTANCE_ID,
  codex: CODEX_INSTANCE_ID
}

/**
 * Seeded vendor instances, in display order. All are enabled: an enabled instance only means the
 * profile may pick it. Whether it can run is its service's `configured()` — Codex, for example,
 * is offered only once the terminal `codex login` is a ChatGPT sign-in.
 */
const VENDOR_SEEDS: ReadonlyArray<[string, ProviderInstanceConfig]> = [
  [ANTIGRAVITY_INSTANCE_ID, { driver: 'antigravity', enabled: true }],
  [CLAUDE_INSTANCE_ID, { driver: 'claude', enabled: true }],
  [CODEX_INSTANCE_ID, { driver: 'codex', enabled: true }]
]

export const PROVIDER_INSTANCE_ERROR_CODES = {
  unknown: 'provider_instance_unknown',
  disabled: 'provider_instance_disabled'
} as const

export function providerInstanceUnknown(instanceId: string, message?: string): AppError {
  return new AppError({
    code: PROVIDER_INSTANCE_ERROR_CODES.unknown,
    message: message ?? `Unknown provider instance "${instanceId}". Choose a connected model and try again.`,
    details: { instanceId },
    errorInfo: { category: 'invalid', retryable: false }
  })
}

export function providerInstanceDisabled(instanceId: string): AppError {
  return new AppError({
    code: PROVIDER_INSTANCE_ERROR_CODES.disabled,
    message: `Provider instance "${instanceId}" is disabled. Enable it or choose another model.`,
    details: { instanceId },
    errorInfo: { category: 'unavailable', retryable: false }
  })
}

export function piInstanceId(providerId: string): string {
  return `${PI_INSTANCE_PREFIX}${providerId}`
}

/** The pi-ai provider id of a `pi:<provider>` instance id, or undefined for any other id. */
export function piProviderIdOf(instanceId: string): string | undefined {
  return instanceId.startsWith(PI_INSTANCE_PREFIX) && instanceId.length > PI_INSTANCE_PREFIX.length
    ? instanceId.slice(PI_INSTANCE_PREFIX.length)
    : undefined
}

/**
 * Maps an `llmProvider` string from before instances existed to its instance id:
 * `claude-subscription` → `claude`, `antigravity` → `antigravity`, `codex` → `codex`, a known
 * pi-ai provider `p` → `pi:p`. Anything else throws `provider_instance_unknown`; it never falls
 * back to the pi loop.
 */
export function instanceIdForLegacyProvider(llmProvider: string, isKnownPiProvider: (providerId: string) => boolean): string {
  const name = llmProvider.trim()
  if (!name) throw providerInstanceUnknown('', 'No model provider is selected. Choose a model and try again.')
  const vendor = LEGACY_VENDOR_INSTANCES[name]
  if (vendor) return vendor
  if (isKnownPiProvider(name)) return piInstanceId(name)
  throw providerInstanceUnknown(name, `Unknown model provider "${name}". Choose a connected model and try again.`)
}

/**
 * The `llmProvider` name a turn on this instance reports (transcripts, provider refs, the pi loop's
 * provider id). Undefined only for a pi instance whose id names no provider.
 */
export function legacyProviderForInstance(instanceId: string, entry: Pick<ProviderInstanceConfig, 'driver'>): string | undefined {
  return entry.driver === 'pi' ? piProviderIdOf(instanceId) : LEGACY_PROVIDER_BY_DRIVER[entry.driver]
}

export function isProviderInstanceConfig(value: unknown): value is ProviderInstanceConfig {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const entry = value as Record<string, unknown>
  return (
    PROVIDER_DRIVER_KINDS.includes(entry.driver as ProviderDriverKind) &&
    typeof entry.enabled === 'boolean' &&
    (entry.config === undefined || (typeof entry.config === 'object' && entry.config !== null && !Array.isArray(entry.config)))
  )
}

/** Well-formed entries of a stored map; malformed ones are ignored (and left untouched on disk). */
export function readProviderInstances(raw: unknown): ProviderInstanceMap {
  const instances: ProviderInstanceMap = {}
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return instances
  for (const [id, entry] of Object.entries(raw as Record<string, unknown>)) {
    if (!id || id === '__proto__' || id === 'constructor' || id === 'prototype') continue
    if (isProviderInstanceConfig(entry)) instances[id] = { ...entry, ...(entry.config ? { config: { ...entry.config } } : {}) }
  }
  return instances
}

/**
 * Version of the seed set. A profile records the version it was seeded with
 * (`providers.instancesSeedVersion`), so a later change to a seed can prove that an entry still
 * holds the earlier seed rather than a choice the user made. Version 1 is the first recorded set.
 * A profile without a marker (version 0) has no seed provenance and is never upgraded.
 */
export const PROVIDER_INSTANCE_SEED_VERSION = 1

/**
 * A seed changed in version `before`: an entry still equal to `seed` on a profile marked with an
 * earlier version (at least 1) is moved to `next`.
 */
export interface SupersededSeed {
  before: number
  id: string
  seed: ProviderInstanceConfig
  next: ProviderInstanceConfig
}

/** Seed changes since version 1; none yet. */
const SUPERSEDED_SEEDS: readonly SupersededSeed[] = []

function sameEntry(value: unknown, seed: ProviderInstanceConfig): boolean {
  if (!isProviderInstanceConfig(value)) return false
  const keys = Object.keys(value)
  return keys.length === Object.keys(seed).length && value.driver === seed.driver && value.enabled === seed.enabled && value.config === undefined
}

/**
 * Extends `stored` with every seed it lacks: the vendor instances and `pi:<provider>` for each
 * credentialed pi-ai provider. A stored id is never overwritten, even when its entry is malformed,
 * with one exception: an entry is only upgraded when the profile's recorded seed version proves it
 * is the seed (a marker of at least 1, below the change, and an entry equal to the old seed).
 * Returns the raw map and the version to persist. `changes` and `current` are for tests.
 */
export function seedProviderInstances(
  stored: unknown,
  credentialedPiProviders: Iterable<string>,
  /** The stored marker; absent means the profile predates markers (version 0). */
  seedVersion?: unknown,
  changes: readonly SupersededSeed[] = SUPERSEDED_SEEDS,
  current: number = PROVIDER_INSTANCE_SEED_VERSION
): { instances: Record<string, unknown>; added: string[]; upgraded: string[]; seedVersion: number } {
  const instances: Record<string, unknown> =
    stored && typeof stored === 'object' && !Array.isArray(stored) ? { ...(stored as Record<string, unknown>) } : {}
  const added: string[] = []
  const seed = (id: string, entry: ProviderInstanceConfig) => {
    if (Object.prototype.hasOwnProperty.call(instances, id)) return
    instances[id] = entry
    added.push(id)
  }
  const version = typeof seedVersion === 'number' && Number.isInteger(seedVersion) && seedVersion >= 0 ? seedVersion : 0
  const upgraded: string[] = []
  for (const change of changes)
    if (version >= 1 && version < change.before && sameEntry(instances[change.id], change.seed)) {
      instances[change.id] = { ...change.next }
      upgraded.push(change.id)
    }
  for (const [id, entry] of VENDOR_SEEDS) seed(id, { ...entry })
  for (const providerId of credentialedPiProviders) if (providerId) seed(piInstanceId(providerId), { driver: 'pi', enabled: true })
  return { instances, added, upgraded, seedVersion: Math.max(version, current) }
}
