import type { ThinkingLevelMap } from '@earendil-works/pi-ai'
import { getSupportedThinkingLevels } from '@earendil-works/pi-ai/compat'

const EFFORT_LEVEL_ORDER = ['minimal', 'low', 'medium', 'high', 'xhigh'] as const

export interface ModelEffortSource {
  reasoning?: boolean
  thinkingLevelMap?: ThinkingLevelMap
}

export function getEffortLevelsFromThinkingMap(map?: ThinkingLevelMap): string[] {
  if (!map) return []

  const levels: string[] = []
  for (const level of EFFORT_LEVEL_ORDER) {
    const mapped = map[level]
    if (mapped === null || mapped === undefined) continue
    levels.push(level)
  }
  return levels
}

export function getModelEffortLevels(model: ModelEffortSource): string[] | undefined {
  const fromMap = getEffortLevelsFromThinkingMap(model.thinkingLevelMap)
  if (fromMap.length > 0) return fromMap

  if (model.reasoning || model.thinkingLevelMap) {
    const supported = getSupportedThinkingLevels(model as Parameters<typeof getSupportedThinkingLevels>[0])
      .filter((level) => level !== 'off')
    if (supported.length > 0) return supported
  }

  return undefined
}
