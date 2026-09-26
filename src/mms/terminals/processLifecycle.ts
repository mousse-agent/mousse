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
  treeSignalPending?: boolean
  treeSignalError?: string
  capturedTreeAlive?: boolean
}

export interface ProcessTreeSignaler {
  /** Capture stable identities before signaling; permits draining after parent exit. */
  capture?(pid: number): CapturedProcessTree
  /**
   * Signal the exact recorded PID. Windows also requests that PID's tree.
   * Must not invent exit metadata and must never match by process name.
   */
  signal(pid: number, mode: OwnedTreeSignal): void | Promise<void>
}

export interface CapturedProcessTree {
  isAlive(): boolean
  signal(mode: OwnedTreeSignal): void
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
  treeSignalPending?: boolean
  treeSignalError?: string
  capturedTree?: CapturedProcessTree
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
  if (process.platform === 'linux') {
    try { return readLinuxProcessIdentity(pid) !== null } catch { return true }
  }
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

interface LinuxProcessIdentity { pid: number; startedAt: string }

function readLinuxProcessIdentity(pid: number): LinuxProcessIdentity | null {
  let stat: string
  try { stat = readFileSync(`/proc/${pid}/stat`, 'utf8') } catch (error) {
    if (['ENOENT', 'ESRCH'].includes((error as NodeJS.ErrnoException).code ?? '')) return null
    throw error
  }
  // comm can contain spaces/parentheses. Fields after its final ')' begin at
  // field 3 (state); field 22 (starttime) distinguishes reuse of a numeric PID.
  const fields = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/)
  if (fields[0] === 'Z' || fields[0] === 'X') return null // exited, awaiting reaping
  if (!/^\d+$/.test(fields[19] ?? '')) throw new Error(`Invalid /proc identity for PID ${pid}`)
  return { pid, startedAt: fields[19] }
}

function captureLinuxProcessTree(rootPid: number): CapturedProcessTree {
  if (!isOwnedPid(rootPid) || rootPid === process.pid) throw new Error('Refusing to capture an invalid or current process PID')
  const root = readLinuxProcessIdentity(rootPid)
  if (!root) return { isAlive: () => false, signal: () => undefined }
  const descendants = collectOwnedDescendantPids(rootPid)
  if (descendants.truncated) throw new Error(`Owned descendant inventory exceeded ${MAX_OWNED_TREE_WALK} processes`)
  const identities = [...descendants.pids.reverse(), rootPid]
    .map((pid) => pid === rootPid ? root : readLinuxProcessIdentity(pid))
    .filter((identity): identity is LinuxProcessIdentity => identity !== null)
  const stillOwned = (identity: LinuxProcessIdentity): boolean =>
    readLinuxProcessIdentity(identity.pid)?.startedAt === identity.startedAt
  return {
    isAlive: () => identities.some((identity) => {
      try { return stillOwned(identity) } catch { return true } // retain uncertain ownership
    }),
    signal: (mode) => {
      for (const identity of identities) {
        if (!stillOwned(identity)) continue
        try { process.kill(identity.pid, mode === 'kill' ? 'SIGKILL' : 'SIGTERM') } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error
        }
      }
    }
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

function collectOwnedDescendantPids(rootPid: number): { pids: number[]; truncated: boolean } {
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
  return { pids: ordered, truncated: queue.length > 0 }
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
export function signalOwnedProcessTree(pid: number, mode: OwnedTreeSignal): void | Promise<void> {
  if (!isOwnedPid(pid) || pid === process.pid) return
  if (process.platform === 'win32') {
    const child = spawn('taskkill', windowsTaskkillArgs(pid, mode), {
      windowsHide: true,
      stdio: 'ignore'
    })
    return new Promise((resolve, reject) => {
      child.once('error', reject)
      child.once('exit', (code) => {
        if (code === 0) resolve()
        else reject(new Error(`taskkill exited with code ${code ?? 'unknown'} for owned PID ${pid}`))
      })
    })
  }
  if (process.platform !== 'linux') {
    return Promise.reject(
      new Error(`Owned descendant termination is unsupported on ${process.platform}`)
    )
  }
  const descendants = collectOwnedDescendantPids(pid)
  posixSignal(pid, mode)
  for (const child of descendants.pids) posixSignal(child, mode)
  if (descendants.truncated) {
    return Promise.reject(
      new Error(`Owned descendant inventory exceeded ${MAX_OWNED_TREE_WALK} processes`)
    )
  }
}

export function createDefaultProcessTreeSignaler(): ProcessTreeSignaler {
  return {
    ...(process.platform === 'linux' ? { capture: captureLinuxProcessTree } : {}),
    signal(pid, mode) {
      return signalOwnedProcessTree(pid, mode)
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export class ProcessLifecycleController {
  private phase: ProcessLifecyclePhase = 'idle'
  private readonly owned = new Map<string, TrackedOwnedWorker>()
  private inFlight: Promise<void> | null = null
  private retrySignals = false

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
      if (
        worker.handle.alive ||
        !worker.handle.closed ||
        worker.capturedTree?.isAlive() ||
        worker.treeSignalPending ||
        worker.treeSignalError
      ) count += 1
    }
    return count
  }

  snapshotRemaining(): ProcessShutdownRemaining[] {
    const remaining: ProcessShutdownRemaining[] = []
    for (const worker of this.owned.values()) {
      if (
        !worker.handle.alive &&
        worker.handle.closed &&
        !worker.capturedTree?.isAlive() &&
        !worker.treeSignalPending &&
        !worker.treeSignalError
      ) continue
      remaining.push({
        id: worker.id,
        agentId: worker.agentId,
        kind: worker.kind,
        ...(isOwnedPid(worker.pid) ? { pid: worker.pid } : {}),
        alive: worker.handle.alive,
        closed: worker.handle.closed,
        signaled: worker.signaled,
        ...(worker.capturedTree?.isAlive() ? { capturedTreeAlive: true } : {}),
        ...(worker.treeSignalPending ? { treeSignalPending: true } : {}),
        ...(worker.treeSignalError ? { treeSignalError: worker.treeSignalError } : {})
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
  }

  untrackIfSettled(id: string): void {
    const worker = this.owned.get(id)
    if (!worker) return
    if (
      !worker.handle.alive &&
      worker.handle.closed &&
      !worker.capturedTree?.isAlive() &&
      !worker.treeSignalPending &&
      !worker.treeSignalError
    ) {
      this.owned.delete(id)
    }
  }

  /** Signal one still-owned worker without dropping ownership or inventing exit. */
  signalWorker(id: string, force = false): void {
    const worker = this.owned.get(id)
    if (!worker) return
    this.signalOne(worker, force)
  }

  beginShutdown(): void {
    if (this.phase !== 'idle') return
    this.phase = 'shutting-down'
    this.signalAll(false)
  }

  shutdown(options?: ProcessShutdownOptions): Promise<void> {
    this.beginShutdown()
    if (this.phase === 'stopped') return Promise.resolve()
    if (this.inFlight) return this.inFlight
    if (this.retrySignals) {
      this.retrySignals = false
      this.signalAll(false)
    }
    const timeoutMs = normalizeTimeoutMs(options?.timeoutMs)
    const drain = this.runDrain(timeoutMs)
    this.inFlight = drain
    return drain
  }

  private signalAll(force: boolean): void {
    for (const worker of this.owned.values()) {
      if (!worker.handle.alive && worker.handle.closed && !worker.capturedTree?.isAlive()) continue
      this.signalOne(worker, force)
    }
  }

  private signalOne(worker: TrackedOwnedWorker, force: boolean): void {
    // After transport exit only previously captured creation identities can be
    // signaled; never rediscover a tree using its now-reusable numeric root PID.
    const transportAlive = worker.handle.alive
    if (!transportAlive && !worker.capturedTree?.isAlive()) return
    if (worker.treeSignalPending) return
    worker.signaled = true
    // Inventory/signal the owned tree before killing the local handle. On Linux
    // a local kill can reparent descendants before /proc is read, losing them.
    // Windows transports suppress local termination while taskkill /T runs.
    if (isOwnedPid(worker.pid)) {
      try {
        worker.treeSignalError = undefined
        if (!worker.capturedTree && transportAlive && this.signaler.capture) {
          worker.capturedTree = this.signaler.capture(worker.pid)
        }
        const result = worker.capturedTree
          ? worker.capturedTree.signal(force ? 'kill' : 'term')
          : this.signaler.signal(worker.pid, force ? 'kill' : 'term')
        if (result && typeof (result as Promise<void>).then === 'function') {
          worker.treeSignalPending = true
          void Promise.resolve(result).then(
            () => {
              worker.treeSignalPending = false
              this.untrackIfSettled(worker.id)
            },
            (error: unknown) => {
              worker.treeSignalPending = false
              worker.treeSignalError = error instanceof Error ? error.message : String(error)
            }
          )
        }
      } catch (error) {
        worker.treeSignalError = error instanceof Error ? error.message : String(error)
      }
    }
    try {
      if (transportAlive && !worker.treeSignalError) worker.signalLocal?.(force)
    } catch {
      /* local handle may already be gone */
    }
  }

  private async runDrain(timeoutMs: number): Promise<void> {
    const startedAt = Date.now()
    const deadline = startedAt + timeoutMs
    const forceAt = startedAt + Math.floor(timeoutMs / 2)
    let forced = false
    try {
      while (this.getActiveCount() > 0) {
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
        // Do not race a permanently-resolved parent settlement here: a pending
        // tree signal may still need event-loop turns to publish taskkill exit.
        await sleep(50)
      }

      if (this.getActiveCount() !== 0) {
        throw new ProcessShutdownError(this.runner, timeoutMs, this.snapshotRemaining(), this.phase)
      }

      this.owned.clear()
      this.phase = 'stopped'
      this.inFlight = Promise.resolve()
    } catch (error) {
      this.inFlight = null
      this.retrySignals = true
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
