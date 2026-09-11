import { randomUUID } from 'node:crypto'
import type { BrowserBounds, BrowserElement, BrowserPoint, BrowserViewport } from '../../shared/browser/types'
import type { CdpConnection } from '../cdp/connection'
import { boundText, sanitizeUrl } from '../util'
import { elementFingerprint } from './fingerprint'
import type { ObservedNode } from './ReferenceStore'

export const MAX_OBSERVATION_ELEMENTS = 1000
const MAX_ROLE = 64
const MAX_NAME = 240
const MAX_TEXT = 240
const CHAR_BUDGET = 12_000
const SKIP_ROLES = new Set(['none', 'presentation', 'InlineTextBox', 'generic'])
const SECRET_TYPES = new Set(['password'])

interface AxNode {
  nodeId: string
  ignored?: boolean
  role?: { value?: string }
  name?: { value?: string }
  description?: { value?: string }
  value?: { value?: string }
  backendDOMNodeId?: number
  childIds?: string[]
  properties?: Array<{ name?: string; value?: { value?: unknown } }>
  chromeRole?: { value?: string }
  frameId?: string
}

interface LayoutBox {
  bounds: BrowserBounds
  display?: string
  visibility?: string
  opacity?: number
  pointerEvents?: string
  tag?: string
  inputType?: string
  hiddenAttr?: boolean
}

export interface CollectedObservation {
  url: string
  title: string
  viewport: BrowserViewport
  documentId: string
  loaderId: string
  frameId: string
  documentFingerprint: string
  nodes: ObservedNode[]
  elements: Omit<BrowserElement, 'ref'>[]
  truncated: boolean
  continuation?: string
  warnings: string[]
}

function axString(value: { value?: string } | undefined): string {
  return typeof value?.value === 'string' ? value.value : ''
}

function axProperty(node: AxNode, name: string): unknown {
  return node.properties?.find((property) => property.name === name)?.value?.value
}

function intersectsViewport(bounds: BrowserBounds, viewport: BrowserViewport): boolean {
  return bounds.x < viewport.cssWidth && bounds.y < viewport.cssHeight && bounds.x + bounds.width > 0 && bounds.y + bounds.height > 0 && bounds.width > 0 && bounds.height > 0
}

function parseSnapshot(snapshot: Record<string, unknown>): Map<number, LayoutBox> {
  const out = new Map<number, LayoutBox>()
  const strings = Array.isArray(snapshot.strings) ? snapshot.strings as string[] : []
  const documents = Array.isArray(snapshot.documents) ? snapshot.documents as Array<Record<string, unknown>> : []
  for (const document of documents) {
    const nodes = (document.nodes ?? {}) as Record<string, unknown>
    const layout = (document.layout ?? {}) as Record<string, unknown>
    const backendNodeId = Array.isArray(nodes.backendNodeId) ? nodes.backendNodeId as number[] : []
    const nodeName = Array.isArray(nodes.nodeName) ? nodes.nodeName as number[] : []
    const attributes = Array.isArray(nodes.attributes) ? nodes.attributes as number[][] : []
    const layoutIndex = Array.isArray(layout.nodeIndex) ? layout.nodeIndex as number[] : []
    const bounds = Array.isArray(layout.bounds) ? layout.bounds as number[][] : []
    const styles = Array.isArray(layout.styles) ? layout.styles as number[][] : []
    const nodeByLayout = new Map<number, number>()
    layoutIndex.forEach((nodeIndex, i) => nodeByLayout.set(i, nodeIndex))
    const styleNames = ['visibility', 'display', 'opacity', 'pointer-events']
    for (let i = 0; i < bounds.length; i += 1) {
      const nodeIndex = layoutIndex[i]
      const id = backendNodeId[nodeIndex]
      const box = bounds[i]
      if (!id || !box || box.length < 4) continue
      const attr = attributes[nodeIndex] ?? []
      let inputType = ''
      let hiddenAttr = false
      for (let a = 0; a + 1 < attr.length; a += 2) {
        const key = strings[attr[a]]
        const value = strings[attr[a + 1]]
        if (key === 'type') inputType = value ?? ''
        if (key === 'hidden' || (key === 'aria-hidden' && value === 'true')) hiddenAttr = true
      }
      const styleIdx = styles[i] ?? []
      const style: Record<string, string> = {}
      styleIdx.forEach((stringIndex, offset) => {
        if (offset < styleNames.length) style[styleNames[offset]] = strings[stringIndex] ?? ''
      })
      out.set(id, {
        bounds: { x: box[0], y: box[1], width: box[2], height: box[3] },
        display: style.display,
        visibility: style.visibility,
        opacity: style.opacity ? Number(style.opacity) : undefined,
        pointerEvents: style['pointer-events'],
        tag: strings[nodeName[nodeIndex]] ?? '',
        inputType,
        hiddenAttr
      })
    }
  }
  return out
}

function toViewportBounds(bounds: BrowserBounds, viewport: BrowserViewport): BrowserBounds {
  return { x: bounds.x - viewport.scrollX, y: bounds.y - viewport.scrollY, width: bounds.width, height: bounds.height }
}

function translateBounds(bounds: BrowserBounds, offset?: BrowserPoint): BrowserBounds {
  return { ...bounds, x: bounds.x + (offset?.x ?? 0), y: bounds.y + (offset?.y ?? 0) }
}

export async function collectStructuredObservation(
  cdp: CdpConnection,
  cdpSessionId: string,
  options: { visibleOnly?: boolean; continuation?: string; maxElements?: number; viewportOffset?: BrowserPoint }
): Promise<CollectedObservation> {
  const warnings: string[] = []
  const visibleOnly = options.visibleOnly !== false
  await Promise.all([
    cdp.send('Page.enable', {}, { sessionId: cdpSessionId }),
    cdp.send('DOM.enable', {}, { sessionId: cdpSessionId }),
    cdp.send('Accessibility.enable', {}, { sessionId: cdpSessionId }),
    cdp.send('Runtime.enable', {}, { sessionId: cdpSessionId })
  ])
  const metrics = await cdp.send<Record<string, unknown>>('Page.getLayoutMetrics', {}, { sessionId: cdpSessionId })
  const cssLayout = (metrics.cssLayoutViewport ?? metrics.layoutViewport) as { clientWidth: number; clientHeight: number; pageX: number; pageY: number }
  const cssVisual = (metrics.cssVisualViewport ?? metrics.visualViewport) as { clientWidth?: number; clientHeight?: number; pageX?: number; pageY?: number; scale?: number; zoom?: number }
  let deviceScaleFactor = 1
  try {
    const dpr = await cdp.send<{ result?: { value?: number } }>('Runtime.evaluate', { expression: 'window.devicePixelRatio', returnByValue: true }, { sessionId: cdpSessionId })
    if (typeof dpr.result?.value === 'number' && dpr.result.value > 0) deviceScaleFactor = dpr.result.value
  } catch { /* keep 1 */ }
  const viewport: BrowserViewport = {
    cssWidth: cssLayout.clientWidth,
    cssHeight: cssLayout.clientHeight,
    deviceScaleFactor,
    scrollX: cssLayout.pageX,
    scrollY: cssLayout.pageY
  }
  void cssVisual
  const tree = await cdp.send<{ frameTree: { frame: { id: string; loaderId: string; url: string; urlFragment?: string; name?: string; parentId?: string }; childFrames?: unknown[] } }>('Page.getFrameTree', {}, { sessionId: cdpSessionId })
  const main = tree.frameTree.frame
  const childFrameCount = tree.frameTree.childFrames?.length ?? 0
  const ax = await cdp.send<{ nodes: AxNode[] }>('Accessibility.getFullAXTree', {}, { sessionId: cdpSessionId })
  let layout = new Map<number, LayoutBox>()
  try {
    await cdp.send('DOMSnapshot.enable', {}, { sessionId: cdpSessionId })
    const snapshot = await cdp.send<Record<string, unknown>>('DOMSnapshot.captureSnapshot', {
      computedStyles: ['visibility', 'display', 'opacity', 'pointer-events'],
      includePaintOrder: true,
      includeDOMRects: true
    }, { sessionId: cdpSessionId })
    layout = parseSnapshot(snapshot)
    await cdp.send('DOMSnapshot.disable', {}, { sessionId: cdpSessionId }).catch(() => undefined)
  } catch {
    warnings.push('layout-snapshot-unavailable')
  }
  const treeAfter = await cdp.send<{ frameTree: { frame: { id: string; loaderId: string; url: string } } }>('Page.getFrameTree', {}, { sessionId: cdpSessionId })
  if (treeAfter.frameTree.frame.loaderId !== main.loaderId) warnings.push('partial-navigation-during-observe')
  let title = ''
  try {
    const evaluated = await cdp.send<{ result: { value?: string } }>('Runtime.evaluate', {
      expression: 'document.title',
      returnByValue: true
    }, { sessionId: cdpSessionId })
    title = typeof evaluated.result?.value === 'string' ? evaluated.result.value : ''
  } catch {
    title = ''
  }
  const url = sanitizeUrl(main.url + (main.urlFragment ?? ''))
  const documentId = 'doc_' + randomUUID()
  const offset = options.continuation ? Number.parseInt(options.continuation, 10) || 0 : 0
  const maxElements = Math.min(MAX_OBSERVATION_ELEMENTS, Math.max(1, Math.floor(options.maxElements ?? MAX_OBSERVATION_ELEMENTS)))
  const nodes: ObservedNode[] = []
  const elements: Omit<BrowserElement, 'ref'>[] = []
  let used = 0
  let seen = 0
  let emitted = 0
  const counts = new Map<string, number>()
  const axById = new Map(ax.nodes.map((node) => [node.nodeId, node]))
  for (const node of ax.nodes) {
    const role = boundText(axString(node.role) || axString(node.chromeRole), MAX_ROLE)
    if (!node.backendDOMNodeId) continue
    if (node.ignored && SKIP_ROLES.has(role) && !axString(node.name) && !axString(node.value)) continue
    const name = boundText(axString(node.name), MAX_NAME)
    const box = layout.get(node.backendDOMNodeId)
    const isPassword = SECRET_TYPES.has((box?.inputType ?? '').toLowerCase()) || role === 'textbox' && /password/i.test(name)
    const hiddenProp = axProperty(node, 'hidden') === true || box?.hiddenAttr || box?.display === 'none' || box?.visibility === 'hidden' || box?.opacity === 0
    const disabled = axProperty(node, 'disabled') === true
    const readonly = axProperty(node, 'readonly') === true
    const focused = axProperty(node, 'focused') === true
    const modal = axProperty(node, 'modal') === true
    const checked = axProperty(node, 'checked')
    const localBounds = box ? toViewportBounds(box.bounds, viewport) : undefined
    if (visibleOnly && (hiddenProp || (localBounds && !intersectsViewport(localBounds, viewport)))) continue
    if (visibleOnly && !localBounds && !['dialog', 'alert', 'heading'].includes(role)) continue
    const bounds = localBounds ? translateBounds(localBounds, options.viewportOffset) : undefined
    seen += 1
    if (seen <= offset) continue
    const text = isPassword ? undefined : boundText(axString(node.value) || axString(node.description), MAX_TEXT)
    const states: string[] = []
    states.push(hiddenProp ? 'hidden' : 'visible')
    states.push(disabled ? 'disabled' : 'enabled')
    if (readonly) states.push('readonly')
    if (focused) states.push('focused')
    if (modal) states.push('overlay')
    if (checked === true || checked === 'true' || checked === 'mixed') states.push('checked')
    if (isPassword) states.push('secret')
    const key = `${role}:${name}`
    counts.set(key, (counts.get(key) ?? 0) + 1)
    const fingerprint = elementFingerprint({ role, name, tag: box?.tag, inputType: box?.inputType, nth: counts.get(key) })
    const frameRef = 'frame_' + (node.frameId || main.id)
    const raw: Omit<BrowserElement, 'ref'> = {
      frameRef,
      ...(role ? { role } : {}),
      ...(name ? { name } : {}),
      ...(text ? { text } : {}),
      ...(bounds ? { bounds } : {}),
      states
    }
    const cost = JSON.stringify(raw).length
    if (emitted >= maxElements || used + cost > CHAR_BUDGET) {
      return {
        url, title, viewport, documentId, loaderId: main.loaderId, frameId: main.id,
        documentFingerprint: `${main.id}|${main.loaderId}|${url}|${title}`,
        nodes, elements, truncated: true, continuation: String(offset + emitted), warnings: addFrameWarnings(warnings, childFrameCount, axById)
      }
    }
    used += cost
    emitted += 1
    nodes.push({
      backendNodeId: node.backendDOMNodeId,
      frameRef,
      cdpSessionId,
      fingerprint,
      frameId: node.frameId || main.id
    })
    elements.push(raw)
  }
  if (childFrameCount > 0 && ![...axById.values()].some((node) => node.frameId && node.frameId !== main.id)) {
    warnings.push('unsupported-oopif')
  }
  return {
    url, title, viewport, documentId, loaderId: main.loaderId, frameId: main.id,
    documentFingerprint: `${main.id}|${main.loaderId}|${url}|${title}`,
    nodes, elements, truncated: false, warnings: addFrameWarnings(warnings, childFrameCount, axById)
  }
}

function addFrameWarnings(warnings: string[], childFrameCount: number, axById: Map<string, AxNode>): string[] {
  if (childFrameCount > 0 && ![...axById.values()].some((node) => node.frameId && node.chromeRole?.value === 'Iframe')) {
    if (!warnings.includes('unsupported-oopif')) warnings.push('iframe-observation-limited')
  }
  return warnings
}
