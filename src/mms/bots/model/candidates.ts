import { botModelTier, catalogEntryFor, type BotModelTier } from '../../../shared/bots/personal/modelTiers'
import type { InstanceSnapshot } from '../../../shared/harness/status'
import type { InstanceModel, RunPolicy } from '../../../shared/harness/types'
import type { ModelCatalog } from '../../../shared/modelCatalog'
import type { BotRuntimeHold } from '../seams'
import type { BotModelCandidate } from './chooseModel'

/**
 * The models a bot may run on (Bot Phase 1 §5.6), built in the daemon from the provider snapshots:
 * the owner's own provider entries, the same ones their chats use, that are enabled, signed in and
 * run, and whose runtime can hold the bot's policy (`canHoldBot`: Pi, Claude Code and Codex; not a
 * runtime that approves tools itself), each with its visible models.
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

/** Whether an instance is ready to run a turn now: enabled, signed in (or needing none) and running. */
export function instanceReady(snapshot: InstanceSnapshot): boolean {
  return snapshot.enabled.effective && (snapshot.auth.state === 'signed_in' || snapshot.auth.state === 'not_required') && snapshot.runs.state === 'yes'
}

function credentialOf(snapshot: InstanceSnapshot): BotModelCandidate['credential'] {
  // Codex runs only on a ChatGPT sign-in (never an API key) and sets no credential of its own.
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
    if (!instanceReady(snapshot)) continue
    const limitedUntil = input.limited?.get(snapshot.instanceId)
    let order = 0
    for (const model of input.models(snapshot.instanceId)) {
      if (model.hidden) continue
      // Where the entry lists the model: the ranking's last word between models of one entry with
      // no release date (Codex lists its default first).
      const listed = order++
      if (!input.hold.canHoldBot(snapshot.instanceId, input.policy, model.id).ok) continue
      const entry = catalogEntryFor(model.id, input.catalog)
      candidates.push({
        instanceId: snapshot.instanceId,
        model: model.id,
        efforts: [...model.capabilities.efforts],
        ...(model.capabilities.defaultEffort ? { defaultEffort: model.capabilities.defaultEffort } : {}),
        tier: candidateTier(snapshot.driver, model.id, input.catalog),
        credential: credentialOf(snapshot),
        ...(entry ? { released: entry.released } : {}),
        ...(limitedUntil ? { limitedUntil } : {}),
        listed,
        names: namesOf(model, input.catalog)
      })
    }
  }
  return candidates
}

/**
 * A model's tier on an entry. Codex's `default` is the model Codex picks for the account: a
 * standard one. Claude Code's `default` stands for Opus or Sonnet by plan, so it stays `unknown` and
 * its `sonnet` and `opus` entries are ranked instead.
 */
function candidateTier(driver: string, model: string, catalog: ModelCatalog | undefined): BotModelTier {
  if (driver === 'codex' && model === 'default') return 'standard'
  return botModelTier(model, catalog)
}

/**
 * An entry of the owner's that could run the bot once they sign in to it (enabled, can hold the
 * policy, signed out or expired): the `sign_in` action of a bot with no model, which opens that
 * entry's own card. One Mousse can sign in itself comes first; the owner's own CLI sign-in (Claude
 * Code, Codex in a terminal) is next, its card saying how.
 */
export function signInCandidate(input: Pick<BotCandidateInput, 'snapshots' | 'hold' | 'policy'>): string | undefined {
  const waiting = input.snapshots.filter((snapshot) =>
    snapshot.enabled.effective &&
    (snapshot.auth.state === 'signed_out' || snapshot.auth.state === 'expired') &&
    input.hold.canHoldBot(snapshot.instanceId, input.policy).ok
  )
  return (waiting.find((snapshot) => snapshot.auth.canSignIn === true) ?? waiting[0])?.instanceId
}
