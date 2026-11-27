import { AppError } from './errors'

/**
 * Provider instances (docs/run-engine/SPEC.md §13.8). A driver is the kind of runtime that serves a
 * turn (the in-process pi loop, Claude Code, Antigravity, Codex); an instance is one configured use
 * of a driver with a stable id. Every caller that picks an agent selects `{ instanceId, model }`.
 * In v1 each vendor driver has exactly one instance, and each pi-ai provider is its own instance.
 */
export type ProviderDriverKind = 'pi' | 'claude' | 'antigravity' | 'codex' | 'acp' | 'cursor' | 'grok' | 'opencode'

export const PROVIDER_DRIVER_KINDS: readonly ProviderDriverKind[] = ['pi', 'claude', 'antigravity', 'codex', 'acp', 'cursor', 'grok', 'opencode']

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
 * A stored model selection (a thread's `modelOverride`). `instanceId` is
 * authoritative; `llmProvider` is derived from the instance and kept so the current GUI and older
 * daemons can still read the record. Records written before instances existed carry only
 * `llmProvider` and are mapped with `instanceIdForLegacyProvider` when read.
 */
export interface ModelOverride {
  instanceId?: string
  /** @deprecated Derived from `instanceId`; kept for readers that predate provider instances. */
  llmProvider: string
  /** The model as its agent lists it, never with a reasoning level attached (see `modelSelection.ts`). */
  model: string
  /** The reasoning level; absent = the model's default. */
  effort?: string
  /** The model's name when it was chosen, for screens and devices that have no listing of it. */
  name?: string
}

export const CLAUDE_INSTANCE_ID = 'claude'
export const ANTIGRAVITY_INSTANCE_ID = 'antigravity'
export const CODEX_INSTANCE_ID = 'codex'
const PI_INSTANCE_PREFIX = 'pi:'

/**
 * The `llmProvider` name each vendor driver used before instances existed. Drivers added since have
 * none (`''`): a reader that predates instances never routes their turns to the pi loop, and
 * selections name them by instance id only.
 */
const LEGACY_PROVIDER_BY_DRIVER: Record<Exclude<ProviderDriverKind, 'pi'>, string> = {
  claude: 'claude-subscription',
  antigravity: 'antigravity',
  codex: 'codex',
  acp: '',
  cursor: '',
  grok: '',
  // Never `opencode`: that names the OpenCode Zen model API (`pi:opencode`), which Pi runs.
  opencode: ''
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

/**
 * Whether a picker listing (`llmProviders` entry) serves a selection: by instance when both name
 * one (two Claude instances share `llmProvider`), else by the legacy provider name.
 */
export function listingServes(listing: { id: string; instanceId?: string }, selection: { instanceId?: string; llmProvider?: string }): boolean {
  const instanceId = selection.instanceId?.trim()
  return instanceId && listing.instanceId ? listing.instanceId === instanceId : listing.id === selection.llmProvider
}

/** The selection one model of a picker listing makes: its instance, provider name and model. */
export function selectionFromListing(listing: { id: string; instanceId?: string }, model: string): ModelOverride {
  return { ...(listing.instanceId ? { instanceId: listing.instanceId } : {}), llmProvider: listing.id, model }
}

/** Stable key of a picker listing: its instance id, else its provider name. */
export function listingKey(listing: { id: string; instanceId?: string }): string {
  return listing.instanceId ?? listing.id
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
    // An OpenCode added as an ACP agent reads as an OpenCode entry; it stays stored as it was (`acpEntryForOpencode`).
    const read = opencodeEntryFromAcp(entry) ?? entry
    if (isProviderInstanceConfig(read)) instances[id] = { ...read, ...(read.config ? { config: { ...read.config } } : {}) }
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
 * Extends `stored` with every seed it lacks: the vendor instances (only on a profile never seeded
 * before) and `pi:<provider>` for each credentialed pi-ai provider. A stored id is never overwritten, even when its entry is malformed,
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
  current: number = PROVIDER_INSTANCE_SEED_VERSION,
  /**
   * The config a vendor seed starts with: its launch settings and sign-out as the vendor's own
   * settings file holds them, with the mirror marker (`harness/vendorMirror`). Undefined: none.
   */
  vendorSeedConfig?: (instanceId: string) => Record<string, unknown> | undefined
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
  // Agents are added once, for a profile that was never seeded; after that they are entries like any
  // other, so a provider the user deleted stays deleted.
  if (version < 1)
    for (const [id, entry] of VENDOR_SEEDS) {
      if (Object.prototype.hasOwnProperty.call(instances, id)) continue
      const config = vendorSeedConfig?.(id)
      seed(id, { ...entry, ...(config ? { config } : {}) })
    }
  for (const providerId of credentialedPiProviders) if (providerId) seed(piInstanceId(providerId), { driver: 'pi', enabled: true })
  return { instances, added, upgraded, seedVersion: Math.max(version, current) }
}

/** The ACP registry's ids of OpenCode: its own and the legacy alias of the same release. */
const OPENCODE_REGISTRY_IDS: ReadonlySet<string> = new Set(['opencode', 'opencode-v2'])

/** An `opencode` executable, by file name: `opencode`, `opencode.exe`, `opencode.cmd`. */
function isOpencodeCommand(command: unknown): command is string {
  if (typeof command !== 'string') return false
  const name = command.split(/[\\/]/).pop() ?? ''
  return /^opencode(?:\.exe|\.cmd)?$/i.test(name)
}

/**
 * An OpenCode added as an ACP agent (from the registry, or as a command running `opencode acp`), as an entry of the
 * OpenCode provider with the same name, executable, arguments, variables and switches. Undefined for any other entry.
 * The id stays, so its threads, its install and its saved native sessions stay with it. The registry `source` becomes
 * `registryAgentId`: the OpenCode provider finds the install by the entry's id and that registry id, and starts its own
 * command (`serve`) from it.
 *
 * Applied when the map is read, never written: the stored entry stays an ACP entry (`acpEntryForOpencode` writes
 * changes back in that form), so an older build that has no OpenCode provider, or one that finds managed copies only
 * under `opencode`, still runs it over ACP from the same files.
 */
export function opencodeEntryFromAcp(entry: unknown): ProviderInstanceConfig | undefined {
  if (!isProviderInstanceConfig(entry) || entry.driver !== 'acp') return undefined
  const config = entry.config ?? {}
  const source = config.source
  const { source: _source, ...rest } = config
  if (source && typeof source === 'object' && !Array.isArray(source)) {
    const record = source as Record<string, unknown>
    if (record.kind === 'registry' && typeof record.agentId === 'string' && OPENCODE_REGISTRY_IDS.has(record.agentId))
      return { ...entry, driver: 'opencode', config: { ...rest, registryAgentId: record.agentId } }
    if (record.kind === 'local' && isOpencodeCommand(record.command) && Array.isArray(record.args) && record.args[0] === 'acp') {
      const env = record.env && typeof record.env === 'object' && !Array.isArray(record.env) ? record.env as Record<string, unknown> : {}
      return {
        ...entry,
        driver: 'opencode',
        config: {
          ...rest,
          binaryPath: record.command,
          args: record.args.slice(1).filter((arg): arg is string => typeof arg === 'string'),
          ...(Object.keys(env).length ? { env: { ...env, ...(isRecordValue(rest.env) ? rest.env : {}) } } : {})
        }
      }
    }
    return undefined
  }
  // An entry with no source runs its `binaryPath` with its `args`.
  if (isOpencodeCommand(config.binaryPath) && Array.isArray(config.args) && config.args[0] === 'acp')
    return { ...entry, driver: 'opencode', config: { ...rest, args: config.args.slice(1).filter((arg): arg is string => typeof arg === 'string') } }
  return undefined
}

/**
 * The stored form of `next`, an OpenCode entry that was read from the stored ACP entry `stored`
 * (`opencodeEntryFromAcp`): that ACP entry with `next`'s changes, so every build reads it as before. Undefined when
 * `stored` is not such an entry, or `next` no longer runs on the OpenCode provider.
 */
export function acpEntryForOpencode(stored: unknown, next: ProviderInstanceConfig): ProviderInstanceConfig | undefined {
  if (next.driver !== 'opencode' || !isProviderInstanceConfig(stored) || !opencodeEntryFromAcp(stored)) return undefined
  const before = stored.config ?? {}
  const { registryAgentId: _registryAgentId, binaryPath, args, env, ...rest } = next.config ?? {}
  const own = Array.isArray(args) ? args.filter((arg): arg is string => typeof arg === 'string') : []
  const source = isRecordValue(before.source) ? before.source : undefined
  const config: Record<string, unknown> = { ...rest }
  if (source?.kind === 'registry') {
    // Its arguments, variables and executable were read as they are stored.
    Object.assign(config, { source }, binaryPath !== undefined ? { binaryPath } : {}, args !== undefined ? { args } : {}, env !== undefined ? { env } : {})
  } else if (source) {
    const { env: _env, ...kept } = source
    config.source = { ...kept, command: typeof binaryPath === 'string' && binaryPath ? binaryPath : source.command, args: ['acp', ...own], ...(isRecordValue(env) && Object.keys(env).length ? { env } : {}) }
  } else {
    Object.assign(config, { binaryPath: typeof binaryPath === 'string' && binaryPath ? binaryPath : before.binaryPath, args: ['acp', ...own] }, env !== undefined ? { env } : {})
  }
  return { ...next, driver: 'acp', config }
}

function isRecordValue(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

/**
 * The name of a further entry of a provider: `<base> 2`, `<base> 3`, ..., the first number no entry is called yet
 * (names compared without case or surrounding spaces).
 */
/**
 * Default names a Mousse version gave new entries and later replaced. An entry still saved under
 * one shows the current default ("ChatGPT subscription 2" reads "Codex 2"); a name the person
 * typed is kept as it is.
 */
const RETIRED_DEFAULT_NAMES: Partial<Record<ProviderDriverKind, { old: string; now: string }>> = {
  codex: { old: 'ChatGPT subscription', now: 'Codex' }
}

/** `name` with a retired default replaced by the current one (`RETIRED_DEFAULT_NAMES`). */
export function currentDefaultName(driver: string, name: string): string {
  const retired = RETIRED_DEFAULT_NAMES[driver as ProviderDriverKind]
  if (!retired) return name
  const match = new RegExp(`^${retired.old}( \\d+)?$`).exec(name.trim())
  return match ? `${retired.now}${match[1] ?? ''}` : name
}

export function nextEntryName(base: string, taken: Iterable<string>): string {
  const names = new Set([...taken].map((name) => name.trim().toLowerCase()))
  for (let n = 2; ; n += 1) {
    const name = `${base} ${n}`
    if (!names.has(name.toLowerCase())) return name
  }
}
