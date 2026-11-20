import { existsSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { atomicWriteJsonSync } from '../data/AtomicFs'

/** `<profileHome>/thread-live-work.json`: the threads whose saved agents or tasks were last seen working. */
export const LIVE_WORK_FILE = 'thread-live-work.json'

interface LiveWorkFile {
  version: 1
  /** Every thread with work saved as running is listed. Unset until one restart has looked at every thread. */
  complete?: true
  threads: string[]
}

/** Saved work a restart cuts short: an agent `starting` or `running`, or a task `in_progress`. */
export function hasLiveWork(state: { agents: ReadonlyArray<{ status: string }>; tasks: ReadonlyArray<{ status: string }> }): boolean {
  return state.agents.some((agent) => agent.status === 'starting' || agent.status === 'running') || state.tasks.some((task) => task.status === 'in_progress')
}

/**
 * The threads a restart has to settle (`ThreadRuntimeManager.beginRestart`), so it reads those and not every thread.
 * A thread is added before work saved as running is written for it, so a crash at any point leaves it listed; it is
 * taken off a little later, after its work is saved as stopped (a thread listed for nothing only costs one extra read
 * at the next restart). The list is trusted only once `complete`: after one restart read every thread and listed the
 * ones still working. A missing or damaged file, or one that could not be written, means the next restart reads
 * every thread again.
 */
export class LiveWorkMarks {
  private readonly path: string
  /** What the file lists. */
  private readonly listed: Set<string>
  /** Listed threads whose work has stopped, taken off at the next write. */
  private readonly stopped = new Set<string>()
  /** Whether the file was complete when the service started. */
  private readonly loaded: boolean
  /** Whether what is written now is complete: set once a restart read every thread, false once a write failed. */
  private complete: boolean | undefined
  private flushTimer: ReturnType<typeof setTimeout> | undefined

  constructor(profileHome: string, private readonly flushDelayMs = 5_000) {
    this.path = join(profileHome, LIVE_WORK_FILE)
    const file = this.read()
    this.loaded = file?.complete === true
    this.listed = new Set(file?.threads ?? [])
  }

  private read(): LiveWorkFile | undefined {
    try {
      if (!existsSync(this.path)) return undefined
      const parsed = JSON.parse(readFileSync(this.path, 'utf-8')) as Partial<LiveWorkFile>
      if (parsed?.version !== 1 || !Array.isArray(parsed.threads)) return undefined
      return { version: 1, ...(parsed.complete === true ? { complete: true } : {}), threads: parsed.threads.filter((id): id is string => typeof id === 'string' && id.length > 0) }
    } catch {
      return undefined
    }
  }

  private write(): boolean {
    try {
      atomicWriteJsonSync(this.path, { version: 1, ...(this.complete ?? this.loaded ? { complete: true as const } : {}), threads: [...this.listed] } satisfies LiveWorkFile)
      return true
    } catch (error) {
      // An unwritten mark must not leave a list that is trusted without it: without the file, every thread is read.
      try { rmSync(this.path, { force: true }) } catch { /* The next write tries again. */ }
      this.complete = false
      console.warn('the threads with running work could not be saved', { error: error instanceof Error ? error.message : String(error) })
      return false
    }
  }

  /** The threads the file listed when the service started, when that list covers every thread; undefined otherwise. */
  startupList(): string[] | undefined {
    return this.loaded ? [...this.listed] : undefined
  }

  /** Lists `threadId` before work saved as running is written for it. Written at once when it was not listed. */
  mark(threadId: string): void {
    if (this.stopped.delete(threadId) || this.listed.has(threadId)) return
    this.listed.add(threadId)
    this.write()
  }

  /** `threadId`'s saved work has stopped: taken off the list with the next write, a little later. */
  unmark(threadId: string): void {
    if (!this.listed.has(threadId) || this.stopped.has(threadId)) return
    this.stopped.add(threadId)
    if (this.flushTimer) return
    this.flushTimer = setTimeout(() => this.flush(), this.flushDelayMs)
    this.flushTimer.unref?.()
  }

  /** Every thread has been read once since the service started: the list covers them all from now on. */
  markComplete(): void {
    if (this.complete === false) return
    this.complete = true
    this.flush()
  }

  flush(): void {
    if (this.flushTimer) clearTimeout(this.flushTimer)
    this.flushTimer = undefined
    for (const threadId of this.stopped) this.listed.delete(threadId)
    this.stopped.clear()
    this.write()
  }
}
