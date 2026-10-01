import { createHash } from 'crypto'

export function sha256Bytes(data: string | Uint8Array): string {
  return createHash('sha256').update(data).digest('hex')
}

export function shortHash(value: string, length = 8): string {
  return sha256Bytes(value).slice(0, length)
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortValue(value))
}

export function revisionFromValue(value: unknown): string {
  return sha256Bytes(canonicalJson(value))
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue)
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>
    return Object.fromEntries(
      Object.keys(record)
        .sort()
        .map((key) => [key, sortValue(record[key])])
    )
  }
  return value
}
