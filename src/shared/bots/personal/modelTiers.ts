import type { ModelCatalog, ModelCatalogEntry, ModelCatalogTier } from '../../modelCatalog'

/**
 * Model tiers for bots' hidden model choice (Bot Phase 1 §5.6). The catalog's `tier` always wins;
 * for models outside it (Pi's OpenAI, xAI and Gemini models, Claude Code's aliases) a short table of
 * id patterns gives one. A model neither knows is `unknown`, used only when nothing better exists.
 * Browser-safe.
 */

export type BotModelTier = ModelCatalogTier | 'unknown'

/**
 * Id patterns (`*` is any text), first match wins: small names first, since "mini" or "nano" in a
 * name outranks the family it belongs to, then frontier, then standard.
 */
const TIER_PATTERNS: ReadonlyArray<readonly [pattern: string, tier: ModelCatalogTier]> = [
  ['*haiku*', 'small'],
  ['gpt-*mini*', 'small'],
  ['gpt-*nano*', 'small'],
  ['o*-mini*', 'small'],
  ['grok-*mini*', 'small'],
  ['gemini-*flash-lite*', 'small'],
  ['gemma*', 'small'],
  ['*opus*', 'frontier'],
  ['*fable*', 'frontier'],
  ['gpt-*-pro*', 'frontier'],
  ['o*-pro*', 'frontier'],
  ['gemini-*-pro*', 'frontier'],
  ['grok-*heavy*', 'frontier'],
  ['*sonnet*', 'standard'],
  ['gpt-*', 'standard'],
  ['o3*', 'standard'],
  ['o4*', 'standard'],
  ['grok-4*', 'standard'],
  ['grok-3*', 'standard'],
  ['grok-code*', 'standard'],
  ['gemini-*flash*', 'standard']
]

const COMPILED = TIER_PATTERNS.map(([pattern, tier]) => [new RegExp(`^${pattern.split('*').map(escape).join('.*')}$`), tier] as const)

function escape(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * A model id as the tables read it: lower case, without a provider prefix (`openai/gpt-5`), Claude
 * Code's `[1m]` suffix or a `:variant` suffix.
 */
export function bareBotModelId(id: string): string {
  const last = id.trim().toLowerCase().split('/').pop() ?? ''
  return last.replace(/\[[^\]]*\]$/, '').replace(/:[^:]*$/, '')
}

/** The tier the pattern table gives an id, or undefined when no pattern matches. */
export function patternModelTier(id: string): ModelCatalogTier | undefined {
  const bare = bareBotModelId(id)
  return COMPILED.find(([pattern]) => pattern.test(bare))?.[1]
}

/** The catalog entry a model id names: its own id or one of its route ids. */
export function catalogEntryFor(modelId: string, catalog: ModelCatalog | undefined): ModelCatalogEntry | undefined {
  if (!catalog) return undefined
  const bare = bareBotModelId(modelId)
  return catalog.models.find((entry) => entry.id.toLowerCase() === bare || Object.values(entry.routes).some((route) => route?.id.toLowerCase() === bare))
}

/** A model's tier: the catalog's, else the pattern table's, else `unknown`. */
export function botModelTier(modelId: string, catalog?: ModelCatalog): BotModelTier {
  const entry = catalogEntryFor(modelId, catalog)
  return entry?.tier ?? patternModelTier(modelId) ?? 'unknown'
}
