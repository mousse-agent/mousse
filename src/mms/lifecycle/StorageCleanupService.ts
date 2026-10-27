import { appendFileSync, existsSync, lstatSync, readFileSync, readdirSync, realpathSync, renameSync, rmdirSync, statSync, unlinkSync, type Dirent } from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'
import type { TaskLifecycleRecord } from '../../shared/resourceLifecycle'
import { REPORT_ENTRY_LIMIT, storagePolicyHasRule, type StorageCleanupItem, type StorageCleanupReport, type StoragePolicy } from '../../shared/storage'
import type { Thread } from '../../shared/types'
import type { ThreadWorkspaceMetadata } from '../../shared/workspace'
import { atomicWriteFileSync, atomicWriteJsonSync } from '../data/AtomicFs'
import { ThreadJournal } from '../data/ThreadJournal'
import { isIntegrated, primaryRemote, resolveDefaultBranch } from '../git/defaultBranch'
import { readOnlyGit } from '../git/readOnlyGit'
import { acquireRepositoryLease } from '../git/RepositoryLease'
import { resolveRepositoryIdentity } from '../git/RepositoryIdentity'
import { isExecutionLeaseHeld, releaseExecutionLeaseHandle, STORAGE_CLEANUP_LEASE_SOURCE, tryAcquireExecutionLease } from '../queue/ThreadExecutionLease'
import { MOUSSE_CONTROL_FILE_PATHS } from '../worktree/controlFiles'
import { measureTree, type Measurement } from './diskMeasure'
import { getExternalResourceClaims } from './LifecycleClaims'
import type { ResourcePurgeService, TrashSweepOutcome } from './ResourcePurgeService'
import { assertLifecyclePath, type ResourceLifecycleStore } from './ResourceLifecycleStore'
import type { PolicySnapshot, StoragePolicyStore } from './StoragePolicyStore'
import type { StorageSweepClock } from './sweepClock'
import { PartialWorktreeRemovalError, WorktreeRetirementService } from './WorktreeRetirementService'

const DAY_MS = 86_400_000
const FIRST_RUN_DELAY_MS = 5 * 60_000
const RUN_INTERVAL_MS = 60 * 60_000
const POLICY_CHANGE_DELAY_MS = 60_000
const SCHEDULED_BATCH = 20
const REPOSITORY_LEASE_WAIT_MS = 2_000
const MEASURE_BUDGET_MS = 20_000
const FORWARD_JUMP_NOTE_MS = 24 * 60 * 60_000
const TERMINAL_OPERATION_STATES = new Set(['completed', 'failed', 'cancelled'])
const HISTORY_FILE = 'storage-cleanup-history.jsonl'
const HISTORY_MAX_BYTES = 1024 * 1024
const HISTORY_KEEP_LINES = 2_000
/** A remembered "keep" for a deleted thread's worktree is looked at again after this long, whatever else is unchanged. */
const KEEP_MEMO_TTL_MS = 7 * DAY_MS
/** Errors that mean "not now" rather than "this failed": the profile or the task is busy. They are kept and retried. */
const BUSY_REASON = /^Cannot trash thread:|Cleanup owns this task|is still active|execution lease busy|Repository is busy/i
/** Keep reasons that can differ on the next look, so they are not remembered. */
const TRANSIENT_REASON = /Settings changed|Commit changed|in use|busy|owns this task|still active|lease/i
const IN_USE_REASON = 'Files in this worktree are in use'
/**
 * A screenshot capture: `art_<uuid>.png` (the worker and the attached browser) or `art_<uuid>` (the default
 * artifact port). Downloads share the `art_` prefix but never this shape: the worker adds `.download`, and an
 * older download keeps its own extension, so neither matches.
 */
const CAPTURE_NAME = /^art_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(\.png)?$/
const SESSION_NAME = /^[a-zA-Z0-9:_-]{1,160}$/
/** A file another process holds open fails to delete with these codes (on Windows also EPERM and EACCES). */
const IN_USE_CODES = new Set(process.platform === 'win32' ? ['EBUSY', 'EPERM', 'EACCES'] : ['EBUSY'])
/** These can also mean a lasting permission problem, so a file that keeps failing with one is reported as failed. */
const MAYBE_PERMANENT_CODES = new Set(['EPERM', 'EACCES'])
const MAX_IN_USE_TRIES = 3

/** The capture folder, the profile folder and one session folder, each with the canonical location it had when the run began. */
interface CaptureChain { root: string; rootReal: string; profileDir: string; profileReal: string; dir?: string; dirReal?: string }

/**
 * On Windows a directory cannot be renamed while a process has its working directory inside it or holds
 * a file in it open without delete sharing, which is also what makes `git worktree remove` stop partway.
 * Renaming the checkout away and straight back therefore tells, before anything is deleted, whether the
 * removal can finish. Elsewhere an open file does not block removal, so nothing is probed.
 */
function probeRemovable(path: string): string | undefined {
  if (process.platform !== 'win32') return undefined
  const probe = `${path}.probe-${process.pid}`
  try { renameSync(path, probe) } catch { return IN_USE_REASON }
  for (let attempt = 0; ; attempt++) {
    try { renameSync(probe, path); return undefined }
    catch (error) {
      if (attempt >= 20) throw new Error(`The worktree was moved to ${probe} while checking it and could not be moved back: ${(error as Error).message}`)
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50)
    }
  }
}

/** Written when a rule retires a worktree; `workspace.getStatus` reads it and a restore removes it. */
export interface CleanupMarker { retiredAt: string; rule: StorageCleanupItem['rule'] }

/**
 * Not under `workspaces/<taskId>/`: the resource inventory reads every `.json` file there as a
 * reconstruction manifest and would block the thread's trash and purge on an unknown one.
 */
export function cleanupMarkerPath(store: ResourceLifecycleStore, taskId: string): string {
  return join(store.root, 'storage-cleanup', `${taskId}.json`)
}
export function readCleanupMarker(store: ResourceLifecycleStore, taskId: string): CleanupMarker | undefined {
  const path = cleanupMarkerPath(store, taskId)
  try { return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) as CleanupMarker : undefined } catch { return undefined }
}
export function clearCleanupMarker(store: ResourceLifecycleStore, taskId: string): void {
  try { unlinkSync(cleanupMarkerPath(store, taskId)) } catch { /* Absent already. */ }
}

export interface StorageCleanupDeps {
  store: ResourceLifecycleStore
  threads: { getThread(threadId: string): Pick<Thread, 'id' | 'name' | 'projectId' | 'createdAt'> | undefined }
  purge: ResourcePurgeService
  policy: StoragePolicyStore
  clock: StorageSweepClock
  /** Why a thread is not idle (`threadHasPendingWork`), or undefined. */
  idle(threadId: string): string | undefined
  installationHome: string
  codeHost?: { cachedDefaultBranch(cwd: string): string | undefined }
  /**
   * Where the browser worker writes captures (`<root>/<profileId>/<sessionId>/art_<uuid>[.png]`) and what is
   * known about each session: whether it is still open and which thread it belongs to. `staleBefore` is a
   * time (ms): a session that has been disconnected since before it, with no worker to close it, counts as
   * closed. Without this dependency the browser capture rule does nothing.
   */
  browserCaptures?: { workerArtifactRoot: string; sessions(staleBefore: number): Map<string, { open: boolean; threadId?: string }> }
  now?: () => number
  /** Test seam: deletes one capture file. Defaults to `unlinkSync`. */
  removeFile?: (path: string) => void
  /** Told after every run with its report, so disk usage can be measured again when a run freed space. */
  onRunComplete?: (report: StorageCleanupReport) => void
  /** Test seam; defaults to `measureTree`. */
  measure?: typeof measureTree
  /** Test seam: returns why the checkout cannot be removed right now (files in use), or undefined. Defaults to a rename probe on Windows. */
  probeRemoval?: (worktreePath: string) => string | undefined
}

/** What evaluation decided about one worktree, before any lease is taken. */
type Verdict =
  | { keep: string }
  | { rule: 'worktree-inactive' | 'worktree-merged'; reason: string; head: string; workspace: ThreadWorkspaceMetadata; policyDigest: string; inactiveDays: number | null; measurement: Measurement }
interface Evaluation { record: TaskLifecycleRecord; label: string; projectId?: string; verdict: Verdict }

/** What evaluation decided about the worktree of a deleted thread. `remember` keeps a content-based keep for later runs. */
type DeletedVerdict =
  | { skip: true }
  | { keep: string; remember: boolean; fingerprint?: string }
  | { remove: true; head: string; workspace: ThreadWorkspaceMetadata; measurement: Measurement }

/** What the content checks found in a checkout that has nothing to keep it for the location and content reasons. */
type CheckoutFacts = { head: string; beyondBase: number; integrated: boolean }

/** One line of a dry run: what a run would do with an item right now, and why. Nothing has been changed. */
export interface PlannedCleanup {
  rule: StorageCleanupItem['rule']
  threadId?: string
  projectId?: string
  label: string
  action: 'remove' | 'keep'
  reason: string
  /** Space a removal would free (0 for a kept item), measured the way a run measures it. */
  bytes: number
  bytesApproximate?: true
  bytesLowerBound?: true
}

const approximate = (measurement: Pick<Measurement, 'estimated' | 'partial'>) => ({
  ...(measurement.estimated || measurement.partial ? { bytesApproximate: true as const } : {}),
  ...(measurement.partial && !measurement.estimated ? { bytesLowerBound: true as const } : {})
})
const plural = (count: number, noun: string): string => `${count} ${noun}${count === 1 ? '' : 's'}`
const samePath = (a: string, b: string): boolean => process.platform === 'win32' ? resolve(a).toLowerCase() === resolve(b).toLowerCase() : resolve(a) === resolve(b)
function within(root: string, path: string): boolean {
  const rel = relative(process.platform === 'win32' ? resolve(root).toLowerCase() : resolve(root), process.platform === 'win32' ? resolve(path).toLowerCase() : resolve(path))
  return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`))
}

function readWorkspaceFile(location: string): ThreadWorkspaceMetadata | undefined {
  const path = join(location, 'workspace.json')
  if (!existsSync(path)) return undefined
  const value = JSON.parse(readFileSync(path, 'utf8')) as Partial<ThreadWorkspaceMetadata>
  if (typeof value.worktreePath !== 'string' || typeof value.branch !== 'string' || typeof value.repositoryId !== 'string' || typeof value.headSha !== 'string' || !isAbsolute(value.worktreePath)) throw new Error('Workspace record is invalid')
  return value as ThreadWorkspaceMetadata
}

/**
 * Looks for a nested Git repository below `root` without hashing or following links. It is the
 * lease-free pre-check of the verifier's own `walkOwnedContent(root, true)` (which runs again under
 * the leases): the same entry and depth bounds, but no content digests, so an hourly scan of an idle
 * worktree does not read every file. `truncated` means a bound ended the scan.
 */
function findNestedRepository(root: string): { nested?: string; truncated: boolean } {
  let visited = 0
  const stack: Array<{ path: string; depth: number }> = [{ path: root, depth: 0 }]
  while (stack.length) {
    const { path, depth } = stack.pop()!
    if (depth > 64) return { truncated: true }
    let entries: Dirent[]
    try { entries = readdirSync(path, { withFileTypes: true }) } catch { return { truncated: true } }
    for (const entry of entries) {
      if (++visited > 100_000) return { truncated: true }
      if (entry.name === '.git') { if (path !== root) return { nested: relative(root, path).split('\\').join('/'), truncated: false }; continue }
      if (entry.isDirectory() && !entry.isSymbolicLink()) stack.push({ path: join(path, entry.name), depth: depth + 1 })
    }
  }
  return { truncated: false }
}

/** Ignored entries that are only Mousse control files do not keep a worktree (the verifier retains them). */
function onlyControlFiles(worktree: string, entry: string): boolean {
  const path = entry.replace(/\/$/, '')
  if (MOUSSE_CONTROL_FILE_PATHS.includes(path)) return true
  if (!entry.endsWith('/')) return false
  const directory = join(worktree, path)
  try {
    const names = readdirSync(directory, { recursive: true, withFileTypes: true }).filter((child) => !child.isDirectory())
    return names.length > 0 && names.every((child) => MOUSSE_CONTROL_FILE_PATHS.includes(`${path}/${relative(directory, join(child.parentPath, child.name)).split('\\').join('/')}`))
  } catch { return false }
}

/**
 * The daemon's storage cleanup rules. It evaluates thread worktrees in a fixed order with a plain
 * reason for every keep, retires a worktree only after the thread and repository leases are held and
 * the checks are repeated, runs the trash sweep through a reporting seam, guards against a clock set
 * backwards and stores the last report. Retirement is reversible: the worktree comes back on use.
 */
export class StorageCleanupService {
  private current?: Promise<StorageCleanupReport>
  private currentTrigger?: StorageCleanupReport['trigger']
  /** A manual run waiting for the scheduled run in progress to finish. */
  private queuedManual?: Promise<StorageCleanupReport>
  /** Content-based keeps for deleted threads' worktrees, so a worktree that was kept is not read and hashed again every hour. */
  private readonly keepMemo = new Map<string, { fingerprint: string; reason: string; at: number }>()
  private firstRun?: ReturnType<typeof setTimeout>
  private interval?: ReturnType<typeof setInterval>
  private afterPolicyChange?: ReturnType<typeof setTimeout>
  private stopping = false
  private cursor?: string
  private now: () => number
  private readonly measure: typeof measureTree
  private readonly probeRemoval: (worktreePath: string) => string | undefined
  private readonly removeFile: (path: string) => void
  /** Consecutive runs in which a capture could not be deleted because it looked in use (in memory). */
  private readonly lockedAttempts = new Map<string, number>()

  constructor(private readonly deps: StorageCleanupDeps) {
    this.now = deps.now ?? Date.now
    this.measure = deps.measure ?? measureTree
    this.probeRemoval = deps.probeRemoval ?? probeRemovable
    this.removeFile = deps.removeFile ?? unlinkSync
  }

  /** Test seam: replaces the clock used for ages and report times. */
  setClockForTests(now: () => number): void { this.now = now }

  start(): void {
    if (this.interval || this.firstRun) return
    this.stopping = false
    this.deps.clock.start()
    this.firstRun = setTimeout(() => {
      this.firstRun = undefined
      void this.run('schedule').catch(() => undefined)
      this.interval = setInterval(() => { void this.run('schedule').catch(() => undefined) }, RUN_INTERVAL_MS)
      this.interval.unref()
    }, FIRST_RUN_DELAY_MS)
    this.firstRun.unref()
  }

  async stop(): Promise<void> {
    this.stopping = true
    if (this.firstRun) clearTimeout(this.firstRun)
    if (this.interval) clearInterval(this.interval)
    if (this.afterPolicyChange) clearTimeout(this.afterPolicyChange)
    this.firstRun = this.interval = this.afterPolicyChange = undefined
    await this.current?.catch(() => undefined)
    await this.queuedManual?.catch(() => undefined)
  }

  /** Runs once, a minute after the policy last changed; further changes restart the minute. */
  scheduleAfterPolicyChange(): void {
    if (this.stopping) return
    if (this.afterPolicyChange) clearTimeout(this.afterPolicyChange)
    this.afterPolicyChange = setTimeout(() => {
      this.afterPolicyChange = undefined
      void this.run('schedule').catch(() => undefined)
    }, POLICY_CHANGE_DELAY_MS)
    this.afterPolicyChange.unref()
  }

  /** True while a run is in progress (or queued behind one). Disk usage scans wait for it. */
  isRunning(): boolean { return this.current !== undefined || this.queuedManual !== undefined }

  /** True while the time-based rules are paused after the clock moved backwards; saving the policy resumes them. */
  clockSuspended(): boolean { return this.deps.clock.suspended() }

  lastReport(): StorageCleanupReport | null {
    const path = this.reportPath
    try { return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) as StorageCleanupReport : null } catch { return null }
  }

  /**
   * One run at a time: a request during a run gets that run's report. The exception is a manual run
   * ("Clean up now") asked for during a scheduled one: the scheduled run looks at one batch of worktrees
   * and five trash records, so the manual request follows it and gets its own full run. Repeated manual
   * requests share that one queued run.
   */
  run(trigger: StorageCleanupReport['trigger']): Promise<StorageCleanupReport> {
    if (!this.current) return this.begin(trigger)
    if (trigger === 'manual' && this.currentTrigger === 'schedule') {
      this.queuedManual ??= this.current.catch(() => undefined).then(() => this.begin('manual')).finally(() => { this.queuedManual = undefined })
      return this.queuedManual
    }
    return this.current
  }

  private begin(trigger: StorageCleanupReport['trigger']): Promise<StorageCleanupReport> {
    this.currentTrigger = trigger
    const run: Promise<StorageCleanupReport> = this.execute(trigger).finally(() => { if (this.current === run) { this.current = undefined; this.currentTrigger = undefined } })
    this.current = run
    return run
  }

  /**
   * Dry run: what a run would remove or keep now, with the reason and the space it would free. It covers
   * everything a manual run touches (the worktrees of deleted threads, the inactive and merged rules,
   * overdue trash and unclaimed directories) and applies the same clock check and the same keep reasons.
   * It is read-only: no lease, no lifecycle-record, manifest or Git-ref write, no report, no history,
   * no memo and no change to the clock guard. A removal it lists can still be kept by the checks a run
   * repeats under the thread and repository leases, and by whether files are in use at that moment.
   */
  async plan(now = this.now()): Promise<PlannedCleanup[]> {
    const snapshot = this.deps.policy.snapshot()
    const clock = this.deps.clock.peek()
    const planned: PlannedCleanup[] = []
    if (clock.suspended) planned.push({ rule: 'worktree-inactive', label: 'Time-based rules', action: 'keep', reason: clock.reason ?? 'Paused after the system clock moved backwards', bytes: 0 })
    if (snapshot.policy.worktrees.removeWithDeletedThreads) planned.push(...await this.planDeletedThreadWorktrees(snapshot))
    for (const entry of await this.evaluateWorktrees(snapshot, !clock.suspended, now, false)) {
      const base = { threadId: entry.record.taskId, projectId: entry.projectId, label: entry.label }
      planned.push('rule' in entry.verdict
        ? { ...base, rule: entry.verdict.rule, action: 'remove', reason: entry.verdict.reason, bytes: entry.verdict.measurement.bytes, ...approximate(entry.verdict.measurement) }
        : { ...base, rule: 'worktree-inactive', action: 'keep', reason: entry.verdict.keep, bytes: 0 })
    }
    if (!clock.suspended) planned.push(...await this.planCaptures(snapshot, now))
    planned.push(...await this.planTrash(now))
    try {
      for (const orphan of await this.orphanItems()) planned.push({ rule: orphan.rule, label: orphan.label, action: 'keep', reason: orphan.reason, bytes: orphan.bytes, ...(orphan.bytesApproximate ? { bytesApproximate: true as const } : {}), ...(orphan.bytesLowerBound ? { bytesLowerBound: true as const } : {}) })
    } catch { /* Ownership could not be proven; a run reports nothing here either. */ }
    return planned
  }

  private async planDeletedThreadWorktrees(snapshot: PolicySnapshot): Promise<PlannedCleanup[]> {
    const planned: PlannedCleanup[] = []
    for (const record of this.deletedRoots()) {
      const { label, projectId } = this.labelFor(record.taskId)
      const base = { rule: 'worktree-deleted' as const, threadId: record.taskId, projectId, label }
      let verdict: DeletedVerdict
      try { verdict = await this.evaluateDeleted(record, snapshot, false) }
      catch (error) { planned.push({ ...base, action: 'keep', reason: (error as Error).message, bytes: 0 }); continue }
      if ('skip' in verdict) continue
      planned.push('keep' in verdict
        ? { ...base, action: 'keep', reason: verdict.keep, bytes: 0 }
        : { ...base, action: 'remove', reason: 'Thread was deleted', bytes: verdict.measurement.bytes, ...approximate(verdict.measurement) })
    }
    return planned
  }

  /** The capture rule's rows for the dry run: the same decisions as a run, with nothing deleted. */
  private async planCaptures(snapshot: PolicySnapshot, now: number): Promise<PlannedCleanup[]> {
    try {
      return (await this.captureItems(snapshot, now, false)).map((entry) => ({
        rule: entry.rule, label: entry.label, action: entry.outcome === 'removed' ? 'remove' as const : 'keep' as const, reason: entry.reason,
        bytes: entry.outcome === 'removed' ? entry.bytes : 0,
        ...(entry.outcome === 'removed' && entry.bytesApproximate ? { bytesApproximate: true as const } : {}),
        ...(entry.outcome === 'removed' && entry.bytesLowerBound ? { bytesLowerBound: true as const } : {})
      }))
    } catch (error) {
      return [{ rule: 'browser-capture', label: 'Browser captures', action: 'keep', reason: (error as Error).message, bytes: 0 }]
    }
  }

  private async planTrash(now: number): Promise<PlannedCleanup[]> {
    const purge = this.deps.purge
    try {
      if (!purge.policy().automaticPurge) {
        const waiting = purge.overdueTaskIds(now, true).length
        return waiting ? [{ rule: 'trash', label: `${plural(waiting, 'thread')} in the trash`, action: 'keep', reason: 'Automatic trash emptying is off', bytes: 0 }] : []
      }
      const ids = purge.overdueTaskIds(now)
      if (!ids.length) return []
      const status = purge.sweepStatus()
      if (status.suspended) return [{ rule: 'trash', label: `${plural(ids.length, 'thread')} in the trash`, action: 'keep', reason: status.reason ?? 'Automatic trash cleanup is paused', bytes: 0 }]
      const planned: PlannedCleanup[] = []
      for (const taskId of ids) {
        const { label, projectId } = this.labelFor(taskId)
        const base = { rule: 'trash' as const, threadId: taskId, projectId, label }
        try {
          const preview = await purge.previewReadOnly(taskId)
          if (preview.blockers.length || preview.items.some((item) => item.discardRequired)) {
            planned.push({ ...base, action: 'keep', reason: preview.blockers.join('; ') || 'Automatic trash cleanup retains unpublished or sole-copy content; review permanent deletion to decide.', bytes: 0 })
            continue
          }
          const reclaim = await purge.reclaimEstimate(preview)
          planned.push({ ...base, action: 'remove', reason: 'Retention passed', bytes: reclaim.bytes, ...approximate(reclaim) })
        } catch (error) {
          planned.push({ ...base, action: 'keep', reason: (error as Error).message, bytes: 0 })
        }
      }
      return planned
    } catch (error) {
      return [{ rule: 'trash', label: 'Trash', action: 'keep', reason: (error as Error).message, bytes: 0 }]
    }
  }

  private get reportPath(): string { return join(this.deps.store.root, 'storage-cleanup-last-run.json') }

  private labelFor(taskId: string): { label: string; projectId?: string } {
    const thread = this.deps.threads.getThread(taskId)
    if (thread) return { label: thread.name || taskId, ...(thread.projectId ? { projectId: thread.projectId } : {}) }
    try {
      const record = this.deps.store.get(taskId)
      const meta = record && JSON.parse(readFileSync(join(record.location, 'meta.json'), 'utf8')) as { name?: unknown; projectId?: unknown }
      if (meta && typeof meta.name === 'string' && meta.name.trim()) return { label: meta.name, ...(typeof meta.projectId === 'string' ? { projectId: meta.projectId } : {}) }
    } catch { /* The id still identifies it. */ }
    return { label: taskId }
  }

  private async execute(trigger: StorageCleanupReport['trigger']): Promise<StorageCleanupReport> {
    const startedMs = this.now()
    const items: StorageCleanupItem[] = []
    let suspended: string | undefined
    let clockNote: string | undefined
    // One snapshot for the whole run: the rules, and the digest that is compared under the leases, come from the same read.
    let snapshot: PolicySnapshot | undefined
    let hasRule = true
    try {
      snapshot = this.deps.policy.snapshot()
      let automaticPurge = false
      try { automaticPurge = this.deps.purge.policy().automaticPurge } catch { /* An unreadable trash policy keeps trash cleanup off. */ }
      hasRule = storagePolicyHasRule(snapshot.policy, { schemaVersion: 1, graceDays: 30, automaticPurge })
    } catch (error) {
      items.push({ rule: 'worktree-inactive', label: 'Storage settings', bytes: 0, outcome: 'failed', reason: `Storage policy could not be read: ${(error as Error).message}` })
    }
    // Checked before any age is evaluated and whether or not automatic trash emptying is on.
    const clock = this.deps.clock.check()
    if (clock.suspended) suspended = clock.reason
    else if ((clock.forwardJumpMs ?? 0) > FORWARD_JUMP_NOTE_MS) clockNote = `Clock moved forward by ${Math.round(clock.forwardJumpMs! / 3_600_000)} h since the last run`

    if (snapshot && (hasRule || trigger === 'manual')) {
      try { items.push(...await this.worktreePhase(snapshot, !clock.suspended, startedMs, trigger)) }
      catch (error) { items.push({ rule: 'worktree-inactive', label: 'Worktrees', bytes: 0, outcome: 'failed', reason: (error as Error).message }) }
      try { items.push(...await this.trashPhase(startedMs, trigger)) }
      catch (error) { items.push({ rule: 'trash', label: 'Trash', bytes: 0, outcome: 'failed', reason: (error as Error).message }) }
      // A time-based rule, so it waits while the clock is suspended (the report already says why).
      if (!clock.suspended) {
        try { items.push(...await this.captureItems(snapshot, startedMs, true)) }
        catch (error) { items.push({ rule: 'browser-capture', label: 'Browser captures', bytes: 0, outcome: 'failed', reason: (error as Error).message }) }
      }
      try { items.push(...await this.orphanItems()) } catch { /* Ownership could not be proven; nothing is reported. */ }
    }
    const report = this.buildReport(trigger, startedMs, items, suspended, clockNote)
    this.recordOutcomes(report.completedAt, trigger, items)
    // An hourly run with no rule on has nothing to say and must not replace the last manual report.
    if (trigger === 'manual' || hasRule) {
      try { atomicWriteJsonSync(this.reportPath, report) } catch { /* The report is still returned. */ }
    }
    try { this.deps.onRunComplete?.(report) } catch { /* A listener never changes what the run reports. */ }
    return report
  }

  private get historyPath(): string { return join(this.deps.store.root, HISTORY_FILE) }

  /**
   * Appends every removal and every failed removal to `storage-cleanup-history.jsonl`, one JSON line
   * each. The last-run report is replaced by the next run, and an hourly run that finds nothing would
   * otherwise erase the only record of what an earlier run deleted (or half-deleted). The file keeps its
   * newest lines once it grows past a limit, rewritten atomically. A write failure never undoes a
   * removal that already happened.
   */
  private recordOutcomes(at: string, trigger: string, items: StorageCleanupItem[]): void {
    const recorded = items.filter((item) => item.outcome === 'removed' || item.outcome === 'failed')
    if (!recorded.length) return
    try {
      const path = this.historyPath
      assertLifecyclePath(this.deps.store.root, path)
      if (existsSync(path) && statSync(path).size > HISTORY_MAX_BYTES) {
        atomicWriteFileSync(path, readFileSync(path, 'utf8').split('\n').filter(Boolean).slice(-HISTORY_KEEP_LINES).join('\n') + '\n')
      }
      appendFileSync(path, recorded.map((item) => JSON.stringify({ at, trigger, outcome: item.outcome, rule: item.rule, threadId: item.threadId, projectId: item.projectId, label: item.label, bytes: item.bytes, ...(item.files !== undefined ? { files: item.files } : {}), ...(item.bytesApproximate ? { bytesApproximate: true } : {}), reason: item.reason })).join('\n') + '\n')
    } catch { /* The report still lists the outcomes. */ }
  }

  private buildReport(trigger: StorageCleanupReport['trigger'], startedMs: number, items: StorageCleanupItem[], suspended?: string, clockNote?: string): StorageCleanupReport {
    const rank = { failed: 0, removed: 1, kept: 2 } as const
    const sorted = [...items].sort((a, b) => rank[a.outcome] - rank[b.outcome])
    const removed = sorted.filter((item) => item.outcome === 'removed')
    const approximateRemoved = removed.filter((item) => item.bytesApproximate)
    const bytesApproximate = approximateRemoved.length > 0
    return {
      startedAt: new Date(startedMs).toISOString(),
      completedAt: new Date(this.now()).toISOString(),
      trigger,
      bytesRecovered: removed.reduce((sum, item) => sum + item.bytes, 0),
      bytesApproximate,
      ...(bytesApproximate && approximateRemoved.every((item) => item.bytesLowerBound) ? { bytesLowerBound: true } : {}),
      ...(clockNote ? { clockNote } : {}),
      ...(suspended ? { suspended } : {}),
      counts: { removed: removed.length, kept: items.filter((item) => item.outcome === 'kept').length, failed: items.filter((item) => item.outcome === 'failed').length },
      items: sorted.slice(0, REPORT_ENTRY_LIMIT),
      omittedCount: Math.max(0, sorted.length - REPORT_ENTRY_LIMIT)
    }
  }

  // ---- Worktrees ----

  private async worktreePhase(snapshot: PolicySnapshot, timeRulesEnabled: boolean, now: number, trigger: StorageCleanupReport['trigger']): Promise<StorageCleanupItem[]> {
    const items: StorageCleanupItem[] = []
    if (snapshot.policy.worktrees.removeWithDeletedThreads) items.push(...await this.deletedThreadWorktrees(snapshot))
    const evaluations = await this.evaluateWorktrees(snapshot, timeRulesEnabled, now, trigger === 'schedule')
    for (const entry of evaluations) {
      if (this.stopping) break
      if ('keep' in entry.verdict) {
        items.push({ rule: 'worktree-inactive', threadId: entry.record.taskId, projectId: entry.projectId, label: entry.label, bytes: 0, outcome: 'kept', reason: entry.verdict.keep })
        continue
      }
      items.push(await this.retire(entry, entry.verdict))
    }
    return items
  }

  private deletedRoots(): TaskLifecycleRecord[] {
    return this.deps.store.list().filter((entry) => entry.state === 'trashed' && !entry.parentTaskId)
  }

  /** Worktrees of threads already in the trash, for a policy turned on after the thread was deleted. */
  private async deletedThreadWorktrees(snapshot: PolicySnapshot): Promise<StorageCleanupItem[]> {
    const items: StorageCleanupItem[] = []
    for (const record of this.deletedRoots()) {
      if (this.stopping) break
      // A policy saved while this loop was waiting on an earlier thread no longer authorizes the rest of it.
      if (this.deps.policy.digest() !== snapshot.digest) {
        items.push({ rule: 'worktree-deleted', label: 'Worktrees of deleted threads', bytes: 0, outcome: 'kept', reason: 'Settings changed since check' })
        break
      }
      const item = await this.retireDeleted(record, snapshot)
      if (item) items.push(item)
    }
    return items
  }

  /**
   * Removes the worktree of a thread that was just deleted, if the rule is on and the usual keep reasons
   * do not apply. `trashThread` calls this instead of retiring the checkout unconditionally, so the
   * immediate removal honours the same rules as the hourly one. The outcome is added to the history.
   */
  async retireDeletedWorktree(taskId: string): Promise<StorageCleanupItem | undefined> {
    const record = this.deps.store.get(taskId)
    if (!record || record.state !== 'trashed' || record.parentTaskId) return undefined
    const snapshot = this.deps.policy.snapshot()
    if (!snapshot.policy.worktrees.removeWithDeletedThreads) return undefined
    const item = await this.retireDeleted(record, snapshot)
    if (item) this.recordOutcomes(new Date(this.now()).toISOString(), 'trash', [item])
    return item
  }

  private deletedFingerprint(record: TaskLifecycleRecord, workspace: ThreadWorkspaceMetadata, snapshot: PolicySnapshot): string | undefined {
    try {
      return [snapshot.digest, readOnlyGit(workspace.worktreePath, ['rev-parse', 'HEAD']), statSync(workspace.worktreePath).mtimeMs, statSync(join(record.location, 'workspace.json')).mtimeMs].join('|')
    } catch { return undefined }
  }

  /**
   * The keep reasons for a deleted thread's worktree are the live rule's: where it is, whether it is in
   * use, uncommitted, untracked or ignored content, another repository, and commits that are not in the
   * default branch. A content-based keep is remembered (against HEAD, the folder's and the workspace
   * record's times and the policy) and not looked at again until one of those changes or a week passes,
   * so a worktree kept for its `node_modules` is not read and hashed every hour. Reads only, except for
   * the rename probe a real run makes.
   */
  private async evaluateDeleted(record: TaskLifecycleRecord, snapshot: PolicySnapshot, real: boolean): Promise<DeletedVerdict> {
    let workspace: ThreadWorkspaceMetadata | undefined
    try { workspace = readWorkspaceFile(record.location) } catch (error) { return { keep: (error as Error).message, remember: false } }
    if (!workspace || !existsSync(workspace.worktreePath)) return { skip: true }
    const fingerprint = this.deletedFingerprint(record, workspace, snapshot)
    const memo = this.keepMemo.get(record.taskId)
    if (fingerprint && memo?.fingerprint === fingerprint && this.now() - memo.at < KEEP_MEMO_TTL_MS) return { keep: memo.reason, remember: false }
    // A thread in the trash is no longer in the live index, so the lookup can fail with "not found": nothing is running for it.
    // The profile-wide idle check inside `retireTrashed` is the authority for a deletion in progress.
    let busy: string | undefined
    try { busy = this.deps.idle(record.taskId) } catch { busy = undefined }
    if (busy) return { keep: busy, remember: false }
    if (isExecutionLeaseHeld(record.location)) return { keep: 'Thread is in use', remember: false }
    if (workspace.lifecycle !== 'ready') return { keep: 'Workspace is not ready', remember: true, fingerprint }
    let facts: ReturnType<StorageCleanupService['inspectCheckout']>
    try { facts = this.inspectCheckout(record, workspace) } catch (error) { return { keep: (error as Error).message, remember: false } }
    if ('keep' in facts) return { keep: facts.keep, remember: true, fingerprint }
    if (real) {
      const inUse = this.probeRemoval(workspace.worktreePath)
      if (inUse) return { keep: inUse, remember: false }
    }
    return { remove: true, head: facts.head, workspace, measurement: await this.measure(workspace.worktreePath, { mode: 'reclaim', budgetMs: MEASURE_BUDGET_MS }) }
  }

  private async retireDeleted(record: TaskLifecycleRecord, snapshot: PolicySnapshot): Promise<StorageCleanupItem | undefined> {
    const { label, projectId } = this.labelFor(record.taskId)
    const base = { rule: 'worktree-deleted' as const, threadId: record.taskId, projectId, label }
    const kept = (reason: string): StorageCleanupItem => ({ ...base, bytes: 0, outcome: 'kept', reason })
    let verdict: DeletedVerdict
    try { verdict = await this.evaluateDeleted(record, snapshot, true) } catch (error) { return kept((error as Error).message) }
    if ('skip' in verdict) return undefined
    if ('keep' in verdict) {
      if (verdict.remember && verdict.fingerprint) this.keepMemo.set(record.taskId, { fingerprint: verdict.fingerprint, reason: verdict.keep, at: this.now() })
      return kept(verdict.keep)
    }
    const { workspace, head, measurement } = verdict
    const path = workspace.worktreePath
    // Runs under the cleanup reservation and the repository lease, right before the checkout is removed.
    const recheck = (candidate: string): string | undefined => {
      try {
        if (!samePath(candidate, path)) return 'Other worktrees of a deleted thread are removed when it is permanently deleted'
        if (this.deps.policy.digest() !== snapshot.digest) return 'Settings changed since check'
        const placement = this.placementProblem(workspace, record.taskId)
        if (placement) return placement
        if (readOnlyGit(path, ['rev-parse', 'HEAD']) !== head) return 'Commit changed since check'
        return this.probeRemoval(path)
      } catch (error) { return (error as Error).message }
    }
    try { await this.deps.purge.retireTrashed(record.taskId, { recheck }) }
    catch (error) {
      const reason = (error as Error).message
      return BUSY_REASON.test(reason) ? kept(reason) : { ...base, bytes: 0, outcome: 'failed', reason }
    }
    if (!existsSync(path)) {
      this.keepMemo.delete(record.taskId)
      return { ...base, bytes: measurement.bytes, files: measurement.files, ...approximate(measurement), outcome: 'removed', reason: 'Thread was deleted' }
    }
    if (!existsSync(join(path, '.git'))) {
      return { ...base, bytes: 0, outcome: 'failed', reason: this.deps.store.get(record.taskId)?.blockedReason ?? 'Worktree was partly removed because files in it were in use; it is rebuilt the next time the thread is used' }
    }
    const reason = this.deps.store.get(record.taskId)?.blockedReason ?? 'Worktree was kept'
    const fingerprint = this.deletedFingerprint(record, workspace, snapshot)
    if (fingerprint && !TRANSIENT_REASON.test(reason)) this.keepMemo.set(record.taskId, { fingerprint, reason, at: this.now() })
    return kept(reason)
  }

  /**
   * Pre-filter: every reason-producing check runs here with no lease held, so nothing in this phase
   * blocks a thread. A scheduled run looks at one batch per tick; a manual run looks at all of them.
   */
  private async evaluateWorktrees(snapshot: PolicySnapshot, timeRulesEnabled: boolean, now: number, batched: boolean): Promise<Evaluation[]> {
    const policy = snapshot.policy
    const inactiveOn = policy.worktrees.inactiveDays !== null && timeRulesEnabled
    const mergedOn = policy.worktrees.removeMerged
    if (!inactiveOn && !mergedOn) return []
    // Only live root threads. A trashed record belongs to the deleted-threads rule alone, and a
    // subagent's worktree goes with its thread.
    let candidates = this.deps.store.list().filter((record) => record.state === 'active' && !record.parentTaskId).sort((a, b) => a.taskId.localeCompare(b.taskId))
    candidates = candidates.filter((record) => {
      try { const workspace = readWorkspaceFile(record.location); return workspace === undefined ? false : existsSync(workspace.worktreePath) || workspace.lifecycle !== 'ready' }
      catch { return true }
    })
    if (batched && candidates.length > SCHEDULED_BATCH) {
      const after = this.cursor ? candidates.findIndex((record) => record.taskId.localeCompare(this.cursor!) > 0) : 0
      const start = after < 0 ? 0 : after
      candidates = [...candidates.slice(start), ...candidates.slice(0, start)].slice(0, SCHEDULED_BATCH)
      this.cursor = candidates.at(-1)?.taskId
    }
    const evaluations: Evaluation[] = []
    for (const record of candidates) {
      if (this.stopping) break
      const { label, projectId } = this.labelFor(record.taskId)
      let verdict: Verdict | undefined
      try { verdict = await this.evaluateOne(record, snapshot, inactiveOn, mergedOn, now) }
      catch (error) { verdict = { keep: (error as Error).message } }
      if (verdict) evaluations.push({ record, label, projectId, verdict })
    }
    return evaluations
  }

  private activityAt(record: TaskLifecycleRecord, workspace: ThreadWorkspaceMetadata, head: string): number {
    const times: number[] = [Date.parse(this.deps.threads.getThread(record.taskId)?.createdAt ?? record.createdAt)]
    for (const name of ['messages.json', 'workspace.json']) {
      try { times.push(statSync(join(record.location, name)).mtimeMs) } catch { /* No such file: it contributes nothing. */ }
    }
    const journal = new ThreadJournal(record.location, { readOnly: true }).list()
    if (journal.length) times.push(Date.parse(journal[journal.length - 1]!.createdAt))
    times.push(Number(readOnlyGit(workspace.worktreePath, ['log', '-1', '--format=%ct', head])) * 1000)
    return Math.max(...times.filter(Number.isFinite))
  }

  /**
   * Why the checkout may not be removed because of where it is, or undefined. It must be a real
   * directory (not a symlink or junction), inside the thread's managed folder by name, and still
   * inside the installation once every link above it is resolved. Evaluated again under the leases.
   */
  private placementProblem(workspace: ThreadWorkspaceMetadata, taskId: string): string | undefined {
    const path = workspace.worktreePath
    const folded = (value: string): string => process.platform === 'win32' ? value.toLowerCase() : value
    if (lstatSync(path).isSymbolicLink() || folded(realpathSync(path)) !== folded(join(realpathSync(dirname(path)), basename(path)))) return 'Worktree is a link'
    if (!within(join(this.deps.installationHome, 'repositories', workspace.repositoryId, 'worktrees', 'threads', taskId), path)) return 'Outside the managed worktree folder'
    // A link anywhere above the checkout (a repository folder that is a junction to another disk) resolves outside the installation.
    if (!within(realpathSync(this.deps.installationHome), realpathSync(path))) return 'Outside the managed worktree folder'
    return undefined
  }

  /**
   * The location and content reasons to keep a checkout, in a fixed order, shared by the live-thread rules
   * and the deleted-thread rule: not a repository any more, a link or a place outside Mousse's folders, an
   * unfinished operation, HEAD moved outside a recorded operation, uncommitted/untracked/ignored files,
   * another repository inside it, and commits that are not in the default branch. Reads only. A Git
   * failure throws and the caller keeps the worktree with its message.
   */
  private inspectCheckout(record: TaskLifecycleRecord, workspace: ThreadWorkspaceMetadata): { keep: string } | CheckoutFacts {
    const path = workspace.worktreePath
    if (!existsSync(join(path, '.git'))) return { keep: 'Worktree is partly removed; it is rebuilt the next time the thread is used' }
    const placement = this.placementProblem(workspace, record.taskId)
    if (placement) return { keep: placement }
    const unfinished = [...new ThreadJournal(record.location, { readOnly: true }).latestByOperation().values()].find((entry) => !TERMINAL_OPERATION_STATES.has(entry.state))
    if (unfinished) return { keep: 'Workspace has an unfinished operation' }
    const head = readOnlyGit(path, ['rev-parse', 'HEAD'])
    if (workspace.headSha !== head) return { keep: 'Workspace HEAD moved outside a recorded operation' }
    const changed = readOnlyGit(path, ['status', '--porcelain', '--untracked-files=all']).split(/\r?\n/).filter(Boolean).length
    if (changed) return { keep: `Has uncommitted changes (${plural(changed, 'file')})` }
    const nested = findNestedRepository(path)
    if (nested.nested) return { keep: 'Contains another repository' }
    const ignored = readOnlyGit(path, ['ls-files', '--others', '--ignored', '--exclude-standard', '--directory', '-z']).split('\0').filter(Boolean).filter((entry) => !onlyControlFiles(path, entry))
    if (ignored.length) return { keep: `Has ignored files (${ignored[0]})` }
    if (nested.truncated) return { keep: 'Worktree is too large to check for another repository' }
    const target = workspace.integrationTarget
    if (!target || !/^[a-f0-9]{40,64}$/.test(target.baseSha)) return { keep: 'Integration target is unknown' }
    const beyondBase = Number(readOnlyGit(path, ['rev-list', '--count', `${target.baseSha}..HEAD`]))
    if (!Number.isSafeInteger(beyondBase)) return { keep: 'Commits beyond the base could not be counted' }
    let integrated = false
    if (beyondBase > 0) {
      const defaults = resolveDefaultBranch(target.checkoutPath, this.deps.codeHost)
      if (!defaults) return { keep: `Default branch is unavailable; run \`git remote set-head ${primaryRemote(target.checkoutPath) ?? '<remote>'} --auto\`` }
      integrated = isIntegrated(path, head, defaults.refs)
      if (!integrated) return { keep: `Has ${plural(beyondBase, 'unpublished commit')}` }
    }
    return { head, beyondBase, integrated }
  }

  /** The fixed order of keep reasons; the first match wins. Undefined means skip silently. */
  private async evaluateOne(record: TaskLifecycleRecord, snapshot: PolicySnapshot, inactiveOn: boolean, mergedOn: boolean, now: number): Promise<Verdict | undefined> {
    const policy = snapshot.policy
    const workspace = readWorkspaceFile(record.location)
    if (!workspace) return undefined
    if (workspace.lifecycle !== 'ready') return { keep: 'Workspace is not ready' }
    const path = workspace.worktreePath
    if (!existsSync(path)) return undefined
    const busy = this.deps.idle(record.taskId)
    if (busy) return { keep: busy }
    if (isExecutionLeaseHeld(record.location)) return { keep: 'Thread is in use' }
    const facts = this.inspectCheckout(record, workspace)
    if ('keep' in facts) return facts
    const { head, beyondBase, integrated } = facts
    let rule: 'worktree-inactive' | 'worktree-merged' | undefined
    let reason = ''
    const reasons: string[] = []
    if (inactiveOn) {
      const ageDays = Math.max(0, (now - this.activityAt(record, workspace, head)) / DAY_MS)
      if (ageDays >= policy.worktrees.inactiveDays!) { rule = 'worktree-inactive'; reason = `Inactive for ${Math.floor(ageDays)} days` }
      else reasons.push(`Inactive for ${Math.floor(ageDays)} of ${policy.worktrees.inactiveDays} days`)
    }
    if (!rule && mergedOn) {
      if (beyondBase === 0 || !integrated) reasons.push('No commits to merge yet')
      // The merged rule reads no age, so a merged thread the person keeps coming back to would be retired,
      // restored by the next status refresh and retired again every hour. A worktree restored or changed in
      // the last day is left alone.
      else if (now - statSync(join(record.location, 'workspace.json')).mtimeMs < DAY_MS) reasons.push('Restored or changed within the last day')
      else { rule = 'worktree-merged'; reason = 'Work is merged into the default branch' }
    }
    if (!rule) return { keep: reasons.join('; ') }
    const measurement = await this.measure(path, { mode: 'reclaim', budgetMs: MEASURE_BUDGET_MS })
    return { rule, reason, head, workspace, policyDigest: snapshot.digest, inactiveDays: policy.worktrees.inactiveDays, measurement }
  }

  /**
   * Take the thread lease, then the repository lease (the order `ThreadWorkspaceManager.restore` and
   * `GitOperationCoordinator` use), repeat the checks that can change, and only then prepare and
   * retire. Expected hold time is the re-check plus `prepare` and `retire`, plus up to two seconds
   * waiting for the repository lease. Removed means `retire` returned. A removal that Git stopped
   * partway (files in use) is a failure, not a keep.
   */
  private async retire(entry: Evaluation, verdict: Extract<Verdict, { rule: unknown }>): Promise<StorageCleanupItem> {
    const { record, label, projectId } = entry
    const { workspace, head, measurement } = verdict
    const base = { rule: verdict.rule, threadId: record.taskId, projectId, label }
    const kept = (reason: string): StorageCleanupItem => ({ ...base, bytes: 0, outcome: 'kept', reason })
    const failed = (reason: string): StorageCleanupItem => ({ ...base, bytes: 0, outcome: 'failed', reason })
    const taskLease = tryAcquireExecutionLease(record.location, { source: STORAGE_CLEANUP_LEASE_SOURCE })
    if (!taskLease) return kept('Thread is in use')
    try {
      const identity = resolveRepositoryIdentity(workspace.worktreePath, { requireMutationCapability: true })
      let repositoryLease
      try { repositoryLease = await acquireRepositoryLease(identity, { signal: AbortSignal.timeout(REPOSITORY_LEASE_WAIT_MS) }) }
      catch { return kept('Repository is busy') }
      try {
        if (this.deps.policy.digest() !== verdict.policyDigest) return kept('Settings changed since check')
        const busy = this.deps.idle(record.taskId)
        if (busy) return kept('Thread became busy')
        const bound = readWorkspaceFile(record.location)
        if (!bound || bound.worktreePath !== workspace.worktreePath || bound.branch !== workspace.branch || bound.headSha !== workspace.headSha || bound.lifecycle !== workspace.lifecycle) return kept('Workspace changed since check')
        const placement = this.placementProblem(workspace, record.taskId)
        if (placement) return kept(placement)
        if (readOnlyGit(workspace.worktreePath, ['rev-parse', 'HEAD']) !== head) return kept('Commit changed since check')
        // A manual run evaluates every worktree before it retires the first, so the thread may have been used since.
        if (verdict.rule === 'worktree-inactive' && verdict.inactiveDays !== null && (this.now() - this.activityAt(record, bound, head)) / DAY_MS < verdict.inactiveDays) return kept('Thread was used since check')
        const retirement = new WorktreeRetirementService(this.deps.store, { taskLease, repositoryLease })
        retirement.prepare({ taskId: record.taskId, worktreePath: workspace.worktreePath, branch: workspace.branch, sourcePath: join(record.location, 'workspace.json'), repositoryId: workspace.repositoryId, baseSha: workspace.baseSha, resultSha: head })
        let inUse: string | undefined
        try { inUse = this.probeRemoval(workspace.worktreePath) } catch (error) { return failed((error as Error).message) }
        if (inUse) return kept(inUse)
        try { retirement.retire(retirement.pathFor(record.taskId, workspace.worktreePath)) }
        catch (error) { if (error instanceof PartialWorktreeRemovalError) return failed(error.message); throw error }
        try { atomicWriteJsonSync(cleanupMarkerPath(this.deps.store, record.taskId), { retiredAt: new Date(this.now()).toISOString(), rule: verdict.rule } satisfies CleanupMarker) }
        catch { /* The checkout is gone and restorable; only the status note is missing. */ }
        return { ...base, bytes: measurement.bytes, files: measurement.files, ...approximate(measurement), outcome: 'removed', reason: verdict.reason }
      } catch (error) {
        return kept((error as Error).message)
      } finally { repositoryLease.release() }
    } catch (error) {
      return kept((error as Error).message)
    } finally { releaseExecutionLeaseHandle(taskLease) }
  }

  // ---- Browser captures ----

  /** `path` is a real directory (not a link or junction) and resolves to exactly `expectedReal`. */
  private isRealDirectoryAt(path: string, expectedReal: string): boolean {
    const folded = (value: string): string => process.platform === 'win32' ? value.toLowerCase() : value
    try {
      const stat = lstatSync(path)
      return !stat.isSymbolicLink() && stat.isDirectory() && folded(realpathSync.native(path)) === folded(expectedReal)
    } catch { return false }
  }

  /**
   * The whole chain from the capture folder down to the session folder, each level a real directory
   * that resolves to the canonical location it had when the run began. A level swapped for a link
   * (or moved and replaced) anywhere above the files fails here, so no deletion can be redirected.
   */
  private captureChainIntact(chain: CaptureChain): boolean {
    return this.isRealDirectoryAt(chain.root, chain.rootReal)
      && this.isRealDirectoryAt(chain.profileDir, chain.profileReal)
      && (chain.dir === undefined || this.isRealDirectoryAt(chain.dir, chain.dirReal!))
  }

  /** Regular files in a session folder that are named like a screenshot capture and are not newer than `cutoff`. */
  private oldCaptures(dir: string, cutoff: number): string[] {
    const names: string[] = []
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!CAPTURE_NAME.test(entry.name)) continue
      try {
        const stat = lstatSync(join(dir, entry.name))
        if (stat.isFile() && !stat.isSymbolicLink() && stat.mtimeMs <= cutoff) names.push(entry.name)
      } catch { /* Gone already. */ }
    }
    return names
  }

  /** Row identity for one session: the thread's name when the session's thread is known, and always the session id. */
  private captureBase(id: string, threadId: string | undefined): Pick<StorageCleanupItem, 'rule' | 'label' | 'threadId' | 'projectId'> {
    const known = threadId !== undefined && (this.deps.threads.getThread(threadId) !== undefined || this.deps.store.get(threadId) !== undefined)
    if (!known) return { rule: 'browser-capture', label: `Browser session ${id}` }
    const { label, projectId } = this.labelFor(threadId!)
    return { rule: 'browser-capture', label: `${label}: browser session ${id}`, threadId, ...(projectId ? { projectId } : {}) }
  }

  /**
   * The browser capture rule. It deletes screenshot captures that were never imported: files named
   * `art_<uuid>` or `art_<uuid>.png` directly inside `<workerArtifactRoot>/<profileId>/<sessionId>/` that are
   * at least `captureDays` old, in sessions that are closed. A screenshot a conversation uses was copied into
   * the profile's artifact store first, so nothing here is referenced by a thread or message; that store, its
   * index and every other file are never touched. Downloads are not captures: the worker names them with a
   * `.download` ending and any other extension is left alone.
   *
   * Nothing is followed. The capture folder is canonicalized once, and it, the profile folder and each
   * session folder must stay real directories at their canonical locations; the whole chain is checked again
   * right before every deletion. A level that was swapped for a link or junction ends that session's work.
   * One session failing does not stop the others or erase what earlier sessions already deleted. `real: false`
   * makes the same decisions and measurements without deleting, for the dry run.
   */
  private async captureItems(snapshot: PolicySnapshot, now: number, real: boolean): Promise<StorageCleanupItem[]> {
    const config = this.deps.browserCaptures
    const days = snapshot.policy.browser.captureDays
    if (!config || days === null) return []
    const rule = 'browser-capture' as const
    const root = resolve(config.workerArtifactRoot), profileId = this.deps.store.profileId
    try { lstatSync(root) } catch { return [] }
    const everything = { rule, label: 'Browser captures', bytes: 0, outcome: 'kept' as const }
    const folded = (value: string): string => process.platform === 'win32' ? value.toLowerCase() : value
    let rootReal: string
    try {
      // Both sides are canonical: a link above the profile home (a moved home, a mapped drive, a short 8.3 name) is
      // fine, a link at or below the capture folder that leads anywhere else is not.
      rootReal = realpathSync.native(root)
      const expected = join(realpathSync.native(this.deps.store.profileHome), 'browser', 'worker-artifacts')
      const stat = lstatSync(root)
      if (stat.isSymbolicLink() || !stat.isDirectory() || folded(rootReal) !== folded(expected)) return [{ ...everything, reason: 'Outside the browser capture folder' }]
    } catch (error) { return [{ ...everything, reason: `The browser capture folder could not be checked: ${(error as Error).message}` }] }
    const profileDir = join(root, profileId), profileReal = join(rootReal, profileId)
    try { lstatSync(profileDir) } catch { return [] }
    if (!this.isRealDirectoryAt(profileDir, profileReal)) return [{ ...everything, reason: 'Outside the browser capture folder' }]

    const items: StorageCleanupItem[] = []
    const cutoff = now - days * DAY_MS
    let sessions: Map<string, { open: boolean; threadId?: string }> | undefined
    try {
      for (const entry of readdirSync(profileDir, { withFileTypes: true })) {
        if (this.stopping) break
        const id = entry.name
        if (!SESSION_NAME.test(id)) continue
        const chain: CaptureChain = { root, rootReal, profileDir, profileReal, dir: join(profileDir, id), dirReal: join(profileReal, id) }
        if (!this.captureChainIntact(chain)) continue
        let base = { rule, label: `Browser session ${id}` } as ReturnType<StorageCleanupService['captureBase']>
        try {
          const old = this.oldCaptures(chain.dir!, cutoff)
          if (!old.length) continue
          try { sessions ??= new Map(config.sessions(cutoff)) }
          catch (error) { items.push({ ...everything, reason: `Browser sessions could not be read, so no capture was deleted: ${(error as Error).message}` }); break }
          const info = sessions.get(id)
          base = this.captureBase(id, info?.threadId)
          if (info?.open) { items.push({ ...base, bytes: 0, outcome: 'kept', reason: 'Session is not closed' }); continue }
          // A policy saved while an earlier session was being cleaned no longer authorizes the rest.
          if (real && this.deps.policy.digest() !== snapshot.digest) { items.push({ ...everything, reason: 'Settings changed since check' }); break }
          items.push(...await this.removeCaptures(chain, base, old, days, cutoff, real ? snapshot.digest : undefined))
          if (items.at(-1)?.reason === 'Settings changed since check') break
        } catch (error) {
          // A folder that vanished is nothing to clean; any other error is this session's failure only.
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') items.push({ ...base, bytes: 0, outcome: 'failed', reason: (error as Error).message })
        }
        await new Promise<void>((resolveYield) => setImmediate(resolveYield))
      }
    } catch (error) {
      items.push({ ...everything, outcome: 'failed', reason: (error as Error).message })
    }
    if (real) for (const path of [...this.lockedAttempts.keys()]) if (!existsSync(path)) this.lockedAttempts.delete(path)
    return items
  }

  /**
   * Measures and deletes the old captures of one closed session, then removes the folder if nothing else
   * is in it. `policyDigest` is given for a real run (a dry run passes none and deletes nothing).
   */
  private async removeCaptures(chain: CaptureChain, base: Pick<StorageCleanupItem, 'rule' | 'label' | 'threadId' | 'projectId'>, names: string[], days: number, cutoff: number, policyDigest: string | undefined): Promise<StorageCleanupItem[]> {
    const real = policyDigest !== undefined
    const dir = chain.dir!
    let bytes = 0, removed = 0, inUse = 0, estimated = false, partial = false, settingsChanged = false
    const failures: string[] = []
    for (const name of names) {
      if (this.stopping) break
      const path = join(dir, name)
      const measurement = await this.measure(path, { mode: 'reclaim', budgetMs: MEASURE_BUDGET_MS })
      if (real) {
        try {
          // The policy, the whole folder chain and the file are looked at again, in one synchronous step, right before the deletion.
          if (this.deps.policy.digest() !== policyDigest) { settingsChanged = true; break }
          if (!this.captureChainIntact(chain)) { failures.push('The capture folder changed while it was being cleaned'); break }
          const stat = lstatSync(path)
          if (!stat.isFile() || stat.mtimeMs > cutoff) continue
          this.removeFile(path)
          this.lockedAttempts.delete(path)
        } catch (error) {
          const code = (error as NodeJS.ErrnoException).code
          if (code === 'ENOENT') { this.lockedAttempts.delete(path); continue }
          if (code && IN_USE_CODES.has(code)) {
            // EBUSY is a file in use. EPERM and EACCES can also be a lasting permission problem, so after a few
            // runs in a row the file is reported as failed instead of promising another try.
            const tries = (this.lockedAttempts.get(path) ?? 0) + 1
            if (MAYBE_PERMANENT_CODES.has(code) && tries >= MAX_IN_USE_TRIES) failures.push(`${name} could not be deleted after ${MAX_IN_USE_TRIES} tries: ${(error as Error).message}`)
            else { this.lockedAttempts.set(path, tries); inUse += 1 }
          } else failures.push((error as Error).message)
          continue
        }
      }
      removed += 1; bytes += measurement.bytes
      estimated = estimated || measurement.estimated; partial = partial || measurement.partial
    }
    const items: StorageCleanupItem[] = []
    if (removed) {
      if (real && this.captureChainIntact(chain)) { try { rmdirSync(dir) } catch { /* Other files remain, or it is gone. */ } }
      items.push({ ...base, bytes, files: removed, ...approximate({ estimated, partial }), outcome: 'removed', reason: `${plural(removed, 'capture')} older than ${plural(days, 'day')}` })
    }
    if (inUse) items.push({ ...base, bytes: 0, outcome: 'kept', reason: `${plural(inUse, 'capture')} in use; tried again on the next run` })
    if (failures.length) items.push({ ...base, bytes: 0, outcome: 'failed', reason: failures[0]! })
    if (settingsChanged) items.push({ ...base, bytes: 0, outcome: 'kept', reason: 'Settings changed since check' })
    return items
  }

  // ---- Orphans ----

  /** Directories in the managed worktree folders that nothing claims. Reported with their size, never removed. */
  private async orphanItems(): Promise<StorageCleanupItem[]> {
    const claimed = getExternalResourceClaims(this.deps.store, new Set()).map((resource) => resource.identity).filter((identity) => isAbsolute(identity))
    const items: StorageCleanupItem[] = []
    const repositories = join(this.deps.installationHome, 'repositories')
    if (!existsSync(repositories)) return items
    for (const repository of readdirSync(repositories)) {
      for (const kind of ['threads', 'agents']) {
        const folder = join(repositories, repository, 'worktrees', kind)
        if (!existsSync(folder)) continue
        for (const name of readdirSync(folder)) {
          if (this.stopping) return items
          const directory = join(folder, name)
          let stat
          try { stat = lstatSync(directory) } catch { continue }
          if (!stat.isDirectory() || stat.isSymbolicLink()) continue
          if (claimed.some((identity) => within(directory, identity) || within(identity, directory))) continue
          const measurement = await this.measure(directory, { mode: 'reclaim', budgetMs: MEASURE_BUDGET_MS })
          if (!measurement.files) continue // An empty leftover folder holds nothing.
          items.push({ rule: 'worktree-orphan', label: `${kind}/${name}`, bytes: measurement.bytes, files: measurement.files, ...approximate(measurement), outcome: 'kept', reason: 'No thread uses this worktree' })
        }
      }
    }
    return items
  }

  // ---- Trash ----

  private trashItem(outcome: TrashSweepOutcome): StorageCleanupItem {
    const { label, projectId } = this.labelFor(outcome.taskId)
    // A profile that is busy right now is not a failure; the record is tried again on the next run.
    const busy = outcome.outcome === 'failed' && BUSY_REASON.test(outcome.reason ?? '')
    return {
      rule: 'trash', threadId: outcome.taskId, projectId, label, bytes: outcome.outcome === 'purged' ? outcome.bytes : 0,
      ...(outcome.outcome === 'purged' ? { ...(outcome.bytesApproximate ? { bytesApproximate: true as const } : {}), ...(outcome.bytesLowerBound ? { bytesLowerBound: true as const } : {}) } : {}),
      outcome: outcome.outcome === 'purged' ? 'removed' : busy ? 'kept' : outcome.outcome,
      reason: outcome.outcome === 'purged' ? 'Retention passed' : outcome.reason ?? 'Kept'
    }
  }

  /**
   * A scheduled run purges at most five overdue records. A manual run takes a snapshot of the
   * overdue records at its start and attempts each at most once (kept and failed count as attempted),
   * so a record that stays retained cannot make it loop. A later run may try kept records again.
   */
  private async trashPhase(now: number, trigger: StorageCleanupReport['trigger']): Promise<StorageCleanupItem[]> {
    const purge = this.deps.purge
    if (trigger === 'schedule') return (await purge.requestSweep(now, { limit: 5 })).map((outcome) => this.trashItem(outcome))
    const snapshot = purge.overdueTaskIds(now)
    if (!purge.policy().automaticPurge) {
      // Only worth a line when something in the trash is already past its retention.
      const waiting = purge.overdueTaskIds(now, true).length
      return waiting ? [{ rule: 'trash', label: `${plural(waiting, 'thread')} in the trash`, bytes: 0, outcome: 'kept', reason: 'Automatic trash emptying is off' }] : []
    }
    const remaining = new Set(snapshot)
    const outcomes: TrashSweepOutcome[] = []
    for (let rounds = snapshot.length + 2; remaining.size && rounds > 0 && !this.stopping; rounds--) {
      if (purge.sweepStatus().suspended) break
      const batch = await purge.requestSweep(now, { limit: 5, only: remaining })
      if (!batch.length) break
      for (const outcome of batch) { remaining.delete(outcome.taskId); outcomes.push(outcome) }
    }
    const items = outcomes.map((outcome) => this.trashItem(outcome))
    const status = purge.sweepStatus()
    if (status.suspended) items.push({ rule: 'trash', label: 'Trash', bytes: 0, outcome: 'kept', reason: status.reason ?? 'Automatic trash cleanup is paused' })
    return items
  }
}
