export function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const proto = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}

export function hasPrototypePollutingKey(key: string): boolean {
  return key === '__proto__' || key === 'prototype' || key === 'constructor'
}

export function objectHasPrototypePollutingKey(value: unknown): boolean {
  if (!isPlainObject(value) && !Array.isArray(value)) return false
  if (isPlainObject(value)) {
    for (const key of Object.keys(value)) {
      if (hasPrototypePollutingKey(key)) return true
      if (objectHasPrototypePollutingKey(value[key])) return true
    }
  } else if (Array.isArray(value)) {
    for (const item of value) {
      if (objectHasPrototypePollutingKey(item)) return true
    }
  }
  return false
}

export function isNonEmptyString(value: unknown, maxLength: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= maxLength
}

export function isFiniteInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && Number.isFinite(value)
}

export function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

export function cloneJson<T>(value: T): T {
  return structuredClone(value)
}

export function jsonByteLength(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).length
}
