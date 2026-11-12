import type { BotDepth, BotModelPick } from '../../../shared/bots/personal/definition'
import type { BotModelOption } from '../../../shared/bots/personal/methods'
import { isPinned, plainLabel } from '../../../shared/bots/personal/modelSlots'
import type { InstanceSnapshot } from '../../../shared/harness/status'
import type { InstanceModel, ProviderSelection, RunPolicy } from '../../../shared/harness/types'
import type { ModelCatalog } from '../../../shared/modelCatalog'
import { shortModelName } from '../../../shared/modelNames'
import { modelCatalog } from '../../models/modelCatalog'
import type { BotModelResolution, BotModelResolver, BotPickMiss, BotPickReason, BotRuntimeHold } from '../seams'
import { botModelCandidates, instanceReady, signInCandidate } from './candidates'
import { chooseBotModel, effortFor, offeredEfforts, type BotModelCandidate } from './chooseModel'

/**
 * The bots' model choice in the daemon (Bot Phase 1 §5.6, #673): `BotEngine` resolves each activation's first dispatch
 * here. A row picked by hand runs on its own entry or not at all; a bot from before picks still runs by usage, picking a
 * ready model by depth. Usage limits are remembered in memory, by instance, until their reset; a restart forgets them,
 * and the next limited turn marks the instance again.
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
  /**
   * The default bot model from Settings (`settings.botModel`): used when a bot's row is
   * Automatic, while it can run the bot. Absent or undefined: Automatic.
   */
  defaultModel?(): { instanceId: string; model: string } | undefined
}

/**
 * A policy that stands for any bot's (`canHoldBot` needs a bot authority): what Settings and Runs on
 * list as bot model choices. Each activation's own compiled policy is checked again when it resolves.
 */
export const REPRESENTATIVE_BOT_POLICY: RunPolicy = Object.freeze({
  mode: 'default',
  origin: 'bot',
  approvals: 'grants',
  approve: 'host',
  authority: Object.freeze({ kind: 'bot', digest: 'settings' })
}) as RunPolicy

const limitedNow = (candidate: BotModelCandidate, now: Date) => candidate.limitedUntil !== undefined && Date.parse(candidate.limitedUntil) > now.getTime()

export class BotModelChooser implements BotModelResolver {
  private readonly limited = new Map<string, string>()

  constructor(private readonly deps: BotModelResolverDeps) {}

  async resolve(input: { botId: string; pick: BotModelPick | null; depth: BotDepth; policy: RunPolicy }): Promise<BotModelResolution> {
    const now = this.now()
    const snapshots = await this.freshSnapshots()
    const candidates = botModelCandidates({
      snapshots,
      models: (instanceId) => this.deps.models(instanceId),
      hold: this.deps.hold,
      policy: input.policy,
      catalog: this.catalog(),
      limited: this.limitedAt(now)
    })
    if (isPinned(input.pick)) return this.picked(input.pick, candidates, snapshots, input.policy, now)
    // A bot from before picks, as before: a model by name across entries, which falls back to by usage when it is
    // missing or at its limit; a row on which Mousse chooses, by usage (the Settings default first).
    if (input.pick) {
      const named = chooseBotModel({ mode: 'named', model: input.pick.model, depth: input.depth }, candidates, now)
      if ('selection' in named) return named
    } else {
      const chosen = this.defaultCandidate(candidates, now)
      if (chosen) return { selection: depthSelection(chosen, input.depth) }
    }
    const result = chooseBotModel({ mode: 'auto', depth: input.depth }, candidates, now)
    if ('problem' in result && result.problem === 'no_provider') {
      const instanceId = signInCandidate({ snapshots, hold: this.deps.hold, policy: input.policy })
      return instanceId ? { problem: 'no_provider', instanceId } : { problem: 'no_provider' }
    }
    return result
  }

  /**
   * A pick on an entry runs there, on the same kind of sign-in and account it was picked on, at its reasoning level
   * (the model's default when it has none or no longer offers it), or not at all: never on another model or entry.
   */
  private picked(pick: BotModelPick & { instanceId: string }, candidates: readonly BotModelCandidate[], snapshots: readonly InstanceSnapshot[], policy: RunPolicy, now: Date): BotModelResolution {
    const found = candidates.find((candidate) => candidate.instanceId === pick.instanceId && candidate.model === pick.model)
    if (!found) return { problem: 'pick_unavailable', missed: this.miss(pick, this.pickReason(pick, snapshots, policy), snapshots) }
    const changed = identityChange(pick, found)
    if (changed) return { problem: 'pick_unavailable', missed: this.miss(pick, changed, snapshots) }
    // At its usage limit: the work waits for the reset, as when every model is limited.
    if (limitedNow(found, now)) return { problem: 'all_limited', until: found.limitedUntil!, instanceId: found.instanceId }
    return { selection: pickSelection(found, pick.effort) }
  }

  /** Why a pick on its entry is not among the candidates. */
  private pickReason(pick: BotModelPick & { instanceId: string }, snapshots: readonly InstanceSnapshot[], policy: RunPolicy): BotPickReason {
    const snapshot = snapshots.find((entry) => entry.instanceId === pick.instanceId)
    if (!snapshot) return 'removed'
    if (!snapshot.enabled.effective) return 'off'
    if (snapshot.auth.state === 'signed_out' || snapshot.auth.state === 'expired') return 'signed_out'
    if (!instanceReady(snapshot)) return 'not_ready'
    let listed = false
    try {
      listed = this.deps.models(pick.instanceId).some((model) => model.id === pick.model && !model.hidden)
    } catch {
      // Unreadable: as gone.
    }
    if (!listed) return 'model_gone'
    if (!this.deps.hold.canHoldBot(pick.instanceId, policy, pick.model).ok) return 'cant_hold'
    return 'not_ready'
  }

  /**
   * The owner's words for a pick that can't run: its model's name and its entry's, as Runs on names them ("Opus 5.5 on
   * Claude Code"). Both may be text from elsewhere (an entry's name, a custom endpoint's model name): one plain line each,
   * cut short.
   */
  private miss(pick: BotModelPick & { instanceId: string }, reason: BotPickReason, snapshots: readonly InstanceSnapshot[]): BotPickMiss {
    const entry = snapshots.find((snapshot) => snapshot.instanceId === pick.instanceId)?.displayName
    let name = pick.model
    try {
      name = this.deps.models(pick.instanceId).find((model) => model.id === pick.model)?.label || pick.model
    } catch {
      // The entry's models can't be read (it was removed): the model's id names it.
    }
    const model = plainLabel(shortModelName(name)) || plainLabel(pick.model)
    const where = entry ? plainLabel(entry, 40) : ''
    return { label: where ? `${model} on ${where}` : model, reason }
  }

  /**
   * The ready models that can hold a bot now, by instance (the Settings choices). Read with a
   * policy that stands for any bot's (`REPRESENTATIVE_BOT_POLICY`).
   */
  async holdable(): Promise<Array<{ instanceId: string; model: string }>> {
    return (await this.holdableCandidates()).map((candidate) => ({ instanceId: candidate.instanceId, model: candidate.model }))
  }

  /**
   * What a bot's rows may be given by hand (#673, Runs on): each ready entry's models that can hold a bot, named by
   * their entry and their own name, with the reasoning levels each offers. The same model on two entries is two options.
   */
  async pickable(): Promise<BotModelOption[]> {
    const snapshots = await this.freshSnapshots()
    const entries = new Map(snapshots.map((snapshot) => [snapshot.instanceId, snapshot.displayName]))
    return this.candidatesOf(snapshots).map((candidate) => this.optionOf(candidate, entries))
  }

  private optionOf(candidate: BotModelCandidate, entries: ReadonlyMap<string, string>): BotModelOption {
    const credential = candidate.credential === 'unknown' ? undefined : candidate.credential
    return {
      instanceId: candidate.instanceId,
      entry: entries.get(candidate.instanceId) || candidate.instanceId,
      model: candidate.model,
      label: this.deps.models(candidate.instanceId).find((model) => model.id === candidate.model)?.label || candidate.model,
      efforts: offeredEfforts(candidate.efforts),
      ...(credential ? { credential } : {}),
      ...(candidate.account ? { account: candidate.account } : {}),
      ...(candidate.names?.length ? { names: candidate.names } : {})
    }
  }

  /**
   * The Runs on choice the owner's words name (`use_model`): among the same options the picker offers, the best name
   * match, ranked subscriptions first. Undefined when none is named. It names the option, so the pick is saved with
   * what the entry is signed in with now.
   */
  async pickFor(words: string): Promise<BotModelOption | undefined> {
    const snapshots = await this.freshSnapshots()
    const candidates = this.candidatesOf(snapshots)
    const named = chooseBotModel({ mode: 'named', model: words, depth: 'normal' }, candidates, this.now())
    if (!('selection' in named)) return undefined
    const found = candidates.find((candidate) => candidate.instanceId === named.selection.instanceId && candidate.model === named.selection.model)
    return found ? this.optionOf(found, new Map(snapshots.map((snapshot) => [snapshot.instanceId, snapshot.displayName]))) : undefined
  }

  private async holdableCandidates(): Promise<BotModelCandidate[]> {
    return this.candidatesOf(await this.freshSnapshots())
  }

  private candidatesOf(snapshots: readonly InstanceSnapshot[]): BotModelCandidate[] {
    return botModelCandidates({ snapshots, models: (instanceId) => this.deps.models(instanceId), hold: this.deps.hold, policy: REPRESENTATIVE_BOT_POLICY, catalog: this.catalog() })
  }

  /** The snapshots, with the enabled instances' policy facts read again (every bot check point does). */
  private async freshSnapshots(): Promise<readonly InstanceSnapshot[]> {
    const snapshots = await this.deps.snapshots()
    const refresh = this.deps.refresh
    if (refresh) await Promise.all(snapshots.filter((snapshot) => snapshot.enabled.effective).map((snapshot) => refresh(snapshot.instanceId).catch(() => undefined)))
    return snapshots
  }

  /** The Settings default among the candidates, when it is there and not at its usage limit. */
  private defaultCandidate(candidates: readonly BotModelCandidate[], now: Date): BotModelCandidate | undefined {
    let wanted: { instanceId: string; model: string } | undefined
    try {
      wanted = this.deps.defaultModel?.()
    } catch {
      return undefined
    }
    if (!wanted?.instanceId || !wanted.model) return undefined
    const found = candidates.find((candidate) => candidate.instanceId === wanted!.instanceId && candidate.model === wanted!.model)
    if (!found) return undefined
    return limitedNow(found, now) ? undefined : found
  }

  markLimited(instanceId: string, until: string): void {
    if (Number.isNaN(Date.parse(until))) return
    const held = this.limited.get(instanceId)
    if (!held || Date.parse(until) > Date.parse(held)) this.limited.set(instanceId, until)
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

/** A pick's selection: its reasoning level while the model offers it, else the model's own default. */
function pickSelection(candidate: BotModelCandidate, effort: string | undefined): ProviderSelection {
  const chosen = effort && candidate.efforts.includes(effort) ? effort : effortFor('normal', candidate)
  return { instanceId: candidate.instanceId, model: candidate.model, ...(chosen ? { effort: chosen } : {}) }
}

/** By usage on a chosen candidate (the Settings default): the effort the depth gives. */
function depthSelection(candidate: BotModelCandidate, depth: BotDepth): ProviderSelection {
  const effort = effortFor(depth, candidate)
  return { instanceId: candidate.instanceId, model: candidate.model, ...(effort ? { effort } : {}) }
}

/**
 * How the entry changed since the pick was saved: it signs in another way now (a subscription switched to an API key
 * keeps the entry's id), or to another account (an entry removed and added again under the same name gets the same
 * id). Compared only where both are known; a pick saved before it remembered them has nothing to compare.
 */
function identityChange(pick: BotModelPick, candidate: BotModelCandidate): BotPickReason | undefined {
  const credential = candidate.credential === 'unknown' ? undefined : candidate.credential
  if (pick.credential && credential && pick.credential !== credential) return 'sign_in_changed'
  if (pick.account && candidate.account && pick.account !== candidate.account) return 'account_changed'
  return undefined
}

/** The resolver `MmsProfileServices` hands to `BotEngine`. */
export function createBotModelResolver(deps: BotModelResolverDeps): BotModelChooser {
  return new BotModelChooser(deps)
}
