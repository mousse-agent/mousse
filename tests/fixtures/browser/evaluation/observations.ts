import type { BrowserElement, BrowserObservation, BrowserPoint, BrowserTarget } from '../../../../src/shared/browser/types'
import type { BrowserToolDispatcher } from '../../../../src/mms/browser/automation/BrowserToolDispatcher'
import type { BrowserToolContext, BrowserToolResult } from '../../../../src/shared/browser/automation'
import type { ElementQuery, ObservationMode } from './types'

export function observationFrom(result: BrowserToolResult): BrowserObservation {
  if (!result.ok || !result.value.observation) throw new Error(`missing observation: ${JSON.stringify(result)}`)
  return result.value.observation
}

export function findElement(observation: BrowserObservation, query: ElementQuery): BrowserElement {
  const matches = observation.elements.filter((element) => {
    if (query.ref && element.ref !== query.ref) return false
    const haystack = `${element.name ?? ''} ${element.text ?? ''}`
    if (query.name && !haystack.includes(query.name) && element.role !== query.name) return false
    if (query.text && !haystack.includes(query.text)) return false
    return true
  })
  const match = query.role
    ? matches.find((element) => element.role === query.role) ?? matches[0]
    : matches[0]
  if (!match) {
    throw new Error(`missing element ${JSON.stringify(query)}: ${observation.elements.map((el) => `${el.role}:${el.name}:${el.text}`).join(' | ')}`)
  }
  return match
}

export function elementImagePoint(observation: BrowserObservation, element: BrowserElement): BrowserPoint {
  const screenshot = observation.screenshot
  const bounds = element.bounds
  if (!screenshot || !bounds) throw new Error('screenshot targeting requires screenshot geometry and element bounds')
  const origin = screenshot.cropOriginCss ?? { x: 0, y: 0 }
  return {
    x: ((bounds.x + bounds.width / 2) - origin.x) * screenshot.cssToImageScaleX,
    y: ((bounds.y + bounds.height / 2) - origin.y) * screenshot.cssToImageScaleY
  }
}

export function targetFor(mode: ObservationMode, observation: BrowserObservation, query: ElementQuery): BrowserTarget {
  const element = findElement(observation, query)
  // Some hosts return a screenshot alongside an accessibility-only element
  // without layout boxes. Preserve the screenshot observation while using
  // the certified semantic ref when pixel geometry is unavailable.
  if (mode === 'screenshot' && observation.screenshot && element.bounds) return { kind: 'image-point', point: elementImagePoint(observation, element) }
  return { kind: 'ref', ref: element.ref }
}

export async function observe(
  tools: BrowserToolDispatcher,
  context: BrowserToolContext,
  sessionId: string,
  tabId: string | undefined,
  mode: ObservationMode
): Promise<{ observation: BrowserObservation; ms: number }> {
  const includeScreenshot = mode !== 'structured'
  const started = performance.now()
  const result = await tools.invoke('browser_observe', { sessionId, tabId, includeScreenshot }, context)
  return { observation: observationFrom(result), ms: performance.now() - started }
}

export function compactObservation(observation: BrowserObservation | undefined): Record<string, unknown> | undefined {
  if (!observation) return undefined
  return {
    observationId: observation.observationId,
    generation: observation.generation,
    url: observation.url,
    title: observation.title,
    tabCount: observation.tabs.length,
    elementCount: observation.elements.length,
    truncated: observation.truncated,
    warnings: observation.warnings,
    screenshot: observation.screenshot
      ? {
        artifactId: observation.screenshot.artifactId,
        pixelWidth: observation.screenshot.pixelWidth,
        pixelHeight: observation.screenshot.pixelHeight,
        bytesOmitted: true
      }
      : undefined,
    elements: observation.elements.slice(0, 24).map((element) => ({
      ref: element.ref,
      role: element.role,
      name: element.name,
      text: element.text,
      states: element.states
    }))
  }
}

export function haystack(observation: BrowserObservation | undefined): string {
  if (!observation) return ''
  return `${observation.title} ${observation.url} ${observation.elements.map((el) => `${el.name ?? ''} ${el.text ?? ''}`).join(' ')}`
}
