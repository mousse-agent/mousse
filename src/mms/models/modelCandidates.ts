import { botModelTier, type BotModelTier } from '../../shared/bots/personal/modelTiers'
import type { InstanceSnapshot } from '../../shared/harness/status'
import type { InstanceModel } from '../../shared/harness/types'
import type { ModelCatalog } from '../../shared/modelCatalog'
import { REASONING_LEVELS } from '../../shared/modelVariants'

/**
 * What every hidden model choice reads from a provider snapshot: bots' model (`bots/model/candidates.ts`) and Automatic
 * thread naming (`orchestrator/TitleModelIndex.ts`). From what is known now; nothing here asks a provider.
 */

export type ModelCredential = 'subscription' | 'api_key' | 'ambient' | 'unknown'

/** Whether an instance is ready to run a turn now: enabled, signed in (or needing none) and running. */
export function instanceReady(snapshot: InstanceSnapshot): boolean {
  return snapshot.enabled.effective && (snapshot.auth.state === 'signed_in' || snapshot.auth.state === 'not_required') && snapshot.runs.state === 'yes'
}

/** How the instance pays for its requests: a subscription, an API key, the environment's, or unknown. */
export function credentialOf(snapshot: InstanceSnapshot): ModelCredential {
  // Codex runs only on a ChatGPT sign-in (never an API key) and sets no credential of its own.
  if (snapshot.driver === 'codex') return 'subscription'
  return snapshot.auth.credential ?? 'unknown'
}

/** The signed-in account's id (a salted hash), when the entry can tell it. */
export function accountOf(snapshot: InstanceSnapshot): string | undefined {
  const id = snapshot.auth.account?.id
  return id && id !== 'unknown' ? id : undefined
}

/**
 * A model's tier on an entry. Codex's `default` is the model Codex picks for the account: a standard one. Claude Code's
 * `default` stands for Opus or Sonnet by plan, so it stays `unknown` and its `sonnet` and `opus` entries are ranked
 * instead. `resolvedId` is the model an alias runs (`haiku` → `claude-haiku-5-5`), read before the alias itself.
 */
export function candidateTier(driver: string, model: string, catalog: ModelCatalog | undefined, resolvedId?: string): BotModelTier {
  if (driver === 'codex' && model === 'default') return 'standard'
  if (resolvedId && resolvedId !== model) {
    const resolved = botModelTier(resolvedId, catalog)
    if (resolved !== 'unknown') return resolved
  }
  return botModelTier(model, catalog)
}

/**
 * The level a naming request asks for. A Pi model runs with thinking off unless it cannot turn it off; Claude Code and
 * Codex at `low` when the model offers it; any other agent (Antigravity) at the model's own default.
 */
export function titleEffortFor(driver: string, model: InstanceModel): string | undefined {
  const efforts = model.capabilities.efforts
  if (driver === 'pi') {
    if (model.capabilities.thinkingOff !== false) return undefined
    if (efforts.includes('low')) return 'low'
    return [...REASONING_LEVELS].find((level) => level !== 'none' && efforts.includes(level)) ?? efforts.find((level) => level !== 'off' && level !== 'none')
  }
  if (driver === 'claude' || driver === 'codex') return efforts.includes('low') ? 'low' : undefined
  return undefined
}
