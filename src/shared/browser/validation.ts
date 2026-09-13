import type { BrowserAction, BrowserActionRequest, BrowserTarget, BrowserWaitCondition } from './types'

function object(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) throw new Error('invalid_action: expected object')
  for (const key of Object.keys(value)) if (!keys.includes(key) || ['__proto__', 'prototype', 'constructor'].includes(key)) throw new Error('invalid_action: unexpected field ' + key)
  return value as Record<string, unknown>
}
function string(value: unknown, max: number, empty = false): string {
  if (typeof value !== 'string' || value.length > max || (!empty && !value.trim())) throw new Error('invalid_action: invalid string')
  return value
}
function number(value: unknown, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) throw new Error('invalid_action: invalid number')
  return value
}
function boolean(value: unknown): boolean {
  if (typeof value !== 'boolean') throw new Error('invalid_action: expected boolean')
  return value
}
function id(value: unknown): string {
  const result = string(value, 160)
  if (!/^[a-zA-Z0-9:_-]+$/.test(result)) throw new Error('invalid_action: invalid identifier')
  return result
}
function strings(value: unknown, maxItems: number, maxLength: number): string[] {
  if (!Array.isArray(value) || value.length > maxItems) throw new Error('invalid_action: invalid array')
  return value.map((item) => string(item, maxLength, true))
}

export function browserNavigationUrl(value: unknown): string {
  const text = string(value, 8192)
  const url = new URL(text)
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('invalid_action: URL must use HTTP(S) without embedded credentials')
  return url.href
}

function target(value: unknown): BrowserTarget {
  const p = object(value, ['kind', 'ref', 'point'])
  if (p.kind === 'ref') { object(p, ['kind', 'ref']); return { kind: 'ref', ref: id(p.ref) } }
  if (p.kind === 'image-point') {
    object(p, ['kind', 'point'])
    const point = object(p.point, ['x', 'y'])
    return { kind: 'image-point', point: { x: number(point.x, 0, 100_000), y: number(point.y, 0, 100_000) } }
  }
  throw new Error('invalid_action: target must be {"kind":"ref","ref":"el_..."} using an element ref from the latest observation, or a vision-enabled {"kind":"image-point","point":{"x":0,"y":0}}')
}

export function validateBrowserAction(value: unknown): BrowserAction {
  if (!value || typeof value !== 'object') throw new Error('invalid_action: expected action')
  const type = (value as Record<string, unknown>).type
  switch (type) {
    case 'navigate': { const p = object(value, ['type', 'url']); return { type, url: browserNavigationUrl(p.url) } }
    case 'back': case 'forward': case 'reload': object(value, ['type']); return { type }
    case 'click': case 'double-click': case 'hover': {
      const p = object(value, ['type', 'target', 'button'])
      if (p.button !== undefined && !['left', 'right', 'middle'].includes(p.button as string)) throw new Error('invalid_action: unsupported button')
      return { type, target: target(p.target), ...(p.button === undefined ? {} : { button: p.button as 'left' | 'right' | 'middle' }) }
    }
    case 'fill': case 'type': { const p = object(value, ['type', 'target', 'text']); return { type, target: target(p.target), text: string(p.text, 64_000, true) } }
    case 'key': {
      const p = object(value, ['type', 'key', 'target'])
      return { type, key: string(p.key, 64), ...(p.target === undefined ? {} : { target: target(p.target) }) }
    }
    case 'select': { const p = object(value, ['type', 'target', 'values']); return { type, target: target(p.target), values: strings(p.values, 100, 4096) } }
    case 'check': { const p = object(value, ['type', 'target', 'checked']); return { type, target: target(p.target), checked: boolean(p.checked) } }
    case 'scroll': {
      const p = object(value, ['type', 'target', 'deltaX', 'deltaY'])
      return { type, deltaX: number(p.deltaX, -100_000, 100_000), deltaY: number(p.deltaY, -100_000, 100_000), ...(p.target === undefined ? {} : { target: target(p.target) }) }
    }
    case 'drag': { const p = object(value, ['type', 'from', 'to']); return { type, from: target(p.from), to: target(p.to) } }
    case 'upload': {
      const p = object(value, ['type', 'target', 'artifactIds', 'resolvedArtifacts'])
      const artifactIds = strings(p.artifactIds, 16, 160).map(id)
      if (!artifactIds.length) throw new Error('invalid_action: no upload artifacts')
      const resolvedArtifacts = p.resolvedArtifacts === undefined ? undefined : (() => {
        if (!Array.isArray(p.resolvedArtifacts) || p.resolvedArtifacts.length !== artifactIds.length) throw new Error('invalid_action: invalid resolved artifacts')
        return p.resolvedArtifacts.map((value) => {
          const item = object(value, ['artifactId', 'path', 'byteLength', 'displayName', 'mediaType'])
          return { artifactId: id(item.artifactId), path: string(item.path, 4096), byteLength: number(item.byteLength, 0, 100 * 1024 * 1024), displayName: string(item.displayName, 255), ...(item.mediaType === undefined ? {} : { mediaType: string(item.mediaType, 128) }) }
        })
      })()
      return { type, target: target(p.target), artifactIds, ...(resolvedArtifacts ? { resolvedArtifacts } : {}) }
    }
    case 'dialog': { const p = object(value, ['type', 'accept', 'promptText']); return { type, accept: boolean(p.accept), ...(p.promptText === undefined ? {} : { promptText: string(p.promptText, 4096, true) }) } }
    default: throw new Error('invalid_action: unsupported action')
  }
}

export function validateBrowserWait(value: unknown): BrowserWaitCondition {
  if (!value || typeof value !== 'object') throw new Error('invalid_action: expected wait condition')
  const type = (value as Record<string, unknown>).type
  switch (type) {
    case 'url': {
      const p = object(value, ['type', 'equals', 'includes'])
      if ((p.equals === undefined) === (p.includes === undefined)) throw new Error('invalid_action: choose one URL condition')
      return p.equals === undefined ? { type, includes: string(p.includes, 8192) } : { type, equals: browserNavigationUrl(p.equals) }
    }
    case 'text': { const p = object(value, ['type', 'text', 'present']); return { type, text: string(p.text, 8192), present: boolean(p.present) } }
    case 'element': {
      const p = object(value, ['type', 'ref', 'state'])
      if (!['visible', 'hidden', 'enabled', 'disabled'].includes(p.state as string)) throw new Error('invalid_action: unsupported element state')
      return { type, ref: id(p.ref), state: p.state as 'visible' | 'hidden' | 'enabled' | 'disabled' }
    }
    case 'document-ready': object(value, ['type']); return { type }
    default: throw new Error('invalid_action: unsupported wait')
  }
}

export function validateBrowserActionRequest(value: unknown): BrowserActionRequest {
  const p = object(value, ['requestId', 'sessionId', 'tabId', 'generation', 'observationId', 'controlLeaseId', 'action', 'timeoutMs', 'expected'])
  const generation = number(p.generation, 1, Number.MAX_SAFE_INTEGER)
  if (!Number.isSafeInteger(generation)) throw new Error('invalid_action: invalid generation')
  return {
    requestId: id(p.requestId), sessionId: id(p.sessionId), tabId: id(p.tabId), generation,
    observationId: id(p.observationId), controlLeaseId: id(p.controlLeaseId), action: validateBrowserAction(p.action),
    timeoutMs: number(p.timeoutMs, 1, 120_000), ...(p.expected === undefined ? {} : { expected: validateBrowserWait(p.expected) })
  }
}
