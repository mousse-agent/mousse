import { WORKFLOW_MAX_JSON_POINTER_LENGTH } from './limits'

/** RFC 6901 JSON Pointer. Empty string addresses the whole document. */
export function isJsonPointer(value: unknown): value is string {
  if (typeof value !== 'string') return false
  if (value.length > WORKFLOW_MAX_JSON_POINTER_LENGTH) return false
  if (value === '') return true
  if (!value.startsWith('/')) return false
  if (value.includes('\0')) return false
  const parts = value.split('/').slice(1)
  for (const part of parts) {
    if (part.includes('~') && !/^([^~]|~0|~1)*$/.test(part)) return false
  }
  return true
}

export function decodeJsonPointerToken(token: string): string {
  return token.replace(/~1/g, '/').replace(/~0/g, '~')
}

export function encodeJsonPointerToken(token: string): string {
  return token.replace(/~/g, '~0').replace(/\//g, '~1')
}

export type JsonPointerLookup =
  | { ok: true; value: unknown }
  | { ok: false; error: string }

export function getJsonPointer(document: unknown, pointer: string): JsonPointerLookup {
  if (!isJsonPointer(pointer)) {
    return { ok: false, error: `Invalid JSON pointer: ${pointer}` }
  }
  if (pointer === '') return { ok: true, value: document }
  let current: unknown = document
  const tokens = pointer.split('/').slice(1).map(decodeJsonPointerToken)
  for (const token of tokens) {
    if (Array.isArray(current)) {
      if (!/^(0|[1-9][0-9]*)$/.test(token)) {
        return { ok: false, error: `Array index required at ${token}` }
      }
      const index = Number(token)
      if (index >= current.length) {
        return { ok: false, error: `Missing array index ${index}` }
      }
      current = current[index]
      continue
    }
    if (current !== null && typeof current === 'object') {
      if (!(token in current)) {
        return { ok: false, error: `Missing property ${token}` }
      }
      current = (current as Record<string, unknown>)[token]
      continue
    }
    return { ok: false, error: `Cannot traverse pointer token ${token}` }
  }
  return { ok: true, value: current }
}

export function setJsonPointer(document: unknown, pointer: string, value: unknown): JsonPointerLookup {
  if (!isJsonPointer(pointer)) {
    return { ok: false, error: `Invalid JSON pointer: ${pointer}` }
  }
  if (pointer === '') return { ok: true, value }
  const tokens = pointer.split('/').slice(1).map(decodeJsonPointerToken)
  const root = document
  let current: unknown = root
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i]!
    const last = i === tokens.length - 1
    if (Array.isArray(current)) {
      if (!/^(0|[1-9][0-9]*)$/.test(token)) {
        return { ok: false, error: `Array index required at ${token}` }
      }
      const index = Number(token)
      if (last) {
        current[index] = value
        return { ok: true, value: root }
      }
      current = current[index]
      continue
    }
    if (current !== null && typeof current === 'object') {
      const record = current as Record<string, unknown>
      if (last) {
        record[token] = value
        return { ok: true, value: root }
      }
      if (!(token in record)) return { ok: false, error: `Missing property ${token}` }
      current = record[token]
      continue
    }
    return { ok: false, error: `Cannot set pointer token ${token}` }
  }
  return { ok: true, value: root }
}
