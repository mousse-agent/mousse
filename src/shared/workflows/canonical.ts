import { isPlainObject } from './util'

/** Key-sorted JSON clone. Reordering object keys does not change the result. */
export function canonicalizeJson(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value
  if (Array.isArray(value)) return value.map(canonicalizeJson)
  if (!isPlainObject(value)) return value
  const keys = Object.keys(value).sort()
  const result: Record<string, unknown> = {}
  for (const key of keys) {
    result[key] = canonicalizeJson(value[key])
  }
  return result
}

export function stableStringify(value: unknown): string {
  return JSON.stringify(canonicalizeJson(value))
}
