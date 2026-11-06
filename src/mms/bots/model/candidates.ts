import { botModelTier, catalogEntryFor } from '../../../shared/bots/personal/modelTiers'
import type { InstanceSnapshot } from '../../../shared/harness/status'
import type { InstanceModel, RunPolicy } from '../../../shared/harness/types'
import type { ModelCatalog } from '../../../shared/modelCatalog'
import type { BotRuntimeHold } from '../seams'
import type { BotModelCandidate } from './chooseModel'

/**
 * The models a bot may run on (Bot Phase 1 §5.6), built in the daemon from the provider snapshots:
 * enabled instances that are signed in and run, whose runtime can hold the bot's policy
 * (`canHoldBot`), each with its visible models. Codex has no bot gate and is never one.
 */

export interface BotCandidateInput {
  snapshots: readonly InstanceSnapshot[]
  /** An instance's models with prefs applied (`HarnessCatalog.models`). */
  models(instanceId: string): readonly InstanceModel[]
  hold: BotRuntimeHold
  /** The bot's compiled policy for the thread (`compileBotThread`). */
  policy: RunPolicy
  catalog?: ModelCatalog
  /** Instances at their usage limit, until when (ISO). */
  limited?: ReadonlyMap<string, string>
}

/** Drivers that can never hold a bot in Phase 1, whatever `canHoldBot` says. */
const NO_BOT_DRIVERS: ReadonlySet<string> = new Set(['codex'])

/** Whether an instance is ready to run a turn now: enabled, signed in (or needing none) and running. */
export function instanceReady(snapshot: InstanceSnapshot): boolean {
  return snapshot.enabled.effective && (snapshot.auth.state === 'signed_in' || snapshot.auth.state === 'not_required') && snapshot.runs.state === 'yes'
}

function credentialOf(snapshot: InstanceSnapshot): BotModelCandidate['credential'] {
  // Codex instances count as subscriptions (they set no credential); they never reach here in Phase 1.
  if (snapshot.driver === 'codex') return 'subscription'
  return snapshot.auth.credential ?? 'unknown'
}

function namesOf(model: InstanceModel, catalog: ModelCatalog | undefined): string[] {
  const entry = catalogEntryFor(model.id, catalog)
  const names = [model.label, ...(entry ? [entry.id, entry.name, entry.short, ...(entry.family ? [entry.family] : []), ...Object.values(entry.routes).map((route) => route!.id)] : [])]
  return [...new Set(names.filter(Boolean).map((name) => name.toLowerCase()))]
}

export function botModelCandidates(input: BotCandidateInput): BotModelCandidate[] {
  const candidates: BotModelCandidate[] = []
  for (const snapshot of input.snapshots) {
    if (NO_BOT_DRIVERS.has(snapshot.driver) || !instanceReady(snapshot)) continue
    const limitedUntil = input.limited?.get(snapshot.instanceId)
    for (const model of input.models(snapshot.instanceId)) {
      if (model.hidden) continue
      if (!input.hold.canHoldBot(snapshot.instanceId, input.policy, model.id).ok) continue
      const entry = catalogEntryFor(model.id, input.catalog)
      candidates.push({
        instanceId: snapshot.instanceId,
        model: model.id,
        efforts: [...model.capabilities.efforts],
        ...(model.capabilities.defaultEffort ? { defaultEffort: model.capabilities.defaultEffort } : {}),
        tier: botModelTier(model.id, input.catalog),
        credential: credentialOf(snapshot),
        ...(entry ? { released: entry.released } : {}),
        ...(limitedUntil ? { limitedUntil } : {}),
        names: namesOf(model, input.catalog)
      })
    }
  }
  return candidates
}

/**
 * An instance that could run the bot once its owner signs in to it (enabled, a bot-capable driver
 * that can hold the policy, signed out or expired, and Mousse can start the sign-in): the `sign_in`
 * action of a bot with no model. The locked bot runner (`claude:bots`) comes first.
 */
export function signInCandidate(input: Pick<BotCandidateInput, 'snapshots' | 'hold' | 'policy'>): string | undefined {
  const waiting = input.snapshots.filter((snapshot) =>
    snapshot.enabled.effective &&
    !NO_BOT_DRIVERS.has(snapshot.driver) &&
    (snapshot.auth.state === 'signed_out' || snapshot.auth.state === 'expired') &&
    snapshot.auth.canSignIn === true &&
    input.hold.canHoldBot(snapshot.instanceId, input.policy).ok
  )
  return (waiting.find((snapshot) => snapshot.instanceId === 'claude:bots') ?? waiting[0])?.instanceId
}
