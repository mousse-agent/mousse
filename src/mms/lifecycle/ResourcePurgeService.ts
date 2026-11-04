import { createErrorProvider, knownAppError, normalizeAppError } from '../../shared/errors'
import { createHash, randomUUID } from 'node:crypto'
import { closeSync, existsSync, fchmodSync, lstatSync, openSync, readdirSync, readFileSync, realpathSync, rmdirSync, unlinkSync, writeFileSync, type Stats } from 'node:fs'
import { access, lstat, readdir, readFile } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'
import type { LifecyclePurgeItem, LifecyclePurgePreview, TaskLifecycleRecord, TrashRetentionPolicy } from '../../shared/resourceLifecycle'
import { atomicWriteJsonSync } from '../data/AtomicFs'
import { acquireRepositoryLease } from '../git/RepositoryLease'
import { resolveRepositoryIdentityAsync } from '../git/RepositoryIdentity'
import { canonicalPathAsync, comparablePath, gitCommonDirAsync } from './canonicalPath'
import { buildResourceInventory, OwnershipFacts } from './ResourceInventory'
import { projectFolderPurgeRefs, threadKeptFilesRefs } from './projectFolderRefs'
import { measureTree } from './diskMeasure'
import { assertLifecyclePath, assertLifecyclePathAsync, ResourceLifecycleStore } from './ResourceLifecycleStore'
import { lockReasonSync, WorktreeRetirementService } from './WorktreeRetirementService'
import { lifecycleGitAsync, lifecycleReadAsync, readDirectLifecycleRefAsync } from './lifecycleGit'
import { READ_ONLY_GIT_ENV } from '../git/readOnlyGit'
import { assertFrozenEntryUnchanged, lockedText, proveFrozenContentEntryAsync, walkOwnedContentAsync } from './verifiedDelete'
import { isOwnerLive, PROCESS_INSTANCE_ID } from '../queue/processLiveness'
import { claimOverlapsPath, getExternalResourceClaims, getExternalResourceClaimsFromFacts, repositoryTargetAsync, unverifiedOwnerOver, type ClaimTarget } from './LifecycleClaims'
import { withFileLock } from '../scheduled/fileLock'
import { isMousseOwnedRef } from '../../shared/mousseBranches'
import { isKeptFilesItem, unverifiedHolds } from '../../shared/resourceLifecycle'
import { isOwnedSnapshotStore } from '../git/gitPolicy'
import { threadStoreKeptFilesAsync } from '../actions/SnapshotRefReleaseService'

const digest = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const within = (root: string, path: string): boolean => { const rel = relative(resolve(root), resolve(path)); return !isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) }
const active = new Set<string>()
/** Whether `path` is there, as `existsSync` answers; a checkout is read without blocking the daemon. */
const present = (path: string): Promise<boolean> => access(path).then(() => true, () => false)
const rootIdentity = (stat: { dev: number; ino: number; birthtimeMs: number }) => digest({ dev: stat.dev, ino: stat.ino, birthtimeMs: stat.birthtimeMs })
/**
 * Whether `stat` is the folder `recorded` identifies: the same device and inode, and the same creation time where the
 * file system keeps one. Where it doesn't, Node gives 0 or the change time, which the folder's own removals move, so it is
 * not compared; the caller compares the real path as well.
 */
function sameFolder(stat: Stats, recorded: { dev: number; ino: number; birthtimeMs: number } | undefined): boolean {
  if (!recorded || !stat.isDirectory() || stat.dev !== recorded.dev || stat.ino !== recorded.ino) return false
  return !hasBirthtime(stat) || stat.birthtimeMs === recorded.birthtimeMs
}
const hasBirthtime = (stat: Stats): boolean => stat.birthtimeMs !== 0 && stat.birthtimeMs !== stat.ctimeMs
/** The real path of an existing `path`, as two of them are compared; always read the same way. */
const realOf = (path: string): string => comparablePath(realpathSync(path))
/** Time one reclaim estimate may spend measuring files. */
const RECLAIM_BUDGET_MS = 20_000

export interface TrashSweepOptions {
  /** Records to attempt in this call; five by default. */
  limit?: number
  /** Attempt only these records (a manual run's snapshot). */
  only?: ReadonlySet<string>
}
export interface TrashSweepOutcome {
  taskId: string
  outcome: 'purged' | 'kept' | 'failed'
  reason?: string
  /** Space recovered; 0 unless `purged`. */
  bytes: number
  bytesApproximate?: true
  bytesLowerBound?: true
}

const purgeErrors = createErrorProvider({
  resource_purge_discard_required: { category: 'denied', retryable: false, message: 'Sole-copy discard requires an exact human-reviewed preview.' },
  resource_purge_repository_unavailable: { category: 'unavailable', retryable: false, message: 'Repository is unavailable; purge remains pending. Reconnect the repository and retry.' },
  resource_purge_preview_stale: { category: 'conflict', retryable: false, message: 'Purge preview changed; review a fresh inventory.' },
  resource_policy_invalid: { category: 'invalid', retryable: false, message: 'Invalid trash retention policy. Grace days must be an integer from 1 to 3650.' },
  resource_purge_io_error: { category: 'conflict', retryable: false, message: 'Purge could not remove a locked or permission-protected resource. Close applications using it and retry the pending purge.' }
})

/** A permanent delete that stopped to keep something; Trash shows the reason, which names what was kept. */
function purgeStopped(reason: string): Error {
  return knownAppError({ code: 'resource_purge_kept', message: `Permanent delete stopped: ${reason}` }, { category: 'conflict', retryable: false })
}
/** "base.txt was saved in this worktree after it began. It was kept.", naming at most three files. */
function savedText(paths: readonly string[]): string {
  const more = paths.length - 3
  const names = more > 0 ? `${paths.slice(0, 3).join(', ')} and ${more} more ${more === 1 ? 'file' : 'files'}`
    : paths.length > 1 ? `${paths.slice(0, -1).join(', ')} and ${paths.at(-1)}` : paths[0] ?? 'A file'
  return `${names} ${paths.length > 1 ? 'were' : 'was'} saved in this worktree after it began. It was kept.`
}
/** What `folder` holds besides its own `.git`, relative to it, sorted; an empty folder ends in `/`. Links are not followed. */
async function filesIn(folder: string, limit = 1000): Promise<string[]> {
  const found: string[] = []
  const visit = async (rel: string): Promise<void> => {
    const names = (await readdir(rel ? join(folder, rel) : folder).catch(() => [] as string[])).sort().filter((name) => rel || name !== '.git')
    if (rel && !names.length) found.push(`${rel}/`)
    for (const name of names) {
      if (found.length >= limit) return
      const path = rel ? `${rel}/${name}` : name
      if ((await lstat(join(folder, path)).catch(() => undefined))?.isDirectory()) await visit(path)
      else found.push(path)
    }
  }
  await visit('')
  return found
}
/**
 * A read-only Git command in the checkout `folder`, which never reaches the repository of a folder above it: `linked`
 * says its `.git` is still there (by default, that it is there at all), and is checked before anything else runs for the
 * command and again right before Git starts; Git may not look past `folder` either (`GIT_CEILING_DIRECTORIES`).
 */
async function readInCheckout(folder: string, args: string[], linked?: () => void): Promise<string> {
  const check = linked ?? ((): void => {
    try { lstatSync(join(folder, '.git')) } catch { throw new Error(`${folder} has no link to its repository (.git)`) }
  })
  check()
  const ceiling = await canonicalPathAsync(dirname(folder))
  return lifecycleGitAsync(folder, args, undefined, undefined, { ...READ_ONLY_GIT_ENV, GIT_CEILING_DIRECTORIES: ceiling }, check)
}
const fileIdentity = (stat: Stats): string => digest({ dev: stat.dev, ino: stat.ino, size: stat.size, mtimeMs: stat.mtimeMs })
interface WorktreeRegistration {
  /** `<common>/worktrees/<name>`: the registration's own folder, whose name is unique in the repository. */
  adminDir: string
  /** The worktree's path as Git recorded it. */
  path: string
}
/**
 * Git's registration of the worktree at `worktree`, found by its administration folder (`<common>/worktrees/<name>/gitdir`)
 * rather than by asking Git about the path, so it is found with the folder, or even its parent, gone. Read without Git.
 */
async function registrationOf(commonDir: string, worktree: string): Promise<WorktreeRegistration | undefined> {
  const root = join(commonDir, 'worktrees')
  const names = await readdir(root).catch(() => [] as string[])
  const wanted = comparablePath(await canonicalPathAsync(worktree))
  for (const name of names.sort()) {
    const recorded = (await readFile(join(root, name, 'gitdir'), 'utf8').catch(() => '')).trim()
    if (!recorded) continue
    // Git writes `<worktree>/.git`, absolute unless `worktree.useRelativePaths` is set.
    const path = (isAbsolute(recorded) ? recorded : resolve(root, name, recorded)).replace(/[\\/]\.git$/, '')
    if (comparablePath(await canonicalPathAsync(path)) === wanted) return { adminDir: join(root, name), path }
  }
  return undefined
}

/** External purge ledger survives deletion of every task-owned source. No Git object pruning. */
export interface RetireTrashedOptions {
  recheck?: (worktreePath: string) => string | undefined | Promise<string | undefined>
  beforeMove?: (worktreePath: string) => string | undefined
}

export class ResourcePurgeService {
  readonly retirement: WorktreeRetirementService
  private timer?: ReturnType<typeof setInterval>
  private sweepPromise?: Promise<TrashSweepOutcome[]>
  private stopping = false
  constructor(readonly store: ResourceLifecycleStore, private readonly hooks: { assertIdle(taskId: string): void; projectPurged(record: TaskLifecycleRecord): void | Promise<void>; onBoundary?(record: TaskLifecycleRecord): void | Promise<void>; /** Every pass, the first and each resumed one, before any item is removed; a failure stops the pass. */ beforeRemoval?(record: TaskLifecycleRecord): void | Promise<void>; configurationChanged?(): void; /** Stops background disk measurement until the returned function is called, so no handle of it is open in what is about to be removed. */ quiesceDisk?(): Promise<() => void> }) { this.retirement = new WorktreeRetirementService(store) }

  policy(): TrashRetentionPolicy {
    const path = join(this.store.root, 'trash-policy.json')
    if (!existsSync(path)) return { schemaVersion: 1, graceDays: 30, automaticPurge: false }
    assertLifecyclePath(this.store.root, path)
    const policy = JSON.parse(readFileSync(path, 'utf8')) as TrashRetentionPolicy
    if (policy.schemaVersion !== 1 || !Number.isSafeInteger(policy.graceDays) || policy.graceDays < 1 || policy.graceDays > 3650 || typeof policy.automaticPurge !== 'boolean') throw new Error('Unknown trash retention policy')
    return policy
  }
  sweepStatus(): { suspended: boolean; reason?: string } {
    const path = join(this.store.root, 'trash-clock.json')
    if (!existsSync(path)) return { suspended: false }
    assertLifecyclePath(this.store.root, path)
    const state = JSON.parse(readFileSync(path, 'utf8')) as { suspended?: boolean }
    return state.suspended ? { suspended: true, reason: 'Automatic trash cleanup paused after a clock discontinuity. Review and save the trash policy to resume.' } : { suspended: false }
  }
  configure(policy: TrashRetentionPolicy, human: boolean): TrashRetentionPolicy {
    if (!human) throw new Error('Trash retention changes require a human-controlled settings action')
    if (policy.schemaVersion !== 1 || !Number.isSafeInteger(policy.graceDays) || policy.graceDays < 1 || policy.graceDays > 3650 || typeof policy.automaticPurge !== 'boolean') throw purgeErrors.create('resource_policy_invalid')
    this.store.enableCleanupWriter(); atomicWriteJsonSync(join(this.store.root, 'trash-policy.json'), policy)
    atomicWriteJsonSync(join(this.store.root, 'trash-clock.json'), { highWater: Date.now() })
    return this.policy()
  }
  start(): void {
    if (this.timer) return
    this.stopping = false
    this.timer = setInterval(() => { void this.requestSweep().catch(() => { /* Invalid policy/source remains visible through inventory; no cleanup occurred. */ }) }, 60_000)
    this.timer.unref()
  }
  async stop(): Promise<void> { this.stopping = true; if (this.timer) clearInterval(this.timer); this.timer = undefined; await this.sweepPromise?.catch(() => undefined) }
  /** Trashed root threads whose retention has passed, in the order a sweep visits them. */
  private overdue(now: number, graceDays: number): TaskLifecycleRecord[] {
    return this.store.list().filter((record) => record.state === 'trashed' && !record.parentTaskId && now - Date.parse(record.trashedAt ?? record.operations.filter((operation) => operation.kind === 'trash' && operation.phase === 'completed').at(-1)?.completedAt ?? record.createdAt) >= graceDays * 86_400_000).sort((a, b) => a.taskId.localeCompare(b.taskId))
  }
  /**
   * Ids past retention now. A manual run snapshots this once. Empty while automatic emptying is
   * off, unless `ignoreAutomatic` asks which records would be due.
   */
  overdueTaskIds(now = Date.now(), ignoreAutomatic = false): string[] {
    const policy = this.policy()
    return policy.automaticPurge || ignoreAutomatic ? this.overdue(now, policy.graceDays).map((record) => record.taskId) : []
  }
  /** One sweep at a time: a request during a running sweep gets that sweep's outcomes. */
  requestSweep(now = Date.now(), options: TrashSweepOptions = {}): Promise<TrashSweepOutcome[]> {
    if (this.sweepPromise) return this.sweepPromise
    const run: Promise<TrashSweepOutcome[]> = this.sweep(now, options).finally(() => { if (this.sweepPromise === run) this.sweepPromise = undefined })
    this.sweepPromise = run
    return run
  }
  /**
   * What permanent deletion would free, measured on the present checkout and file items. An absent
   * (already retired) checkout and Git refs count 0. Hard-linked files free nothing and are not
   * counted. This is an estimate for display; `preview.exclusiveBytes` and the digest are untouched.
   */
  async reclaimEstimate(preview: LifecyclePurgePreview): Promise<{ bytes: number; estimated: boolean; partial: boolean }> {
    const total = { bytes: 0, estimated: false, partial: false }
    const deadline = Date.now() + RECLAIM_BUDGET_MS
    for (const item of preview.items) {
      if ((item.kind !== 'worktree' && item.kind !== 'path') || !await present(item.identity)) continue
      const budgetMs = deadline - Date.now()
      if (budgetMs <= 0) { total.partial = true; break }
      const measured = await measureTree(item.identity, { mode: 'reclaim', budgetMs })
      total.bytes += measured.bytes; total.estimated ||= measured.estimated; total.partial ||= measured.partial
    }
    return total
  }
  /**
   * Purges overdue records, at most `limit` per call (five by default), and says what happened to each:
   * purged, kept (unpublished or sole-copy content, or a blocker) or failed. Bytes are measured before
   * the purge and reported only when it succeeds.
   */
  async sweep(now = Date.now(), options: TrashSweepOptions = {}): Promise<TrashSweepOutcome[]> {
    const outcomes: TrashSweepOutcome[] = []
    const policy = this.policy()
    if (!policy.automaticPurge || this.stopping) return outcomes
    const clockPath = join(this.store.root, 'trash-clock.json')
    assertLifecyclePath(this.store.root, clockPath)
    const previous = existsSync(clockPath) ? JSON.parse(readFileSync(clockPath, 'utf8')) as { highWater: number; suspended?: boolean; cursor?: string } : { highWater: now }
    if (!Number.isSafeInteger(previous.highWater) || previous.suspended || now < previous.highWater || now - previous.highWater > 24 * 60 * 60 * 1000) {
      atomicWriteJsonSync(clockPath, { ...previous, suspended: true }); return outcomes
    }
    atomicWriteJsonSync(clockPath, { ...previous, highWater: Math.max(now, previous.highWater) })
    const overdue = this.overdue(now, policy.graceDays)
    const all = options.only ? overdue.filter((record) => options.only!.has(record.taskId)) : overdue
    const afterCursor = previous.cursor && !options.only ? all.findIndex((record) => record.taskId.localeCompare(previous.cursor!) > 0) : 0
    const start = afterCursor < 0 ? 0 : afterCursor
    const eligible = [...all.slice(start), ...all.slice(0, start)].slice(0, options.limit ?? 5)
    for (const record of eligible) {
      if (this.stopping) break
      atomicWriteJsonSync(clockPath, { highWater: Math.max(now, previous.highWater), cursor: record.taskId })
      try {
        const preview = await this.preview(record.taskId)
        if (preview.blockers.length || preview.items.some((item) => item.discardRequired)) {
          const reason = preview.blockers.join('; ') || 'Automatic trash cleanup retains unpublished or sole-copy content; review permanent deletion to decide.'
          this.store.update(record.taskId, (current) => { current.blockedReason = reason })
          outcomes.push({ taskId: record.taskId, outcome: 'kept', reason, bytes: 0 }); continue
        }
        const reclaim = await this.reclaimEstimate(preview)
        await this.purge({ taskId: record.taskId, operationId: randomUUID(), expectedGeneration: preview.generation, previewDigest: preview.digest })
        outcomes.push({ taskId: record.taskId, outcome: 'purged', bytes: reclaim.bytes,
          ...(reclaim.estimated || reclaim.partial ? { bytesApproximate: true as const } : {}), ...(reclaim.partial && !reclaim.estimated ? { bytesLowerBound: true as const } : {}) })
      } catch (error) {
        const reason = (error as Error).message
        this.store.update(record.taskId, (current) => { current.blockedReason = reason })
        outcomes.push({ taskId: record.taskId, outcome: 'failed', reason, bytes: 0 })
      }
    }
    return outcomes
  }
  /**
   * Retires the checkouts of a trashed thread. `recheck` runs for each checkout under the cleanup
   * reservation and the repository lease, just before it is removed; a returned reason keeps that
   * checkout. Automatic rules use it to repeat their location and content checks at that point.
   * `beforeMove` runs synchronously right before the checkout moves, with nothing awaited in between,
   * for the checks that must hold at that moment; a returned reason keeps the checkout too.
   */
  async retireTrashed(taskId: string, options: RetireTrashedOptions = {}): Promise<void> {
    const release = await this.hooks.quiesceDisk?.()
    try { await this.retireTrashedQuiet(taskId, options) } finally { release?.() }
  }
  private async retireTrashedQuiet(taskId: string, options: RetireTrashedOptions): Promise<void> {
    await this.withOwnership(taskId, async () => {
      const record = this.store.require(taskId), token = record.cleanupOwner!.token
      if (record.state !== 'trashed') return
      const preview = await this.previewOwned(taskId)
      const retained = [...preview.blockers]
      // Checkouts another thread's unverifiable records may name are not items; the thread's other checkouts still retire.
      const holds = new Set(unverifiedHolds(preview))
      if (preview.blockers.every((blocker) => holds.has(blocker))) for (const item of preview.items.filter((item) => item.kind === 'worktree')) {
        if (!item.manifestPath) { retained.push(`Checkout retained: ${item.reason ?? item.identity}`); continue }
        if (!await present(item.identity)) continue
        try {
          const lease = await acquireRepositoryLease(await resolveRepositoryIdentityAsync(item.identity, { requireMutationCapability: true }), { signal: AbortSignal.timeout(10_000) })
          try {
            this.assertReservation(taskId, token, record.generation)
            const refusal = await options.recheck?.(item.identity)
            if (refusal) throw new Error(refusal)
            this.assertReservation(taskId, token, record.generation)
            // The reservation and the caller's own last checks run again right before the move, with nothing awaited in between.
            const beforeMove = (): void => {
              this.assertReservation(taskId, token, record.generation)
              const late = options.beforeMove?.(item.identity)
              if (late) throw new Error(late)
            }
            await new WorktreeRetirementService(this.store, { repositoryLease: lease, cleanupTaskId: taskId, cleanupToken: token, cleanupGeneration: record.generation }).retire(item.manifestPath, { beforeMove })
          } finally { lease.release() }
        } catch (error) { retained.push(`Checkout retained: ${(error as Error).message}`) }
      }
      this.store.update(taskId, (current) => { if (retained.length) current.blockedReason = retained.join('; '); else delete current.blockedReason })
    })
  }
  private owned(taskId: string): TaskLifecycleRecord[] {
    const records = this.store.list(), ids = new Set([taskId])
    for (let added = true; added;) { added = false; for (const item of records) if (item.parentTaskId && ids.has(item.parentTaskId) && !ids.has(item.taskId) && item.state !== 'trashed') { ids.add(item.taskId); added = true } }
    return records.filter((record) => ids.has(record.taskId))
  }
  /** Fresh source-derived claims from every installed profile; no cached preview authorizes deletion. */
  private peers(ownedIds: Set<string>) {
    return getExternalResourceClaims(this.store, ownedIds)
  }
  /**
   * The peers' claims for a check right before a destructive step: the checkouts and project folders their records name
   * are read now, without blocking, and the returned function re-reads the records themselves synchronously, so nothing
   * is awaited between that check and the step it guards. A record naming a checkout not read here fails closed.
   */
  private async peersCheck(ownedIds: Set<string>): Promise<() => ReturnType<typeof getExternalResourceClaimsFromFacts>> {
    const facts = new OwnershipFacts()
    // Only the facts are wanted: a refusal is made again, from the records, by the returned check.
    await getExternalResourceClaims(this.store, ownedIds, facts).catch(() => undefined)
    return () => getExternalResourceClaimsFromFacts(this.store, ownedIds, facts)
  }
  async preview(taskId: string): Promise<LifecyclePurgePreview> {
    return this.withOwnership(taskId, () => this.previewOwned(taskId))
  }
  private async withOwnership<T>(taskId: string, fn: () => Promise<T>): Promise<T> {
    const token = randomUUID()
    this.store.require(taskId)
    this.store.enableCleanupWriter()
    this.store.update(taskId, (record) => {
      if (!['trashed', 'purge-started', 'purged'].includes(record.state)) throw new Error('Cleanup requires a durable trash fence')
      if (record.cleanupOwner && isOwnerLive(record.cleanupOwner)) throw new Error('Cleanup owns this task; retry after it completes')
      record.cleanupOwner = { pid: process.pid, processInstanceId: PROCESS_INSTANCE_ID, token }
    })
    try { return await fn() }
    finally { this.store.update(taskId, (record) => { if (record.cleanupOwner?.token === token) delete record.cleanupOwner }) }
  }
  private assertReservation(taskId: string, token: string, generation: number): void {
    const current = this.store.require(taskId)
    if (current.cleanupOwner?.token !== token || current.cleanupOwner.pid !== process.pid || current.cleanupOwner.processInstanceId !== PROCESS_INSTANCE_ID || current.generation !== generation || !['trashed', 'purge-started', 'purged'].includes(current.state)) throw new Error('Cleanup reservation or lifecycle generation changed')
  }
  /**
   * What a permanent deletion would do, computed without ownership, leases, lifecycle-record writes,
   * reconstruction manifests or Git refs. For a dry run only: the result is never signed for use.
   */
  async previewReadOnly(taskId: string): Promise<LifecyclePurgePreview> {
    return this.previewOwned(taskId, true)
  }
  private async previewOwned(taskId: string, readOnly = false): Promise<LifecyclePurgePreview> {
    const record = this.store.require(taskId)
    const reservation = record.cleanupOwner?.token ?? ''
    if (!readOnly && !reservation) throw new Error('Cleanup reservation is missing')
    if (record.state === 'purge-started' || record.state === 'purged') {
      if (!record.purge) throw new Error('Purge state has no external recovery ledger')
      return record.purge
    }
    if (record.state !== 'trashed') throw new Error('Only a trashed task can be permanently deleted')
    // A dry run does not hydrate runtimes; the caller asks the cheap idle lookup instead.
    if (!readOnly) this.hooks.assertIdle(taskId)
    const tasks = this.owned(taskId), ownedIds = new Set(tasks.map((task) => task.taskId))
    const preview: LifecyclePurgePreview = { schemaVersion: 1, taskId, generation: record.generation, digest: '', items: [], ownedTaskIds: [...ownedIds].sort(), blockers: [], retained: [], exclusiveBytes: 0 }
    let peers: Awaited<ReturnType<ResourcePurgeService['peers']>>
    try { peers = await this.peers(ownedIds) } catch (error) { preview.blockers.push((error as Error).message); return this.sign(preview) }
    let inventory = await buildResourceInventory(this.store, record)
    preview.blockers.push(...inventory.blockers)
    if (inventory.blockers.length || inventory.sources.some((source) => source.status !== 'verified')) return this.sign(preview)
    const repositories = new Map<string, string>()
    // Another thread whose checkout can't be verified holds only what its records may still name: that is kept back, with why.
    const held = new Set<string>()
    /** The real repository of each worktree that stays, for listing the files its restores kept as kept too. */
    const keptRepositories = new Map<string, string>()
    /** The repository part of a target, read once per repository. */
    const repositoryTargets = new Map<string, ReturnType<typeof repositoryTargetAsync>>()
    const repositoryTarget = async (commonDir: string | undefined, recorded?: string): Promise<ClaimTarget> => {
      if (!commonDir) return { repositoryIds: [recorded] }
      if (!repositoryTargets.has(commonDir)) repositoryTargets.set(commonDir, repositoryTargetAsync(commonDir))
      const found = await repositoryTargets.get(commonDir)!
      return { repositoryIds: [recorded, ...found.repositoryIds], registeredWorktrees: found.registeredWorktrees }
    }
    /** Real paths, so an alias of a folder another record names is that folder (`claimOverlapsPath`). */
    const canonical = async (identity: string): Promise<string | undefined> => isAbsolute(identity) ? canonicalPathAsync(identity) : undefined
    const keptBack = (identity: string, target: ClaimTarget): boolean => {
      const owner = unverifiedOwnerOver(peers, target)
      if (!owner) return false
      if (!held.has(identity)) preview.retained.push({ identity, reason: owner.reason, unverifiedOwner: owner.taskId })
      held.add(identity)
      return true
    }
    // Mousse's refs outside `refs/heads/` are named by ids, so the same name is the same ref whatever repository a record
    // gives: one written before the repository moved names it by its old id. A branch name is shared within a repository.
    const idNamed = (identity: string): boolean => identity.startsWith('refs/') && !identity.startsWith('refs/heads/')
    const shared = (identity: string, repositoryId: string | undefined, real: string | undefined): boolean => peers.some((peer) => peer.identity === identity && (!repositoryId || !peer.repositoryId || peer.repositoryId === repositoryId || idNamed(identity)) || real !== undefined && claimOverlapsPath(peer, real))
    for (const resource of inventory.resources.filter((item) => item.kind === 'worktree' && ownedIds.has(item.ownerTaskId))) {
      const real = await canonical(resource.identity)
      const realCommonDir = await gitCommonDirAsync(resource.identity)
      if (resource.repositoryId && realCommonDir) keptRepositories.set(resource.repositoryId, realCommonDir)
      if (shared(resource.identity, resource.repositoryId, real)) { preview.retained.push({ identity: resource.identity, reason: 'Another task or profile retains this workspace' }); continue }
      if (keptBack(resource.identity, { ...await repositoryTarget(realCommonDir, resource.repositoryId), path: real })) continue
      keptRepositories.delete(resource.repositoryId ?? '')
      try {
        const manifestPath = this.retirement.pathFor(resource.ownerTaskId, resource.identity)
        let manifest = existsSync(manifestPath) ? this.retirement.load(manifestPath) : undefined
        if (await present(resource.identity)) {
          const sources = inventory.sources.filter((source) => resource.sourceIds.includes(source.id))
          const source = sources.find((source) => basename(source.path) === 'agent-episodes.json') ?? sources.find((source) => ['workspace.json', 'agents.json', 'mousse-agent-sessions.json'].includes(basename(source.path))) ?? sources.find((source) => source.path.includes('workflow'))
          if (!source) throw new Error('Workspace has no supported owner source')
          const current = await readInCheckout(resource.identity, ['branch', '--show-current'])
          // The owner's record names the branch; the checkout may be on another one the agent switched to.
          const branch = this.retirement.ownedBranch(source.path, resource.identity) ?? current
          if (readOnly) {
            // No repository lease and no `prepare`, which writes a manifest and Git refs: judge the checkout by
            // what `prepare` would refuse. The item is for display only; it is never signed or acted on.
            const discard = await this.retirement.inspectForDiscard({ taskId: resource.ownerTaskId, sourcePath: source.path, worktreePath: resource.identity, branch, repositoryId: resource.repositoryId })
            repositories.set(discard.repositoryId, discard.commonDir)
            let retained: string | undefined
            try { await this.retirement.inspectContent(resource.identity) } catch (error) { retained = (error as Error).message }
            let discardRequired = Boolean(retained) || resource.claims.some((claim) => ['pending-integration', 'conflict'].includes(claim.kind))
            for (const source of inventory.sources.filter((source) => resource.sourceIds.includes(source.id) && basename(source.path) === 'workspace.json')) {
              // The thread's branch is the agent's to move, so the commits it holds are read from HEAD, not from the record.
              const workspace = JSON.parse(readFileSync(source.path, 'utf8')) as { integrationTarget?: { baseSha?: string } }
              if (discard.resultSha !== workspace.integrationTarget?.baseSha) discardRequired = true
            }
            preview.items.push({ id: resource.id, kind: 'worktree', identity: resource.identity, ownerTaskId: resource.ownerTaskId, commonDir: discard.commonDir, expectedValue: discard.resultSha, discardRequired, ...(discardRequired ? { reason: retained ?? 'This result may contain unpublished work' } : {}), status: 'pending' })
            preview.exclusiveBytes += discard.content.reduce((sum, entry) => sum + entry.bytes, 0)
            continue
          }
          const identity = await resolveRepositoryIdentityAsync(resource.identity, { requireMutationCapability: true })
          const lease = await acquireRepositoryLease(identity, { signal: AbortSignal.timeout(10_000) })
          try {
            this.assertReservation(taskId, reservation, record.generation)
            const input = { taskId: resource.ownerTaskId, sourcePath: source.path, worktreePath: resource.identity, branch, repositoryId: resource.repositoryId }
            try { manifest = await new WorktreeRetirementService(this.store, { repositoryLease: lease, cleanupTaskId: taskId, cleanupToken: reservation, cleanupGeneration: record.generation }).prepare(input) }
            catch (error) {
              const discard = await this.retirement.inspectForDiscard(input)
              repositories.set(discard.repositoryId, discard.commonDir)
              // The discard path compares the checkout's own branch when it removes it.
              preview.items.push({ id: resource.id, kind: 'worktree', identity: resource.identity, ownerTaskId: resource.ownerTaskId, commonDir: discard.commonDir, expectedValue: discard.resultSha, rootIdentity: discard.rootIdentity, content: discard.content, indexDigest: discard.indexDigest, branch: current, sourcePath: source.path, discardRequired: true, discardState: 'pending', reason: (error as Error).message, status: 'pending' })
              preview.exclusiveBytes += discard.content.reduce((sum, entry) => sum + entry.bytes, 0)
              continue
            }
          } finally { lease.release() }
        }
        if (!manifest) throw new Error('Absent workspace lacks a reconstruction manifest')
        await this.retirement.verifyPins(manifest)
        repositories.set(manifest.repositoryId, manifest.commonDir)
        // A worktree that held uncommitted or ignored files is kept as a snapshot and kept copies; deleting them deletes that work.
        let discardRequired = resource.claims.some((claim) => ['pending-integration', 'conflict'].includes(claim.kind)) || manifest.snapshotSha !== undefined || Boolean(manifest.keptFiles?.length)
        for (const source of inventory.sources.filter((source) => resource.sourceIds.includes(source.id) && basename(source.path) === 'workspace.json')) {
          const workspace = JSON.parse(readFileSync(source.path, 'utf8')) as { integrationTarget?: { baseSha?: string } }
          if (manifest.resultSha !== workspace.integrationTarget?.baseSha) discardRequired = true
        }
        preview.items.push({ id: resource.id, kind: 'worktree', identity: resource.identity, ownerTaskId: resource.ownerTaskId, manifestPath, commonDir: manifest.commonDir, expectedValue: manifest.resultSha, discardRequired, ...(discardRequired ? { reason: 'This result may contain unpublished work' } : {}), status: 'pending' })
        preview.exclusiveBytes += manifest.content.reduce((sum, entry) => sum + entry.bytes, 0)
      } catch (error) { preview.blockers.push(`Workspace retained: ${resource.identity}: ${(error as Error).message}`) }
    }
    // A thread that worked in its project's own folder pinned snapshots there, outside every worktree: its pins, its
    // receipts' refs and the files its restores kept (`refs/mousse/preserved/<operation>-…`) are released like a worktree
    // thread's refs, before its record goes with the task data. Refs only: nothing in the person's folder is deleted or moved.
    const folderRefs: LifecyclePurgeItem[] = []
    for (const task of tasks) {
      if (!ownedIds.has(task.taskId)) continue
      let plan: Awaited<ReturnType<typeof projectFolderPurgeRefs>>
      try { plan = await projectFolderPurgeRefs(task) } catch (error) { preview.blockers.push(`Project folder refs of ${task.taskId}: ${(error as Error).message}`); continue }
      if (!plan) continue
      if ('unavailable' in plan) { preview.retained.push({ identity: join(task.location, 'project-folder.json'), reason: plan.unavailable }); continue }
      const repository = await repositoryTarget(plan.commonDir)
      for (const { ref, sha, discardReason } of plan.refs) if (!keptBack(ref, { ...repository, ref })) folderRefs.push({ id: `project-folder-ref:${task.taskId}:${ref}`, kind: 'ref', identity: ref, ownerTaskId: task.taskId, commonDir: plan.commonDir, expectedValue: sha, ...(discardReason ? { discardRequired: true, reason: discardReason } : {}), status: 'pending' })
    }
    // A worktree thread's restores keep files in its repository's refs too; they go with the thread's other refs, and
    // while they may be the only copy of a file a purge asks before dropping them (`threadKeptFilesRefs`).
    for (const task of tasks) {
      if (!ownedIds.has(task.taskId)) continue
      const repositoryIds = new Set(inventory.resources.filter((resource) => resource.kind === 'worktree' && resource.ownerTaskId === task.taskId && resource.repositoryId).map((resource) => resource.repositoryId!))
      for (const repositoryId of repositoryIds) {
        // A worktree that stays (another owner keeps it) keeps the files its restores kept too; they are listed as kept.
        const commonDir = repositories.get(repositoryId) ?? keptRepositories.get(repositoryId)
        if (!commonDir) continue
        try {
          const repository = await repositoryTarget(commonDir, repositoryId)
          for (const { ref, sha, discardReason } of await threadKeptFilesRefs(commonDir, task.location)) {
            if (folderRefs.some((item) => item.identity === ref) || await readDirectLifecycleRefAsync(commonDir, ref) !== sha || keptBack(ref, { ...repository, ref })) continue
            if (!repositories.has(repositoryId)) { preview.retained.push({ identity: ref, reason: 'Kept with its worktree, which another task or profile retains' }); continue }
            folderRefs.push({ id: `preserved-ref:${task.taskId}:${ref}`, kind: 'ref', identity: ref, ownerTaskId: task.taskId, commonDir, expectedValue: sha, ...(discardReason ? { discardRequired: true, reason: discardReason } : {}), status: 'pending' })
          }
        } catch (error) { preview.blockers.push(`Files kept by restores of ${task.taskId}: ${(error as Error).message}`) }
      }
    }
    // A thread in a folder without Git keeps them in its hidden snapshot store, which `releaseThreadSnapshots` empties
    // before any item is removed (the purge's `beforeRemoval`). They are listed here so the same rule applies: while they
    // may be the only copy, the person must discard them and automatic cleanup keeps the thread.
    for (const task of tasks) {
      if (!ownedIds.has(task.taskId)) continue
      try {
        const kept = await threadStoreKeptFilesAsync(task.location)
        for (const { ref, sha, discardReason } of kept?.refs ?? []) folderRefs.push({ id: `snapshot-kept-ref:${task.taskId}:${ref}`, kind: 'ref', identity: ref, ownerTaskId: task.taskId, commonDir: kept!.gitDir, expectedValue: sha, ...(discardReason ? { discardRequired: true, reason: discardReason } : {}), status: 'pending' })
      } catch (error) { preview.blockers.push(`Files kept in the snapshot store of ${task.taskId}: ${(error as Error).message}`) }
    }
    preview.items.push(...folderRefs)
    const plannedRefs = new Set(folderRefs.map((item) => item.identity))
    // Preparation adds explicit reconstruction pins. Refresh rather than omitting their cleanup.
    inventory = await buildResourceInventory(this.store, this.store.require(taskId))
    for (const resource of inventory.resources) {
      if (!ownedIds.has(resource.ownerTaskId)) continue
      if (resource.kind === 'worktree' || resource.kind === 'agent-session' || resource.kind === 'artifact') continue
      const real = await canonical(resource.identity)
      if (shared(resource.identity, resource.repositoryId, real)) { preview.retained.push({ identity: resource.identity, reason: 'Another owner retains this resource' }); continue }
      if (held.has(resource.identity)) continue
      const repositoryId = resource.repositoryId ?? (repositories.size === 1 ? [...repositories.keys()][0] : undefined)
      // A ref of a worktree that stays is judged in that worktree's real repository too.
      const commonDir = repositoryId ? repositories.get(repositoryId) ?? keptRepositories.get(repositoryId) : undefined
      if (!plannedRefs.has(resource.identity) && keptBack(resource.identity, resource.kind === 'git-ref' ? { ...await repositoryTarget(commonDir, repositoryId), ref: resource.identity } : { path: resource.identity.includes('#') ? undefined : real })) continue
      if (resource.kind === 'git-ref') {
        // Already planned from the project folder's own repository.
        if (plannedRefs.has(resource.identity)) continue
        try {
          if (!isMousseOwnedRef(resource.identity)) throw new Error('Source ref is not Mousse-owned')
          const commonDir = resource.repositoryId ? repositories.get(resource.repositoryId) : repositories.size === 1 ? [...repositories.values()][0] : undefined
          if (!commonDir) throw new Error('Repository is unavailable; ref existence cannot be established')
          const expectedValue = await readDirectLifecycleRefAsync(commonDir, resource.identity)
          if (!expectedValue) continue
          preview.items.push({ id: resource.id, kind: 'ref', identity: resource.identity, ownerTaskId: resource.ownerTaskId, commonDir, expectedValue, status: 'pending' })
        } catch (error) { preview.blockers.push((error as Error).message) }
        continue
      }
      if (resource.identity === this.store.recordPath(resource.ownerTaskId)) continue // Permanent ID tombstone.
      if (resource.identity.includes('#')) {
        const [path, fragment] = resource.identity.split('#'), rowId = fragment.replace(/^scheduled.jobs\//, '')
        try {
          if (![join(this.store.profileHome, 'mousse.conf'), join(this.store.profileHome, 'scheduled', 'jobs-runtime.json')].includes(path)) throw new Error('Unknown shared configuration ownership')
          assertLifecyclePath(this.store.profileHome, path)
          const data = JSON.parse(readFileSync(path, 'utf8'))
          const row = basename(path) === 'mousse.conf' ? data.scheduled?.jobs?.find((job: { id: string }) => job.id === rowId) : data[rowId]
          if (row !== undefined) preview.items.push({ id: resource.id, kind: 'scheduled-row', identity: resource.identity, sourcePath: path, rowId, expectedValue: digest(row), ownerTaskId: resource.ownerTaskId, status: 'pending' })
        } catch (error) { preview.blockers.push((error as Error).message) }
        continue
      }
      if (!isAbsolute(resource.identity)) { preview.blockers.push('Unknown external resource identity'); continue }
      if (!within(this.store.profileHome, resource.identity)) { preview.blockers.push(`External resource lacks a profile-owned disposal root: ${resource.identity}`); continue }
      if (!await present(resource.identity)) continue
      try {
        assertLifecyclePath(this.store.profileHome, resource.identity)
        const stat = await lstat(resource.identity), content = await walkOwnedContentAsync(resource.identity)
        const scratch = inventory.sources.filter((source) => resource.sourceIds.includes(source.id)).some((source) => {
          const workflow = dirname(source.path) === join(this.store.profileHome, 'workflow-agent-bindings', 'workspaces')
          const agent = basename(source.path) === 'run.json' && dirname(dirname(source.path)) === join(this.store.profileHome, 'agent-runs')
          const terminal = basename(source.path) === 'terminal-workspace.json'
          if (!workflow && !agent && !terminal) return false
          const value = JSON.parse(readFileSync(source.path, 'utf8'))
          return workflow && value.kind === 'scratch' && value.worktreePath === resource.identity || agent && resource.identity === join(dirname(source.path), 'workspace') || terminal && value.kind === 'task-terminal-scratch' && resource.identity === join(dirname(source.path), 'terminal-workspace')
        })
        const discardRequired = (scratch || within(join(this.store.profileHome, 'browser', 'worker-artifacts'), resource.identity)) && content.some((entry) => entry.kind !== 'directory')
        preview.items.push({ id: resource.id, kind: 'path', identity: resource.identity, ownerTaskId: resource.ownerTaskId, content, rootIdentity: { dev: stat.dev, ino: stat.ino, birthtimeMs: stat.birthtimeMs }, discardRequired, ...(discardRequired ? { reason: scratch ? 'Scratch files have no durable reconstruction proof' : 'Browser runtime files include content outside the durable artifact index' } : {}), status: 'pending' })
      } catch (error) { preview.blockers.push((error as Error).message) }
    }
    // Delete maximal owned containers once, with task data last. Contained source entries are accounted by their parent snapshot.
    for (const child of preview.items.filter((item) => item.kind === 'path' && item.discardRequired)) {
      for (const parent of preview.items.filter((item) => item.kind === 'path' && item.identity !== child.identity && within(item.identity, child.identity))) {
        parent.discardRequired = true
        parent.reason = [parent.reason, `Includes sole-copy content: ${child.identity}`].filter(Boolean).join('; ')
      }
    }
    preview.items = preview.items.filter((item, index, all) => item.kind !== 'path' || !all.some((parent, parentIndex) => parent.kind === 'path' && parentIndex !== index && parent.identity !== item.identity && within(parent.identity, item.identity)))
      .filter((item, index, all) => all.findIndex((other) => other.kind === item.kind && other.identity === item.identity) === index)
    preview.items.sort((a, b) => this.order(a, tasks) - this.order(b, tasks) || a.identity.localeCompare(b.identity))
    for (const item of preview.items) if (item.kind === 'path') preview.exclusiveBytes += item.content!.reduce((sum, entry) => sum + entry.bytes, 0)
    // Deleting the thread while something of it is kept back would leave that with no thread to own it or delete it later:
    // the thread stays in the trash, and the refusal names the thread and the worktree that can't be checked.
    preview.blockers = [...new Set([...preview.blockers, ...unverifiedHolds(preview)])]
    return this.sign(preview)
  }

  /** What an unverified thread's scope is matched against for `item` (`unverifiedOwnerOver`). */
  private async claimTarget(item: LifecyclePurgeItem): Promise<ClaimTarget> {
    const repository = await repositoryTargetAsync(item.kind === 'ref' || item.kind === 'worktree' ? item.commonDir : undefined)
    if (item.kind === 'ref') return { ...repository, ref: item.identity }
    return { ...repository, ...(isAbsolute(item.identity) ? { path: await canonicalPathAsync(item.identity) } : {}) }
  }
  private sign(preview: LifecyclePurgePreview): LifecyclePurgePreview { preview.digest = digest({ ...preview, digest: '' }); return preview }
  private order(item: LifecyclePurgeItem, tasks: TaskLifecycleRecord[]): number { return item.kind === 'worktree' ? 0 : item.kind === 'ref' ? 1 : tasks.some((task) => task.location === item.identity) ? 3 : 2 }

  async purge(input: { taskId: string; operationId: string; expectedGeneration?: number; previewDigest?: string; discard?: boolean; human?: boolean }): Promise<TaskLifecycleRecord> {
    if (!input || typeof input !== 'object' || typeof input.operationId !== 'string' || !input.operationId || input.operationId.length > 256 || /[\x00-\x1f]/.test(input.operationId) || typeof input.taskId !== 'string') throw new Error('Purge requires a valid task and operation identity')
    const release = await this.hooks.quiesceDisk?.()
    try { return await this.withOwnership(input.taskId, () => this.purgeOwned(input)) } finally { release?.() }
  }
  private async purgeOwned(input: { taskId: string; operationId: string; expectedGeneration?: number; previewDigest?: string; discard?: boolean; human?: boolean }): Promise<TaskLifecycleRecord> {
    const key = `${this.store.root}/${input.taskId}`
    if (active.has(key)) throw new Error('Purge already running')
    active.add(key)
    try {
      let record = this.store.require(input.taskId)
      if (record.purge && record.purge.operationId !== input.operationId) throw new Error('Purge operation identity differs from its irreversible ledger')
      if (record.state === 'purged') return record
      if (record.state !== 'purge-started') {
        this.hooks.assertIdle(input.taskId)
        const preview = await this.previewOwned(input.taskId)
        if (preview.blockers.length) throw new Error(preview.blockers.join('; '))
        if (preview.digest !== input.previewDigest || input.expectedGeneration !== preview.generation) throw purgeErrors.create('resource_purge_preview_stale')
        if (preview.items.some((item) => item.discardRequired) && !(input.human && input.discard)) throw purgeErrors.create('resource_purge_discard_required')
        this.store.enableCleanupWriter()
        record = this.store.update(input.taskId, (current) => {
          if (current.state !== 'trashed' || current.generation !== preview.generation) throw new Error('Task changed before purge boundary')
          current.state = 'purge-started'; current.generation++
          current.purge = { ...preview, operationId: input.operationId, startedAt: new Date().toISOString(), discardAuthorized: Boolean(input.human && input.discard) }
        })
        await this.hooks.onBoundary?.(record)
      }
      if (!record.purge) throw new Error('Purge recovery ledger is absent')
      await this.hooks.beforeRemoval?.(record)
      const reservation = record.cleanupOwner!.token
      for (const item of record.purge.items) {
        if (item.status !== 'pending') continue
        // Peer source records are re-read at each step. Partial failure never weakens another owner's claim.
        const target = await this.claimTarget(item)
        const peers = await this.peers(new Set(record.purge!.ownedTaskIds))
        if (peers.some((peer) => peer.identity === item.identity || target.path !== undefined && claimOverlapsPath(peer, target.path))) throw new Error(`New shared owner retains ${item.identity}`)
        const unverified = unverifiedOwnerOver(peers, target)
        if (unverified) throw new Error(`${unverified.reason} ${item.identity} is kept.`)
        await this.remove(item, new Set(record.purge!.ownedTaskIds), () => this.store.update(input.taskId, (current) => { current.purge!.items.find((entry) => entry.id === item.id)!.discardState = 'cleared' }), () => this.assertReservation(input.taskId, reservation, record.generation), { taskId: input.taskId, token: reservation, generation: record.generation })
        record = this.store.update(input.taskId, (current) => { const progress = current.purge!.items.find((entry) => entry.id === item.id)!; progress.status = 'removed'; delete current.purge!.error; delete current.blockedReason })
        await this.hooks.onBoundary?.(record)
      }
      for (const taskId of record.purge!.ownedTaskIds) {
        const child = this.store.require(taskId)
        await this.hooks.projectPurged(child)
        if (taskId !== input.taskId) this.store.update(taskId, (current) => { current.state = 'purged'; current.generation++ })
      }
      for (const child of this.store.list().filter((child) => child.parentTaskId && record.purge!.ownedTaskIds.includes(child.parentTaskId) && !record.purge!.ownedTaskIds.includes(child.taskId))) {
        if (child.state !== 'trashed') throw new Error('Independent descendant is not safely retained in trash')
        this.store.update(child.taskId, (current) => { current.formerParentTaskId = current.parentTaskId; delete current.parentTaskId; current.generation++ })
      }
      return this.store.update(input.taskId, (current) => { current.state = 'purged'; current.purge!.completedAt = new Date().toISOString(); delete current.blockedReason; delete current.purge!.error })
    } catch (error) {
      const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined
      const descriptor = code === 'EPERM' || code === 'EACCES' || code === 'EBUSY'
        ? purgeErrors.create('resource_purge_io_error', error, { code })
        : normalizeAppError(error, 'resource_purge_failed')
      const record = this.store.require(input.taskId)
      if (record.state === 'purge-started') this.store.update(input.taskId, (current) => { current.blockedReason = descriptor.message; current.purge!.error = descriptor.message })
      throw descriptor
    } finally { active.delete(key) }
  }
  private async remove(item: LifecyclePurgeItem, ownedIds: Set<string>, onDiscardCleared: () => unknown, assertReservation: () => void, reservation: { taskId: string; token: string; generation: number }): Promise<void> {
    assertReservation()
    if (item.kind === 'scheduled-row') {
      const path = item.sourcePath!
      assertLifecyclePath(this.store.profileHome, path)
      withFileLock(join(this.store.profileHome, 'scheduled', '.jobs.lock'), () => {
        const data = JSON.parse(readFileSync(path, 'utf8'))
        const definition = basename(path) === 'mousse.conf'
        const row = definition ? data.scheduled?.jobs?.find((job: { id: string }) => job.id === item.rowId) : data[item.rowId!]
        if (row === undefined) return
        if (digest(row) !== item.expectedValue) throw new Error('Scheduled row changed since purge preview')
        if (definition) data.scheduled.jobs = data.scheduled.jobs.filter((job: { id: string }) => job.id !== item.rowId)
        else delete data[item.rowId!]
        atomicWriteJsonSync(path, data)
        this.hooks.configurationChanged?.()
      })
      return
    }
    if (item.kind === 'path') {
      if (!await present(item.identity)) return
      // Peer claims are read without blocking, then checked again from the records right before each entry is removed.
      const target = await this.claimTarget(item)
      const claims = await this.peersCheck(ownedIds)
      const unclaimed = (): void => {
        assertReservation()
        const current = claims()
        if (current.some((peer) => peer.identity === item.identity || target.path !== undefined && claimOverlapsPath(peer, target.path))) throw new Error(`New shared owner retains ${item.identity}`)
        const unverified = unverifiedOwnerOver(current, target)
        if (unverified) throw new Error(`${unverified.reason} ${item.identity} is kept.`)
      }
      await this.removeFrozen(item.identity, item.content!, this.store.profileHome, item.rootIdentity, 'Owned resource changed during purge', false, unclaimed)
      return
    }
    const commonDir = item.commonDir!
    // Kept files in a hidden snapshot store were released with the store by `releaseThreadSnapshots` (`beforeRemoval`).
    if (isKeptFilesItem(item) && isOwnedSnapshotStore(commonDir)) return
    if (!await present(commonDir)) throw purgeErrors.create('resource_purge_repository_unavailable')
    const worktree = (await lifecycleReadAsync(commonDir, ['worktree', 'list', '--porcelain'])).split(/\r?\n/).find((line) => line.startsWith('worktree '))?.slice(9)
    if (!worktree || !await present(worktree)) throw purgeErrors.create('resource_purge_repository_unavailable')
    const identity = await resolveRepositoryIdentityAsync(worktree, { requireMutationCapability: true })
    if (resolve(identity.commonDir) !== resolve(commonDir)) throw new Error('Repository identity changed')
    const lease = await acquireRepositoryLease(identity, { signal: AbortSignal.timeout(10_000) })
    try {
      assertReservation()
      // Re-checked right before each change below, with nothing awaited in between (`peersCheck`).
      const target = await this.claimTarget(item)
      const claims = await this.peersCheck(ownedIds)
      const unclaimed = (): void => {
        assertReservation()
        const current = claims()
        if (current.some((peer) => peer.identity === item.identity || target.path !== undefined && claimOverlapsPath(peer, target.path))) throw new Error('A new source claim retains the resource')
        const unverified = unverifiedOwnerOver(current, target)
        if (unverified) throw new Error(`${unverified.reason} ${item.identity} is kept.`)
      }
      unclaimed()
      if (item.kind === 'worktree') {
        if (item.content && item.discardState) {
          await this.removeDiscarded(item, commonDir, unclaimed, onDiscardCleared)
          return
        }
        // Purge reuses the verifier; its source is fenced by the external irreversible owner.
        unclaimed()
        // Checked again right before the checkout moves (or Git deletes it from the trash), with nothing awaited in between.
        await new WorktreeRetirementService(this.store, { repositoryLease: lease, cleanupTaskId: reservation.taskId, cleanupToken: reservation.token, cleanupGeneration: reservation.generation }).retire(item.manifestPath!, { purging: true, beforeMove: unclaimed })
      } else {
        const current = await readDirectLifecycleRefAsync(commonDir, item.identity)
        if (!current) return
        if (current !== item.expectedValue) throw new Error('Owned ref changed after purge preview')
        const input = `start\ndelete ${item.identity} ${item.expectedValue!}\nprepare\ncommit\n`
        // The central check runs first, then the ownership check right before the transaction starts, with nothing awaited in between.
        await lifecycleGitAsync(commonDir, ['update-ref', '--no-deref', '--stdin'], input, undefined, undefined, unclaimed)
      }
    } finally { lease.release() }
  }

  /**
   * Permanently deletes a checkout whose files the person reviewed and agreed to discard. Mousse never writes inside it:
   * it removes the reviewed files (`pending`), then, with the checkout holding only its `.git`, removes that and the
   * folder, and has Git unregister the folder that is gone. Recovery (`cleared`: the reviewed files went before a stop)
   * continues from what is on disk, never by replaying a step, so anything written in the checkout since stops the purge
   * and the reason names it. Git is run in the folder only while its `.git` leads to this repository's registration of it;
   * without one Git would find the repository of a folder above.
   */
  private async removeDiscarded(item: LifecyclePurgeItem, commonDir: string, unclaimed: () => void, onDiscardCleared: () => unknown): Promise<void> {
    const folder = item.identity
    const changed = (): Error => purgeStopped(`the worktree at ${folder} changed (its folder, branch or commit) since the delete was reviewed. It was kept.`)
    const lostLink = (): Error => purgeStopped(`the worktree at ${folder} lost its link to its repository (.git) before its files were cleared. It was kept.`)
    const writtenSince = (): Error => purgeStopped(`files were written at ${folder} after its worktree was deleted. They were kept.`)
    // The real path the reviewed folder had; compared too, so a file system without creation times still tells folders apart.
    const realRecorded = comparablePath(await canonicalPathAsync(folder))
    const sameRoot = (stat: Stats): boolean => {
      if (!sameFolder(stat, item.rootIdentity)) return false
      try { return realOf(folder) === realRecorded } catch { return false }
    }
    /** What a folder that could not be removed holds; nothing visible (a delete Windows has not finished) is said as such. */
    const kept = (files: string[]): Error => files.length ? purgeStopped(savedText(files)) : purgeStopped(`the worktree folder ${folder} could not be removed yet. It will be tried again.`)
    /** Synchronously, right before each removal: Git has no lock on the worktree (it never removes a locked one). */
    const unlocked = (registration: WorktreeRegistration | undefined): void => {
      const locked = registration && lockReasonSync(registration.adminDir)
      if (locked !== undefined) throw purgeStopped(lockedText(locked, folder))
    }
    const stat = await lstat(folder).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return undefined; throw error })
    if (!stat) {
      // The folder is gone, so only Git's registration of it is left.
      const registration = await registrationOf(commonDir, folder)
      if (!registration) return
      // Its reviewed files were never cleared: something else moved or deleted the worktree, and Git's record of it stays.
      if (item.discardState === 'pending') throw purgeStopped(`the worktree at ${folder} was moved or deleted by something else, and Git still lists it. It was kept in Git's list of worktrees.`)
      return await this.unregisterDiscarded(registration, folder, commonDir, unclaimed)
    }
    const dotGit = join(folder, '.git')
    if (!sameRoot(stat)) {
      // Once the reviewed files are gone, a real folder at the path without `.git` is one someone made after the checkout
      // was removed (a stop came before Git unregistered it): its files are theirs and are kept; empty, it goes.
      if (item.discardState !== 'cleared' || !stat.isDirectory() || await lstat(dotGit).then(() => true, () => false)) throw changed()
      const registration = await registrationOf(commonDir, folder)
      unlocked(registration)
      if ((await filesIn(folder)).length) throw writtenSince()
      unclaimed()
      unlocked(registration)
      const now = lstatSync(folder)
      if (now.isSymbolicLink() || !now.isDirectory() || fileIdentity(now) !== fileIdentity(stat)) throw writtenSince()
      try { rmdirSync(folder) } catch (error) {
        if (['ENOTEMPTY', 'EEXIST'].includes((error as NodeJS.ErrnoException).code ?? '')) throw writtenSince()
        throw error
      }
      if (registration) await this.unregisterDiscarded(registration, folder, commonDir, unclaimed)
      return
    }
    const linkInfo = await lstat(dotGit).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return undefined; throw error })
    if (!linkInfo) {
      // Before the files were cleared, a missing `.git` is someone else's doing.
      if (item.discardState === 'pending') throw lostLink()
      // A purge stopped right after removing `.git` leaves the folder empty; anything in it now was written since.
      const files = await filesIn(folder)
      if (files.length) throw purgeStopped(savedText(files))
      const registration = await registrationOf(commonDir, folder)
      unlocked(registration)
      unclaimed()
      unlocked(registration)
      if (!sameRoot(lstatSync(folder))) throw changed()
      try { rmdirSync(folder) } catch (error) {
        if (!['ENOTEMPTY', 'EEXIST'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error
        throw kept(await filesIn(folder))
      }
      if (registration) await this.unregisterDiscarded(registration, folder, commonDir, unclaimed)
      return
    }
    if (!linkInfo.isFile() || linkInfo.size > 4096) throw changed()
    const link = await readFile(dotGit, 'utf8')
    const linkIdentity = fileIdentity(linkInfo)
    const linkMode = linkInfo.mode & 0o7777
    const gitDir = /^gitdir:[ \t]*(.+?)[ \t]*$/m.exec(link)?.[1]
    const registration = await registrationOf(commonDir, folder)
    if (!gitDir || !registration || comparablePath(await canonicalPathAsync(resolve(folder, gitDir))) !== comparablePath(await canonicalPathAsync(registration.adminDir))) throw changed()
    const realFolder = realOf(folder)
    /** Synchronously: `.git` is still the very file read above. */
    const linked = (): void => {
      let now: Stats
      try { now = lstatSync(dotGit) } catch { throw item.discardState === 'pending' ? lostLink() : changed() }
      if (fileIdentity(now) !== linkIdentity || readFileSync(dotGit, 'utf8') !== link) throw changed()
    }
    // Git refuses to unregister a locked worktree without `--force`, which is never used: the lock is named before anything
    // goes, and checked again right before each removal.
    unlocked(registration)
    // Git runs here only while `.git` is the file read above, and never looks past this folder.
    if (await readInCheckout(folder, ['branch', '--show-current'], linked) !== item.branch || await readInCheckout(folder, ['rev-parse', 'HEAD'], linked) !== item.expectedValue) throw changed()
    if (item.discardState === 'pending') {
      if (createHash('sha256').update(await readInCheckout(folder, ['ls-files', '--stage', '-v', '-z'], linked)).digest('hex') !== item.indexDigest) throw purgeStopped('files were staged in this worktree after it began. It was kept.')
      const named = (paths: string[]): Error => {
        // Only the folder itself changed (its permissions): it is named.
        const files = paths.filter(Boolean)
        return files.length ? purgeStopped(savedText(files)) : purgeStopped(`the worktree folder ${folder} changed after the delete began. It was kept.`)
      }
      await this.removeFrozen(folder, item.content!, folder, undefined, named, true, () => { unclaimed(); unlocked(registration) })
      onDiscardCleared()
    }
    // Right after the reviewed files went, the checkout holds only its `.git`: anything else was written since, and is kept.
    const files = await filesIn(folder)
    if (files.length) throw purgeStopped(savedText(files))
    // From here to the removals nothing is awaited.
    unclaimed()
    unlocked(registration)
    if (!sameRoot(lstatSync(folder))) throw changed()
    linked()
    let landed = readdirSync(folder).some((name) => name !== '.git')
    if (!landed) {
      unlinkSync(dotGit)
      try {
        unlocked(registration)
        rmdirSync(folder)
      } catch (error) {
        // A lock, a write landed between the check and the removal, or a file in use: `.git` goes back, so the folder kept
        // is still a working worktree; but only into that very folder. One swapped in for it (or a link to another
        // folder) gets nothing, and is named. A `.git` someone wrote there meanwhile is theirs, and stays.
        let same = false
        try { const now = lstatSync(folder); same = !now.isSymbolicLink() && sameRoot(now) && realOf(folder) === realFolder } catch { /* gone */ }
        if (!same) throw purgeStopped(`the worktree at ${folder} was moved or replaced while it was being deleted, so its link to its repository (.git) was not put back. Its files were kept.`)
        // With its own permissions, whatever the umask.
        try {
          const fd = openSync(dotGit, 'wx', linkMode)
          try { fchmodSync(fd, linkMode); writeFileSync(fd, link) } finally { closeSync(fd) }
        } catch { /* kept as it is */ }
        if (!['ENOTEMPTY', 'EEXIST'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error
        landed = true
      }
    }
    if (landed) throw kept(await filesIn(folder))
    await this.unregisterDiscarded(registration, folder, commonDir, unclaimed)
  }
  /** Git unregisters the deleted checkout. A folder at that path again would be someone's new files: it is kept, and so is the registration. */
  private async unregisterDiscarded(registration: WorktreeRegistration, folder: string, commonDir: string, unclaimed: () => void): Promise<void> {
    const lockedNow = (): void => {
      const locked = lockReasonSync(registration.adminDir)
      if (locked !== undefined) throw purgeStopped(lockedText(locked, folder))
    }
    lockedNow()
    // The path as Git recorded it: Git matches it whatever is on disk, so this works with the folder's parent gone too.
    await lifecycleGitAsync(commonDir, ['worktree', 'remove', registration.path], undefined, undefined, undefined, () => {
      unclaimed()
      lockedNow()
      if (existsSync(folder)) throw purgeStopped(`files were written at ${folder} after its worktree was deleted. They were kept.`)
    })
    if (await registrationOf(commonDir, folder)) throw new Error('Git still lists the deleted worktree')
  }

  /**
   * Removes the frozen `content` of `root`, deepest first, as the plan recorded it: everything still there must match the
   * plan (a prior crash may have removed a prefix). Each entry is read and checked against its frozen record without
   * blocking; then, right before it is removed and with nothing awaited in between, the path, the root, `beforeEach` (the
   * caller's claims check) and the entry itself are checked again synchronously ({@link assertFrozenEntryUnchanged}), so a
   * write since its bytes were checked refuses it and nothing unreviewed is unlinked. Never follows a link or removes an
   * unreviewed subtree. `rootIdentity`, when given, is checked before every removal too. The entries are under the Mousse home.
   */
  private async removeFrozen(root: string, content: NonNullable<LifecyclePurgeItem['content']>, owner: string, frozenRoot: LifecyclePurgeItem['rootIdentity'], changed: string | ((paths: string[]) => Error), skipRootGit = false, beforeEach?: () => void): Promise<void> {
    if (frozenRoot) {
      await assertLifecyclePathAsync(owner, root)
      if (rootIdentity(await lstat(root)) !== digest(frozenRoot)) throw new Error('Owned resource root was replaced')
    }
    const current = await walkOwnedContentAsync(root, skipRootGit)
    const expected = new Map(content.map((entry) => [entry.path, digest(entry)]))
    const differ = current.filter((entry) => expected.get(entry.path) !== digest(entry))
    if (differ.length) {
      if (typeof changed === 'string') throw new Error(changed)
      // A changed or new file is named; its folders change with it, and are named only when nothing else is.
      const files = differ.filter((entry) => entry.kind !== 'directory')
      throw changed((files.length ? files : differ).map((entry) => entry.path))
    }
    for (const entry of [...current].reverse()) {
      if (skipRootGit && !entry.path) continue
      const path = join(root, entry.path)
      await assertLifecyclePathAsync(owner, dirname(path))
      const proof = await proveFrozenContentEntryAsync(root, entry)
      // From here to the removal nothing is awaited.
      beforeEach?.()
      assertLifecyclePath(owner, dirname(path))
      if (frozenRoot && rootIdentity(lstatSync(root)) !== digest(frozenRoot)) throw new Error('Owned resource root was replaced during removal')
      assertFrozenEntryUnchanged(proof)
      if (entry.kind === 'directory') rmdirSync(path)
      else unlinkSync(path)
    }
  }
}
