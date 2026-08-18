import type { LlmModelOption } from './settings'

export interface ParsedModelVariant {
  id: string
  label: string
  familyLabel: string
  context?: string
  effort?: string
  speed?: string
  alias?: string
  availableEfforts?: string[]
}

export interface ModelFamily {
  familyId: string
  familyLabel: string
  variants: ParsedModelVariant[]
  contexts: string[]
  efforts: string[]
  speeds: string[]
  hasSubOptions: boolean
  /** Inferred model brand (e.g. anthropic, openai) for sectioning multi-vendor catalogs. */
  brandId: string
  brandLabel: string
}

export interface ModelBrandSection {
  brandId: string
  brandLabel: string
  families: ModelFamily[]
}

export interface ModelFamilyGroup {
  providerId: string
  label: string
  families: ModelFamily[]
  /** Brand sections within this provider. Multi-brand catalogs get multiple entries. */
  brandSections: ModelBrandSection[]
}

export const EFFORT_LEVELS = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const
export const EFFORT_SUFFIXES = new Set(['off', ...EFFORT_LEVELS])
const SPEED_SUFFIXES = new Set(['fast', 'slow'])

export function parseThinkingSuffixFromModelId(modelId: string): {
  baseId: string
  effort?: string
} {
  const colonIdx = modelId.lastIndexOf(':')
  if (colonIdx === -1) return { baseId: modelId }

  const suffix = modelId.slice(colonIdx + 1)
  if (EFFORT_SUFFIXES.has(suffix)) {
    return { baseId: modelId.slice(0, colonIdx), effort: suffix }
  }
  if (SPEED_SUFFIXES.has(suffix)) {
    return { baseId: modelId.slice(0, colonIdx) }
  }

  return { baseId: modelId }
}

export function extractFamilyLabel(label: string): string {
  let text = label.trim()
  text = text.replace(/\s+\((fast|slow)\)\s*$/i, '')
  const parenIdx = text.indexOf(' (')
  if (parenIdx !== -1) {
    text = text.slice(0, parenIdx)
  }
  const atIdx = text.indexOf(' @ ')
  if (atIdx !== -1) {
    text = text.slice(0, atIdx)
  }
  return text.trim()
}

function parseAliasFromLabel(label: string): string | undefined {
  const match = /\(([^)]+)\)/.exec(label)
  if (!match) return undefined
  const value = match[1]?.trim()
  if (!value || SPEED_SUFFIXES.has(value.toLowerCase())) return undefined
  return value
}

function parseContextFromLabel(label: string): string | undefined {
  const normalized = label.replace(/\s+\((fast|slow)\)\s*$/i, '')
  const match = /\s@\s(.+)$/.exec(normalized)
  return match?.[1]?.trim()
}

function parseIdSuffixes(id: string): {
  baseId: string
  context?: string
  effort?: string
  speed?: string
} {
  let remaining = id
  let effort: string | undefined
  let speed: string | undefined

  const colonIdx = remaining.lastIndexOf(':')
  if (colonIdx !== -1) {
    const suffix = remaining.slice(colonIdx + 1)
    if (SPEED_SUFFIXES.has(suffix)) {
      speed = suffix
      remaining = remaining.slice(0, colonIdx)
    } else if (EFFORT_SUFFIXES.has(suffix)) {
      effort = suffix
      remaining = remaining.slice(0, colonIdx)
    }
  }

  const atIdx = remaining.indexOf('@')
  const baseId = atIdx === -1 ? remaining : remaining.slice(0, atIdx)
  const context = atIdx === -1 ? undefined : remaining.slice(atIdx + 1)

  return { baseId, context, effort, speed }
}

export function parseModelVariant(model: LlmModelOption): ParsedModelVariant {
  const parsedId = parseIdSuffixes(model.id)
  const familyLabel = extractFamilyLabel(model.label)
  const context = parseContextFromLabel(model.label) ?? parsedId.context
  const alias = parseAliasFromLabel(model.label)
  const speed =
    parsedId.speed ??
    (/\(fast\)/i.test(model.label) ? 'fast' : /\((slow)\)/i.test(model.label) ? 'slow' : undefined)

  return {
    id: model.id,
    label: model.label,
    familyLabel,
    context,
    effort: parsedId.effort,
    speed,
    alias,
    availableEfforts: model.efforts
  }
}

function uniqueSorted(values: Array<string | undefined>): string[] {
  return [...new Set(values.filter((value): value is string => Boolean(value)))].sort((a, b) =>
    a.localeCompare(b, undefined, { numeric: true })
  )
}

function uniqueEfforts(values: Array<string | undefined>): string[] {
  const order = new Map<string, number>(EFFORT_LEVELS.map((level, index) => [level, index]))
  return [...new Set(values.filter((value): value is string => Boolean(value)))]
    .filter((effort) => effort !== 'off')
    .sort((a, b) => (order.get(a) ?? Number.MAX_SAFE_INTEGER) - (order.get(b) ?? Number.MAX_SAFE_INTEGER) || a.localeCompare(b))
}

/** Preferred order for brand sections inside multi-vendor providers (e.g. Cursor). */
const BRAND_SECTION_ORDER = [
  'opencode',
  'opencode-go',
  'cursor',
  'anthropic',
  'openai',
  'google',
  'xai',
  'deepseek',
  'mistral',
  'meta',
  'moonshot',
  'zhipu',
  'cohere',
  'groq',
  'openrouter',
  'other'
]

const BRAND_LABELS: Record<string, string> = {
  opencode: 'OpenCode',
  'opencode-go': 'OpenCode Go',
  cursor: 'Cursor',
  anthropic: 'Anthropic',
  openai: 'OpenAI',
  google: 'Google',
  xai: 'xAI',
  deepseek: 'DeepSeek',
  mistral: 'Mistral',
  meta: 'Meta',
  moonshot: 'Moonshot',
  zhipu: 'Zhipu',
  cohere: 'Cohere',
  groq: 'Groq',
  openrouter: 'OpenRouter',
  other: 'Other'
}

/**
 * Infer the model brand for section headers. Used when a single API provider
 * (Cursor, OpenRouter, …) hosts models from many vendors.
 */
export function inferModelBrand(
  modelId: string,
  label?: string,
  fallbackProviderId = 'other'
): { brandId: string; brandLabel: string } {
  const haystack = `${modelId} ${label ?? ''}`.toLowerCase()

  // OpenCode Zen / OpenCode Go host a curated cross-vendor catalog; keep their
  // models grouped under the OpenCode brand instead of scattering into vendor monograms.
  if (fallbackProviderId === 'opencode' || fallbackProviderId === 'opencode-go') {
    return {
      brandId: fallbackProviderId,
      brandLabel: BRAND_LABELS[fallbackProviderId] ?? fallbackProviderId
    }
  }

  // OpenRouter-style `vendor/model` paths take precedence.
  const pathMatch = /(?:^|\/)(anthropic|openai|google|google-ai-studio|vertex|xai|deepseek|mistral|meta|meta-llama|cohere|groq|moonshot|zhipu)(?:\/|$)/i.exec(
    modelId
  )
  if (pathMatch) {
    const raw = pathMatch[1].toLowerCase()
    const brandId =
      raw === 'google-ai-studio' || raw === 'vertex'
        ? 'google'
        : raw === 'meta-llama'
          ? 'meta'
          : raw
    return { brandId, brandLabel: BRAND_LABELS[brandId] ?? brandId }
  }

  if (
    /\b(composer|cursor|cyber)\b/.test(haystack) ||
    /^(composer|cursor|cyber|default)([/_:-]|$)/.test(haystack)
  ) {
    return { brandId: 'cursor', brandLabel: BRAND_LABELS.cursor }
  }
  if (
    /\b(claude|anthropic|haiku|sonnet|opus|fable)\b/.test(haystack) ||
    /^(claude|anthropic|haiku|sonnet|opus|fable)([/_:-]|$)/.test(haystack)
  ) {
    return { brandId: 'anthropic', brandLabel: BRAND_LABELS.anthropic }
  }
  if (
    /\b(gpt|openai|chatgpt|o1|o3|o4)\b/.test(haystack) ||
    /^(gpt|o1|o3|o4|chatgpt)([/_:-]|$)/.test(haystack)
  ) {
    return { brandId: 'openai', brandLabel: BRAND_LABELS.openai }
  }
  if (/\b(gemini|google)\b/.test(haystack) || /^(gemini|google)([/_:-]|$)/.test(haystack)) {
    return { brandId: 'google', brandLabel: BRAND_LABELS.google }
  }
  if (/\b(grok|xai)\b/.test(haystack) || /^(grok|xai)([/_:-]|$)/.test(haystack)) {
    return { brandId: 'xai', brandLabel: BRAND_LABELS.xai }
  }
  if (/\bdeepseek\b/.test(haystack) || /^deepseek([/_:-]|$)/.test(haystack)) {
    return { brandId: 'deepseek', brandLabel: BRAND_LABELS.deepseek }
  }
  if (/\b(mistral|codestral|mixtral)\b/.test(haystack) || /^(mistral|codestral|mixtral)([/_:-]|$)/.test(haystack)) {
    return { brandId: 'mistral', brandLabel: BRAND_LABELS.mistral }
  }
  if (/\b(llama|meta)\b/.test(haystack) || /^(llama|meta)([/_:-]|$)/.test(haystack)) {
    return { brandId: 'meta', brandLabel: BRAND_LABELS.meta }
  }
  if (/\b(kimi|moonshot)\b/.test(haystack) || /^(kimi|moonshot)([/_:-]|$)/.test(haystack)) {
    return { brandId: 'moonshot', brandLabel: BRAND_LABELS.moonshot }
  }
  if (/\b(glm|zhipu)\b/.test(haystack) || /^(glm|zhipu)([/_:-]|$)/.test(haystack)) {
    return { brandId: 'zhipu', brandLabel: BRAND_LABELS.zhipu }
  }
  if (/\bcohere\b/.test(haystack) || /^command([/_:-]|$)/.test(haystack)) {
    return { brandId: 'cohere', brandLabel: BRAND_LABELS.cohere }
  }
  if (/\bgroq\b/.test(haystack)) {
    return { brandId: 'groq', brandLabel: BRAND_LABELS.groq }
  }

  const fallback = fallbackProviderId.toLowerCase()
  if (BRAND_LABELS[fallback]) {
    return { brandId: fallback, brandLabel: BRAND_LABELS[fallback] }
  }
  return {
    brandId: fallback || 'other',
    brandLabel: BRAND_LABELS[fallback] ?? (fallbackProviderId || BRAND_LABELS.other)
  }
}

function brandSectionSortKey(brandId: string): number {
  const index = BRAND_SECTION_ORDER.indexOf(brandId)
  return index === -1 ? BRAND_SECTION_ORDER.length : index
}

/**
 * Rough “how new is this model?” score from digits in the name.
 * "GPT 5.6" → 5 + 6/1000 = 5.006, "Opus 4.8" → 4.008, higher = newer.
 */
export function modelNewnessScore(text: string): number {
  const nums = [...text.matchAll(/\d+/g)].map((match) => Number(match[0]))
  if (nums.length === 0) return 0
  return nums.reduce((score, n, index) => score + n / 1000 ** index, 0)
}

/** Newest first by digit score (GPT 5.6 above GPT 5.5 / Opus 4.x). */
export function compareModelsNewestFirst(a: string, b: string): number {
  const byScore = modelNewnessScore(b) - modelNewnessScore(a)
  if (byScore !== 0) return byScore
  return b.localeCompare(a, undefined, { numeric: true, sensitivity: 'base' })
}

export function groupModelsByFamily(
  providerId: string,
  models: LlmModelOption[]
): ModelFamily[] {
  const byFamily = new Map<string, ParsedModelVariant[]>()

  for (const model of models) {
    const parsed = parseModelVariant(model)
    const bucket = byFamily.get(parsed.familyLabel) ?? []
    bucket.push(parsed)
    byFamily.set(parsed.familyLabel, bucket)
  }

  return [...byFamily.entries()]
    .map(([familyLabel, variants]) => {
      const contexts = uniqueSorted(variants.map((variant) => variant.context))
      const efforts = uniqueEfforts([
        ...variants.map((variant) => variant.effort),
        ...variants.flatMap((variant) => variant.availableEfforts ?? [])
      ])
      const speeds = uniqueSorted(variants.map((variant) => variant.speed))
      // Effort is selected via a separate chat control; only context/speed open the side panel.
      const hasSubOptions = contexts.length > 1 || speeds.length > 1

      // Brand from the first non-alias-looking variant id (prefer canonical ids).
      const brandSource =
        variants.find((variant) => !variant.alias) ?? variants[0]
      const brand = inferModelBrand(brandSource?.id ?? familyLabel, familyLabel, providerId)

      return {
        familyId: `${providerId}:${familyLabel}`,
        familyLabel,
        variants,
        contexts,
        efforts,
        speeds,
        hasSubOptions,
        brandId: brand.brandId,
        brandLabel: brand.brandLabel
      } satisfies ModelFamily
    })
    // Newest published/versioned models first (catalog order is often oldest-first).
    .sort((a, b) => {
      const aKey = `${a.familyLabel} ${a.variants[0]?.id ?? ''}`
      const bKey = `${b.familyLabel} ${b.variants[0]?.id ?? ''}`
      return compareModelsNewestFirst(aKey, bKey)
    })
}

export function groupFamiliesByBrand(families: ModelFamily[]): ModelBrandSection[] {
  const byBrand = new Map<string, ModelBrandSection>()

  for (const family of families) {
    const existing = byBrand.get(family.brandId)
    if (existing) {
      existing.families.push(family)
    } else {
      byBrand.set(family.brandId, {
        brandId: family.brandId,
        brandLabel: family.brandLabel,
        families: [family]
      })
    }
  }

  return [...byBrand.values()].sort((a, b) => {
    const order = brandSectionSortKey(a.brandId) - brandSectionSortKey(b.brandId)
    if (order !== 0) return order
    return a.brandLabel.localeCompare(b.brandLabel)
  })
}

export function groupProviderModels(
  providerId: string,
  label: string,
  models: LlmModelOption[]
): ModelFamilyGroup {
  const families = groupModelsByFamily(providerId, models)
  return {
    providerId,
    label,
    families,
    brandSections: groupFamiliesByBrand(families)
  }
}

export function findModelFamily(
  providerId: string,
  models: LlmModelOption[],
  modelId: string
): ModelFamily | undefined {
  const { baseId } = parseThinkingSuffixFromModelId(modelId)
  const parsed =
    models.find((model) => model.id === modelId) ?? models.find((model) => model.id === baseId)
  if (!parsed) {
    // Fall back to family match via variant ids that already include effort suffixes.
    return groupModelsByFamily(providerId, models).find(
      (family) =>
        family.variants.some((variant) => variant.id === modelId) ||
        family.variants.some((variant) => variant.id === baseId)
    )
  }
  const familyLabel = extractFamilyLabel(parsed.label)
  return groupModelsByFamily(providerId, models).find((family) => family.familyLabel === familyLabel)
}

function withEffortSuffix(variant: ParsedModelVariant, effort: string): ParsedModelVariant {
  if (variant.effort === effort) return variant
  return {
    ...variant,
    id: `${variant.id}:${effort}`,
    effort
  }
}

export function resolveModelVariant(
  family: ModelFamily,
  options: { context?: string; effort?: string; speed?: string } = {}
): ParsedModelVariant | undefined {
  const { context, effort, speed } = options

  const exact = family.variants.find(
    (variant) =>
      (context === undefined || variant.context === context) &&
      (effort === undefined || variant.effort === effort) &&
      (speed === undefined || variant.speed === speed)
  )
  if (exact) return exact

  const ranked = family.variants
    .map((variant) => {
      let score = 0
      if (context !== undefined) score += variant.context === context ? 4 : -4
      if (effort !== undefined) score += variant.effort === effort ? 3 : variant.effort ? -2 : 1
      if (speed !== undefined) score += variant.speed === speed ? 2 : variant.speed ? -1 : 1
      if (!variant.alias) score += 1
      return { variant, score }
    })
    .sort((a, b) => b.score - a.score)

  const best = ranked[0]?.variant
  if (!best) return undefined

  if (effort !== undefined && family.efforts.includes(effort)) {
    return withEffortSuffix(best, effort)
  }

  return best
}

export function getModelDisplayLabel(
  providerId: string,
  modelId: string,
  models: LlmModelOption[],
  providerLabel?: string
): string {
  const model = models.find((entry) => entry.id === modelId)
  if (!model) return modelId || providerLabel || 'Select model'
  return model.label
}

export function getFamilyDisplayLabel(
  providerId: string,
  modelId: string,
  models: LlmModelOption[]
): string {
  const model = models.find((entry) => entry.id === modelId)
  if (!model) return 'Select model'
  return extractFamilyLabel(model.label)
}

/** Strip an existing effort suffix and optionally re-apply a new one. */
export function applyEffortToModelId(modelId: string, effort?: string): string {
  const { baseId } = parseThinkingSuffixFromModelId(modelId)
  if (!effort || effort === 'off') return baseId
  return `${baseId}:${effort}`
}

export function formatEffortLabel(effort: string): string {
  if (!effort) return effort
  if (effort === 'xhigh') return 'XHigh'
  return effort.charAt(0).toUpperCase() + effort.slice(1)
}

/**
 * Resolve available effort levels for the currently selected model/family.
 */
export function getEffortsForModel(
  providerId: string,
  modelId: string,
  models: LlmModelOption[]
): string[] {
  if (!providerId || !modelId || models.length === 0) return []
  const family = findModelFamily(providerId, models, modelId)
  if (family?.efforts.length) return family.efforts

  const { baseId, effort } = parseThinkingSuffixFromModelId(modelId)
  const model =
    models.find((entry) => entry.id === modelId) ?? models.find((entry) => entry.id === baseId)
  if (!model) return effort ? [effort] : []

  const fromMeta = uniqueEfforts([...(model.efforts ?? []), effort])
  return fromMeta
}

export function getCurrentEffort(
  modelId: string,
  models: LlmModelOption[],
  providerId?: string
): string | undefined {
  const { baseId, effort: effortFromId } = parseThinkingSuffixFromModelId(modelId)
  if (effortFromId) return effortFromId

  if (providerId) {
    const family = findModelFamily(providerId, models, modelId)
    if (family?.efforts[0]) return family.efforts[0]
  }

  const model =
    models.find((entry) => entry.id === modelId) ?? models.find((entry) => entry.id === baseId)
  if (!model) return undefined
  const parsed = parseModelVariant(model)
  return parsed.effort ?? model.efforts?.[0]
}
