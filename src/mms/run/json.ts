/** Stable JSON: object keys sorted, undefined object members dropped. */
export function stableStringify(value: unknown): string {
  return serialize(value) ?? 'null'
}

function serialize(value: unknown): string | undefined {
  if (value === undefined || typeof value === 'function' || typeof value === 'symbol')
    return undefined
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  const json = (value as { toJSON?: () => unknown }).toJSON
  if (typeof json === 'function') return serialize(json.call(value))
  if (Array.isArray(value)) return `[${value.map((item) => serialize(item) ?? 'null').join(',')}]`
  const entries: string[] = []
  for (const key of Object.keys(value).sort()) {
    const item = serialize((value as Record<string, unknown>)[key])
    if (item !== undefined) entries.push(`${JSON.stringify(key)}:${item}`)
  }
  return `{${entries.join(',')}}`
}
