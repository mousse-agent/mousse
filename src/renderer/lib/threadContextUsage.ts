import type { ContextUsageSnapshot } from '../../shared/types'

/** Threads whose last measurement is kept; the oldest one read goes first. */
const KEPT = 64

interface Measured {
  usage: ContextUsageSnapshot
  /** The thread's `updatedAt` when it was measured; absent for the blank composer. */
  version?: string
}

const measured = new Map<string, Measured>()

/** One thread of one profile; the blank composer (no thread) is its own entry. */
export function contextUsageKey(profileId: string | null, threadId: string | null): string {
  return `${profileId ?? ''}\0${threadId ?? ''}`
}

/** Keeps a thread's measurement, so the thread shows it at once the next time it opens. */
export function rememberContextUsage(key: string, usage: ContextUsageSnapshot, version?: string): void {
  measured.delete(key)
  measured.set(key, { usage, ...(version !== undefined ? { version } : {}) })
  while (measured.size > KEPT) measured.delete(measured.keys().next().value!)
}

/**
 * A thread's last measurement, to show while it is measured again. A thread that changed since (a turn ran,
 * here or elsewhere) keeps its ring but loses its prompt cache record until the new measurement says where the
 * cache stands, so the Full/Compact chip never shows for a moment and then goes.
 */
export function cachedContextUsage(key: string, version?: string): ContextUsageSnapshot | undefined {
  const entry = measured.get(key)
  if (!entry) return undefined
  if (entry.version === version || !entry.usage.promptCache) return entry.usage
  const { promptCache: _changed, ...usage } = entry.usage
  return usage
}

/** Tests only. */
export function forgetContextUsage(): void {
  measured.clear()
}
