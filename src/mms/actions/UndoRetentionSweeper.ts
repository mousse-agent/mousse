import type { ResourceLifecycleStore } from '../lifecycle/ResourceLifecycleStore'
import { ThreadWorkspaceManager } from '../workspace/ThreadWorkspaceManager'
import { releaseExecutionLeaseHandle, tryAcquireExecutionLease } from '../queue/ThreadExecutionLease'
import { UndoRetentionService } from './UndoRetentionService'
import { ReceiptRefReleaseService } from './ReceiptRefReleaseService'
import { releaseSnapshotRefs } from './SnapshotRefReleaseService'
import { expirePreservedFiles } from './preservedFiles'

/**
 * Small rotating idle-task batches. Shutdown cancels lease waits and awaits completion. Files a restore kept
 * (`refs/mousse/preserved/`) expire here too, once they are older than the thread's Undo retention window; never in
 * the first pass after `start`, which runs while the daemon starts.
 */
export class UndoRetentionSweeper {
  private timer?: ReturnType<typeof setInterval>
  private pending?: Promise<void>
  private readonly abort = new AbortController()
  private cursor = 0
  private passes = 0
  readonly outcomes = new Map<string, { at: string; expired?: number; releasedRefs?: number; expiredPreservedRefs?: number; reason?: string }>()
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
    // The first pass belongs to starting up: kept files are not looked at until a later one.
    const startup = this.passes++ === 0
    const batch = Math.min(tasks.length, this.options.tasksPerBatch)
    for (let i = 0; i < batch && !this.abort.signal.aborted; i++) {
      const task = tasks[this.cursor++ % tasks.length]!
      let lease
      // Kept files have their own outcome: a failure there never holds back the receipt release, nor is hidden by one.
      let preserved: { expired?: number; reason?: string } = {}
      try {
        lease = tryAcquireExecutionLease(task.location, { source: 'undo-retention-sweep' })
        if (!lease) continue
        const workspace = new ThreadWorkspaceManager(task.location).loadOrSnapshot()
        if (!workspace || workspace.lifecycle !== 'ready') continue
        const result = await new UndoRetentionService(task.location).sweep(workspace.worktreePath, this.abort.signal, lease)
        if (!result.suspended && !startup) {
          try {
            const expiry = await expirePreservedFiles(task.location, workspace.worktreePath, { signal: this.abort.signal, heldThreadLease: lease })
            preserved = { expired: expiry.expiredRefs.length, ...(expiry.skipped ? { reason: `Kept files: ${expiry.skipped}` } : {}) }
          }
          catch (error) { preserved = { reason: `Kept files: ${error instanceof Error ? error.message : String(error)}` } }
        }
        // A folder with no worktree keeps its snapshots in a store of Mousse's own, which is also tidied after the release.
        const released = result.suspended ? undefined : workspace.snapshotOnly
          ? await releaseSnapshotRefs(task.location, { signal: this.abort.signal, heldThreadLease: lease })
          : await new ReceiptRefReleaseService(this.store, task.taskId).release(workspace.worktreePath, { signal: this.abort.signal, heldThreadLease: lease })
        const reasons = result.suspended ? ['Clock review required'] : [...(released?.retained.map((item) => item.reason) ?? []), ...(preserved.reason ? [preserved.reason] : [])]
        this.outcomes.set(task.taskId, { at: new Date().toISOString(), expired: result.expired.length, releasedRefs: released?.releasedRefs.length ?? 0,
          ...(preserved.expired !== undefined ? { expiredPreservedRefs: preserved.expired } : {}), ...(reasons.length ? { reason: reasons.join('; ') } : {}) })
      } catch (error) {
        this.outcomes.set(task.taskId, { at: new Date().toISOString(), ...(preserved.expired !== undefined ? { expiredPreservedRefs: preserved.expired } : {}),
          reason: [error instanceof Error ? error.message : String(error), ...(preserved.reason ? [preserved.reason] : [])].join('; ') })
      } finally { if (lease) releaseExecutionLeaseHandle(lease) }
    }
  }
}
