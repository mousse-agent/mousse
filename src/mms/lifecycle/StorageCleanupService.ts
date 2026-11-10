import { knownAppError } from '../../shared/errors'
import { chosenFolderPlace, disconnectedWorktreeFolder, driveNotConnectedText, isThreadWorktreePlace, worktreeContainers } from '../worktree/worktreeLayout'
import { appendFileSync, existsSync, lstatSync, readFileSync, readdirSync, realpath as realpathCallback, realpathSync, renameSync, rmdirSync, statSync, unlinkSync, type Dirent } from 'node:fs'
import { access, lstat, readdir, stat } from 'node:fs/promises'
import { promisify } from 'node:util'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'
import type { TaskLifecycleRecord } from '../../shared/resourceLifecycle'
import { REPORT_ENTRY_LIMIT, storagePolicyHasRule, STORAGE_PLAN_TTL_MS, type StorageCleanupItem, type StorageCleanupPlanItem, type StorageCleanupPlanToken, type StorageCleanupReport, type StoragePolicy } from '../../shared/storage'
import type { Thread } from '../../shared/types'
import type { ThreadWorkspaceMetadata } from '../../shared/workspace'
import { atomicWriteFileSync, atomicWriteJsonSync } from '../data/AtomicFs'
import { ThreadJournal } from '../data/ThreadJournal'
import { isIntegratedAsync, primaryRemoteAsync, resolveDefaultBranchAsync } from '../git/defaultBranch'
import { operationInProgressAsync } from '../actions/git'
import { publishedRef } from '../actions/snapshots'
import { readOnlyGitAsync, runReadOnlyGitAsync } from '../git/readOnlyGit'
import { LISTING_MAX_BUFFER } from '../git/runGitProcess'
import { acquireRepositoryLease } from '../git/RepositoryLease'
import { resolveRepositoryIdentityAsync } from '../git/RepositoryIdentity'
import { isExecutionLeaseHeld, releaseExecutionLeaseHandle, STORAGE_CLEANUP_LEASE_SOURCE, tryAcquireExecutionLease } from '../queue/ThreadExecutionLease'
import { MOUSSE_CONTROL_FILE_PATHS } from '../worktree/controlFiles'
import { measureTree, type Measurement } from './diskMeasure'
import { claimOverlapsPath, getExternalResourceClaims, repositoryTargetAsync, unverifiedOwnerOver } from './LifecycleClaims'
import { canonicalPathAsync, gitCommonDirAsync } from './canonicalPath'
import type { ResourcePurgeService, TrashSweepOutcome } from './ResourcePurgeService'
import { assertLifecyclePath, type ResourceLifecycleStore } from './ResourceLifecycleStore'
import type { PolicySnapshot, StoragePolicyStore } from './StoragePolicyStore'
import type { StorageSweepClock } from './sweepClock'
import { WORKTREE_TRASH_QUIET_MS, WorktreeRetirementService } from './WorktreeRetirementService'
import { expireSnapshotTrash } from '../workspace/SnapshotWorkspace'
import { expireTrashedSnapshotRefs, trashRemovedProjectStores } from '../actions/SnapshotRefReleaseService'
import { WorktreeManager } from '../worktree/WorktreeManager'
import { CLEANUP_QUIET_MS, cleanupRecordFor, DELETING_NAME, listCleanupRecords, onlyInFolderAsync, resumeCleanupAsync, type CleanupRecord } from '../worktree/verifiedCleanup'
import { forgetKeptWorktree, listKeptWorktrees, type KeptWorktree } from './keptWorktrees'
import { dispatchKeptFilesOwner, projectKeptFilesOwners, registerDispatchKeptFilesFolder } from '../actions/keptCopies'

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
/** `realpathSync` without blocking (the same answers, unlike `fs/promises`' native one). */
const realpathLike = promisify(realpathCallback)
/** Whether `path` is there, as `existsSync` answers; read without blocking. */
const present = (path: string): Promise<boolean> => access(path).then(() => true, () => false)
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
 * removal can finish. Elsewhere an open file does not block removal, so nothing is probed. It stays synchronous: the
 * folder is away only within this one call, so nothing else ever finds the checkout missing (Windows only, and only
 * a rename within Mousse's own folder).
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
  /** Stops disk measurement until the returned function is called. A run and an immediate removal hold it while they rename and delete. */
  quiesceDisk?: () => Promise<() => void>
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
type CheckoutFacts = { head: string; beyondBase: number; integrated: boolean; uncommitted: number }

/** One line of a dry run; the shape the Storage page reads. */
export type PlannedCleanup = StorageCleanupPlanItem

const worktreeKey = (taskId: string): string => `worktree:${taskId}`
const trashKey = (taskId: string): string => `trash:${taskId}`
const captureKey = (sessionId: string): string => `capture:${sessionId}`
const dispatchWorktreeKey = (dispatchId: string): string => `dispatch-worktree:${dispatchId}`
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
const yieldToLoop = (): Promise<void> => new Promise<void>((resolveYield) => setImmediate(resolveYield))
/** Entries examined between two turns of the event loop, so a long walk never holds up a request. */
const WALK_YIELD_ENTRIES = 500

export async function findNestedRepository(root: string): Promise<{ nested?: string; truncated: boolean }> {
  let visited = 0, sinceYield = 0
  const stack: Array<{ path: string; depth: number }> = [{ path: root, depth: 0 }]
  while (stack.length) {
    const { path, depth } = stack.pop()!
    if (depth > 64) return { truncated: true }
    let entries: Dirent[]
    try { entries = await readdir(path, { withFileTypes: true }) } catch { return { truncated: true } }
    sinceYield += entries.length
    if (sinceYield >= WALK_YIELD_ENTRIES) { sinceYield = 0; await yieldToLoop() }
    for (const entry of entries) {
      if (++visited > 100_000) return { truncated: true }
      if (entry.name === '.git') { if (path !== root) return { nested: relative(root, path).split('\\').join('/'), truncated: false }; continue }
      if (entry.isDirectory() && !entry.isSymbolicLink()) stack.push({ path: join(path, entry.name), depth: depth + 1 })
    }
  }
  return { truncated: false }
}

/** Ignored entries that are only Mousse control files do not keep a worktree (the verifier retains them). */
async function onlyControlFiles(worktree: string, entry: string): Promise<boolean> {
  const path = entry.replace(/\/$/, '')
  if (MOUSSE_CONTROL_FILE_PATHS.includes(path)) return true
  if (!entry.endsWith('/')) return false
  const directory = join(worktree, path)
  try {
    const names = (await readdir(directory, { recursive: true, withFileTypes: true })).filter((child) => !child.isDirectory())
    return names.length > 0 && names.every((child) => MOUSSE_CONTROL_FILE_PATHS.includes(`${path}/${relative(directory, join(child.parentPath, child.name)).split('\\').join('/')}`))
  } catch { return false }
}

/**
 * The daemon's storage cleanup rules. It evaluates thread worktrees in a fixed order with a plain
 * reason for every keep, retires a worktree only after the thread and repository leases are held and
 * the checks are repeated, runs the trash sweep through a reporting seam, guards against a clock set
 * backwards and stores the last report. Retirement is reversible: the worktree moves into the trash
 * and comes back on use, from the trash or, once the trash has deleted it, from its snapshot.
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
   * ("Preview cleanup", then confirmed) asked for during a scheduled one: the scheduled run looks at one batch of worktrees
   * and five trash records, so the manual request follows it and gets its own full run. Repeated manual
   * requests share that one queued run.
   */
  run(trigger: StorageCleanupReport['trigger'], options?: { plan?: StorageCleanupPlanToken }): Promise<StorageCleanupReport> {
    if (options?.plan) return this.runPlanned(options.plan)
    if (!this.current) return this.begin(trigger)
    if (trigger === 'manual' && this.currentTrigger === 'schedule') {
      this.queuedManual ??= this.current.catch(() => undefined).then(() => this.begin('manual')).finally(() => { this.queuedManual = undefined })
      return this.queuedManual
    }
    return this.current
  }

  /** A confirmed plan waits for any run in progress and then gets a run of its own: it is never merged with another request. */
  private async runPlanned(plan: StorageCleanupPlanToken): Promise<StorageCleanupReport> {
    while (this.current || this.queuedManual) await (this.queuedManual ?? this.current)!.catch(() => undefined)
    return this.begin('manual', plan)
  }

  private begin(trigger: StorageCleanupReport['trigger'], plan?: StorageCleanupPlanToken): Promise<StorageCleanupReport> {
    this.currentTrigger = trigger
    const run: Promise<StorageCleanupReport> = this.execute(trigger, plan).finally(() => { if (this.current === run) { this.current = undefined; this.currentTrigger = undefined } })
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
    return this.buildPlan(this.deps.policy.snapshot(), now)
  }

  /**
   * The dry run and what a confirmed run is bounded by: the time, the policy it used, and the keys of
   * exactly the items it would remove. `run('manual', { plan })` removes only those, and only while
   * they are still eligible, within ten minutes, under the same policy.
   */
  async planWithToken(now = this.now()): Promise<{ plan: PlannedCleanup[]; token: StorageCleanupPlanToken }> {
    const snapshot = this.deps.policy.snapshot()
    const plan = await this.buildPlan(snapshot, now)
    return { plan, token: { issuedAt: now, expiresAt: now + STORAGE_PLAN_TTL_MS, policyDigest: snapshot.digest, keys: plan.flatMap((item) => item.action === 'remove' && item.key ? [item.key] : []) } }
  }

  private async buildPlan(snapshot: PolicySnapshot, now: number): Promise<PlannedCleanup[]> {
    const clock = this.deps.clock.peek()
    const planned: PlannedCleanup[] = []
    if (clock.suspended) planned.push({ rule: 'worktree-inactive', label: 'Time-based rules', action: 'keep', reason: clock.reason ?? 'Paused after the system clock moved backwards', bytes: 0 })
    if (snapshot.policy.worktrees.removeWithDeletedThreads) planned.push(...await this.planDeletedThreadWorktrees(snapshot))
    for (const entry of await this.evaluateWorktrees(snapshot, !clock.suspended, now, false)) {
      const base = { threadId: entry.record.taskId, projectId: entry.projectId, label: entry.label }
      planned.push('rule' in entry.verdict
        ? { ...base, key: worktreeKey(entry.record.taskId), rule: entry.verdict.rule, action: 'remove', reason: entry.verdict.reason, bytes: entry.verdict.measurement.bytes, ...approximate(entry.verdict.measurement) }
        : { ...base, rule: 'worktree-inactive', action: 'keep', reason: entry.verdict.keep, bytes: 0 })
    }
    if (!clock.suspended) planned.push(...await this.planCaptures(snapshot, now))
    planned.push(...await this.planTrash(now))
    try { planned.push(...await this.planDispatchWorktrees()) }
    catch (error) { planned.push({ rule: 'dispatch-worktree', label: 'Dispatch worktrees', action: 'keep', reason: (error as Error).message, bytes: 0 }) }
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
        : { ...base, key: worktreeKey(record.taskId), action: 'remove', reason: 'Thread was deleted', bytes: verdict.measurement.bytes, ...approximate(verdict.measurement) })
      await yieldToLoop()
    }
    return planned
  }

  /** The capture rule's rows for the dry run: the same decisions as a run, with nothing deleted. */
  private async planCaptures(snapshot: PolicySnapshot, now: number): Promise<PlannedCleanup[]> {
    try {
      return (await this.captureItems(snapshot, now, false)).map((entry) => ({
        rule: entry.rule, label: entry.label, action: entry.outcome === 'removed' ? 'remove' as const : 'keep' as const, reason: entry.reason,
        ...(entry.outcome === 'removed' && entry.key ? { key: entry.key } : {}),
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
        return waiting ? [{ rule: 'trash', label: `${plural(waiting, 'thread')} in the trash`, action: 'keep', reason: 'A delete that did not finish; it finishes at the next start', bytes: 0 }] : []
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
          planned.push({ ...base, key: trashKey(taskId), action: 'remove', reason: 'Retention passed', bytes: reclaim.bytes, ...approximate(reclaim) })
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

  private async execute(trigger: StorageCleanupReport['trigger'], plan?: StorageCleanupPlanToken): Promise<StorageCleanupReport> {
    // Disk measurement holds handles that make a worktree look in use to the rename probe; it waits for the run.
    const resume = await this.deps.quiesceDisk?.()
    try { return await this.executeQuiet(trigger, plan) } finally { resume?.() }
  }

  private async executeQuiet(trigger: StorageCleanupReport['trigger'], plan?: StorageCleanupPlanToken): Promise<StorageCleanupReport> {
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
    // A confirmed plan authorizes only what it named, only for a short while, and only under the policy it was made with.
    let allowed: ReadonlySet<string> | undefined
    if (plan) {
      // Known errors, so the person reads these two sentences instead of a generic failure.
      if (this.now() > plan.expiresAt) throw knownAppError({ code: 'storage_plan_expired', message: 'This plan has expired. Check what would be removed again.' }, { category: 'invalid', retryable: false })
      if (!snapshot || snapshot.digest !== plan.policyDigest) throw knownAppError({ code: 'storage_plan_stale', message: 'Settings changed since the plan was made. Check what would be removed again.' }, { category: 'invalid', retryable: false })
      allowed = new Set(plan.keys)
    }
    // Checked before any age is evaluated and whether or not automatic trash emptying is on.
    const clock = this.deps.clock.check()
    if (clock.suspended) suspended = clock.reason
    else if ((clock.forwardJumpMs ?? 0) > FORWARD_JUMP_NOTE_MS) clockNote = `Clock moved forward by ${Math.round(clock.forwardJumpMs! / 3_600_000)} h since the last run`

    if (snapshot && (hasRule || trigger === 'manual')) {
      try { items.push(...await this.worktreePhase(snapshot, !clock.suspended, startedMs, trigger, allowed)) }
      catch (error) { items.push({ rule: 'worktree-inactive', label: 'Worktrees', bytes: 0, outcome: 'failed', reason: (error as Error).message }) }
      try { items.push(...await this.dispatchWorktreeItems(allowed)) }
      catch (error) { items.push({ rule: 'dispatch-worktree', label: 'Dispatch worktrees', bytes: 0, outcome: 'failed', reason: (error as Error).message }) }
    }
    // Worktrees already in the trash are settled whatever rules are on now; a confirmed plan touches only what it named.
    if (!allowed && !clock.suspended && !this.stopping) {
      try { items.push(...await this.worktreeTrashItems(startedMs)) }
      catch (error) { items.push({ rule: 'trash', label: 'Worktrees in the trash', bytes: 0, outcome: 'failed', reason: (error as Error).message }) }
      try { items.push(...await this.snapshotTrashItems(startedMs)) }
      catch (error) { items.push({ rule: 'trash', label: 'Snapshot stores in the trash', bytes: 0, outcome: 'failed', reason: (error as Error).message }) }
      try { items.push(...await this.stoppedCleanupItems(startedMs)) }
      catch (error) { items.push({ rule: 'worktree-orphan', label: 'Agent worktree cleanups', bytes: 0, outcome: 'failed', reason: (error as Error).message }) }
    }
    if (snapshot && (hasRule || trigger === 'manual')) {
      try { items.push(...await this.trashPhase(startedMs, trigger, allowed)) }
      catch (error) { items.push({ rule: 'trash', label: 'Trash', bytes: 0, outcome: 'failed', reason: (error as Error).message }) }
      // A time-based rule, so it waits while the clock is suspended (the report already says why).
      if (!clock.suspended) {
        try { items.push(...await this.captureItems(snapshot, startedMs, true, allowed)) }
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

  private async worktreePhase(snapshot: PolicySnapshot, timeRulesEnabled: boolean, now: number, trigger: StorageCleanupReport['trigger'], allowed?: ReadonlySet<string>): Promise<StorageCleanupItem[]> {
    const items: StorageCleanupItem[] = []
    if (snapshot.policy.worktrees.removeWithDeletedThreads) items.push(...await this.deletedThreadWorktrees(snapshot, allowed))
    const evaluations = await this.evaluateWorktrees(snapshot, timeRulesEnabled, now, trigger === 'schedule', allowed)
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
  private async deletedThreadWorktrees(snapshot: PolicySnapshot, allowed?: ReadonlySet<string>): Promise<StorageCleanupItem[]> {
    const items: StorageCleanupItem[] = []
    for (const record of this.deletedRoots()) {
      if (this.stopping) break
      if (allowed && !allowed.has(worktreeKey(record.taskId))) continue
      // A policy saved while this loop was waiting on an earlier thread no longer authorizes the rest of it.
      if (this.deps.policy.digest() !== snapshot.digest) {
        items.push({ rule: 'worktree-deleted', label: 'Worktrees of deleted threads', bytes: 0, outcome: 'kept', reason: 'Settings changed since check' })
        break
      }
      const item = await this.retireDeleted(record, snapshot)
      if (item) items.push(item)
      await yieldToLoop()
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
    // The rename probe and the removal both need the disk measurement out of the way.
    const resume = await this.deps.quiesceDisk?.()
    try {
      const item = await this.retireDeleted(record, snapshot)
      if (item) this.recordOutcomes(new Date(this.now()).toISOString(), 'trash', [item])
      return item
    } finally { resume?.() }
  }

  private async deletedFingerprint(record: TaskLifecycleRecord, workspace: ThreadWorkspaceMetadata, snapshot: PolicySnapshot): Promise<string | undefined> {
    try {
      return [snapshot.digest, await readOnlyGitAsync(workspace.worktreePath, ['rev-parse', 'HEAD']), (await stat(workspace.worktreePath)).mtimeMs, statSync(join(record.location, 'workspace.json')).mtimeMs].join('|')
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
    if (!workspace) return { skip: true }
    // On a drive that is not connected: there, out of reach, and kept; never taken for already removed.
    const offline = await disconnectedWorktreeFolder(workspace.worktreePath)
    if (offline) return { keep: driveNotConnectedText(offline), remember: false }
    if (!await present(workspace.worktreePath)) return { skip: true }
    const fingerprint = await this.deletedFingerprint(record, workspace, snapshot)
    const memo = this.keepMemo.get(record.taskId)
    if (fingerprint && memo?.fingerprint === fingerprint && this.now() - memo.at < KEEP_MEMO_TTL_MS) return { keep: memo.reason, remember: false }
    // A thread in the trash is no longer in the live index, so the lookup can fail with "not found": nothing is running for it.
    // The profile-wide idle check inside `retireTrashed` is the authority for a deletion in progress.
    let busy: string | undefined
    try { busy = this.deps.idle(record.taskId) } catch { busy = undefined }
    if (busy) return { keep: busy, remember: false }
    if (isExecutionLeaseHeld(record.location)) return { keep: 'Thread is in use', remember: false }
    if (workspace.lifecycle !== 'ready') return { keep: 'Workspace is not ready', remember: true, fingerprint }
    let facts: Awaited<ReturnType<StorageCleanupService['inspectCheckout']>>
    try { facts = await this.inspectCheckout(record, workspace) } catch (error) { return { keep: (error as Error).message, remember: false } }
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
    // The purge checks its reservation again after this, right before the checkout moves.
    const recheck = async (candidate: string): Promise<string | undefined> => {
      try {
        if (!samePath(candidate, path)) return 'Other worktrees of a deleted thread are removed when it is permanently deleted'
        if (this.deps.policy.digest() !== snapshot.digest) return 'Settings changed since check'
        const placement = await this.placementProblem(workspace, record.taskId)
        if (placement) return placement
        if (await readOnlyGitAsync(path, ['rev-parse', 'HEAD']) !== head) return 'Commit changed since check'
        // Again, with nothing awaited after it: the reads above wait.
        if (this.deps.policy.digest() !== snapshot.digest) return 'Settings changed since check'
        return this.probeRemoval(path)
      } catch (error) { return (error as Error).message }
    }
    // The checks that can change without the reads above, once more right before the move, with nothing awaited between
    // them and its start (retirement prepares first): the settings, and on Windows whether a file in it is open.
    const beforeMove = (): string | undefined => {
      try {
        if (this.deps.policy.digest() !== snapshot.digest) return 'Settings changed since check'
        return this.probeRemoval(path)
      } catch (error) { return (error as Error).message }
    }
    try { await this.deps.purge.retireTrashed(record.taskId, { recheck, beforeMove }) }
    catch (error) {
      const reason = (error as Error).message
      return BUSY_REASON.test(reason) ? kept(reason) : { ...base, bytes: 0, outcome: 'failed', reason }
    }
    if (!await present(path)) {
      this.keepMemo.delete(record.taskId)
      return { ...base, bytes: measurement.bytes, files: measurement.files, ...approximate(measurement), outcome: 'removed', reason: 'Thread was deleted' }
    }
    if (!await present(join(path, '.git'))) {
      return { ...base, bytes: 0, outcome: 'failed', reason: this.deps.store.get(record.taskId)?.blockedReason ?? 'Worktree was partly removed because files in it were in use; it is rebuilt the next time the thread is used' }
    }
    const reason = this.deps.store.get(record.taskId)?.blockedReason ?? 'Worktree was kept'
    const fingerprint = await this.deletedFingerprint(record, workspace, snapshot)
    if (fingerprint && !TRANSIENT_REASON.test(reason)) this.keepMemo.set(record.taskId, { fingerprint, reason, at: this.now() })
    return kept(reason)
  }

  /**
   * Pre-filter: every reason-producing check runs here with no lease held, so nothing in this phase
   * blocks a thread. A scheduled run looks at one batch per tick; a manual run looks at all of them.
   */
  private async evaluateWorktrees(snapshot: PolicySnapshot, timeRulesEnabled: boolean, now: number, batched: boolean, allowed?: ReadonlySet<string>): Promise<Evaluation[]> {
    const policy = snapshot.policy
    const inactiveOn = policy.worktrees.inactiveDays !== null && timeRulesEnabled
    const mergedOn = policy.worktrees.removeMerged
    if (!inactiveOn && !mergedOn) return []
    // Only live root threads. A trashed record belongs to the deleted-threads rule alone, and a
    // subagent's worktree goes with its thread.
    let candidates = this.deps.store.list().filter((record) => record.state === 'active' && !record.parentTaskId && (!allowed || allowed.has(worktreeKey(record.taskId)))).sort((a, b) => a.taskId.localeCompare(b.taskId))
    const kept: TaskLifecycleRecord[] = []
    for (const record of candidates) {
      let keep: boolean
      try { const workspace = readWorkspaceFile(record.location); keep = workspace === undefined ? false : await present(workspace.worktreePath) || workspace.lifecycle !== 'ready' || Boolean(await disconnectedWorktreeFolder(workspace.worktreePath)) }
      catch { keep = true }
      if (keep) kept.push(record)
    }
    candidates = kept
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
      // Each candidate runs Git and reads files; let requests, turns and terminals in between.
      await yieldToLoop()
    }
    return evaluations
  }

  private async activityAt(record: TaskLifecycleRecord, workspace: ThreadWorkspaceMetadata, head: string): Promise<number> {
    const times: number[] = [Date.parse(this.deps.threads.getThread(record.taskId)?.createdAt ?? record.createdAt)]
    for (const name of ['messages.json', 'workspace.json', 'thread.db', 'thread.db-wal']) {
      try { times.push(statSync(join(record.location, name)).mtimeMs) } catch { /* No such file: it contributes nothing. */ }
    }
    const journal = new ThreadJournal(record.location, { readOnly: true }).list()
    if (journal.length) times.push(Date.parse(journal[journal.length - 1]!.createdAt))
    times.push(Number(await readOnlyGitAsync(workspace.worktreePath, ['log', '-1', '--format=%ct', head])) * 1000)
    return Math.max(...times.filter(Number.isFinite))
  }

  /**
   * Why the checkout may not be removed because of where it is, or undefined. It must be a real
   * directory (not a symlink or junction), inside the thread's managed folder by name, and still
   * inside the installation once every link above it is resolved. Evaluated again under the leases.
   */
  private async placementProblem(workspace: ThreadWorkspaceMetadata, taskId: string): Promise<string | undefined> {
    const path = workspace.worktreePath
    const folded = (value: string): string => process.platform === 'win32' ? value.toLowerCase() : value
    if ((await lstat(path)).isSymbolicLink() || folded(await realpathLike(path)) !== folded(join(await realpathLike(dirname(path)), basename(path)))) return 'Worktree is a link'
    // Where `worktreeLayout` makes the thread's worktrees: Mousse's own folder, or a worktree folder the person chose.
    if (!isThreadWorktreePlace(path, { home: this.deps.installationHome, repositoryId: workspace.repositoryId, threadId: taskId })) return 'Outside the managed worktree folder'
    // A link anywhere above the checkout (a repository folder that is a junction to another disk) resolves outside the installation,
    // or outside its repository's folder in the chosen worktree folder.
    const chosen = chosenFolderPlace(path)
    const root = chosen ? join(await realpathLike(chosen.folder), basename(chosen.repositoryFolder)) : await realpathLike(this.deps.installationHome)
    if (!within(root, await realpathLike(path))) return 'Outside the managed worktree folder'
    return undefined
  }

  /**
   * The location and content reasons to keep a checkout, in a fixed order, shared by the live-thread rules
   * and the deleted-thread rule: not a repository any more, a link or a place outside Mousse's folders, an
   * unfinished operation, HEAD moved outside a recorded operation, uncommitted/untracked/ignored files,
   * another repository inside it, and commits that are not in the default branch. Reads only. A Git
   * failure throws and the caller keeps the worktree with its message.
   */
  private async inspectCheckout(record: TaskLifecycleRecord, workspace: ThreadWorkspaceMetadata): Promise<{ keep: string } | CheckoutFacts> {
    const path = workspace.worktreePath
    if (!await present(join(path, '.git'))) return { keep: 'Worktree is partly removed; it is rebuilt the next time the thread is used' }
    const placement = await this.placementProblem(workspace, record.taskId)
    if (placement) return { keep: placement }
    const unfinished = [...new ThreadJournal(record.location, { readOnly: true }).latestByOperation().values()].find((entry) => !TERMINAL_OPERATION_STATES.has(entry.state))
    if (unfinished) return { keep: 'Workspace has an unfinished operation' }
    // HEAD and the branch are the agent's to move; the commits it added are counted below.
    const head = await readOnlyGitAsync(path, ['rev-parse', 'HEAD'])
    // Uncommitted files do not keep a worktree: retiring it saves them as a snapshot first. What a snapshot cannot hold keeps it.
    const changed = (await readOnlyGitAsync(path, ['status', '--porcelain', '--untracked-files=all'], LISTING_MAX_BUFFER)).split(/\r?\n/).filter(Boolean).length
    const operation = await operationInProgressAsync(path)
    if (operation) return { keep: `Has a ${operation} in progress` }
    if (await readOnlyGitAsync(path, ['ls-files', '-u'], LISTING_MAX_BUFFER)) return { keep: 'Has unresolved conflicts' }
    const staged = (await readOnlyGitAsync(path, ['diff', '--cached', '--name-only'], LISTING_MAX_BUFFER)).split(/\r?\n/).filter(Boolean).length
    if (staged) return { keep: `Has staged changes (${plural(staged, 'file')})` }
    if (changed && (await runReadOnlyGitAsync(path, ['config', '--bool', 'core.sparseCheckout'])).stdout.trim() === 'true') return { keep: `Has uncommitted changes in a sparse checkout (${plural(changed, 'file')})` }
    // Cheap checks first: a worktree with ignored files (node_modules, .env) is kept without walking it for another repository.
    const ignored: string[] = []
    for (const entry of (await readOnlyGitAsync(path, ['ls-files', '--others', '--ignored', '--exclude-standard', '--directory', '-z'], LISTING_MAX_BUFFER)).split('\0').filter(Boolean)) {
      if (!await onlyControlFiles(path, entry)) ignored.push(entry)
    }
    if (ignored.length) return { keep: `Has ignored files (${ignored[0]})` }
    await yieldToLoop()
    const nested = await findNestedRepository(path)
    if (nested.nested) return { keep: 'Contains another repository' }
    if (nested.truncated) return { keep: 'Worktree is too large to check for another repository' }
    const target = workspace.integrationTarget
    if (!target || !/^[a-f0-9]{40,64}$/.test(target.baseSha)) return { keep: 'Integration target is unknown' }
    const beyondBase = Number(await readOnlyGitAsync(path, ['rev-list', '--count', `${target.baseSha}..HEAD`]))
    if (!Number.isSafeInteger(beyondBase)) return { keep: 'Commits beyond the base could not be counted' }
    let integrated = false
    if (beyondBase > 0) {
      const defaults = await resolveDefaultBranchAsync(target.checkoutPath, this.deps.codeHost)
      if (!defaults) return { keep: `Default branch is unavailable; run \`git remote set-head ${await primaryRemoteAsync(target.checkoutPath) ?? '<remote>'} --auto\`` }
      // Ancestry covers a branch that was merged as it is. A publish puts the files into one new commit, so it is also
      // integrated when the files it last published are the ones in HEAD.
      integrated = await isIntegratedAsync(path, head, defaults.refs) || (changed === 0 && await this.publishedAsHead(target.checkoutPath, record.taskId, path))
      if (!integrated) return { keep: `Has ${plural(beyondBase, 'unpublished commit')}` }
    }
    return { head, beyondBase, integrated, uncommitted: changed }
  }

  /** Whether the thread's last publish put exactly the files HEAD has into the primary checkout. Reads only. */
  private async publishedAsHead(primaryCheckout: string, taskId: string, worktree: string): Promise<boolean> {
    const published = await runReadOnlyGitAsync(primaryCheckout, ['rev-parse', '--verify', '-q', `${publishedRef(taskId)}^{tree}`])
    return published.status === 0 && published.stdout.trim() === await readOnlyGitAsync(worktree, ['rev-parse', 'HEAD^{tree}'])
  }

  /** The fixed order of keep reasons; the first match wins. Undefined means skip silently. */
  private async evaluateOne(record: TaskLifecycleRecord, snapshot: PolicySnapshot, inactiveOn: boolean, mergedOn: boolean, now: number): Promise<Verdict | undefined> {
    const policy = snapshot.policy
    const workspace = readWorkspaceFile(record.location)
    if (!workspace) return undefined
    if (workspace.lifecycle !== 'ready') return { keep: 'Workspace is not ready' }
    const path = workspace.worktreePath
    const offline = await disconnectedWorktreeFolder(path)
    if (offline) return { keep: driveNotConnectedText(offline) }
    if (!await present(path)) return undefined
    const busy = this.deps.idle(record.taskId)
    if (busy) return { keep: busy }
    if (isExecutionLeaseHeld(record.location)) return { keep: 'Thread is in use' }
    const facts = await this.inspectCheckout(record, workspace)
    if ('keep' in facts) return facts
    const { head, beyondBase, integrated, uncommitted } = facts
    let rule: 'worktree-inactive' | 'worktree-merged' | undefined
    let reason = ''
    const reasons: string[] = []
    if (inactiveOn) {
      const ageDays = Math.max(0, (now - await this.activityAt(record, workspace, head)) / DAY_MS)
      if (ageDays >= policy.worktrees.inactiveDays!) { rule = 'worktree-inactive'; reason = `Inactive for ${Math.floor(ageDays)} days` }
      else reasons.push(`Inactive for ${Math.floor(ageDays)} of ${policy.worktrees.inactiveDays} days`)
    }
    if (!rule && mergedOn) {
      if (beyondBase === 0 || !integrated) reasons.push('No commits to merge yet')
      else if (uncommitted) reasons.push(`Has uncommitted changes (${plural(uncommitted, 'file')})`)
      // A merged thread the person keeps coming back to would be retired, restored by the next status
      // refresh and retired again every hour. A worktree used in the last day (a message, an operation,
      // a commit or a restore) is left alone.
      else if (now - await this.activityAt(record, workspace, head) < DAY_MS) reasons.push('Used within the last day')
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
   * waiting for the repository lease. Removed means `retire` moved the folder into the trash; a later
   * run deletes it from there after a snapshot (`worktreeTrashItems`). A folder that cannot be moved
   * (files in use) is kept where it is.
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
      const identity = await resolveRepositoryIdentityAsync(workspace.worktreePath, { requireMutationCapability: true })
      let repositoryLease
      try { repositoryLease = await acquireRepositoryLease(identity, { signal: AbortSignal.timeout(REPOSITORY_LEASE_WAIT_MS) }) }
      catch { return kept('Repository is busy') }
      try {
        if (this.deps.policy.digest() !== verdict.policyDigest) return kept('Settings changed since check')
        const busy = this.deps.idle(record.taskId)
        if (busy) return kept('Thread became busy')
        const bound = readWorkspaceFile(record.location)
        if (!bound || bound.worktreePath !== workspace.worktreePath || bound.branch !== workspace.branch || bound.headSha !== workspace.headSha || bound.lifecycle !== workspace.lifecycle) return kept('Workspace changed since check')
        const placement = await this.placementProblem(workspace, record.taskId)
        if (placement) return kept(placement)
        if (await readOnlyGitAsync(workspace.worktreePath, ['rev-parse', 'HEAD']) !== head) return kept('Commit changed since check')
        // A manual run evaluates every worktree before it retires the first, so the thread may have been used since.
        if (verdict.rule === 'worktree-inactive' && verdict.inactiveDays !== null && (this.now() - await this.activityAt(record, bound, head)) / DAY_MS < verdict.inactiveDays) return kept('Thread was used since check')
        // The reads above wait: the policy is checked again. The thread cannot start work meanwhile, since cleanup holds its lease.
        if (this.deps.policy.digest() !== verdict.policyDigest) return kept('Settings changed since check')
        const retirement = new WorktreeRetirementService(this.deps.store, { taskLease, repositoryLease })
        await retirement.prepare({ taskId: record.taskId, worktreePath: workspace.worktreePath, branch: workspace.branch, sourcePath: join(record.location, 'workspace.json'), repositoryId: workspace.repositoryId, baseSha: workspace.baseSha, resultSha: head })
        let inUse: string | undefined
        try { inUse = this.probeRemoval(workspace.worktreePath) } catch (error) { return failed((error as Error).message) }
        if (inUse) return kept(inUse)
        // Preparing and retiring wait, so the checks above that can change without those reads run once more right before
        // the move, with nothing awaited between them and its start: the outcome they give is the one they gave before.
        let stopped: StorageCleanupItem | undefined
        const stop = (item: StorageCleanupItem): never => { stopped = item; throw new Error(item.reason ?? 'Kept') }
        const beforeMove = (): void => {
          if (this.deps.policy.digest() !== verdict.policyDigest) stop(kept('Settings changed since check'))
          const busyNow = this.deps.idle(record.taskId)
          if (busyNow) stop(kept('Thread became busy'))
          const boundNow = readWorkspaceFile(record.location)
          if (!boundNow || boundNow.worktreePath !== workspace.worktreePath || boundNow.branch !== workspace.branch || boundNow.headSha !== workspace.headSha || boundNow.lifecycle !== workspace.lifecycle) stop(kept('Workspace changed since check'))
          let inUseNow: string | undefined
          try { inUseNow = this.probeRemoval(workspace.worktreePath) } catch (error) { stop(failed((error as Error).message)) }
          if (inUseNow) stop(kept(inUseNow))
        }
        // The folder moves into the trash in one step or not at all; a folder in use stays where it is.
        try { await retirement.retire(retirement.pathFor(record.taskId, workspace.worktreePath), { beforeMove }) }
        catch (error) { if (stopped) return stopped; throw error }
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

  /**
   * Worktrees the rules moved into the trash. One that has waited an hour with nothing in it changing has its files
   * kept and is deleted against that proof (`WorktreeRetirementService.expireTrash`); what cannot be kept keeps it in the
   * trash, with the reason, and one whose delete stopped carries on. Only the repository lease is taken: the thread's own
   * worktree is not the one in the trash.
   */
  private async worktreeTrashItems(now: number): Promise<StorageCleanupItem[]> {
    const items: StorageCleanupItem[] = []
    const root = join(this.deps.store.root, 'workspaces')
    const reader = new WorktreeRetirementService(this.deps.store)
    let owners: string[]
    try { owners = readdirSync(root) } catch { return items }
    for (const owner of owners) {
      let names: string[]
      try { names = readdirSync(join(root, owner)).filter((name) => name.endsWith('.json')) } catch { continue }
      for (const name of names) {
        if (this.stopping) return items
        const path = join(root, owner, name)
        let manifest: ReturnType<WorktreeRetirementService['load']>
        try { manifest = reader.load(path) } catch { continue }
        if (manifest.state !== 'deleting' && (!manifest.trashPath || !existsSync(manifest.trashPath))) continue
        if (manifest.state === 'trashed' && now - Date.parse(manifest.trashedAt ?? '') < WORKTREE_TRASH_QUIET_MS) continue
        // The repository is found from the folder while it is still a checkout; once its `.git` file is gone, from the
        // repository's own top folder.
        const at = [manifest.deleting?.path, manifest.trashPath].find((folder) => folder && existsSync(join(folder, '.git'))) ?? dirname(manifest.commonDir)
        const { label, projectId } = this.labelFor(manifest.taskId)
        const base = { rule: 'trash' as const, threadId: manifest.taskId, projectId, label: `${label}: worktree in the trash` }
        try {
          let lease
          try { lease = await acquireRepositoryLease(await resolveRepositoryIdentityAsync(at, { requireMutationCapability: true }), { signal: AbortSignal.timeout(REPOSITORY_LEASE_WAIT_MS) }) }
          catch { items.push({ ...base, bytes: 0, outcome: 'kept', reason: 'Repository is busy' }); continue }
          let outcome: Awaited<ReturnType<WorktreeRetirementService['expireTrash']>>
          try { outcome = await new WorktreeRetirementService(this.deps.store, { repositoryLease: lease }).expireTrash(path, { now, inUse: this.probeRemoval }) }
          finally { lease.release() }
          if (!outcome || 'waiting' in outcome) continue
          items.push('removed' in outcome
            ? { ...base, bytes: 0, outcome: 'removed', reason: 'Deleted from the trash after an hour with no changes; its files are kept as a snapshot' }
            : { ...base, bytes: 0, outcome: 'kept', reason: outcome.kept })
        } catch (error) {
          items.push({ ...base, bytes: 0, outcome: 'failed', reason: (error as Error).message })
        }
        await yieldToLoop()
      }
    }
    return items
  }

  /**
   * Snapshot stores of folders without Git that went to the trash (a removed project's, once no thread used it; a deleted
   * thread's with no project), and the files deleted threads' restores kept in a shared store: deleted once they have
   * waited as long as a retired worktree.
   */
  private async snapshotTrashItems(now: number): Promise<StorageCleanupItem[]> {
    const items: StorageCleanupItem[] = []
    const moved = trashRemovedProjectStores()
    if (moved) items.push({ rule: 'trash', label: 'Snapshot stores of removed projects', bytes: 0, outcome: 'removed', reason: `${moved} moved to the trash` })
    for (const entry of expireSnapshotTrash(now)) {
      if (!entry.removed && entry.reason === 'Waiting in the trash') continue
      items.push({ rule: 'trash', label: `Snapshot store in the trash (${entry.name})`, bytes: 0, outcome: entry.removed ? 'removed' : 'kept', reason: entry.reason })
    }
    const refs = await expireTrashedSnapshotRefs(now)
    if (refs.length) items.push({ rule: 'trash', label: 'Files kept by deleted threads’ restores', bytes: 0, outcome: 'removed', reason: `${refs.length} deleted from the trash after an hour` })
    return items
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
  private captureBase(id: string, threadId: string | undefined): Pick<StorageCleanupItem, 'rule' | 'label' | 'threadId' | 'projectId' | 'key'> {
    const known = threadId !== undefined && (this.deps.threads.getThread(threadId) !== undefined || this.deps.store.get(threadId) !== undefined)
    if (!known) return { rule: 'browser-capture', label: `Browser session ${id}`, key: captureKey(id) }
    const { label, projectId } = this.labelFor(threadId!)
    return { rule: 'browser-capture', label: `${label}: browser session ${id}`, key: captureKey(id), threadId, ...(projectId ? { projectId } : {}) }
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
  private async captureItems(snapshot: PolicySnapshot, now: number, real: boolean, allowed?: ReadonlySet<string>): Promise<StorageCleanupItem[]> {
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
        if (allowed && !allowed.has(captureKey(id))) continue
        const chain: CaptureChain = { root, rootReal, profileDir, profileReal, dir: join(profileDir, id), dirReal: join(profileReal, id) }
        if (!this.captureChainIntact(chain)) continue
        let base = { rule, label: `Browser session ${id}`, key: captureKey(id) } as ReturnType<StorageCleanupService['captureBase']>
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
  private async removeCaptures(chain: CaptureChain, base: Pick<StorageCleanupItem, 'rule' | 'label' | 'threadId' | 'projectId' | 'key'>, names: string[], days: number, cutoff: number, policyDigest: string | undefined): Promise<StorageCleanupItem[]> {
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

  // ---- Worktrees finished dispatches left in place ----

  private dispatchWorktreeBase(kept: KeptWorktree): Pick<StorageCleanupItem, 'rule' | 'key' | 'label' | 'threadId' | 'projectId'> {
    const thread = kept.threadId ? this.deps.threads.getThread(kept.threadId) : undefined
    return {
      rule: 'dispatch-worktree', key: dispatchWorktreeKey(kept.dispatchId),
      label: kept.dispatchId,
      ...(thread ? { threadId: thread.id } : {}), ...(thread?.projectId ? { projectId: thread.projectId } : {})
    }
  }

  /**
   * Why a dispatch's worktree was left. For what is left of a cleanup that stopped, exactly which files are only in the
   * folder (written into it after it began), apart from those in its kept copies or its last commit.
   */
  private async dispatchWorktreeReason(kept: KeptWorktree): Promise<string> {
    if (DELETING_NAME.test(basename(kept.path))) {
      const record = await cleanupRecordFor(this.deps.installationHome, kept.path)
      const only = record ? await onlyInFolderAsync(record) : []
      const copies = record ? (record.copy ? 1 : 0) + record.late.length : 0
      return `What is left after its cleanup stopped part way. ${copies ? `Its files are in ${(copies === 1 ? '1 kept copy' : `${copies} kept copies`)} or its last commit` : 'Its files are in its last commit'}${only.length ? `, except ${plural(only.length, 'file')} written into it since, which ${only.length === 1 ? 'is' : 'are'} only in the folder (${only.slice(0, 3).join(', ')}${only.length > 3 ? ', …' : ''}) and ${only.length === 1 ? 'is' : 'are'} copied before it goes` : ''}. Removing it finishes the cleanup.`
    }
    return `Left in place when its dispatch finished, with ${plural(kept.ignoredFiles, 'ignored file')} Mousse could not keep a copy of. Removing it deletes them.`
  }

  /**
   * Each worktree a finished dispatch left in place (`keptWorktrees`) is offered for removal: nothing else ever removes
   * it, since no thread's resources name it. It goes only when the person confirms a plan that lists it.
   */
  private async planDispatchWorktrees(): Promise<PlannedCleanup[]> {
    const planned: PlannedCleanup[] = []
    for (const kept of listKeptWorktrees(this.deps.store.profileHome)) {
      if (this.stopping) break
      if (!existsSync(kept.path)) continue
      const measurement = await this.measure(kept.path, { mode: 'reclaim', budgetMs: MEASURE_BUDGET_MS })
      const { rule, key, label, threadId, projectId } = this.dispatchWorktreeBase(kept)
      planned.push({ rule, key, label, ...(threadId ? { threadId } : {}), ...(projectId ? { projectId } : {}), action: 'remove', reason: await this.dispatchWorktreeReason(kept), bytes: measurement.bytes, ...approximate(measurement) })
    }
    return planned
  }

  /**
   * In a run: a worktree a finished dispatch left in place is removed, with its ignored files, only when the confirmed
   * plan named it (`allowed`); otherwise it is reported as kept. Git's own data of it is kept first, as a copy the
   * dispatch owns. One that still has uncommitted changes stays, and is reported as kept with the files named.
   * A record whose folder is gone is forgotten.
   */
  private async dispatchWorktreeItems(allowed?: ReadonlySet<string>): Promise<StorageCleanupItem[]> {
    const items: StorageCleanupItem[] = []
    for (const kept of listKeptWorktrees(this.deps.store.profileHome)) {
      if (this.stopping) break
      if (!existsSync(kept.path)) { forgetKeptWorktree(this.deps.store.profileHome, kept.dispatchId); continue }
      const base = this.dispatchWorktreeBase(kept)
      const measurement = await this.measure(kept.path, { mode: 'reclaim', budgetMs: MEASURE_BUDGET_MS })
      const sized = { bytes: measurement.bytes, files: measurement.files, ...approximate(measurement) }
      if (!allowed?.has(base.key!)) { items.push({ ...base, ...sized, outcome: 'kept', reason: `${await this.dispatchWorktreeReason(kept)} Preview cleanup lists it.` }); continue }
      // The ignored files go, as confirmed; Git's own data of the worktree is kept, as a copy the dispatch owns.
      let owner: string | undefined
      try { owner = dispatchKeptFilesOwner(this.deps.store.profileHome, kept.dispatchId) } catch { owner = undefined }
      const result = await new WorktreeManager(kept.repositoryRoot, this.deps.installationHome).cleanupValidatedAgentWorktree(
        { path: kept.path, branch: kept.branch, repositoryRoot: kept.repositoryRoot },
        { safeCheckout: true, ...(owner ? { keepIgnored: { owner, deleteIgnored: true, record: (step) => { if (step.phase === 'keeping') registerDispatchKeptFilesFolder(owner, kept.dispatchId, kept.repositoryRoot) } } } : {}) })
      if (result.success) {
        forgetKeptWorktree(this.deps.store.profileHome, kept.dispatchId)
        items.push({ ...base, ...sized,  outcome: 'removed', reason: DELETING_NAME.test(basename(kept.path)) ? 'Cleanup finished, as confirmed; its files are in kept copies or its last commit' : `Removed with its ${plural(kept.ignoredFiles, 'ignored file')}, as confirmed` })
      } else if (result.kept?.code === 'uncommitted_changes') items.push({ ...base, ...sized, outcome: 'kept', reason: `It has uncommitted changes (${result.kept.uncommitted}), so it stays as it is. It can be removed once they are committed or discarded.` })
      else items.push({ ...base, bytes: 0, outcome: 'failed', reason: result.error ?? 'The worktree could not be removed' })
    }
    return items
  }

  // ---- Agent worktree cleanups a process left part way ----

  /**
   * An agent's or dispatch's worktree cleanup that a process left part way, or that stopped, leaves its folder renamed
   * to `.deleting-<id>`, with the proof it recorded in Mousse's own folder (`verifiedCleanup.ts`). Each is finished here
   * against that proof: shown to name that folder and to list only held bytes, then compared, deleted entry by entry,
   * and unregistered. One that stopped (files in it kept changing, say) is tried again once nothing has changed in it for
   * an hour, whether a dispatch or an agent made it. One another run has right now is left to it and not reported.
   * A thread's worktree whose cleanup stopped (a pull request thread whose start failed, its copies owned by the
   * thread's project or the thread) is finished the same way, against its record alone (`resumeCleanupAsync`): it is no
   * agent's worktree, so it is never checked as one. Another profile's is left to that profile and not reported.
   */
  private async stoppedCleanupItems(now: number): Promise<StorageCleanupItem[]> {
    const items: StorageCleanupItem[] = []
    const owners = [...this.deps.store.list().map((task) => task.location), ...projectKeptFilesOwners(this.deps.store.profileHome).map((project) => project.owner)]
    const within = (path: string, folder: string): boolean => { const rel = relative(resolve(folder), resolve(path)); return rel === '' || !rel.startsWith('..') && !isAbsolute(rel) }
    const otherProfile = (path: string): boolean => within(path, join(this.deps.installationHome, 'profiles')) && !within(path, this.deps.store.profileHome)
    for (const record of await listCleanupRecords(this.deps.installationHome)) {
      if (this.stopping) return items
      const agent = record.branch.startsWith('mousse/agent/')
      if (!agent && otherProfile(record.owner)) continue
      const thread = !agent && owners.some((owner) => samePath(owner, record.owner))
      const base = { rule: 'worktree-orphan' as const, label: `${thread ? 'threads' : 'agents'}/${basename(record.worktreePath)}` }
      const since = record.stopped ? Date.parse(record.changedAt ?? record.stopped.at) : Number.NaN
      const stoppedAt = record.stopped ? Date.parse(record.stopped.at) : Number.NaN
      if (record.stopped && now - Math.max(since, stoppedAt) < CLEANUP_QUIET_MS) {
        items.push({ ...base, bytes: 0, outcome: 'kept', reason: `${record.stopped.reason} Cleanup tries again once nothing has changed in it for an hour.` })
        continue
      }
      const measurement = existsSync(record.deletingPath) ? await this.measure(record.deletingPath, { mode: 'reclaim', budgetMs: MEASURE_BUDGET_MS }) : undefined
      const result = thread ? await this.resumeThreadCleanup(record) : await new WorktreeManager(record.repositoryRoot, this.deps.installationHome).cleanupValidatedAgentWorktree(
        { path: record.deletingPath, branch: record.branch, repositoryRoot: record.repositoryRoot }, { safeCheckout: true })
      if (result.kept?.code === 'cleanup_running') continue
      items.push(result.success
        ? { ...base, bytes: measurement?.bytes ?? 0, ...(measurement ? { files: measurement.files, ...approximate(measurement) } : {}), outcome: 'removed', reason: 'Finished a cleanup that stopped part way; its files are in kept copies or its last commit' }
        : { ...base, bytes: 0, outcome: 'kept', reason: (result.error ?? 'Its cleanup could not be finished').replace(/^Kept: /, '') })
      await yieldToLoop()
    }
    return items
  }

  /**
   * Finishes the stopped cleanup of a thread's worktree against its record, owned by that thread, as
   * `cleanupValidatedAgentWorktree` reports it. A folder that went back to its own path is no cleanup's any more.
   */
  private async resumeThreadCleanup(record: CleanupRecord): Promise<{ success: boolean; error?: string; kept?: { code: string } }> {
    const resumed = await resumeCleanupAsync({ home: this.deps.installationHome, id: record.id, owner: record.owner })
    if (resumed === 'gone') return { success: false, kept: { code: 'cleanup_running' } }
    if (resumed === 'restart') return { success: false, error: `It went back to ${record.worktreePath} before its cleanup began, and stays there.` }
    if ('kept' in resumed) return { success: false, error: resumed.kept.reason, kept: resumed.kept }
    return { success: true }
  }

  // ---- Orphans ----

  /** Directories in the managed worktree folders that nothing claims. Reported with their size, never removed. */
  private async orphanItems(): Promise<StorageCleanupItem[]> {
    const claims = await getExternalResourceClaims(this.deps.store, new Set())
    const items: StorageCleanupItem[] = []
    // A worktree a dispatch left in place has its own row, which can remove it.
    const dispatchKept = new Set(await Promise.all(listKeptWorktrees(this.deps.store.profileHome).map((kept) => canonicalPathAsync(kept.path))))
    // What is left of a rebuild's clear of an earlier rebuild's folder: the next rebuild finishes it, never unused.
    const clearing = new Set(await Promise.all(new WorktreeRetirementService(this.deps.store).clearingFolders().map((path) => canonicalPathAsync(path))))
    // Mousse's own folder and every worktree folder the person chose that is there (`worktreeLayout`). One that is not
    // there (a drive not connected) is not looked at: what is in it is out of reach, never unused.
    for (const { path: folder, repository, kind } of await worktreeContainers(this.deps.installationHome)) {
      if (!existsSync(folder)) continue
      for (const name of readdirSync(folder)) {
        if (this.stopping) return items
        // A repository's folder in a chosen worktree folder holds its agents' folder beside the threads' worktrees.
        if (kind === 'folder' && name === 'agents') continue
        const directory = join(folder, name)
        // What is left of a cleanup under way, with its proof in Mousse's folder: finished by `stoppedCleanupItems`, never unused.
        if (DELETING_NAME.test(name) && await cleanupRecordFor(this.deps.installationHome, directory)) continue
        let stat
        try { stat = lstatSync(directory) } catch { continue }
        if (!stat.isDirectory() || stat.isSymbolicLink()) continue
        // Compared by real paths, so a record that names this folder through an alias still claims it.
        const real = await canonicalPathAsync(directory)
        if (dispatchKept.has(real) || clearing.has(real) || claims.some((claim) => claimOverlapsPath(claim, real))) continue
        const measurement = await this.measure(directory, { mode: 'reclaim', budgetMs: MEASURE_BUDGET_MS })
        if (!measurement.files) continue // An empty leftover folder holds nothing.
        // A thread whose checkout can't be verified may still use a folder of its repository: not called unused, and says why.
        // The repository is the one the folder's checkouts point at now, as well as the one its place is named after.
        let children: string[] = []
        try { children = readdirSync(directory).slice(0, 32) } catch { /* Judged by the folder itself. */ }
        const checkouts = [directory, ...children.map((child) => join(directory, child))]
        const actual = await Promise.all([...new Set((await Promise.all(checkouts.map((checkout) => gitCommonDirAsync(checkout)))).filter((commonDir): commonDir is string => Boolean(commonDir)))].map((commonDir) => repositoryTargetAsync(commonDir)))
        const unverified = unverifiedOwnerOver(claims, { repositoryIds: [repository, ...actual.flatMap((target) => target.repositoryIds)], registeredWorktrees: actual.flatMap((target) => target.registeredWorktrees), path: real })
        items.push({ rule: 'worktree-orphan', label: `${kind === 'folder' ? basename(folder) : kind}/${name}`, bytes: measurement.bytes, files: measurement.files, ...approximate(measurement), outcome: 'kept', reason: unverified ? `${unverified.reason} It may still use this worktree.` : 'No thread uses this worktree' })
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
  private async trashPhase(now: number, trigger: StorageCleanupReport['trigger'], allowed?: ReadonlySet<string>): Promise<StorageCleanupItem[]> {
    const purge = this.deps.purge
    if (trigger === 'schedule') return (await purge.requestSweep(now, { limit: 5 })).map((outcome) => this.trashItem(outcome))
    // A confirmed plan empties only the trash it listed; anything that became overdue since stays for the next run.
    const snapshot = purge.overdueTaskIds(now).filter((taskId) => !allowed || allowed.has(trashKey(taskId)))
    if (allowed && !snapshot.length) return []
    if (!purge.policy().automaticPurge) {
      // Only worth a line when something in the trash is already past its retention.
      const waiting = purge.overdueTaskIds(now, true).length
      return waiting ? [{ rule: 'trash', label: `${plural(waiting, 'thread')} in the trash`, bytes: 0, outcome: 'kept', reason: 'A delete that did not finish; it finishes at the next start' }] : []
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
