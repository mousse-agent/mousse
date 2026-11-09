/**
 * A skeleton is a copy of a value as `JSON.stringify` would write it: objects and arrays are copied, while
 * strings are shared with the original (JavaScript strings are immutable). The thread store keeps one per
 * saved row, so a save can tell what changed by walking the thread instead of serializing it: an unchanged
 * string is the same instance, and comparing it costs nothing.
 */

export type Skeleton = null | boolean | number | string | Skeleton[] | { [key: string]: Skeleton }

function hasToJson(value: object): value is { toJSON: () => unknown } {
  return typeof (value as { toJSON?: unknown }).toJSON === 'function'
}

/** The value `JSON.parse(JSON.stringify(value))` would give, without serializing; `undefined` when JSON drops it. */
export function skeletonOf(value: unknown): Skeleton | undefined {
  if (value === null) return null
  switch (typeof value) {
    case 'string':
    case 'boolean':
      return value
    case 'number':
      return Number.isFinite(value) ? value : null
    case 'bigint':
      throw new TypeError('Do not know how to serialize a BigInt')
    case 'undefined':
    case 'function':
    case 'symbol':
      return undefined
  }
  const object = value as object
  if (hasToJson(object)) return skeletonOf(object.toJSON())
  if (Array.isArray(object)) {
    const out: Skeleton[] = new Array(object.length)
    for (let i = 0; i < object.length; i++) {
      const item = skeletonOf(object[i])
      out[i] = item === undefined ? null : item
    }
    return out
  }
  const out: { [key: string]: Skeleton } = {}
  for (const key of Object.keys(object)) {
    const item = skeletonOf((object as Record<string, unknown>)[key])
    if (item !== undefined) out[key] = item
  }
  return out
}

/** True when `value` would serialize to the same JSON as `skeleton` (key order aside). */
export function sameAsSkeleton(value: unknown, skeleton: Skeleton | undefined): boolean {
  if (value === null) return skeleton === null
  switch (typeof value) {
    case 'string':
    case 'boolean':
      return value === skeleton
    case 'number':
      return Number.isFinite(value) ? value === skeleton : skeleton === null
    case 'undefined':
    case 'function':
    case 'symbol':
      return skeleton === undefined
    case 'bigint':
      return false
  }
  const object = value as object
  if (hasToJson(object)) return sameAsSkeleton(object.toJSON(), skeleton)
  if (Array.isArray(object)) {
    if (!Array.isArray(skeleton) || skeleton.length !== object.length) return false
    for (let i = 0; i < object.length; i++) {
      const item = object[i]
      const dropped = item === undefined || typeof item === 'function' || typeof item === 'symbol'
      if (dropped ? skeleton[i] !== null : !sameAsSkeleton(item, skeleton[i])) return false
    }
    return true
  }
  if (skeleton === null || typeof skeleton !== 'object' || Array.isArray(skeleton)) return false
  let seen = 0
  for (const key of Object.keys(object)) {
    const item = (object as Record<string, unknown>)[key]
    if (item === undefined || typeof item === 'function' || typeof item === 'symbol') continue
    if (!Object.prototype.hasOwnProperty.call(skeleton, key)) return false
    if (!sameAsSkeleton(item, skeleton[key])) return false
    seen += 1
  }
  return seen === Object.keys(skeleton).length
}

/** A fresh, independent value built from a skeleton (strings stay shared). */
export function fromSkeleton<T = unknown>(skeleton: Skeleton): T {
  if (skeleton === null || typeof skeleton !== 'object') return skeleton as T
  if (Array.isArray(skeleton)) return skeleton.map((item) => fromSkeleton(item)) as T
  const out: Record<string, unknown> = {}
  for (const key of Object.keys(skeleton)) out[key] = fromSkeleton(skeleton[key])
  return out as T
}
