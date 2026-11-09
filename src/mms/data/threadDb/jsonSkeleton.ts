/**
 * A skeleton is a copy of a value as `JSON.stringify` would write it: objects and arrays are copied, while
 * strings are shared with the original (JavaScript strings are immutable). The thread store keeps one per
 * saved row, so a save can tell what changed by walking the thread instead of serializing it: an unchanged
 * string is the same instance, and comparing it costs nothing.
 *
 * Both functions follow `JSON.stringify` exactly: `toJSON` is called with the value's key, boxed numbers, strings
 * and booleans are unwrapped, getters are read, values JSON drops are dropped (or written as null in arrays), and a
 * key named `__proto__` stays an ordinary own property.
 */

export type Skeleton = null | boolean | number | string | Skeleton[] | { [key: string]: Skeleton }

/** True when `value` has the internal slot `valueOf` of `proto` reads (a boxed primitive of that type). */
function boxed(value: object, proto: { valueOf: () => unknown }): boolean {
  try {
    proto.valueOf.call(value)
    return true
  } catch {
    return false
  }
}

/**
 * What `JSON.stringify` serializes in place of `value` found under `key` (SerializeJSONProperty): `toJSON` read once
 * and called with the key (also on functions and BigInts), then boxed primitives unwrapped as the spec does.
 */
function serialized(value: unknown, key: string): unknown {
  if (value !== null && (typeof value === 'object' || typeof value === 'function' || typeof value === 'bigint')) {
    const toJSON = (value as { toJSON?: unknown }).toJSON
    if (typeof toJSON === 'function') value = toJSON.call(value, key)
  }
  if (value !== null && typeof value === 'object') {
    // ToNumber, as JSON does: unary plus throws on a BigInt where Number() would convert it.
    if (boxed(value, Number.prototype)) return +(value as unknown as number)
    if (boxed(value, String.prototype)) return String(value)
    if (boxed(value, Boolean.prototype)) return Boolean.prototype.valueOf.call(value)
    if (boxed(value, BigInt.prototype)) throw new TypeError('Do not know how to serialize a BigInt')
  }
  return value
}

function dropped(value: unknown): boolean {
  return value === undefined || typeof value === 'function' || typeof value === 'symbol'
}

/** Sets an own property, also for the key `__proto__`. */
function setOwn(target: Record<string, unknown>, key: string, value: unknown): void {
  if (key === '__proto__') Object.defineProperty(target, key, { value, enumerable: true, writable: true, configurable: true })
  else target[key] = value
}

function convert(raw: unknown, key: string, stack: Set<object> = new Set()): Skeleton | undefined {
  const value = serialized(raw, key)
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
  if (stack.has(value as object)) throw new TypeError('Converting circular structure to JSON')
  stack.add(value as object)
  try {
    if (Array.isArray(value)) {
      const length = value.length
      const out: Skeleton[] = new Array(length)
      for (let i = 0; i < length; i++) {
        const item = convert(value[i], String(i), stack)
        out[i] = item === undefined ? null : item
      }
      return out
    }
    const out: Record<string, Skeleton> = {}
    for (const name of Object.keys(value as object)) {
      const item = convert((value as Record<string, unknown>)[name], name, stack)
      if (item !== undefined) setOwn(out, name, item)
    }
    return out
  } finally {
    stack.delete(value as object)
  }
}

/** The value `JSON.parse(JSON.stringify(value))` would give, without serializing; `undefined` when JSON drops it. */
export function skeletonOf(value: unknown): Skeleton | undefined {
  return convert(value, '')
}

function same(raw: unknown, key: string, skeleton: Skeleton | undefined): boolean {
  return sameValue(serialized(raw, key), skeleton)
}

/** `same` for a value `serialized` already ran on (`toJSON` is called once, as JSON does). */
function sameValue(value: unknown, skeleton: Skeleton | undefined, stack: Set<object> = new Set()): boolean {
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
  if (stack.has(value as object)) throw new TypeError('Converting circular structure to JSON')
  stack.add(value as object)
  try {
    if (Array.isArray(value)) {
      const length = value.length
      if (!Array.isArray(skeleton) || skeleton.length !== length) return false
      for (let i = 0; i < length; i++) {
        const item = serialized(value[i], String(i))
        if (dropped(item) ? skeleton[i] !== null : !sameValue(item, skeleton[i], stack)) return false
      }
      return true
    }
    if (skeleton === null || typeof skeleton !== 'object' || Array.isArray(skeleton)) return false
    let seen = 0
    for (const name of Object.keys(value as object)) {
      const item = serialized((value as Record<string, unknown>)[name], name)
      if (dropped(item)) continue
      if (!Object.prototype.hasOwnProperty.call(skeleton, name)) return false
      if (!sameValue(item, (skeleton as Record<string, Skeleton>)[name], stack)) return false
      seen += 1
    }
    return seen === Object.keys(skeleton).length
  } finally {
    stack.delete(value as object)
  }
}

/** True when two skeletons are equal (key order aside); shared strings compare at once. */
export function sameSkeleton(a: Skeleton | undefined, b: Skeleton | undefined): boolean {
  if (a === b) return true
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return false
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false
    return a.every((item, i) => sameSkeleton(item, b[i]))
  }
  const keys = Object.keys(a)
  if (keys.length !== Object.keys(b).length) return false
  return keys.every((key) => Object.prototype.hasOwnProperty.call(b, key) && sameSkeleton(a[key], b[key]))
}

/** True when `value` would serialize to the same JSON as `skeleton` (key order aside). */
export function sameAsSkeleton(value: unknown, skeleton: Skeleton | undefined): boolean {
  return same(value, '', skeleton)
}

/** A fresh, independent value built from a skeleton (strings stay shared). */
export function fromSkeleton<T = unknown>(skeleton: Skeleton): T {
  if (skeleton === null || typeof skeleton !== 'object') return skeleton as T
  if (Array.isArray(skeleton)) return skeleton.map((item) => fromSkeleton(item)) as T
  const out: Record<string, unknown> = {}
  for (const key of Object.keys(skeleton)) setOwn(out, key, fromSkeleton(skeleton[key]))
  return out as T
}
