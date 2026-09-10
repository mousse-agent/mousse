export function plainObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  return value as Record<string, unknown>
}

export function optionalString(value: unknown, max: number): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string' || value.length > max) throw new Error('invalid_action: invalid string')
  return value
}

export function requiredString(value: unknown, max: number): string {
  if (typeof value !== 'string' || value.length > max || !value.trim()) throw new Error('invalid_action: invalid string')
  return value
}

export function requiredId(value: unknown): string {
  const result = requiredString(value, 160)
  if (!/^[a-zA-Z0-9:_-]+$/.test(result)) throw new Error('invalid_action: invalid identifier')
  return result
}

export function optionalBoolean(value: unknown): boolean | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'boolean') throw new Error('invalid_action: expected boolean')
  return value
}

export function optionalInteger(value: unknown, min: number, max: number): number | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) throw new Error('invalid_action: invalid number')
  return value
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new Error('cancelled'))
      return
    }
    const timer = setTimeout(resolve, ms)
    const onAbort = () => {
      clearTimeout(timer)
      reject(signal?.reason ?? new Error('cancelled'))
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

export function boundText(value: string, max: number): string {
  if (value.length <= max) return value
  return value.slice(0, max)
}

export function sanitizeUrl(value: string): string {
  try {
    const url = new URL(value)
    url.username = ''
    url.password = ''
    return url.href
  } catch {
    return ''
  }
}

export function nowIso(clock: () => Date = () => new Date()): string {
  return clock().toISOString()
}
