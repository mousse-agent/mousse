import { catalogEntryFor, type BotModelTier } from '../../shared/bots/personal/modelTiers'
import type { InstanceSnapshot } from '../../shared/harness/status'
import type { InstanceModel, ProviderScope } from '../../shared/harness/types'
import type { ModelCatalog } from '../../shared/modelCatalog'
import { piProviderIdOf } from '../../shared/providerInstances'
import { bundledModelCatalog, modelCatalog } from '../models/modelCatalog'
import { candidateTier, credentialOf, instanceReady, titleEffortFor, type ModelCredential } from '../models/modelCandidates'
import type { UsageLimitTracker } from '../models/usageLimits'

export { titleEffortFor }

/**
 * Automatic thread naming's models (Settings → Agents → Thread titles left on Automatic): every connected model that
 * can run a single request, best first, from what the provider snapshots already say. Nothing here asks a provider:
 * the index is rebuilt when the snapshots change, and read synchronously at each naming.
 *
 * Best first means: the provider by the catalog's `namingProviders` (Claude, then Codex, then Antigravity, then Pi's
 * providers, then the other agents), then the model's tier (`small` first: Haiku, gpt-6-luna, gemini-3.8-flash), then a subscription before an
 * API key, a current model before an older one, the newest release, and the order the agent lists them.
 */

const TIER_ORDER: Record<BotModelTier, number> = { small: 0, standard: 1, frontier: 2, unknown: 3 }

/** One model Automatic naming may ask, with the reasoning level it asks at (absent: the model's default). */
export interface TitleModelCandidate {
  instanceId: string
  driver: string
  model: string
  effort?: string
  tier: BotModelTier
  credential: ModelCredential
}

export interface RankTitleModelsInput {
  snapshots: readonly InstanceSnapshot[]
  /** An instance's models with prefs applied (`HarnessCatalog.models`). */
  models(instanceId: string): readonly InstanceModel[]
  /** Whether the instance's driver runs single requests (`HarnessGateway.canOneShot`). */
  canOneShot(instanceId: string): boolean
  catalog?: ModelCatalog
}

/** The naming provider list in use: the catalog's, else the bundled catalog's. */
function namingProviders(catalog: ModelCatalog | undefined): readonly string[] {
  return catalog?.namingProviders?.length ? catalog.namingProviders : (bundledModelCatalog().namingProviders ?? ['*'])
}

/** Where an instance stands in the provider list: the first entry naming its Pi provider, its driver, or `*`. */
function providerRank(snapshot: InstanceSnapshot, list: readonly string[]): number {
  const piProvider = piProviderIdOf(snapshot.instanceId)
  const keys = [...(piProvider ? [`pi:${piProvider}`] : []), snapshot.driver, '*']
  const rank = list.findIndex((entry) => keys.includes(entry))
  return rank === -1 ? list.length : rank
}

interface Ranked {
  candidate: TitleModelCandidate
  provider: number
  tier: number
  subscription: number
  older: number
  released: string
  listed: number
}

/**
 * Every model Automatic naming may ask, best first. A model is left out when its instance is not ready (off, signed out,
 * not running), is a locked bot entry, runs no single requests, or the model is hidden or cannot run one. Usage limits
 * are not read here: they are filtered when the index is read (`TitleModelCache.candidates`), so a reset that passes
 * brings the model back without a rebuild.
 */
export function rankTitleModels(input: RankTitleModelsInput): TitleModelCandidate[] {
  const list = namingProviders(input.catalog)
  const ranked: Ranked[] = []
  for (const snapshot of input.snapshots) {
    if (!instanceReady(snapshot) || snapshot.config?.profile === 'locked') continue
    if (!input.canOneShot(snapshot.instanceId)) continue
    let models: readonly InstanceModel[]
    try {
      models = input.models(snapshot.instanceId)
    } catch {
      continue
    }
    const usable = models.filter((model) => !model.hidden && model.oneShot !== false)
    // `default` stands for whichever model the agent picks: used only when the instance lists nothing else.
    const concrete = usable.some((model) => model.id !== 'default')
    const provider = providerRank(snapshot, list)
    const credential = credentialOf(snapshot)
    usable.forEach((model, listed) => {
      if (concrete && model.id === 'default') return
      const lookupId = model.resolvedId ?? model.id
      const entry = catalogEntryFor(lookupId, input.catalog) ?? catalogEntryFor(model.id, input.catalog)
      const tier = candidateTier(snapshot.driver, model.id, input.catalog, model.resolvedId)
      const effort = titleEffortFor(snapshot.driver, model)
      ranked.push({
        candidate: { instanceId: snapshot.instanceId, driver: snapshot.driver, model: model.id, ...(effort ? { effort } : {}), tier, credential },
        provider,
        tier: TIER_ORDER[tier],
        subscription: credential === 'subscription' ? 0 : 1,
        older: entry?.older || model.older ? 1 : 0,
        released: entry?.released ?? '',
        listed
      })
    })
  }
  return ranked
    .sort((a, b) =>
      a.provider - b.provider ||
      a.tier - b.tier ||
      a.subscription - b.subscription ||
      a.older - b.older ||
      b.released.localeCompare(a.released) ||
      a.listed - b.listed ||
      a.candidate.instanceId.localeCompare(b.candidate.instanceId) ||
      a.candidate.model.localeCompare(b.candidate.model))
    .map(({ candidate }) => candidate)
}

/** What the index reads from the harness gateway. The optional readers may be missing (a test's stub gateway). */
export interface TitleModelSource {
  cachedSnapshots?(scope: ProviderScope): readonly InstanceSnapshot[]
  canOneShot?(instanceId: string): boolean
  isEnabledInScope?(instanceId: string, scope: ProviderScope): boolean
  catalog?: { models(instanceId: string, scope: ProviderScope): InstanceModel[] }
  instances?: { subscribe?(listener: (event: { type: string; data?: unknown }) => void): () => void }
}

export interface TitleModelCacheOptions {
  usageLimits: UsageLimitTracker
  /** Naming's own short waits after too many requests (`ExtractedLimit.transient`), which bots do not share. */
  cooldowns?: UsageLimitTracker
  catalog?(): ModelCatalog
  /** Called after each rebuild from new snapshots, so queued namings can be tried again. */
  onSnapshotsUpdated?(): void
}

const DEVICE: ProviderScope = { kind: 'device' }

/**
 * The ranked models, kept in memory: built from the gateway's snapshots as known now (no check is started), rebuilt on
 * each device snapshots event. Reading it is synchronous and asks no provider.
 */
export class TitleModelCache {
  private ranked: TitleModelCandidate[] = []
  private snapshots: readonly InstanceSnapshot[] = []
  private source: TitleModelSource | undefined
  private unsubscribe: (() => void) | undefined

  constructor(private readonly options: TitleModelCacheOptions) {}

  /** Reads from `source` (the profile's gateway) from now on, and rebuilds at once. */
  attach(source: TitleModelSource | undefined): void {
    this.unsubscribe?.()
    this.unsubscribe = undefined
    this.source = source
    try {
      this.unsubscribe = source?.instances?.subscribe?.((event) => {
        if (event.type !== 'snapshots') return
        const scope = (event.data as { scope?: ProviderScope } | undefined)?.scope
        if (scope && scope.kind !== 'device') return
        this.rebuild()
        this.options.onSnapshotsUpdated?.()
      })
    } catch {
      // A gateway without events: the index is rebuilt on the next attach only.
    }
    this.rebuild()
  }

  detach(): void {
    this.unsubscribe?.()
    this.unsubscribe = undefined
    this.source = undefined
    this.ranked = []
    this.snapshots = []
  }

  /** Builds the index again from the snapshots known now. */
  rebuild(): void {
    const source = this.source
    if (!source?.cachedSnapshots || !source.canOneShot) {
      this.ranked = []
      this.snapshots = []
      return
    }
    try {
      this.snapshots = source.cachedSnapshots(DEVICE)
      this.ranked = rankTitleModels({
        snapshots: this.snapshots,
        models: (instanceId) => source.catalog?.models(instanceId, DEVICE) ?? [],
        canOneShot: (instanceId) => source.canOneShot!(instanceId),
        catalog: this.options.catalog ? this.options.catalog() : modelCatalog()
      })
    } catch (error) {
      console.warn('[titles] the naming models could not be read', { error: error instanceof Error ? error.message : String(error) })
      this.ranked = []
      this.snapshots = []
    }
  }

  /**
   * The models Automatic naming may ask in `scope` now, best first: those on in the scope (a project may turn an entry
   * off), not at a usage limit at `now`, and not in naming's own cooldown.
   */
  candidates(scope: ProviderScope = DEVICE, now: Date = new Date()): TitleModelCandidate[] {
    const held = (candidate: TitleModelCandidate) =>
      this.options.usageLimits.isLimited(candidate.instanceId, candidate.model, now) || Boolean(this.options.cooldowns?.isLimited(candidate.instanceId, candidate.model, now))
    return this.ranked.filter((candidate) => this.enabledIn(candidate.instanceId, scope) && !held(candidate))
  }

  /**
   * Whether an entry that could name threads in `scope` has not been checked yet (no `checkedAt`): turned on, not a
   * locked bot entry, and able to run single requests. Its first check may still make it ready. A check that ended in
   * any way (not installed, timed out, a failed sign-in check) counts as checked.
   */
  hasPendingProbe(scope: ProviderScope = DEVICE): boolean {
    const source = this.source
    if (!source?.cachedSnapshots || !source.canOneShot) return false
    return this.snapshots.some((snapshot) =>
      snapshot.enabled.effective &&
      snapshot.checkedAt === undefined &&
      snapshot.config?.profile !== 'locked' &&
      this.enabledIn(snapshot.instanceId, scope) &&
      source.canOneShot!(snapshot.instanceId))
  }

  private enabledIn(instanceId: string, scope: ProviderScope): boolean {
    if (scope.kind === 'device') return true
    const check = this.source?.isEnabledInScope
    if (!check) return true
    try {
      return check.call(this.source, instanceId, scope)
    } catch {
      return false
    }
  }
}
