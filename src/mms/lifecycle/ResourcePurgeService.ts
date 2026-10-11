import { createErrorProvider, normalizeAppError } from '../../shared/errors'
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, lstatSync, readFileSync, readdirSync, rmdirSync, unlinkSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'
import type { LifecyclePurgeItem, LifecyclePurgePreview, TaskLifecycleRecord, TrashRetentionPolicy } from '../../shared/resourceLifecycle'
import { atomicWriteJsonSync } from '../data/AtomicFs'
import { acquireRepositoryLease } from '../git/RepositoryLease'
import { resolveRepositoryIdentity } from '../git/RepositoryIdentity'
import { buildResourceInventory } from './ResourceInventory'
import { assertLifecyclePath, ResourceLifecycleStore } from './ResourceLifecycleStore'
import { assertFrozenContentEntry, lifecycleGit, readDirectLifecycleRef, walkOwnedContent, WorktreeRetirementService } from './WorktreeRetirementService'
import { isOwnerLive, PROCESS_INSTANCE_ID } from '../queue/processLiveness'
import { getExternalResourceClaims } from './LifecycleClaims'
import { withFileLock } from '../scheduled/fileLock'

const digest = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const within = (root: string, path: string): boolean => { const rel = relative(resolve(root), resolve(path)); return !isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) }
const active = new Set<string>()

const purgeErrors = createErrorProvider({
  resource_purge_discard_required: { category: 'denied', retryable: false, message: 'Sole-copy discard requires an exact human-reviewed preview.' },
  resource_purge_repository_unavailable: { category: 'unavailable', retryable: false, message: 'Repository is unavailable; purge remains pending. Reconnect the repository and retry.' },
  resource_purge_preview_stale: { category: 'conflict', retryable: false, message: 'Purge preview changed; review a fresh inventory.' },
  resource_policy_invalid: { category: 'invalid', retryable: false, message: 'Invalid trash retention policy. Grace days must be an integer from 1 to 3650.' },
  resource_purge_io_error: { category: 'conflict', retryable: false, message: 'Purge could not remove a locked or permission-protected resource. Close applications using it and retry the pending purge.' }
})

/** External purge ledger survives deletion of every task-owned source. No Git object pruning. */
export class ResourcePurgeService {
  readonly retirement: WorktreeRetirementService
  private timer?: ReturnType<typeof setInterval>
  private sweepPromise?: Promise<void>
  private stopping = false
  constructor(readonly store: ResourceLifecycleStore, private readonly hooks: { assertIdle(taskId: string): void; projectPurged(record: TaskLifecycleRecord): void | Promise<void>; onBoundary?(record: TaskLifecycleRecord): void | Promise<void>; configurationChanged?(): void }) { this.retirement = new WorktreeRetirementService(store) }

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
    this.timer = setInterval(() => { if (!this.sweepPromise) this.sweepPromise = this.sweep().catch(() => { /* Invalid policy/source remains visible through inventory; no cleanup occurred. */ }).finally(() => { this.sweepPromise = undefined }) }, 60_000)
    this.timer.unref()
  }
  async stop(): Promise<void> { this.stopping = true; if (this.timer) clearInterval(this.timer); this.timer = undefined; await this.sweepPromise }
  async sweep(now = Date.now()): Promise<void> {
    const policy = this.policy()
    if (!policy.automaticPurge || this.stopping) return
    const clockPath = join(this.store.root, 'trash-clock.json')
    assertLifecyclePath(this.store.root, clockPath)
    const previous = existsSync(clockPath) ? JSON.parse(readFileSync(clockPath, 'utf8')) as { highWater: number; suspended?: boolean; cursor?: string } : { highWater: now }
    if (!Number.isSafeInteger(previous.highWater) || previous.suspended || now < previous.highWater || now - previous.highWater > 24 * 60 * 60 * 1000) {
      atomicWriteJsonSync(clockPath, { ...previous, suspended: true }); return
    }
    atomicWriteJsonSync(clockPath, { ...previous, highWater: Math.max(now, previous.highWater) })
    const all = this.store.list().filter((record) => record.state === 'trashed' && !record.parentTaskId && now - Date.parse(record.trashedAt ?? record.operations.filter((operation) => operation.kind === 'trash' && operation.phase === 'completed').at(-1)?.completedAt ?? record.createdAt) >= policy.graceDays * 86_400_000).sort((a, b) => a.taskId.localeCompare(b.taskId))
    const afterCursor = previous.cursor ? all.findIndex((record) => record.taskId.localeCompare(previous.cursor!) > 0) : 0
    const start = afterCursor < 0 ? 0 : afterCursor
    const eligible = [...all.slice(start), ...all.slice(0, start)].slice(0, 5)
    for (const record of eligible) {
      if (this.stopping) break
      atomicWriteJsonSync(clockPath, { highWater: Math.max(now, previous.highWater), cursor: record.taskId })
      try {
        const preview = await this.preview(record.taskId)
        if (preview.blockers.length || preview.items.some((item) => item.discardRequired)) {
          this.store.update(record.taskId, (current) => { current.blockedReason = preview.blockers.join('; ') || 'Automatic trash cleanup retains unpublished or sole-copy content; review permanent deletion to decide.' }); continue
        }
        await this.purge({ taskId: record.taskId, operationId: randomUUID(), expectedGeneration: preview.generation, previewDigest: preview.digest })
      } catch (error) { this.store.update(record.taskId, (current) => { current.blockedReason = (error as Error).message }) }
    }
  }
  async retireTrashed(taskId: string): Promise<void> {
    await this.withOwnership(taskId, async () => {
      const record = this.store.require(taskId), token = record.cleanupOwner!.token
      if (record.state !== 'trashed') return
      const preview = await this.previewOwned(taskId)
      const retained = [...preview.blockers]
      if (!preview.blockers.length) for (const item of preview.items.filter((item) => item.kind === 'worktree')) {
        if (!item.manifestPath) { retained.push(`Checkout retained: ${item.reason ?? item.identity}`); continue }
        if (!existsSync(item.identity)) continue
        try {
          const lease = await acquireRepositoryLease(resolveRepositoryIdentity(item.identity, { requireMutationCapability: true }), { signal: AbortSignal.timeout(10_000) })
          try { this.assertReservation(taskId, token, record.generation); new WorktreeRetirementService(this.store, { repositoryLease: lease, cleanupTaskId: taskId, cleanupToken: token, cleanupGeneration: record.generation }).retire(item.manifestPath) } finally { lease.release() }
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
  private async previewOwned(taskId: string): Promise<LifecyclePurgePreview> {
    const record = this.store.require(taskId)
    const reservation = record.cleanupOwner!.token
    if (record.state === 'purge-started' || record.state === 'purged') {
      if (!record.purge) throw new Error('Purge state has no external recovery ledger')
      return record.purge
    }
    if (record.state !== 'trashed') throw new Error('Only a trashed task can be permanently deleted')
    this.hooks.assertIdle(taskId)
    const tasks = this.owned(taskId), ownedIds = new Set(tasks.map((task) => task.taskId))
    const preview: LifecyclePurgePreview = { schemaVersion: 1, taskId, generation: record.generation, digest: '', items: [], ownedTaskIds: [...ownedIds].sort(), blockers: [], retained: [], exclusiveBytes: 0 }
    let peers: ReturnType<ResourcePurgeService['peers']>
    try { peers = this.peers(ownedIds) } catch (error) { preview.blockers.push((error as Error).message); return this.sign(preview) }
    let inventory = buildResourceInventory(this.store, record)
    preview.blockers.push(...inventory.blockers)
    if (inventory.blockers.length || inventory.sources.some((source) => source.status !== 'verified')) return this.sign(preview)
    const repositories = new Map<string, string>()
    const shared = (identity: string, repositoryId?: string): boolean => peers.some((peer) => peer.identity === identity && (!repositoryId || peer.repositoryId === repositoryId) || isAbsolute(identity) && isAbsolute(peer.identity) && (within(identity, peer.identity) || within(peer.identity, identity)))
    for (const resource of inventory.resources.filter((item) => item.kind === 'worktree' && ownedIds.has(item.ownerTaskId))) {
      if (shared(resource.identity, resource.repositoryId)) { preview.retained.push({ identity: resource.identity, reason: 'Another task or profile retains this workspace' }); continue }
      try {
        const manifestPath = this.retirement.pathFor(resource.ownerTaskId, resource.identity)
        let manifest = existsSync(manifestPath) ? this.retirement.load(manifestPath) : undefined
        if (existsSync(resource.identity)) {
          const sources = inventory.sources.filter((source) => resource.sourceIds.includes(source.id))
          const source = sources.find((source) => basename(source.path) === 'agent-episodes.json') ?? sources.find((source) => ['workspace.json', 'agents.json', 'mousse-agent-sessions.json'].includes(basename(source.path))) ?? sources.find((source) => source.path.includes('workflow'))
          if (!source) throw new Error('Workspace has no supported owner source')
          const branch = lifecycleGit(resource.identity, ['branch', '--show-current'])
          const identity = resolveRepositoryIdentity(resource.identity, { requireMutationCapability: true })
          const lease = await acquireRepositoryLease(identity, { signal: AbortSignal.timeout(10_000) })
          try {
            this.assertReservation(taskId, reservation, record.generation)
            const input = { taskId: resource.ownerTaskId, sourcePath: source.path, worktreePath: resource.identity, branch, repositoryId: resource.repositoryId }
            try { manifest = new WorktreeRetirementService(this.store, { repositoryLease: lease, cleanupTaskId: taskId, cleanupToken: reservation, cleanupGeneration: record.generation }).prepare(input) }
            catch (error) {
              const discard = this.retirement.inspectForDiscard(input)
              repositories.set(discard.repositoryId, discard.commonDir)
              preview.items.push({ id: resource.id, kind: 'worktree', identity: resource.identity, ownerTaskId: resource.ownerTaskId, commonDir: discard.commonDir, expectedValue: discard.resultSha, rootIdentity: discard.rootIdentity, content: discard.content, indexDigest: discard.indexDigest, branch, sourcePath: source.path, discardRequired: true, discardState: 'pending', reason: (error as Error).message, status: 'pending' })
              preview.exclusiveBytes += discard.content.reduce((sum, entry) => sum + entry.bytes, 0)
              continue
            }
          } finally { lease.release() }
        }
        if (!manifest) throw new Error('Absent workspace lacks a reconstruction manifest')
        this.retirement.verifyPins(manifest)
        repositories.set(manifest.repositoryId, manifest.commonDir)
        let discardRequired = resource.claims.some((claim) => ['pending-integration', 'conflict'].includes(claim.kind))
        for (const source of inventory.sources.filter((source) => resource.sourceIds.includes(source.id) && basename(source.path) === 'workspace.json')) {
          const workspace = JSON.parse(readFileSync(source.path, 'utf8')) as { headSha?: string; integrationTarget?: { baseSha?: string } }
          if (workspace.headSha !== workspace.integrationTarget?.baseSha) discardRequired = true
        }
        preview.items.push({ id: resource.id, kind: 'worktree', identity: resource.identity, ownerTaskId: resource.ownerTaskId, manifestPath, commonDir: manifest.commonDir, expectedValue: manifest.resultSha, discardRequired, ...(discardRequired ? { reason: 'This result may contain unpublished work' } : {}), status: 'pending' })
        preview.exclusiveBytes += manifest.content.reduce((sum, entry) => sum + entry.bytes, 0)
      } catch (error) { preview.blockers.push(`Workspace retained: ${resource.identity}: ${(error as Error).message}`) }
    }
    // Preparation adds explicit reconstruction pins. Refresh rather than omitting their cleanup.
    inventory = buildResourceInventory(this.store, this.store.require(taskId))
    for (const resource of inventory.resources) {
      if (!ownedIds.has(resource.ownerTaskId)) continue
      if (resource.kind === 'worktree' || resource.kind === 'agent-session' || resource.kind === 'artifact') continue
      if (shared(resource.identity, resource.repositoryId)) { preview.retained.push({ identity: resource.identity, reason: 'Another owner retains this resource' }); continue }
      if (resource.kind === 'git-ref') {
        try {
          if (!/^(refs\/mousse\/|refs\/heads\/mousse\/(thread|agent|workflow)\/)/.test(resource.identity)) throw new Error('Source ref is not Mousse-owned')
          const commonDir = resource.repositoryId ? repositories.get(resource.repositoryId) : repositories.size === 1 ? [...repositories.values()][0] : undefined
          if (!commonDir) throw new Error('Repository is unavailable; ref existence cannot be established')
          const expectedValue = readDirectLifecycleRef(commonDir, resource.identity)
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
      if (!existsSync(resource.identity)) continue
      try {
        assertLifecyclePath(this.store.profileHome, resource.identity)
        const stat = lstatSync(resource.identity), content = walkOwnedContent(resource.identity)
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
    preview.blockers = [...new Set(preview.blockers)]
    return this.sign(preview)
  }
  private sign(preview: LifecyclePurgePreview): LifecyclePurgePreview { preview.digest = digest({ ...preview, digest: '' }); return preview }
  private order(item: LifecyclePurgeItem, tasks: TaskLifecycleRecord[]): number { return item.kind === 'worktree' ? 0 : item.kind === 'ref' ? 1 : tasks.some((task) => task.location === item.identity) ? 3 : 2 }

  async purge(input: { taskId: string; operationId: string; expectedGeneration?: number; previewDigest?: string; discard?: boolean; human?: boolean }): Promise<TaskLifecycleRecord> {
    if (!input || typeof input !== 'object' || typeof input.operationId !== 'string' || !input.operationId || input.operationId.length > 256 || /[\x00-\x1f]/.test(input.operationId) || typeof input.taskId !== 'string') throw new Error('Purge requires a valid task and operation identity')
    return this.withOwnership(input.taskId, () => this.purgeOwned(input))
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
      const reservation = record.cleanupOwner!.token
      for (const item of record.purge.items) {
        if (item.status !== 'pending') continue
        // Peer source records are re-read at each step. Partial failure never weakens another owner's claim.
        const peers = this.peers(new Set(record.purge!.ownedTaskIds))
        if (peers.some((peer) => peer.identity === item.identity || isAbsolute(item.identity) && isAbsolute(peer.identity) && (within(item.identity, peer.identity) || within(peer.identity, item.identity)))) throw new Error(`New shared owner retains ${item.identity}`)
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
      if (!existsSync(item.identity)) return
      assertLifecyclePath(this.store.profileHome, item.identity)
      const stat = lstatSync(item.identity)
      if (digest({ dev: stat.dev, ino: stat.ino, birthtimeMs: stat.birthtimeMs }) !== digest(item.rootIdentity)) throw new Error('Owned resource root was replaced')
      const current = walkOwnedContent(item.identity)
      const expected = new Map(item.content!.map((entry) => [entry.path, digest(entry)]))
      // A prior crash may have removed a prefix; every remaining entry must still match the frozen plan.
      for (const entry of current) if (expected.get(entry.path) !== digest(entry)) throw new Error('Owned resource changed during purge')
      for (const entry of [...current].reverse()) {
        const path = join(item.identity, entry.path)
        assertLifecyclePath(this.store.profileHome, dirname(path))
        const again = lstatSync(item.identity)
        if (digest({ dev: again.dev, ino: again.ino, birthtimeMs: again.birthtimeMs }) !== digest(item.rootIdentity)) throw new Error('Owned resource root was replaced during removal')
        assertFrozenContentEntry(item.identity, entry)
        if (entry.kind === 'directory') rmdirSync(path)
        else unlinkSync(path) // Never follows a link or recursively removes an unreviewed subtree.
      }
      return
    }
    const commonDir = item.commonDir!
    if (!existsSync(commonDir)) throw purgeErrors.create('resource_purge_repository_unavailable')
    const worktree = lifecycleGit(commonDir, ['worktree', 'list', '--porcelain']).split(/\r?\n/).find((line) => line.startsWith('worktree '))?.slice(9)
    if (!worktree || !existsSync(worktree)) throw purgeErrors.create('resource_purge_repository_unavailable')
    const identity = resolveRepositoryIdentity(worktree, { requireMutationCapability: true })
    if (resolve(identity.commonDir) !== resolve(commonDir)) throw new Error('Repository identity changed')
    const lease = await acquireRepositoryLease(identity, { signal: AbortSignal.timeout(10_000) })
    try {
      assertReservation()
      if (this.peers(ownedIds).some((peer) => peer.identity === item.identity)) throw new Error('A new source claim retains the resource')
      if (item.kind === 'worktree') {
        if (item.content && item.discardState) {
          if (!existsSync(item.identity)) {
            if (lifecycleGit(commonDir, ['worktree', 'list', '--porcelain']).includes(`worktree ${item.identity.replaceAll('\\', '/')}`)) throw new Error('Missing discarded worktree is still registered')
            return
          }
          const stat = lstatSync(item.identity)
          if (digest({ dev: stat.dev, ino: stat.ino, birthtimeMs: stat.birthtimeMs }) !== digest(item.rootIdentity) || lifecycleGit(item.identity, ['branch', '--show-current']) !== item.branch || lifecycleGit(item.identity, ['rev-parse', 'HEAD']) !== item.expectedValue) throw new Error('Discarded checkout identity changed')
          if (item.discardState === 'pending') {
            if (createHash('sha256').update(lifecycleGit(item.identity, ['ls-files', '--stage', '-v', '-z'])).digest('hex') !== item.indexDigest) throw new Error('Staged sole-copy content changed after the reviewed discard')
            const content = walkOwnedContent(item.identity, true)
            const expected = new Map(item.content.map((entry) => [entry.path, digest(entry)]))
            for (const entry of content) if (expected.get(entry.path) !== digest(entry)) throw new Error('Sole-copy content changed after the reviewed discard')
            for (const entry of [...content].reverse()) {
              if (!entry.path) continue
              const path = join(item.identity, entry.path)
              assertLifecyclePath(item.identity, dirname(path))
              assertFrozenContentEntry(item.identity, entry)
              if (entry.kind === 'directory') rmdirSync(path); else unlinkSync(path)
            }
            onDiscardCleared()
          }
          // Clearing is durably recorded before this idempotent index/worktree reconstruction.
          lifecycleGit(item.identity, ['restore', '--source=HEAD', '--staged', '--worktree', '--', '.'])
          lifecycleGit(commonDir, ['worktree', 'remove', item.identity])
          return
        }
        // Purge reuses the verifier; its source is fenced by the external irreversible owner.
        new WorktreeRetirementService(this.store, { repositoryLease: lease, cleanupTaskId: reservation.taskId, cleanupToken: reservation.token, cleanupGeneration: reservation.generation }).retire(item.manifestPath!, { purging: true })
      } else {
        const current = readDirectLifecycleRef(commonDir, item.identity)
        if (!current) return
        if (current !== item.expectedValue) throw new Error('Owned ref changed after purge preview')
        lifecycleGit(commonDir, ['update-ref', '--no-deref', '--stdin'], `start\ndelete ${item.identity} ${item.expectedValue!}\nprepare\ncommit\n`)
      }
    } finally { lease.release() }
  }
}
