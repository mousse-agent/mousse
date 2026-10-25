import type { RunStore } from './RunStore'

/**
 * The Stop fence (issue #142). Every Stop of a thread raises the generation of that thread and of
 * every subagent below it, in the same transaction that snapshots what the Stop cancels. Work that
 * starts something on behalf of a parent records the generation of its thread when it is admitted
 * (`runs.stop_generation`, a queue entry's `stopGeneration`) and is refused at execution once the
 * generation is higher, so a run that was already past the Stop cannot start new subagent work.
 * Human sends are never fenced: they are new intent after the Stop and record the current value.
 */

/** The thread's generation: 0 until its first Stop. */
export function currentStopGeneration(store: RunStore, threadId: string): number {
  const row = store.db.statement('SELECT generation FROM thread_stop_generations WHERE thread_id = ?').get(threadId)
  return row ? Number(row.generation) : 0
}

/** Raises the generation of every thread in `threadIds` by one and returns the new values. Joins the caller's transaction. */
export function bumpStopGenerations(store: RunStore, threadIds: readonly string[], now: string): Record<string, number> {
  return store.db.transaction(() => {
    const bumped: Record<string, number> = {}
    for (const threadId of threadIds) {
      store.db
        .statement(
          `INSERT INTO thread_stop_generations(thread_id, generation, updated_at) VALUES(?, 1, ?)
           ON CONFLICT(thread_id) DO UPDATE SET generation = generation + 1, updated_at = excluded.updated_at`
        )
        .run(threadId, now)
      bumped[threadId] = currentStopGeneration(store, threadId)
    }
    return bumped
  })
}

/** The generation a run was admitted at: that of its own thread when it was created. */
export function runStopGeneration(store: RunStore, runId: string): number {
  const row = store.db.statement('SELECT stop_generation FROM runs WHERE run_id = ?').get(runId)
  return row ? Number(row.stop_generation) : 0
}

/**
 * Whether a Stop of the run's thread (or of an ancestor, which raises it too) came after the run was
 * admitted. A stale run must not start new work for its thread; an unknown run is not stale.
 */
export function isRunAdmissionStale(store: RunStore, runId: string): boolean {
  const row = store.db.statement('SELECT thread_id, stop_generation FROM runs WHERE run_id = ?').get(runId)
  if (!row) return false
  return Number(row.stop_generation) < currentStopGeneration(store, String(row.thread_id))
}
