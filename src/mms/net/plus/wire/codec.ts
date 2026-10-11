// Adapted from Mousse sync/codec.ts at 6fedcada90f365ce44aa34b116063dcbc3cb8ae7. See UPSTREAM_LICENSE.
import { NetRelayError as NetError } from './errors.js'
const MAX_MESSAGE_BYTES = 1024 * 1024
export const MAX_JSON_DEPTH = 32
export const MAX_JSON_NODES = 16_384
const encoder = new TextEncoder()
const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })
const fail = (message: string): never => {
  throw new NetError('bad_request', message)
}
const large = (message: string): never => {
  throw new NetError('too_large', message)
}

/** No normalization or duplicate-key ambiguity in signed or header JSON. */
export function parseProtocolJson(bytes: Uint8Array): unknown {
  return parseBoundedJsonDocument(bytes, MAX_MESSAGE_BYTES)
}

/** Trusted assembled documents may have a larger byte budget; grammar, depth,
 * node count and duplicate-key protections remain the wire parser's rules. */
export function parseBoundedJsonDocument(bytes: Uint8Array, maximumBytes: number): unknown {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1 || maximumBytes > 32 * 1024 * 1024)
    return fail('Invalid JSON document byte bound.')
  if (bytes.length > maximumBytes) return large('JSON document exceeds its byte bound.')
  let source: string
  try {
    source = decoder.decode(bytes)
  } catch {
    return fail('Invalid UTF-8.')
  }
  let index = 0
  let nodes = 0
  const ws = (): void => {
    while (/[\x20\x09\x0a\x0d]/.test(source[index] ?? '\0')) index++
  }
  const string = (): string => {
    const start = index++
    while (index < source.length) {
      const char = source[index++]
      if (char === '"') {
        let value: string
        try {
          value = JSON.parse(source.slice(start, index)) as string
        } catch {
          return fail('Invalid JSON string.')
        }
        if (/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(value))
          return fail('Unpaired Unicode surrogate.')
        return value
      }
      if (char === '\\') index++
    }
    return fail('Unterminated JSON string.')
  }
  const value = (depth: number): unknown => {
    if (depth > MAX_JSON_DEPTH || ++nodes > MAX_JSON_NODES)
      return large('JSON structure exceeds bounds.')
    ws()
    const char = source[index]
    if (char === '"') return string()
    if (char === '{') {
      index++
      ws()
      const result = Object.create(null) as Record<string, unknown>
      if (source[index] === '}') {
        index++
        return result
      }
      for (;;) {
        ws()
        if (source[index] !== '"') return fail('Expected JSON object key.')
        if (++nodes > MAX_JSON_NODES) return large('JSON structure exceeds bounds.')
        const key = string()
        if (Object.hasOwn(result, key)) return fail('Duplicate JSON object key.')
        ws()
        if (source[index++] !== ':') return fail('Expected colon.')
        result[key] = value(depth + 1)
        ws()
        const next = source[index++]
        if (next === '}') return result
        if (next !== ',') return fail('Expected object delimiter.')
      }
    }
    if (char === '[') {
      index++
      ws()
      const result: unknown[] = []
      if (source[index] === ']') {
        index++
        return result
      }
      for (;;) {
        result.push(value(depth + 1))
        ws()
        const next = source[index++]
        if (next === ']') return result
        if (next !== ',') return fail('Expected array delimiter.')
      }
    }
    for (const [token, parsed] of [
      ['true', true],
      ['false', false],
      ['null', null]
    ] as const) {
      if (source.startsWith(token, index)) {
        index += token.length
        return parsed
      }
    }
    const number = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(source.slice(index))?.[0]
    if (!number) return fail('Invalid JSON value.')
    index += number.length
    const parsed = Number(number)
    if (!Number.isFinite(parsed) || (Number.isInteger(parsed) && !Number.isSafeInteger(parsed)))
      return fail('Unsafe JSON number.')
    return parsed
  }
  const result = value(0)
  ws()
  if (index !== source.length) return fail('Trailing JSON content.')
  return result
}

/** Canonical compact sorted-key JSON for presence and enrollment proof inputs only. */
export function canonicalJson(value: unknown): Uint8Array {
  let nodes = 0
  const serialize = (item: unknown, depth: number): string => {
    if (depth > MAX_JSON_DEPTH || ++nodes > MAX_JSON_NODES)
      return large('JSON structure exceeds bounds.')
    if (item === null || typeof item === 'boolean') return JSON.stringify(item)
    if (typeof item === 'number') {
      if (!Number.isFinite(item) || (Number.isInteger(item) && !Number.isSafeInteger(item)))
        return fail('Unsafe JSON number.')
      return JSON.stringify(item)
    }
    if (typeof item === 'string') {
      if (/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(item))
        return fail('Unpaired Unicode surrogate.')
      return JSON.stringify(item)
    }
    if (Array.isArray(item)) {
      for (let i = 0; i < item.length; i++)
        if (!Object.hasOwn(item, i)) return fail('Sparse arrays are not canonical JSON.')
      return `[${item.map((entry) => serialize(entry, depth + 1)).join(',')}]`
    }
    if (
      typeof item === 'object' &&
      item !== null &&
      (Object.getPrototypeOf(item) === Object.prototype || Object.getPrototypeOf(item) === null)
    ) {
      return `{${Object.keys(item)
        .sort()
        .map(
          (key) =>
            `${serialize(key, depth + 1)}:${serialize((item as Record<string, unknown>)[key], depth + 1)}`
        )
        .join(',')}}`
    }
    return fail('Expected a JSON value.')
  }
  return encoder.encode(serialize(value, 0))
}
