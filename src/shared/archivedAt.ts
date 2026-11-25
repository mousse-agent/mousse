/**
 * A thread's archive time. Mousse versions before archived threads were called archived in code stored and sent it as
 * `settledAt`: thread metadata on disk, the warm start file, and the list rows and thread records another computer or a
 * phone sends still may. Every reader of a stored or received thread goes through `archivedAtOf` or `withArchivedAt`, so
 * an archived thread stays archived after an upgrade and when an older computer sends it; new writes carry only
 * `archivedAt` (and, to an older computer or client, the legacy `settledAt` beside it).
 */

/** `archivedAt`, or the legacy `settledAt` a row written by an older Mousse carries; undefined when neither is a string. */
export function archivedAtOf(row: { archivedAt?: unknown; settledAt?: unknown } | null | undefined): string | undefined {
  if (!row) return undefined
  if (typeof row.archivedAt === 'string') return row.archivedAt
  return typeof row.settledAt === 'string' ? row.settledAt : undefined
}

/**
 * `thread` with a legacy `settledAt` moved into `archivedAt` and dropped; the same object when it carries no `settledAt`.
 * An `archivedAt` it already has wins.
 */
export function withArchivedAt<T>(thread: T): T {
  if (!thread || typeof thread !== 'object' || !('settledAt' in thread)) return thread
  const { settledAt: _legacy, ...rest } = thread as T & { settledAt?: unknown; archivedAt?: unknown }
  const archivedAt = archivedAtOf(thread as { archivedAt?: unknown; settledAt?: unknown })
  return (archivedAt === undefined ? rest : { ...rest, archivedAt }) as T
}

/**
 * `thread` with the legacy `settledAt` beside its `archivedAt`, for a computer or a phone that may run an older Mousse,
 * which reads only `settledAt`. The same object when it is not archived.
 */
export function withLegacySettledAt<T>(thread: T): T {
  if (!thread || typeof thread !== 'object') return thread
  const archivedAt = (thread as { archivedAt?: unknown }).archivedAt
  return typeof archivedAt === 'string' ? { ...thread, settledAt: archivedAt } : thread
}

/** A reply's `thread` and `threads` with the legacy `settledAt` (`withLegacySettledAt`); anything else as it is. */
export function withLegacySettledAtIn<T>(result: T): T {
  if (!result || typeof result !== 'object' || Array.isArray(result)) return result
  const record = result as Record<string, unknown>
  let out: Record<string, unknown> | undefined
  if (record.thread && typeof record.thread === 'object' && !Array.isArray(record.thread)) {
    const next = withLegacySettledAt(record.thread)
    if (next !== record.thread) (out ??= { ...record }).thread = next
  }
  if (Array.isArray(record.threads)) {
    const next = record.threads.map(withLegacySettledAt)
    if (next.some((thread, index) => thread !== (record.threads as unknown[])[index])) (out ??= { ...record }).threads = next
  }
  return (out ?? result) as T
}
