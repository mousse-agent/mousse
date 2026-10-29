/**
 * Runs `task` for a key at most once at a time. A trigger that arrives while the task runs asks for
 * one more run after it, so a burst of triggers costs at most two runs instead of one per trigger.
 * The task reports its own failures; a failure here only ends that run.
 */
export function coalescedRunner<K>(task: (key: K) => Promise<void>): (key: K) => Promise<void> {
  const running = new Map<K, Promise<void>>()
  const again = new Set<K>()
  const start = (key: K): Promise<void> => {
    const run = (async () => {
      try {
        await task(key)
      } catch {
        /* the task reports its own failures */
      } finally {
        running.delete(key)
        if (again.delete(key)) void start(key)
      }
    })()
    running.set(key, run)
    return run
  }
  return (key) => {
    const current = running.get(key)
    if (!current) return start(key)
    again.add(key)
    return current
  }
}
