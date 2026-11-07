import type { BotDepth, BotModelChoice } from '../../../shared/bots/personal/definition'
import type { BotModelTier } from '../../../shared/bots/personal/modelTiers'
import { bareBotModelId } from '../../../shared/bots/personal/modelTiers'
import type { ProviderSelection } from '../../../shared/harness/types'
import { REASONING_LEVELS } from '../../../shared/modelVariants'
import type { BotModelProblem } from '../seams'

/**
 * A bot's hidden model choice (Bot Phase 1 §5.6). Pure: the candidates are the ready instances
 * whose runtime can hold the bot (`candidates.ts`), each with one of its models. Nothing here ever
 * reaches the UI; a problem becomes a `BotError` in plain words.
 */

export interface BotModelCandidate {
  instanceId: string
  model: string
  /** Efforts the model accepts, as the instance lists them; empty: no effort control. */
  efforts: string[]
  defaultEffort?: string
  tier: BotModelTier
  credential: 'subscription' | 'api_key' | 'ambient' | 'unknown'
  /** `YYYY-MM-DD`, from the catalog. */
  released?: string
  /** ISO time until which the instance is at its usage limit. */
  limitedUntil?: string
  /**
   * Other words that name this model, for `named` choices: the catalog id and route ids, its full
   * and short names and its family ("opus"). Lower case.
   */
  names?: string[]
}

export type BotModelChoiceResult =
  | { selection: ProviderSelection }
  | { problem: BotModelProblem; until?: string; instanceId?: string }

/**
 * The tiers each depth tries, best first. "Maybe not Haiku": small is used for `quick` only when
 * no standard model exists, and for the others only when nothing else does. Unknown tiers come last.
 */
const TIER_ORDER: Record<BotDepth, readonly BotModelTier[]> = {
  quick: ['standard', 'small', 'frontier', 'unknown'],
  normal: ['standard', 'frontier', 'small', 'unknown'],
  deep: ['frontier', 'standard', 'small', 'unknown']
}

const LEVEL = new Map<string, number>(REASONING_LEVELS.map((level, index) => [level, index]))
const byLevel = (efforts: readonly string[]) =>
  [...efforts].filter((effort) => effort !== 'none' && effort !== 'off').sort((a, b) => (LEVEL.get(a) ?? 99) - (LEVEL.get(b) ?? 99))

/**
 * The effort a depth runs at: `quick` low (else the lowest offered), `deep` high (else the
 * highest offered), `normal` the model's default. Absent: the model's own default.
 */
export function effortFor(depth: BotDepth, candidate: Pick<BotModelCandidate, 'efforts' | 'defaultEffort'>): string | undefined {
  const efforts = byLevel(candidate.efforts)
  if (!efforts.length) return undefined
  if (depth === 'quick') return efforts.includes('low') ? 'low' : efforts[0]
  if (depth === 'deep') return efforts.includes('high') ? 'high' : efforts[efforts.length - 1]
  return candidate.defaultEffort && candidate.efforts.includes(candidate.defaultEffort) ? candidate.defaultEffort : undefined
}

/** Subscriptions first, then newer releases, then a stable id order. */
function compareCandidates(a: BotModelCandidate, b: BotModelCandidate): number {
  const subscription = Number(b.credential === 'subscription') - Number(a.credential === 'subscription')
  if (subscription) return subscription
  const released = (b.released ?? '').localeCompare(a.released ?? '')
  if (released) return released
  return a.instanceId.localeCompare(b.instanceId) || a.model.localeCompare(b.model)
}

/** Lower case, spaces and dots as dashes: "Opus 4.6" → "opus-4-6". */
function normalName(text: string): string {
  return text.trim().toLowerCase().replace(/[\s._]+/g, '-')
}

/**
 * How well `wanted` (as the owner said it) names a candidate: 2 exactly (an id or a name), 1 by a
 * family word or id prefix ("opus", "grok", "gpt-5"), 0 not at all.
 */
export function nameMatch(wanted: string, candidate: Pick<BotModelCandidate, 'model' | 'names'>): 0 | 1 | 2 {
  const want = normalName(wanted)
  if (!want) return 0
  const bare = bareBotModelId(candidate.model)
  const names = [bare, ...(candidate.names ?? [])].map(normalName)
  if (names.includes(want)) return 2
  const words = new Set(names.flatMap((name) => name.split('-')))
  if (words.has(want)) return 1
  if (names.some((name) => name.startsWith(`${want}-`) || name.endsWith(`-${want}`))) return 1
  return 0
}

const selectionOf = (candidate: BotModelCandidate, depth: BotDepth): { selection: ProviderSelection } => {
  const effort = effortFor(depth, candidate)
  return { selection: { instanceId: candidate.instanceId, model: candidate.model, ...(effort ? { effort } : {}) } }
}

const limitedNow = (candidate: BotModelCandidate, now: Date) => candidate.limitedUntil !== undefined && Date.parse(candidate.limitedUntil) > now.getTime()

/** The earliest time a limited candidate frees up, with its instance. */
function earliestReset(limited: readonly BotModelCandidate[]): { until?: string; instanceId?: string } {
  const first = [...limited].sort((a, b) => Date.parse(a.limitedUntil!) - Date.parse(b.limitedUntil!))[0]
  return first ? { until: first.limitedUntil, instanceId: first.instanceId } : {}
}

/**
 * Picks a model. `auto`: the best tier for the depth, then subscriptions, newer releases and a
 * stable order. `named`: the candidates the owner's words name (exact names before family words),
 * ranked the same way; none: `named_unavailable`. Candidates at their usage limit are left out;
 * when that leaves none, `all_limited` with the earliest reset.
 */
export function chooseBotModel(choice: BotModelChoice, candidates: readonly BotModelCandidate[], now: Date): BotModelChoiceResult {
  let pool = [...candidates]
  if (choice.mode === 'named') {
    const scored = pool.map((candidate) => ({ candidate, score: nameMatch(choice.model, candidate) })).filter((entry) => entry.score > 0)
    if (!scored.length) return { problem: 'named_unavailable' }
    const best = Math.max(...scored.map((entry) => entry.score))
    pool = scored.filter((entry) => entry.score === best).map((entry) => entry.candidate)
  }
  if (!pool.length) return { problem: 'no_provider' }
  const ready = pool.filter((candidate) => !limitedNow(candidate, now))
  if (!ready.length) return { problem: 'all_limited', ...earliestReset(pool) }
  if (choice.mode === 'named') return selectionOf(ready.sort(compareCandidates)[0]!, choice.depth)
  for (const tier of TIER_ORDER[choice.depth]) {
    const inTier = ready.filter((candidate) => candidate.tier === tier)
    if (inTier.length) return selectionOf(inTier.sort(compareCandidates)[0]!, choice.depth)
  }
  return { problem: 'no_provider' }
}
