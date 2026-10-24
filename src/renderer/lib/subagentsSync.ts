import type { SubagentSummary, SubagentsUpdatedEvent } from '../../shared/subagents'

export interface SubagentsSyncDeps {
  list: (threadId: string) => Promise<SubagentSummary[]>
  onUpdated: (cb: (event: SubagentsUpdatedEvent) => void) => () => void
  apply: (threadId: string, subagents: SubagentSummary[]) => void
  /** Wait after an update before refetching, so a burst of run events costs one request. */
  debounceMs?: number
}

/**
 * Keeps the store's subagent list current for the threads something is watching: one fetch when a
 * thread gains its first watcher, then one debounced refetch per burst of `subagents.updated`
 * events for it. A reply that arrives after a newer request started is dropped.
 */
export function createSubagentsSync(deps: SubagentsSyncDeps): { watch: (threadId: string) => () => void } {
  const debounceMs = deps.debounceMs ?? 150
  const watchers = new Map<string, number>()
  const timers = new Map<string, ReturnType<typeof setTimeout>>()
  const requests = new Map<string, number>()
  let unsubscribe: (() => void) | null = null

  const fetchNow = (threadId: string): void => {
    const request = (requests.get(threadId) ?? 0) + 1
    requests.set(threadId, request)
    void deps.list(threadId).then(
      (subagents) => {
        if (requests.get(threadId) === request && watchers.has(threadId)) deps.apply(threadId, subagents)
      },
      () => undefined // an older daemon without `subagents.list` leaves the last list in place
    )
  }

  const schedule = (threadId: string): void => {
    clearTimeout(timers.get(threadId))
    timers.set(threadId, setTimeout(() => {
      timers.delete(threadId)
      if (watchers.has(threadId)) fetchNow(threadId)
    }, debounceMs))
  }

  return {
    watch(threadId) {
      watchers.set(threadId, (watchers.get(threadId) ?? 0) + 1)
      if (watchers.get(threadId) === 1) fetchNow(threadId)
      unsubscribe ??= deps.onUpdated(({ parentThreadId }) => {
        if (watchers.has(parentThreadId)) schedule(parentThreadId)
      })
      let released = false
      return () => {
        if (released) return
        released = true
        const remaining = (watchers.get(threadId) ?? 1) - 1
        if (remaining > 0) {
          watchers.set(threadId, remaining)
          return
        }
        watchers.delete(threadId)
        clearTimeout(timers.get(threadId))
        timers.delete(threadId)
        if (watchers.size === 0) {
          unsubscribe?.()
          unsubscribe = null
        }
      }
    }
  }
}
