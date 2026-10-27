import { appendFileSync, existsSync, lstatSync, readFileSync, readdirSync, realpathSync, statSync, unlinkSync, writeFileSync, type Dirent } from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'
import type { TaskLifecycleRecord } from '../../shared/resourceLifecycle'
import { REPORT_ENTRY_LIMIT, storagePolicyHasRule, type StorageCleanupItem, type StorageCleanupReport, type StoragePolicy } from '../../shared/storage'
import type { Thread } from '../../shared/types'
import type { ThreadWorkspaceMetadata } from '../../shared/workspace'
import { atomicWriteJsonSync } from '../data/AtomicFs'
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
import type { StoragePolicyStore } from './StoragePolicyStore'
import type { StorageSweepClock } from './sweepClock'
import { WorktreeRetirementService } from './WorktreeRetirementService'

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
  now?: () => number
  /** Test seam; defaults to `measureTree`. */
  measure?: typeof measureTree
}

/** What evaluation decided about one worktree, before any lease is taken. */
type Verdict =
  | { keep: string }
  | { rule: 'worktree-inactive' | 'worktree-merged'; reason: string; head: string; workspace: ThreadWorkspaceMetadata; policyDigest: string; measurement: Measurement }
interface Evaluation { record: TaskLifecycleRecord; label: string; projectId?: string; verdict: Verdict }

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
  private firstRun?: ReturnType<typeof setTimeout>
  private interval?: ReturnType<typeof setInterval>
  private afterPolicyChange?: ReturnType<typeof setTimeout>
  private stopping = false
  private cursor?: string
  private now: () => number
  private readonly measure: typeof measureTree

  constructor(private readonly deps: StorageCleanupDeps) {
    this.now = deps.now ?? Date.now
    this.measure = deps.measure ?? measureTree
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

  /** True while the time-based rules are paused after the clock moved backwards; saving the policy resumes them. */
  clockSuspended(): boolean { return this.deps.clock.suspended() }

  lastReport(): StorageCleanupReport | null {
    const path = this.reportPath
    try { return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) as StorageCleanupReport : null } catch { return null }
  }

  /** One run at a time: a request during a run gets that run's report. */
  run(trigger: StorageCleanupReport['trigger']): Promise<StorageCleanupReport> {
    if (this.current) return this.current
    const run: Promise<StorageCleanupReport> = this.execute(trigger).finally(() => { if (this.current === run) this.current = undefined })
    this.current = run
    return run
  }

  /**
   * Dry run: what a run would remove or keep now, with the reason and the space it would free, for
   * the worktree rules and the overdue trash. It takes no lease, changes nothing, writes no report
   * and does not touch the clock guard. A removal it lists can still be kept by the checks a run
   * repeats under the thread and repository leases.
   */
  async plan(now = this.now()): Promise<PlannedCleanup[]> {
    const policy = this.deps.policy.policy()
    const planned: PlannedCleanup[] = []
    if (policy.worktrees.removeWithDeletedThreads) planned.push(...await this.planDeletedThreadWorktrees())
    for (const entry of await this.evaluateWorktrees(policy, !this.deps.clock.suspended(), now, false)) {
      const base = { threadId: entry.record.taskId, projectId: entry.projectId, label: entry.label }
      planned.push('rule' in entry.verdict
        ? { ...base, rule: entry.verdict.rule, action: 'remove', reason: entry.verdict.reason, bytes: entry.verdict.measurement.bytes, ...approximate(entry.verdict.measurement) }
        : { ...base, rule: 'worktree-inactive', action: 'keep', reason: entry.verdict.keep, bytes: 0 })
    }
    planned.push(...await this.planTrash(now))
    return planned
  }

  private async planDeletedThreadWorktrees(): Promise<PlannedCleanup[]> {
    const planned: PlannedCleanup[] = []
    for (const record of this.deps.store.list().filter((entry) => entry.state === 'trashed' && !entry.parentTaskId)) {
      const { label, projectId } = this.labelFor(record.taskId)
      const base = { rule: 'worktree-deleted' as const, threadId: record.taskId, projectId, label }
      try {
        const workspace = readWorkspaceFile(record.location)
        if (!workspace || !existsSync(workspace.worktreePath)) continue
        const preview = await this.deps.purge.preview(record.taskId)
        const retained = preview.blockers[0] ?? preview.items.find((item) => item.kind === 'worktree' && existsSync(item.identity) && !item.manifestPath)?.reason
        if (retained) { planned.push({ ...base, action: 'keep', reason: retained, bytes: 0 }); continue }
        const measurement = await this.measure(workspace.worktreePath, { mode: 'reclaim', budgetMs: MEASURE_BUDGET_MS })
        planned.push({ ...base, action: 'remove', reason: 'Thread was deleted', bytes: measurement.bytes, ...approximate(measurement) })
      } catch (error) {
        planned.push({ ...base, action: 'keep', reason: (error as Error).message, bytes: 0 })
      }
    }
    return planned
  }

  private async planTrash(now: number): Promise<PlannedCleanup[]> {
    const purge = this.deps.purge
    const ids = purge.overdueTaskIds(now)
    if (!ids.length) return []
    const status = purge.sweepStatus()
    if (status.suspended) return [{ rule: 'trash', label: `${plural(ids.length, 'thread')} in the trash`, action: 'keep', reason: status.reason ?? 'Automatic trash cleanup is paused', bytes: 0 }]
    const planned: PlannedCleanup[] = []
    for (const taskId of ids) {
      const { label, projectId } = this.labelFor(taskId)
      const base = { rule: 'trash' as const, threadId: taskId, projectId, label }
      try {
        const preview = await purge.preview(taskId)
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
    let policy: StoragePolicy | undefined
    let hasRule = true
    try {
      policy = this.deps.policy.policy()
      let automaticPurge = false
      try { automaticPurge = this.deps.purge.policy().automaticPurge } catch { /* An unreadable trash policy keeps trash cleanup off. */ }
      hasRule = storagePolicyHasRule(policy, { schemaVersion: 1, graceDays: 30, automaticPurge })
    } catch (error) {
      items.push({ rule: 'worktree-inactive', label: 'Storage settings', bytes: 0, outcome: 'failed', reason: `Storage policy could not be read: ${(error as Error).message}` })
    }
    // Checked before any age is evaluated and whether or not automatic trash emptying is on.
    const clock = this.deps.clock.check()
    if (clock.suspended) suspended = clock.reason
    else if ((clock.forwardJumpMs ?? 0) > FORWARD_JUMP_NOTE_MS) clockNote = `Clock moved forward by ${Math.round(clock.forwardJumpMs! / 3_600_000)} h since the last run`

    if (policy && (hasRule || trigger === 'manual')) {
      try { items.push(...await this.worktreePhase(policy, !clock.suspended, startedMs, trigger)) }
      catch (error) { items.push({ rule: 'worktree-inactive', label: 'Worktrees', bytes: 0, outcome: 'failed', reason: (error as Error).message }) }
      try { items.push(...await this.trashPhase(startedMs, trigger)) }
      catch (error) { items.push({ rule: 'trash', label: 'Trash', bytes: 0, outcome: 'failed', reason: (error as Error).message }) }
      try { items.push(...await this.orphanItems()) } catch { /* Ownership could not be proven; nothing is reported. */ }
    }
    const report = this.buildReport(trigger, startedMs, items, suspended, clockNote)
    this.recordRemovals(report.completedAt, trigger, items)
    // An hourly run with no rule on has nothing to say and must not replace the last manual report.
    if (trigger === 'manual' || hasRule) {
      try { atomicWriteJsonSync(this.reportPath, report) } catch { /* The report is still returned. */ }
    }
    return report
  }

  private get historyPath(): string { return join(this.deps.store.root, HISTORY_FILE) }

  /**
   * Appends every removal to `storage-cleanup-history.jsonl`, one JSON line each. The last-run report
   * is replaced by the next run, and an hourly run that finds nothing would otherwise erase the only
   * record of what an earlier run deleted. The file keeps its newest lines once it grows past a limit.
   * A write failure never undoes a removal that already happened.
   */
  private recordRemovals(at: string, trigger: StorageCleanupReport['trigger'], items: StorageCleanupItem[]): void {
    const removed = items.filter((item) => item.outcome === 'removed')
    if (!removed.length) return
    try {
      const path = this.historyPath
      assertLifecyclePath(this.deps.store.root, path)
      if (existsSync(path) && statSync(path).size > HISTORY_MAX_BYTES) {
        writeFileSync(path, readFileSync(path, 'utf8').split('\n').filter(Boolean).slice(-HISTORY_KEEP_LINES).join('\n') + '\n')
      }
      appendFileSync(path, removed.map((item) => JSON.stringify({ at, trigger, rule: item.rule, threadId: item.threadId, projectId: item.projectId, label: item.label, bytes: item.bytes, ...(item.bytesApproximate ? { bytesApproximate: true } : {}), reason: item.reason })).join('\n') + '\n')
    } catch { /* The report still lists the removals. */ }
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

  private async worktreePhase(policy: StoragePolicy, timeRulesEnabled: boolean, now: number, trigger: StorageCleanupReport['trigger']): Promise<StorageCleanupItem[]> {
    const items: StorageCleanupItem[] = []
    if (policy.worktrees.removeWithDeletedThreads) items.push(...await this.deletedThreadWorktrees())
    const evaluations = await this.evaluateWorktrees(policy, timeRulesEnabled, now, trigger === 'schedule')
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

  /** Worktrees of threads already in the trash, for a policy turned on after the thread was deleted. */
  private async deletedThreadWorktrees(): Promise<StorageCleanupItem[]> {
    const items: StorageCleanupItem[] = []
    for (const record of this.deps.store.list().filter((entry) => entry.state === 'trashed' && !entry.parentTaskId)) {
      if (this.stopping) break
      const { label, projectId } = this.labelFor(record.taskId)
      try {
        const workspace = readWorkspaceFile(record.location)
        if (!workspace || !existsSync(workspace.worktreePath)) continue
        const measurement = await this.measure(workspace.worktreePath, { mode: 'reclaim', budgetMs: MEASURE_BUDGET_MS })
        await this.deps.purge.retireTrashed(record.taskId)
        if (existsSync(workspace.worktreePath)) {
          items.push({ rule: 'worktree-deleted', threadId: record.taskId, projectId, label, bytes: 0, outcome: 'kept', reason: this.deps.store.get(record.taskId)?.blockedReason ?? 'Worktree was kept' })
        } else {
          items.push({ rule: 'worktree-deleted', threadId: record.taskId, projectId, label, bytes: measurement.bytes, files: measurement.files, ...approximate(measurement), outcome: 'removed', reason: 'Thread was deleted' })
        }
      } catch (error) {
        items.push({ rule: 'worktree-deleted', threadId: record.taskId, projectId, label, bytes: 0, outcome: 'failed', reason: (error as Error).message })
      }
    }
    return items
  }

  /**
   * Pre-filter: every reason-producing check runs here with no lease held, so nothing in this phase
   * blocks a thread. A scheduled run looks at one batch per tick; a manual run looks at all of them.
   */
  private async evaluateWorktrees(policy: StoragePolicy, timeRulesEnabled: boolean, now: number, batched: boolean): Promise<Evaluation[]> {
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
    const policyDigest = this.deps.policy.digest()
    const evaluations: Evaluation[] = []
    for (const record of candidates) {
      if (this.stopping) break
      const { label, projectId } = this.labelFor(record.taskId)
      let verdict: Verdict | undefined
      try { verdict = await this.evaluateOne(record, policy, inactiveOn, mergedOn, now, policyDigest) }
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

  /** The fixed order of keep reasons; the first match wins. Undefined means skip silently. */
  private async evaluateOne(record: TaskLifecycleRecord, policy: StoragePolicy, inactiveOn: boolean, mergedOn: boolean, now: number, policyDigest: string): Promise<Verdict | undefined> {
    const workspace = readWorkspaceFile(record.location)
    if (!workspace) return undefined
    if (workspace.lifecycle !== 'ready') return { keep: 'Workspace is not ready' }
    const path = workspace.worktreePath
    if (!existsSync(path)) return undefined
    const busy = this.deps.idle(record.taskId)
    if (busy) return { keep: busy }
    if (isExecutionLeaseHeld(record.location)) return { keep: 'Thread is in use' }
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
    let rule: 'worktree-inactive' | 'worktree-merged' | undefined
    let reason = ''
    const reasons: string[] = []
    if (inactiveOn) {
      const ageDays = Math.max(0, (now - this.activityAt(record, workspace, head)) / DAY_MS)
      if (ageDays >= policy.worktrees.inactiveDays!) { rule = 'worktree-inactive'; reason = `Inactive for ${Math.floor(ageDays)} days` }
      else reasons.push(`Inactive for ${Math.floor(ageDays)} of ${policy.worktrees.inactiveDays} days`)
    }
    if (!rule && mergedOn) {
      if (beyondBase > 0 && integrated) { rule = 'worktree-merged'; reason = 'Work is merged into the default branch' }
      else reasons.push('No commits to merge yet')
    }
    if (!rule) return { keep: reasons.join('; ') }
    const measurement = await this.measure(path, { mode: 'reclaim', budgetMs: MEASURE_BUDGET_MS })
    return { rule, reason, head, workspace, policyDigest, measurement }
  }

  /**
   * Take the thread lease, then the repository lease (the order `ThreadWorkspaceManager.restore` and
   * `GitOperationCoordinator` use), repeat the checks that can change, and only then prepare and
   * retire. Expected hold time is the re-check plus `prepare` and `retire`, plus up to two seconds
   * waiting for the repository lease. Removed means `retire` returned.
   */
  private async retire(entry: Evaluation, verdict: Extract<Verdict, { rule: unknown }>): Promise<StorageCleanupItem> {
    const { record, label, projectId } = entry
    const { workspace, head, measurement } = verdict
    const base = { rule: verdict.rule, threadId: record.taskId, projectId, label }
    const kept = (reason: string): StorageCleanupItem => ({ ...base, bytes: 0, outcome: 'kept', reason })
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
        const retirement = new WorktreeRetirementService(this.deps.store, { taskLease, repositoryLease })
        retirement.prepare({ taskId: record.taskId, worktreePath: workspace.worktreePath, branch: workspace.branch, sourcePath: join(record.location, 'workspace.json'), repositoryId: workspace.repositoryId, baseSha: workspace.baseSha, resultSha: head })
        retirement.retire(retirement.pathFor(record.taskId, workspace.worktreePath))
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
    return {
      rule: 'trash', threadId: outcome.taskId, projectId, label, bytes: outcome.outcome === 'purged' ? outcome.bytes : 0,
      ...(outcome.outcome === 'purged' ? { ...(outcome.bytesApproximate ? { bytesApproximate: true as const } : {}), ...(outcome.bytesLowerBound ? { bytesLowerBound: true as const } : {}) } : {}),
      outcome: outcome.outcome === 'purged' ? 'removed' : outcome.outcome,
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
