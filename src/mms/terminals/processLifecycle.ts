import { spawn } from 'node:child_process'
import { readdirSync, readFileSync } from 'node:fs'
import type { WorkerHandle, WorkerKind } from './WorkerHandle'

export const DEFAULT_PROCESS_SHUTDOWN_TIMEOUT_MS = 15_000
export const MAX_OWNED_TREE_WALK = 256

export type ProcessRunnerKind = WorkerKind
export type ProcessLifecyclePhase = 'idle' | 'shutting-down' | 'stopped'
export type OwnedTreeSignal = 'term' | 'kill'

export interface ProcessShutdownOptions {
  timeoutMs?: number
}

export interface ProcessShutdownRemaining {
  id: string
  agentId: string
  kind: WorkerKind
  pid?: number
  alive: boolean
  closed: boolean
  signaled: boolean
}

export interface ProcessTreeSignaler {
  /**
   * Signal the exact recorded PID. Windows also requests that PID's tree.
   * Must not invent exit metadata and must never match by process name.
   */
  signal(pid: number, mode: OwnedTreeSignal): void
}

export interface TerminalProcessLifecycleOptions {
  treeSignaler?: ProcessTreeSignaler
}

export interface TrackedOwnedWorker {
  readonly id: string
  readonly agentId: string
  readonly kind: WorkerKind
  pid: number | undefined
  readonly handle: WorkerHandle
  signaled: boolean
  /** Process-local signal (ChildProcess.kill / IPty.kill). Exact handle only. */
  signalLocal?: (force: boolean) => void
}

export class ProcessAdmissionError extends Error {
  readonly code = 'admission_closed' as const

  constructor(
    readonly runner: ProcessRunnerKind,
    readonly operation: string,
    readonly phase: ProcessLifecyclePhase
  ) {
    super(`${runner} ${operation} rejected: process runner is ${phase}`)
    this.name = 'ProcessAdmissionError'
  }
}

export class ProcessShutdownError extends Error {
  readonly code = 'shutdown_timeout' as const

  constructor(
    readonly runner: ProcessRunnerKind,
    readonly timeoutMs: number,
    readonly remaining: ProcessShutdownRemaining[],
    readonly phase: ProcessLifecyclePhase
  ) {
    super(
      `${runner} shutdown timed out after ${timeoutMs}ms with ${remaining.length} owned worker(s) still live`
    )
    this.name = 'ProcessShutdownError'
  }
}

export function isOwnedPid(pid: unknown): pid is number {
  return typeof pid === 'number' && Number.isInteger(pid) && pid > 0
}

export function isOwnedPidAlive(pid: number): boolean {
  if (!isOwnedPid(pid) || pid === process.pid) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    const code =
      error && typeof error === 'object' && 'code' in error
        ? String((error as { code?: unknown }).code)
        : ''
    return code === 'EPERM'
  }
}

/**
 * Linux-only: direct children of an exact recorded PID via /proc. Never used on
 * Windows (taskkill /T owns the tree) and never kills a process group.
 */
export function listDirectChildPids(pid: number): number[] {
  if (process.platform !== 'linux' || !isOwnedPid(pid)) return []
  const found = new Set<number>()
  try {
    for (const tid of readdirSync(`/proc/${pid}/task`)) {
      try {
        const raw = readFileSync(`/proc/${pid}/task/${tid}/children`, 'utf8')
        for (const part of raw.trim().split(/\s+/)) {
          if (!part) continue
          const child = Number(part)
          if (isOwnedPid(child) && child !== pid && child !== process.pid) found.add(child)
        }
      } catch {
        /* task or children file disappeared */
      }
    }
  } catch {
    /* /proc not available or pid already gone */
  }
  return [...found]
}

function collectOwnedDescendantPids(rootPid: number): number[] {
  const ordered: number[] = []
  const seen = new Set<number>([rootPid, process.pid])
  const queue = [rootPid]
  while (queue.length > 0 && ordered.length < MAX_OWNED_TREE_WALK) {
    const current = queue.shift()!
    for (const child of listDirectChildPids(current)) {
      if (seen.has(child)) continue
      seen.add(child)
      ordered.push(child)
      queue.push(child)
    }
  }
  return ordered
}

function posixSignal(pid: number, mode: OwnedTreeSignal): void {
  try {
    process.kill(pid, mode === 'kill' ? 'SIGKILL' : 'SIGTERM')
  } catch {
    /* ESRCH / EPERM: already gone or not signalable */
  }
}

export function windowsTaskkillArgs(pid: number, mode: OwnedTreeSignal): string[] {
  const args = ['/PID', String(pid), '/T']
  if (mode === 'kill') args.push('/F')
  return args
}

/**
 * Signal one owned PID. Windows uses taskkill with `/PID` + `/T` (and `/F` when
 * forced). POSIX signals only recorded PIDs — never `kill(-pid)`, which would
 * target a process group we did not create.
 */
export function signalOwnedProcessTree(pid: number, mode: OwnedTreeSignal): void {
  if (!isOwnedPid(pid) || pid === process.pid) return
  if (process.platform === 'win32') {
    const child = spawn('taskkill', windowsTaskkillArgs(pid, mode), {
      windowsHide: true,
      stdio: 'ignore'
    })
    child.on('error', () => undefined)
    child.unref()
    return
  }
  const descendants = collectOwnedDescendantPids(pid)
  posixSignal(pid, mode)
  for (const child of descendants) posixSignal(child, mode)
}

export function createDefaultProcessTreeSignaler(): ProcessTreeSignaler {
  return {
    signal(pid, mode) {
      signalOwnedProcessTree(pid, mode)
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export class ProcessLifecycleController {
  private phase: ProcessLifecyclePhase = 'idle'
  private readonly owned = new Map<string, TrackedOwnedWorker>()
  private readonly settlements = new Map<string, Promise<void>>()
  private inFlight: Promise<void> | null = null

  constructor(
    readonly runner: ProcessRunnerKind,
    private readonly signaler: ProcessTreeSignaler
  ) {}

  getPhase(): ProcessLifecyclePhase {
    return this.phase
  }

  getActiveCount(): number {
    let count = 0
    for (const worker of this.owned.values()) {
      if (worker.handle.alive || !worker.handle.closed) count += 1
    }
    return count
  }

  snapshotRemaining(): ProcessShutdownRemaining[] {
    const remaining: ProcessShutdownRemaining[] = []
    for (const worker of this.owned.values()) {
      if (!worker.handle.alive && worker.handle.closed) continue
      remaining.push({
        id: worker.id,
        agentId: worker.agentId,
        kind: worker.kind,
        ...(isOwnedPid(worker.pid) ? { pid: worker.pid } : {}),
        alive: worker.handle.alive,
        closed: worker.handle.closed,
        signaled: worker.signaled
      })
    }
    return remaining
  }

  assertAdmits(operation: string): void {
    if (this.phase === 'idle') return
    throw new ProcessAdmissionError(this.runner, operation, this.phase)
  }

  track(worker: TrackedOwnedWorker): void {
    this.owned.set(worker.id, worker)
    if (!this.settlements.has(worker.id)) {
      this.settlements.set(
        worker.id,
        Promise.all([worker.handle.waitForExit(), worker.handle.waitForClose()]).then(() => undefined)
      )
    }
  }

  untrackIfSettled(id: string): void {
    const worker = this.owned.get(id)
    if (!worker) return
    if (!worker.handle.alive && worker.handle.closed) {
      this.owned.delete(id)
      this.settlements.delete(id)
    }
  }

  /** Signal one still-owned worker without dropping ownership or inventing exit. */
  signalWorker(id: string, force = false): void {
    const worker = this.owned.get(id)
    if (!worker) return
    this.signalOne(worker, force)
  }

  beginShutdown(): void {
    if (this.phase === 'stopped') return
    this.phase = 'shutting-down'
    this.signalAll(false)
  }

  shutdown(options?: ProcessShutdownOptions): Promise<void> {
    this.beginShutdown()
    if (this.phase === 'stopped') return Promise.resolve()
    if (this.inFlight) return this.inFlight
    const timeoutMs = normalizeTimeoutMs(options?.timeoutMs)
    const drain = this.runDrain(timeoutMs)
    this.inFlight = drain
    return drain
  }

  private signalAll(force: boolean): void {
    for (const worker of this.owned.values()) {
      if (!worker.handle.alive && worker.handle.closed) continue
      this.signalOne(worker, force)
    }
  }

  private signalOne(worker: TrackedOwnedWorker, force: boolean): void {
    worker.signaled = true
    // Local first: Windows node-pty kill() must AttachConsole while the PTY is alive.
    // Headless Windows signalLocal is a no-op when a PID is recorded, so taskkill /T
    // below still sees a live parent. Never invent exit metadata here.
    try {
      worker.signalLocal?.(force)
    } catch {
      /* local handle may already be gone */
    }
    if (isOwnedPid(worker.pid)) {
      try {
        this.signaler.signal(worker.pid, force ? 'kill' : 'term')
      } catch {
        /* signaler must not invent exit; ignore throw so drain can still wait */
      }
    }
  }

  private async runDrain(timeoutMs: number): Promise<void> {
    const startedAt = Date.now()
    const deadline = startedAt + timeoutMs
    const forceAt = startedAt + Math.floor(timeoutMs / 2)
    let forced = false
    const allSettled = Promise.all(
      [...this.owned.keys()].map((id) => this.settlements.get(id) ?? Promise.resolve())
    ).then(() => undefined)
    let finished = false
    void allSettled.then(() => {
      finished = true
    })

    try {
      while (this.getActiveCount() > 0 && !finished) {
        const now = Date.now()
        if (now >= deadline) {
          throw new ProcessShutdownError(
            this.runner,
            timeoutMs,
            this.snapshotRemaining(),
            this.phase
          )
        }
        if (!forced && now >= forceAt) {
          forced = true
          this.signalAll(true)
        }
        await Promise.race([allSettled, sleep(50)])
      }

      if (this.getActiveCount() !== 0) {
        throw new ProcessShutdownError(this.runner, timeoutMs, this.snapshotRemaining(), this.phase)
      }

      this.owned.clear()
      this.settlements.clear()
      this.phase = 'stopped'
      this.inFlight = Promise.resolve()
    } catch (error) {
      this.inFlight = null
      throw error
    }
  }
}

function normalizeTimeoutMs(timeoutMs: number | undefined): number {
  if (timeoutMs === undefined) return DEFAULT_PROCESS_SHUTDOWN_TIMEOUT_MS
  if (!Number.isFinite(timeoutMs) || timeoutMs < 0) {
    return DEFAULT_PROCESS_SHUTDOWN_TIMEOUT_MS
  }
  return Math.floor(timeoutMs)
}


