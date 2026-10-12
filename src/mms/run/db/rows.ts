/** A row as `node:sqlite` returns it: column name to value. */
export type Row = Record<string, unknown>

/** A nullable TEXT column. */
export function str(value: unknown): string | null {
  return typeof value === 'string' ? value : null
}

/** A nullable INTEGER column. */
export function int(value: unknown): number | null {
  return value === null || value === undefined ? null : Number(value)
}

/** A nullable JSON TEXT column, parsed. */
export function json<T>(value: unknown): T | null {
  return typeof value === 'string' ? (JSON.parse(value) as T) : null
}
