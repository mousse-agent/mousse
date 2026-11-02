import type { ResourceLifecycleStore } from '../lifecycle/ResourceLifecycleStore'
import { ThreadWorkspaceManager } from '../workspace/ThreadWorkspaceManager'
import { releaseExecutionLeaseHandle, tryAcquireExecutionLease } from '../queue/ThreadExecutionLease'
import { UndoRetentionService } from './UndoRetentionService'
import { ReceiptRefReleaseService } from './ReceiptRefReleaseService'
import { releaseSnapshotRefs } from './SnapshotRefReleaseService'
import { waitForFolderAccess } from '../files/folderAccess'

export interface UndoRetentionSweeperOptions {
  intervalMs: number
  tasksPerBatch: number
  /**
   * When the first pass runs after `start`. It is never part of starting up: the pass runs Git in each
   * thread's folder synchronously, and a folder on a volume that is slow to answer would hold the daemon
   * before it is ready.
   */
  firstPassAfterMs?: number
}

/**
 * Small rotating idle-task batches. Shutdown cancels lease waits and awaits completion. A thread whose
 * folder (or its repository's Git directory) is on a volume that is not answering, such as one macOS is
 * still asking about, is skipped until a later pass: its Git calls would block the daemon.
 */
export class UndoRetentionSweeper {
  private timer?: ReturnType<typeof setInterval>
  private first?: ReturnType<typeof setTimeout>
  private pending?: Promise<void>
  private readonly abort = new AbortController()
  private cursor = 0
  readonly outcomes = new Map<string, { at: string; expired?: number; releasedRefs?: number; reason?: string }>()
  constructor(private readonly store: ResourceLifecycleStore, private readonly options: UndoRetentionSweeperOptions = { intervalMs: 60 * 60 * 1000, tasksPerBatch: 20, firstPassAfterMs: 2 * 60 * 1000 }) {}
  start(): void {
    if (this.timer || this.abort.signal.aborted) return
    this.timer = setInterval(() => { void this.tick() }, this.options.intervalMs)
    this.timer.unref()
    this.first = setTimeout(() => { void this.tick() }, this.options.firstPassAfterMs ?? 0)
    this.first.unref()
  }
  stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer)
    if (this.first) clearTimeout(this.first)
    this.timer = undefined
    this.first = undefined
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
        const workspace = new ThreadWorkspaceManager(task.location).loadOrSnapshot()
        if (!workspace || workspace.lifecycle !== 'ready') continue
        // Everything below runs Git synchronously in the thread's folder: a volume that does not answer is left for a later pass.
        await waitForFolderAccess([task.location, workspace.worktreePath], { whenNotAnswering: 'fail', signal: this.abort.signal })
        const result = await new UndoRetentionService(task.location).sweep(workspace.worktreePath, this.abort.signal, lease)
        // A folder with no worktree keeps its snapshots in a store of Mousse's own, which is also tidied after the release.
        const released = result.suspended ? undefined : workspace.snapshotOnly
          ? await releaseSnapshotRefs(task.location, { signal: this.abort.signal, heldThreadLease: lease })
          : await new ReceiptRefReleaseService(this.store, task.taskId).release(workspace.worktreePath, { signal: this.abort.signal, heldThreadLease: lease })
        this.outcomes.set(task.taskId, { at: new Date().toISOString(), expired: result.expired.length, releasedRefs: released?.releasedRefs.length ?? 0,
          ...(result.suspended ? { reason: 'Clock review required' } : released?.retained.length ? { reason: released.retained.map((item) => item.reason).join('; ') } : {}) })
      } catch (error) {
        this.outcomes.set(task.taskId, { at: new Date().toISOString(), reason: error instanceof Error ? error.message : String(error) })
      } finally { if (lease) releaseExecutionLeaseHandle(lease) }
    }
  }
}
