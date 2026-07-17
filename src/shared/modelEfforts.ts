import type { ThinkingLevelMap } from '@earendil-works/pi-ai'
import { getSupportedThinkingLevels } from '@earendil-works/pi-ai/compat'

export interface ModelEffortSource {
  reasoning?: boolean
  thinkingLevelMap?: ThinkingLevelMap
}

export function getEffortLevelsFromThinkingMap(map?: ThinkingLevelMap): string[] {
  if (!map) return []

  // A map only declares exceptions: pi-ai considers the regular levels
  // supported unless one is explicitly mapped to null. Reading only its keys
  // hid intermediate ChatGPT and Claude subscription effort levels.
  return getSupportedThinkingLevels({ reasoning: true, thinkingLevelMap: map } as Parameters<
    typeof getSupportedThinkingLevels
  >[0]).filter((level) => level !== 'off')
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
