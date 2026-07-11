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
}

export interface ModelFamilyGroup {
  providerId: string
  families: ModelFamily[]
}

export const EFFORT_SUFFIXES = new Set(['off', 'minimal', 'low', 'medium', 'high', 'xhigh'])
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
      const efforts = uniqueSorted([
        ...variants.map((variant) => variant.effort),
        ...variants.flatMap((variant) => variant.availableEfforts ?? [])
      ]).filter((effort) => effort !== 'off')
      const speeds = uniqueSorted(variants.map((variant) => variant.speed))
      const hasSubOptions =
        variants.length > 1 ||
        contexts.length > 1 ||
        speeds.length > 1 ||
        efforts.length > 1 ||
        (efforts.length > 0 && (contexts.length > 0 || speeds.length > 0))

      return {
        familyId: `${providerId}:${familyLabel}`,
        familyLabel,
        variants,
        contexts,
        efforts,
        speeds,
        hasSubOptions
      } satisfies ModelFamily
    })
    .sort((a, b) => a.familyLabel.localeCompare(b.familyLabel))
}

export function groupProviderModels(
  providerId: string,
  label: string,
  models: LlmModelOption[]
): ModelFamilyGroup {
  return {
    providerId,
    families: groupModelsByFamily(providerId, models)
  }
}

export function findModelFamily(
  providerId: string,
  models: LlmModelOption[],
  modelId: string
): ModelFamily | undefined {
  const parsed = models.find((model) => model.id === modelId)
  if (!parsed) return undefined
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
