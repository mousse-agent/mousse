import type { BotModelChoice } from '../../../shared/bots/personal/definition'
import type { InstanceSnapshot } from '../../../shared/harness/status'
import type { InstanceModel, RunPolicy } from '../../../shared/harness/types'
import type { ModelCatalog } from '../../../shared/modelCatalog'
import { modelCatalog } from '../../models/modelCatalog'
import type { BotModelResolver, BotRuntimeHold } from '../seams'
import { botModelCandidates, instanceReady, signInCandidate } from './candidates'
import { chooseBotModel, nameMatch, type BotModelChoiceResult } from './chooseModel'

/**
 * The hidden model choice in the daemon (Bot Phase 1 §5.6): `BotEngine` resolves each activation's
 * first dispatch here. Usage limits are remembered in memory, by instance, until their reset; a
 * restart forgets them, and the next limited turn marks the instance again.
 */

export interface BotModelResolverDeps {
  /** Provider snapshots in the device scope (`harness.instances.snapshots({ kind: 'device' })`). */
  snapshots(): Promise<readonly InstanceSnapshot[]>
  /** An instance's models with prefs applied (`harness.catalog.models(instanceId, { kind: 'device' })`). */
  models(instanceId: string): readonly InstanceModel[]
  /** `gateway.canHoldBot` (WP1). */
  hold: BotRuntimeHold
  /**
   * Reads an instance's policy facts again (`HarnessGateway.refreshPolicyFacts`). A locked Claude
   * entry trusts its last "no organisation policy" reading only briefly, so without a fresh reading
   * `canHoldBot` refuses it and a signed-in runner is skipped.
   */
  refresh?(instanceId: string): Promise<void>
  /** Default: the bundled catalog for this Mousse (`modelCatalog()`). */
  catalog?(): ModelCatalog
  now?(): Date
}

export class BotModelChooser implements BotModelResolver {
  private readonly limited = new Map<string, string>()

  constructor(private readonly deps: BotModelResolverDeps) {}

  async resolve(input: { botId: string; choice: BotModelChoice; override?: BotModelChoice; policy: RunPolicy }): Promise<BotModelChoiceResult> {
    const now = this.now()
    const snapshots = await this.deps.snapshots()
    // The hold checks below decide on the instances' policy facts: read them now, as every other bot check point does.
    const refresh = this.deps.refresh
    if (refresh) await Promise.all(snapshots.filter((snapshot) => snapshot.enabled.effective).map((snapshot) => refresh(snapshot.instanceId).catch(() => undefined)))
    const candidates = botModelCandidates({
      snapshots,
      models: (instanceId) => this.deps.models(instanceId),
      hold: this.deps.hold,
      policy: input.policy,
      catalog: this.catalog(),
      limited: this.limitedAt(now)
    })
    const choice = input.override ?? input.choice
    let result = chooseBotModel(choice, candidates, now)
    // A named model that is missing or at its limit: the bot stays on auto at the same depth.
    if (choice.mode === 'named' && 'problem' in result) result = chooseBotModel({ mode: 'auto', depth: choice.depth }, candidates, now)
    if ('problem' in result && result.problem === 'no_provider') {
      const instanceId = signInCandidate({ snapshots, hold: this.deps.hold, policy: input.policy })
      return instanceId ? { problem: 'no_provider', instanceId } : { problem: 'no_provider' }
    }
    return result
  }

  markLimited(instanceId: string, until: string): void {
    if (Number.isNaN(Date.parse(until))) return
    const held = this.limited.get(instanceId)
    if (!held || Date.parse(until) > Date.parse(held)) this.limited.set(instanceId, until)
  }

  /**
   * Whether the owner's words name a model some ready instance lists now (`use_model`). It does not
   * check the bot's policy, which the tool does not have; the next activation's `resolve` does, and
   * falls back to auto when the model can't hold it.
   */
  async namedAvailable(model: string): Promise<boolean> {
    const catalog = this.catalog()
    const snapshots = await this.deps.snapshots()
    const anyPolicy: BotRuntimeHold = { canHoldBot: () => ({ ok: true }) }
    const candidates = botModelCandidates({
      snapshots: snapshots.filter(instanceReady),
      models: (instanceId) => this.deps.models(instanceId),
      hold: anyPolicy,
      policy: { mode: 'default', origin: 'bot', approvals: 'grants' },
      catalog
    })
    return candidates.some((candidate) => nameMatch(model, candidate) > 0)
  }

  /** The instances at their limit now; resets that passed are forgotten. */
  private limitedAt(now: Date): ReadonlyMap<string, string> {
    for (const [instanceId, until] of this.limited) if (Date.parse(until) <= now.getTime()) this.limited.delete(instanceId)
    return this.limited
  }

  private catalog(): ModelCatalog {
    return this.deps.catalog ? this.deps.catalog() : modelCatalog()
  }

  private now(): Date {
    return this.deps.now ? this.deps.now() : new Date()
  }
}

/** The resolver `MmsProfileServices` hands to `BotEngine`. */
export function createBotModelResolver(deps: BotModelResolverDeps): BotModelChooser {
  return new BotModelChooser(deps)
}
