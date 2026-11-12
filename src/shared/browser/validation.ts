import { knownAppError } from '../errors'
import { MAX_BROWSER_PASTE_CHARS, type BrowserAction, type BrowserActionRequest, type BrowserHumanInput, type BrowserTarget, type BrowserWaitCondition } from './types'

function object(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) throw invalidAction('invalid_action: expected object')
  for (const key of Object.keys(value)) if (!keys.includes(key) || ['__proto__', 'prototype', 'constructor'].includes(key)) throw invalidAction('invalid_action: unexpected field')
  return value as Record<string, unknown>
}
function string(value: unknown, max: number, empty = false): string {
  if (typeof value !== 'string' || value.length > max || (!empty && !value.trim())) throw invalidAction('invalid_action: invalid string')
  return value
}
function number(value: unknown, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) throw invalidAction('invalid_action: invalid number')
  return value
}
function boolean(value: unknown): boolean {
  if (typeof value !== 'boolean') throw invalidAction('invalid_action: expected boolean')
  return value
}
function id(value: unknown): string {
  const result = string(value, 160)
  if (!/^[a-zA-Z0-9:_-]+$/.test(result)) throw invalidAction('invalid_action: invalid identifier')
  return result
}
function strings(value: unknown, maxItems: number, maxLength: number): string[] {
  if (!Array.isArray(value) || value.length > maxItems) throw invalidAction('invalid_action: invalid array')
  return value.map((item) => string(item, maxLength, true))
}

export function browserNavigationUrl(value: unknown): string {
  const text = string(value, 8192)
  let url: URL
  try { url = new URL(text) } catch { throw invalidAction('invalid_action: URL must be a valid HTTP(S) URL') }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw invalidAction('invalid_action: URL must use HTTP(S) without embedded credentials')
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
  throw invalidAction('invalid_action: target must be {"kind":"ref","ref":"el_..."} using an element ref from the latest observation, or a vision-enabled {"kind":"image-point","point":{"x":0,"y":0}}')
}

export function validateBrowserAction(value: unknown): BrowserAction {
  if (!value || typeof value !== 'object') throw invalidAction('invalid_action: expected action')
  const type = (value as Record<string, unknown>).type
  switch (type) {
    case 'navigate': { const p = object(value, ['type', 'url']); return { type, url: browserNavigationUrl(p.url) } }
    case 'back': case 'forward': case 'reload': object(value, ['type']); return { type }
    case 'click': case 'double-click': case 'hover': {
      const p = object(value, ['type', 'target', 'button'])
      if (p.button !== undefined && !['left', 'right', 'middle'].includes(p.button as string)) throw invalidAction('invalid_action: unsupported button')
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
      if (!artifactIds.length) throw invalidAction('invalid_action: no upload artifacts')
      const resolvedArtifacts = p.resolvedArtifacts === undefined ? undefined : (() => {
        if (!Array.isArray(p.resolvedArtifacts) || p.resolvedArtifacts.length !== artifactIds.length) throw invalidAction('invalid_action: invalid resolved artifacts')
        return p.resolvedArtifacts.map((value) => {
          const item = object(value, ['artifactId', 'path', 'byteLength', 'displayName', 'mediaType'])
          return { artifactId: id(item.artifactId), path: string(item.path, 4096), byteLength: number(item.byteLength, 0, 100 * 1024 * 1024), displayName: string(item.displayName, 255), ...(item.mediaType === undefined ? {} : { mediaType: string(item.mediaType, 128) }) }
        })
      })()
      return { type, target: target(p.target), artifactIds, ...(resolvedArtifacts ? { resolvedArtifacts } : {}) }
    }
    case 'dialog': { const p = object(value, ['type', 'accept', 'promptText']); return { type, accept: boolean(p.accept), ...(p.promptText === undefined ? {} : { promptText: string(p.promptText, 4096, true) }) } }
    default: throw invalidAction('invalid_action: unsupported action')
  }
}

export function validateBrowserWait(value: unknown): BrowserWaitCondition {
  if (!value || typeof value !== 'object') throw invalidAction('invalid_action: expected wait condition')
  const type = (value as Record<string, unknown>).type
  switch (type) {
    case 'url': {
      const p = object(value, ['type', 'equals', 'includes'])
      if ((p.equals === undefined) === (p.includes === undefined)) throw invalidAction('invalid_action: choose one URL condition')
      return p.equals === undefined ? { type, includes: string(p.includes, 8192) } : { type, equals: browserNavigationUrl(p.equals) }
    }
    case 'text': { const p = object(value, ['type', 'text', 'present']); return { type, text: string(p.text, 8192), present: boolean(p.present) } }
    case 'element': {
      const p = object(value, ['type', 'ref', 'state'])
      if (!['visible', 'hidden', 'enabled', 'disabled'].includes(p.state as string)) throw invalidAction('invalid_action: unsupported element state')
      return { type, ref: id(p.ref), state: p.state as 'visible' | 'hidden' | 'enabled' | 'disabled' }
    }
    case 'document-ready': object(value, ['type']); return { type }
    default: throw invalidAction('invalid_action: unsupported wait')
  }
}

export function validateBrowserActionRequest(value: unknown): BrowserActionRequest {
  const p = object(value, ['requestId', 'sessionId', 'tabId', 'generation', 'observationId', 'controlLeaseId', 'action', 'timeoutMs', 'expected'])
  const generation = number(p.generation, 1, Number.MAX_SAFE_INTEGER)
  if (!Number.isSafeInteger(generation)) throw invalidAction('invalid_action: invalid generation')
  return {
    requestId: id(p.requestId), sessionId: id(p.sessionId), tabId: id(p.tabId), generation,
    observationId: id(p.observationId), controlLeaseId: id(p.controlLeaseId), action: validateBrowserAction(p.action),
    timeoutMs: number(p.timeoutMs, 1, 120_000), ...(p.expected === undefined ? {} : { expected: validateBrowserWait(p.expected) })
  }
}

/** A person's input to a managed tab (`BrowserHumanInput`), checked like an action. */
const MOUSE_BUTTONS = ['left', 'middle', 'right'] as const
const EDIT_COMMANDS = ['selectAll', 'copy', 'cut', 'undo', 'redo'] as const

function modifiers(value: unknown): number {
  const result = number(value, 0, 15)
  if (!Number.isInteger(result)) throw invalidAction('invalid_action: invalid modifiers')
  return result
}

export function validateBrowserHumanInput(value: unknown): BrowserHumanInput {
  if (!value || typeof value !== 'object') throw invalidAction('invalid_action: expected input')
  const kind = (value as Record<string, unknown>).kind
  switch (kind) {
    case 'click': { const p = object(value, ['kind', 'x', 'y']); return { kind, x: number(p.x, 0, 100_000), y: number(p.y, 0, 100_000) } }
    case 'scroll': {
      const p = object(value, ['kind', 'x', 'y', 'deltaX', 'deltaY', 'modifiers'])
      return { kind, x: number(p.x, 0, 100_000), y: number(p.y, 0, 100_000), deltaX: number(p.deltaX, -100_000, 100_000), deltaY: number(p.deltaY, -100_000, 100_000), ...(p.modifiers === undefined ? {} : { modifiers: modifiers(p.modifiers) }) }
    }
    case 'type': {
      // Committed text may be a space alone.
      const p = object(value, ['kind', 'text'])
      const text = string(p.text, 8192, true)
      if (!text) throw invalidAction('invalid_action: invalid string')
      return { kind, text }
    }
    case 'key': { const p = object(value, ['kind', 'key']); return { kind, key: string(p.key, 64) } }
    case 'pointer': {
      const p = object(value, ['kind', 'type', 'x', 'y', 'button', 'buttons', 'clicks', 'modifiers'])
      if (p.type !== 'down' && p.type !== 'up' && p.type !== 'move') throw invalidAction('invalid_action: unsupported pointer event')
      const button = p.button === 'none' ? 'none' : MOUSE_BUTTONS.find((entry) => entry === p.button)
      if (!button || (p.type !== 'move' && button === 'none')) throw invalidAction('invalid_action: unsupported button')
      const buttons = number(p.buttons, 0, 7)
      return {
        kind, type: p.type, x: number(p.x, 0, 100_000), y: number(p.y, 0, 100_000), button, buttons: Math.floor(buttons),
        ...(p.clicks === undefined ? {} : { clicks: Math.floor(number(p.clicks, 1, 3)) }),
        ...(p.modifiers === undefined ? {} : { modifiers: modifiers(p.modifiers) })
      }
    }
    case 'keys': {
      const p = object(value, ['kind', 'type', 'key', 'code', 'keyCode', 'modifiers', 'text', 'repeat', 'command'])
      if (p.type !== 'down' && p.type !== 'up') throw invalidAction('invalid_action: unsupported key event')
      const command = p.command === undefined ? undefined : EDIT_COMMANDS.find((entry) => entry === p.command)
      if (p.command !== undefined && !command) throw invalidAction('invalid_action: unsupported command')
      // The space bar's key is a space.
      const keyName = string(p.key, 64, true)
      if (!keyName) throw invalidAction('invalid_action: invalid string')
      return {
        kind, type: p.type, key: keyName, code: string(p.code, 64, true), keyCode: Math.floor(number(p.keyCode, 0, 255)), modifiers: modifiers(p.modifiers),
        // The text a key types may be a space.
        ...(p.text === undefined || p.text === '' ? {} : { text: string(p.text, 16, true) }),
        ...(p.repeat === undefined ? {} : { repeat: boolean(p.repeat) }),
        ...(command ? { command } : {})
      }
    }
    case 'compose': {
      const p = object(value, ['kind', 'text', 'selectionStart', 'selectionEnd'])
      const text = string(p.text, 1024, true)
      return { kind, text, selectionStart: Math.floor(number(p.selectionStart, 0, text.length)), selectionEnd: Math.floor(number(p.selectionEnd, 0, text.length)) }
    }
    case 'paste': {
      const p = object(value, ['kind', 'text'])
      if (typeof p.text !== 'string' || !p.text) throw invalidAction('invalid_action: invalid string')
      if (p.text.length > MAX_BROWSER_PASTE_CHARS) throw invalidAction(`invalid_action: a paste holds at most ${MAX_BROWSER_PASTE_CHARS} characters`)
      return { kind, text: p.text }
    }
    case 'copy': { const p = object(value, ['kind', 'cut']); return { kind, ...(p.cut === undefined ? {} : { cut: boolean(p.cut) }) } }
    case 'dialog': { const p = object(value, ['kind', 'accept', 'text']); return { kind, accept: boolean(p.accept), ...(p.text === undefined ? {} : { text: string(p.text, 4096, true) }) } }
    case 'files': {
      const p = object(value, ['kind', 'paths'])
      const paths = strings(p.paths, 32, 4096)
      if (paths.some((path) => !path || path.includes('\0'))) throw invalidAction('invalid_action: invalid file path')
      return { kind, paths }
    }
    case 'release': object(value, ['kind']); return { kind }
    case 'navigate': { const p = object(value, ['kind', 'url']); return { kind, url: browserNavigationUrl(p.url) } }
    case 'back': case 'forward': case 'reload': object(value, ['kind']); return { kind }
    default: throw invalidAction('invalid_action: unsupported input')
  }
}

function invalidAction(message: string) {
  return knownAppError({ code: 'invalid_action', message }, { category: 'invalid', retryable: false })
}
