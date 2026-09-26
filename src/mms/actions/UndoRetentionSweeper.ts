import type { ResourceLifecycleStore } from '../lifecycle/ResourceLifecycleStore'
import { ThreadWorkspaceManager } from '../workspace/ThreadWorkspaceManager'
import { releaseExecutionLeaseHandle, tryAcquireExecutionLease } from '../queue/ThreadExecutionLease'
import { UndoRetentionService } from './UndoRetentionService'
import { ReceiptRefReleaseService } from './ReceiptRefReleaseService'

/** Small rotating idle-task batches. Shutdown cancels lease waits and awaits completion. */
export class UndoRetentionSweeper {
  private timer?: ReturnType<typeof setInterval>
  private pending?: Promise<void>
  private readonly abort = new AbortController()
  private cursor = 0
  readonly outcomes = new Map<string, { at: string; expired?: number; releasedRefs?: number; reason?: string }>()
  constructor(private readonly store: ResourceLifecycleStore, private readonly options = { intervalMs: 60 * 60 * 1000, tasksPerBatch: 20 }) {}
  start(): void {
    if (this.timer || this.abort.signal.aborted) return
    this.timer = setInterval(() => { void this.tick() }, this.options.intervalMs)
    this.timer.unref()
    void this.tick()
  }
  stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer)
    this.timer = undefined
    this.abort.abort()
    return this.pending ?? Promise.resolve()
  }
  tick(): Promise<void> {
    if (this.pending) return this.pending
    if (this.abort.signal.aborted) return Promise.resolve()
    const run = this.run()
    this.pending = run.finally(() => { this.pending = undefined })
    return this.pending
  }
  private async run(): Promise<void> {
    let tasks
    try { tasks = this.store.list().filter((task) => task.state === 'active') }
    catch { return } // Unknown ownership disables sweeping; inventory exposes its source error.
    const batch = Math.min(tasks.length, this.options.tasksPerBatch)
    for (let i = 0; i < batch && !this.abort.signal.aborted; i++) {
      const task = tasks[this.cursor++ % tasks.length]!
      let lease
      try {
        lease = tryAcquireExecutionLease(task.location, { source: 'undo-retention-sweep' })
        if (!lease) continue
        const workspace = new ThreadWorkspaceManager(task.location).load()
        if (!workspace || workspace.lifecycle !== 'ready') continue
        const result = await new UndoRetentionService(task.location).sweep(workspace.worktreePath, this.abort.signal, lease)
        const released = result.suspended ? undefined : await new ReceiptRefReleaseService(this.store, task.taskId).release(workspace.worktreePath, { signal: this.abort.signal, heldThreadLease: lease })
        this.outcomes.set(task.taskId, { at: new Date().toISOString(), expired: result.expired.length, releasedRefs: released?.releasedRefs.length ?? 0,
          ...(result.suspended ? { reason: 'Clock review required' } : released?.retained.length ? { reason: released.retained.map((item) => item.reason).join('; ') } : {}) })
      } catch (error) {
        this.outcomes.set(task.taskId, { at: new Date().toISOString(), reason: error instanceof Error ? error.message : String(error) })
      } finally { if (lease) releaseExecutionLeaseHandle(lease) }
    }
  }
}
