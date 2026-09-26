import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync
} from 'fs'
import { join } from 'path'
import { EventEmitter } from 'events'
import { v4 as uuidv4, v5 as uuidv5 } from 'uuid'
import type {
  Agent,
  ChatMessage,
  MousseAgentSessionSnapshot,
  NativeLlmContext,
  Project,
  QueuedMessage,
  Task,
  Thread,
  ThreadData
} from '../../shared/types'
import { isDefaultThreadName } from '../../shared/threadTitle'
import { parseMousseAgentSessions } from '../agents/MousseAgentService'
import { normalizeQueuedMessages } from '../queue/ThreadMessageQueue'
import { withThreadDataMutationLock } from '../queue/ThreadExecutionLease'
import type { ProjectManager } from './ProjectManager'
import { getMousseHomeDir } from './paths'
import { atomicWriteJsonSync } from './AtomicFs'
import { ThreadGenerationStore } from './ThreadGenerationStore'
import { ThreadJournal } from './ThreadJournal'
import { ThreadRecoveryService } from './ThreadRecoveryService'
import { ThreadStorageLayout } from './ThreadStorageLayout'
import { ThreadStorageMigration } from './ThreadStorageMigration'
import { ThreadTrashService, type LegacyTrashDiagnostic } from './ThreadTrashService'
import { ResourceLifecycleStore } from '../lifecycle/ResourceLifecycleStore'
import type { TaskLifecycleRecord } from '../../shared/resourceLifecycle'
import { registerThreadLifecycleGate, withThreadLifecyclePath } from '../queue/ThreadLifecycleAdmission'
import { withFileLock } from '../scheduled/fileLock'
import { pathsEqual } from '../profiles/pathSafety'

interface ThreadMeta {
  id: string
  name: string
  projectId?: string
  createdAt: string
  updatedAt: string
  modelOverride?: {
    llmProvider: string
    model: string
  }
  /** Opt-in isolated git worktree. OFF by default; undefined treated as false. */
  worktreeEnabled?: boolean
  order: number
  pinnedAt?: string
  settledAt?: string
  /** Set once the user commits the first message (send/enqueue). */
  startedAt?: string
}

interface ActiveThreadState {
  id: string
}

export class ThreadDataCorruptionError extends Error {
  constructor(readonly filePath: string, cause?: unknown) {
    super(`Corrupt thread data: ${filePath}${cause instanceof Error ? ` (${cause.message})` : ''}`)
    this.name = 'ThreadDataCorruptionError'
  }
}

export interface ThreadDataPatch {
  messages?: ChatMessage[]
  agents?: Agent[]
  tasks?: Task[]
  /** undefined preserves; null explicitly clears the durable context. */
  llmContext?: NativeLlmContext | null
  /** undefined preserves; null explicitly clears durable subagent sessions. */
  mousseAgentSessions?: MousseAgentSessionSnapshot[] | null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function validateNativeContext(value: unknown, filePath: string): NativeLlmContext | undefined {
  if (value === undefined) return undefined
  if (!isRecord(value)) throw new ThreadDataCorruptionError(filePath, new Error('expected an object'))
  if (value.version !== 1 && value.version !== 2) {
    throw new ThreadDataCorruptionError(filePath, new Error(`unsupported version ${String(value.version)}`))
  }
  if (!Array.isArray(value.messages)) {
    throw new ThreadDataCorruptionError(filePath, new Error('messages must be an array'))
  }
  if (value.retiredMessages !== undefined && !Array.isArray(value.retiredMessages)) {
    throw new ThreadDataCorruptionError(filePath, new Error('retiredMessages must be an array'))
  }
  if (
    !Number.isSafeInteger(value.activeStartIndex) ||
    (value.activeStartIndex as number) < 0 ||
    (value.activeStartIndex as number) > value.messages.length
  ) {
    throw new ThreadDataCorruptionError(filePath, new Error('activeStartIndex is outside the archive'))
  }
  if (value.fidelity !== 'native' && value.fidelity !== 'legacy-estimated') {
    throw new ThreadDataCorruptionError(filePath, new Error('unsupported fidelity'))
  }
  if (
    value.acceptedQueueItemIds !== undefined &&
    (!Array.isArray(value.acceptedQueueItemIds) ||
      value.acceptedQueueItemIds.some((id) => typeof id !== 'string' || id.length === 0))
  ) {
    throw new ThreadDataCorruptionError(filePath, new Error('acceptedQueueItemIds must be non-empty strings'))
  }
  if (
    value.acceptedSteerItemIds !== undefined &&
    (!Array.isArray(value.acceptedSteerItemIds) ||
      value.acceptedSteerItemIds.some((id) => typeof id !== 'string' || id.length === 0))
  ) {
    throw new ThreadDataCorruptionError(filePath, new Error('acceptedSteerItemIds must be non-empty strings'))
  }
  if (value.compaction !== undefined) {
    if (!isRecord(value.compaction)) {
      throw new ThreadDataCorruptionError(filePath, new Error('compaction must be an object'))
    }
    for (const field of ['generation', 'tokensBefore', 'createdAt'] as const) {
      const number = value.compaction[field]
      if (typeof number !== 'number' || !Number.isFinite(number) || number < 0) {
        throw new ThreadDataCorruptionError(filePath, new Error(`invalid compaction.${field}`))
      }
    }
    if (typeof value.compaction.summary !== 'string') {
      throw new ThreadDataCorruptionError(filePath, new Error('invalid compaction.summary'))
    }
  }
  return value as unknown as NativeLlmContext
}

export function executionThreadId(executionKey: string): string {
  if (!executionKey || executionKey.length > 1024) throw new Error('Invalid execution thread key')
  return uuidv5('mousse-execution-thread:' + executionKey, uuidv5.URL)
}

export class ThreadDataStore extends EventEmitter {
  /**
   * Warm list cache. Invalidated on mutations; also keyed by project set so
   * opening/removing a project forces a rescan without an explicit invalidate call.
   */
  private listCache: Thread[] | null = null
  private listCacheProjectsKey: string | null = null
  private standaloneListCache: Thread[] | null = null
  private projectListCache = new Map<string, Thread[]>()
  private readonly storageLayout: ThreadStorageLayout
  private readonly storageMigration: ThreadStorageMigration
  private transactionalOverride?: boolean
  readonly lifecycleStore: ResourceLifecycleStore
  private lifecycleMigrationDiagnostics: LegacyTrashDiagnostic[] = []

  constructor(private projectManager: ProjectManager, private readonly homeDir = getMousseHomeDir(), options: { allowLegacyProjectData?: boolean; profileId?: string } = {}) {
    super()
    this.storageLayout = new ThreadStorageLayout(homeDir, options.allowLegacyProjectData ?? true)
    this.storageMigration = new ThreadStorageMigration(this.storageLayout)
    this.lifecycleStore = new ResourceLifecycleStore({ profileId: options.profileId ?? 'default', profileHome: homeDir })
    registerThreadLifecycleGate(homeDir, this.lifecycleStore)
    this.refreshLegacyTrash()
  }

  refreshLegacyTrash(): LegacyTrashDiagnostic[] {
    const legacy = new ThreadTrashService(this.homeDir, { strictOwnedRoot: true }).inspectLegacy()
    const diagnostics = [...legacy.diagnostics]
    for (const record of legacy.records) {
      try {
        const managed = this.lifecycleStore.get(record.threadId)
        // A successful new restore supersedes the retained, immutable legacy index.
        if (managed?.locations.some((location) => pathsEqual(location, record.trashPath)) && pathsEqual(managed.originalLocation, record.originalPath)) continue
        this.lifecycleStore.adoptTrashedTask({ taskId: record.threadId, originalLocation: record.originalPath, location: record.trashPath })
      } catch (error) { diagnostics.push({ threadId: record.threadId, reason: (error as Error).message }) }
    }
    this.lifecycleMigrationDiagnostics = diagnostics
    return diagnostics.map((entry) => ({ ...entry }))
  }

  assertLifecycleMutationAvailable(): void {
    const diagnostics = this.refreshLegacyTrash()
    if (diagnostics.length) throw new Error(`Lifecycle migration is blocked: ${diagnostics.map((entry) => entry.reason).join('; ')}`)
  }

  setTransactionalStoreEnabled(enabled: boolean): void {
    this.transactionalOverride = enabled
  }

  private transactionalStoreEnabled(): boolean {
    if (this.transactionalOverride !== undefined) return this.transactionalOverride
    const value = process.env.MOUSSE_TRANSACTIONAL_THREAD_STORE
    return value === '1' || value === 'true'
  }

  private projectsCacheKey(): string {
    return this.projectManager
      .listProjects()
      .map((project) => `${project.id}\0${project.path}`)
      .join('\n')
  }

  private invalidateListCache(): void {
    this.listCache = null
    this.listCacheProjectsKey = null
    this.standaloneListCache = null
    this.projectListCache.clear()
  }

  /** Replace one thread in the warm cache (avoids full rescan after meta updates). */
  private patchListCache(thread: Thread): void {
    if (this.listCache) {
      const idx = this.listCache.findIndex((entry) => entry.id === thread.id)
      if (idx >= 0) this.listCache[idx] = thread
      else this.listCache = null
    }
    if (!thread.projectId) {
      if (this.standaloneListCache) {
        const idx = this.standaloneListCache.findIndex((entry) => entry.id === thread.id)
        if (idx >= 0) this.standaloneListCache[idx] = thread
        else this.standaloneListCache = null
      }
    } else {
      const cached = this.projectListCache.get(thread.projectId)
      if (cached) {
        const idx = cached.findIndex((entry) => entry.id === thread.id)
        if (idx >= 0) cached[idx] = thread
        else this.projectListCache.delete(thread.projectId)
      }
    }
  }

  createThread(name: string, projectId?: string, projectPath?: string, opts?: { worktreeEnabled?: boolean }): Thread {
    this.invalidateListCache()
    const now = new Date().toISOString()
    const id = uuidv4()
    const meta: ThreadMeta = {
      id,
      name,
      projectId,
      createdAt: now,
      updatedAt: now,
      order: this.nextThreadOrder(projectId, projectPath)
    }
    if (opts?.worktreeEnabled === true) meta.worktreeEnabled = true

    const threadDir = this.resolveThreadDir(meta, projectPath)
    this.lifecycleStore.registerTask({ taskId: id, location: threadDir, creating: true })
    this.ensureThreadDir(threadDir)

    this.writeJsonAtomic(join(threadDir, 'meta.json'), meta)
    this.writeJsonAtomic(join(threadDir, 'messages.json'), [])
    this.writeJsonAtomic(join(threadDir, 'agents.json'), [])
    this.writeJsonAtomic(join(threadDir, 'tasks.json'), [])
    mkdirSync(join(threadDir, 'terminals'), { recursive: true })

    if (!projectId) {
      this.addToStandaloneIndex(meta)
    }

    // This is the authoritative creation notification for every producer:
    // GUI/CLI protocol calls, channels, and scheduled jobs.
    this.emit('created', meta)
    return meta
  }

  /** Daemon-owned execution admission: retry/crash recovery keeps one thread and its data. */
  ensureExecutionThread(executionKey: string, name: string, projectId?: string, ownership?: { parentTaskId: string; runId?: string }): Thread {
    const project = projectId ? this.projectManager.getProject(projectId) : undefined
    if (projectId && !project) throw new Error('Execution project is unavailable')
    const id = executionThreadId(executionKey)
    if (this.lifecycleMigrationDiagnostics.some((entry) => !entry.threadId || entry.threadId === id)) {
      throw new Error('Execution thread identity has unresolved legacy trash ownership')
    }
    const now = new Date().toISOString()
    const initial: ThreadMeta = { id, name, projectId, createdAt: now, updatedAt: now, startedAt: now, order: this.nextThreadOrder(projectId, project?.path) }
    const threadDir = this.resolveThreadDir(initial, project?.path)
    this.lifecycleStore.registerTask({ taskId: id, location: threadDir, parentTaskId: ownership?.parentTaskId, creating: true })
    this.ensureThreadDir(threadDir)
    return withThreadLifecyclePath(threadDir, 'write', () => withFileLock(join(threadDir, '.execution-init.lock'), () => {
      const metaPath = join(threadDir, 'meta.json')
      const meta = existsSync(metaPath) ? JSON.parse(readFileSync(metaPath, 'utf8')) as ThreadMeta : initial
      if (meta.id !== id || meta.projectId !== projectId || meta.settledAt) throw new Error('Execution thread identity or state changed')
      // A previous process may have died between these writes. Preserve every
      // file already present, including messages produced after admission.
      for (const file of ['messages.json', 'agents.json', 'tasks.json']) {
        const path = join(threadDir, file)
        if (!existsSync(path)) this.writeJsonAtomic(path, [])
      }
      if (!existsSync(metaPath)) this.writeJsonAtomic(metaPath, meta)
      const indexed = !projectId && this.readStandaloneIndexRaw().some((entry) => entry.id === id)
      if (!projectId && !indexed) this.addToStandaloneIndex(meta)
      this.invalidateListCache()
      if (meta === initial || (!projectId && !indexed)) this.emit('created', meta)
      return meta
    }))
  }

  /** Projects owning grouped threads, in the same order as the desktop sidebar. */
  listProjects(): Project[] {
    return this.projectManager.listProjects()
  }

  listThreads(projectId?: string): Thread[] {
    if (projectId) {
      const cached = this.projectListCache.get(projectId)
      if (cached) return cached
      const project = this.projectManager.getProject(projectId)
      if (!project) return []
      const threads = this.scanProjectThreads(project.path)
      this.projectListCache.set(projectId, threads)
      return threads
    }
    if (this.standaloneListCache) return this.standaloneListCache
    const standalone = this.readStandaloneIndex()
    this.standaloneListCache = standalone
    return standalone
  }

  listAllThreads(): Thread[] {
    const projectsKey = this.projectsCacheKey()
    if (this.listCache && this.listCacheProjectsKey === projectsKey) {
      return this.listCache
    }
    // Project set/path changed — drop per-project caches so we do not reuse
    // threads scanned from a previous project path for the same id.
    if (this.listCacheProjectsKey !== projectsKey) {
      this.projectListCache.clear()
      this.listCache = null
    }
    const standalone = this.listThreads()
    const projectThreads = this.projectManager.listProjects().flatMap((project) =>
      this.listThreads(project.id)
    )
    this.listCache = [...standalone, ...projectThreads]
    this.listCacheProjectsKey = projectsKey
    return this.listCache
  }

  private isLifecycleVisible(id: string): boolean {
    const seen = new Set<string>()
    let current: string | undefined = id
    while (current) {
      if (seen.has(current)) throw new Error('Cyclic lifecycle task ownership')
      seen.add(current)
      const record = this.lifecycleStore.get(current)
      if (!record) return true
      if (record.state !== 'active') return false
      current = record.parentTaskId
    }
    return true
  }

  getThread(id: string): Thread | undefined {
    if (!this.isLifecycleVisible(id)) return undefined
    // Prefer warm list cache (common after list/setModel/pin paths).
    if (this.listCache && this.listCacheProjectsKey === this.projectsCacheKey()) {
      const hit = this.listCache.find((t) => t.id === id)
      if (hit) return hit
    }
    if (this.standaloneListCache) {
      const hit = this.standaloneListCache.find((t) => t.id === id)
      if (hit) return hit
    }
    for (const threads of this.projectListCache.values()) {
      const hit = threads.find((t) => t.id === id)
      if (hit) return hit
    }

    const standalone = this.readStandaloneIndex().find((t) => t.id === id)
    if (standalone) return standalone

    for (const project of this.projectManager.listProjects()) {
      const targetMetaPath = join(this.storageLayout.repositoryThreadDir(project.id, id), 'meta.json')
      const legacyMetaPath = join(this.storageLayout.legacyRepositoryThreadDir(project.path, id), 'meta.json')
      if (existsSync(targetMetaPath) || (this.storageLayout.allowLegacyProjectData && existsSync(legacyMetaPath))) {
        const threadDir = this.storageMigration.migrateRepository(project.path, project.id, id)
        if (!this.lifecycleStore.get(id)) this.lifecycleStore.registerTask({ taskId: id, location: threadDir })
        return JSON.parse(readFileSync(join(threadDir, 'meta.json'), 'utf-8')) as Thread
      }
    }
    return undefined
  }

  updateThreadMeta(
    id: string,
    partial: Partial<Pick<Thread, 'name' | 'modelOverride' | 'worktreeEnabled'>>
  ): Thread {
    const thread = this.getThread(id)
    if (!thread) {
      throw new Error(`Thread not found: ${id}`)
    }

    const updated: Thread = {
      ...thread,
      ...partial,
      updatedAt: new Date().toISOString()
    }

    const threadDir = this.getThreadDir(id)
    this.writeJsonAtomic(join(threadDir, 'meta.json'), updated)

    if (!updated.projectId) {
      this.updateStandaloneIndexEntry(updated)
    }

    this.patchListCache(updated)
    return updated
  }

  setThreadWorktreeEnabled(id: string, enabled: boolean): Thread {
    const thread = this.getThread(id)
    if (!thread) {
      throw new Error(`Thread not found: ${id}`)
    }
    // Gate on actual transcript content, not `startedAt`: the latter is
    // backfilled for merely-named threads with zero messages (see
    // ensureStartedAt), which would otherwise lock the toggle on new chats
    // that never ran a turn.
    const messages = this.loadThreadData(id).messages
    if (messages.length > 0) {
      throw new Error('Worktree mode can only be changed before the first message.')
    }
    const updated: Thread = {
      ...thread,
      updatedAt: new Date().toISOString()
    }
    if (enabled) updated.worktreeEnabled = true
    else delete updated.worktreeEnabled

    const threadDir = this.getThreadDir(id)
    this.writeJsonAtomic(join(threadDir, 'meta.json'), updated)

    if (!updated.projectId) {
      this.updateStandaloneIndexEntry(updated)
    }

    this.patchListCache(updated)
    return updated
  }

  setThreadSettled(id: string, settled: boolean): Thread {
    const thread = this.getThread(id)
    if (!thread) {
      throw new Error(`Thread not found: ${id}`)
    }

    const updated: Thread = {
      ...thread,
      updatedAt: new Date().toISOString()
    }

    if (settled) {
      updated.settledAt = updated.updatedAt
      delete updated.pinnedAt
    } else {
      delete updated.settledAt
    }

    const threadDir = this.getThreadDir(id)
    this.writeJsonAtomic(join(threadDir, 'meta.json'), updated)
    if (!updated.projectId) this.updateStandaloneIndexEntry(updated)
    this.patchListCache(updated)
    return updated
  }

  setThreadPinned(id: string, pinned: boolean): Thread {
    const thread = this.getThread(id)
    if (!thread) {
      throw new Error(`Thread not found: ${id}`)
    }

    const updated: Thread = {
      ...thread,
      updatedAt: new Date().toISOString()
    }

    if (pinned) {
      updated.pinnedAt = updated.updatedAt
    } else {
      delete updated.pinnedAt
    }

    const threadDir = this.getThreadDir(id)
    this.writeJsonAtomic(join(threadDir, 'meta.json'), updated)

    if (!updated.projectId) {
      this.updateStandaloneIndexEntry(updated)
    }

    this.patchListCache(updated)
    return updated
  }

  reorderThreads(projectId: string | undefined, threadIds: string[]): Thread[] {
    const threads = projectId ? this.listThreads(projectId) : this.readStandaloneIndex()
    if (threadIds.length !== threads.length || new Set(threadIds).size !== threadIds.length) {
      throw new Error('Thread reorder must include every thread in its group exactly once')
    }
    const byId = new Map(threads.map((thread) => [thread.id, thread]))
    if (threadIds.some((id) => !byId.has(id))) {
      throw new Error('Threads may only be reordered within their current group')
    }
    const reordered = threadIds.map((id, order) => ({ ...byId.get(id)!, order }))
    for (const thread of reordered) {
      this.writeJsonAtomic(join(this.resolveThreadDir(thread), 'meta.json'), thread)
    }
    if (!projectId) this.writeStandaloneIndex(reordered)
    this.invalidateListCache()
    return reordered
  }

  /** Lifecycle mutations require the daemon coordinator and its execution fence. */
  deleteThread(_id: string): never {
    throw new Error('Thread deletion requires the lifecycle coordinator')
  }

  restoreThreadFromTrash(_id: string): never {
    throw new Error('Thread restore requires the lifecycle coordinator')
  }

  purgeThreadFromTrash(_id: string): never {
    throw new Error('Permanent purge is unavailable in lifecycle Phase 1')
  }

  /** Coordinator post-move projection only. Keep a durable audit of cancelled inputs. */
  cancelLifecycleQueue(record: TaskLifecycleRecord, operationId: string): void {
    const queue = this.readMessageQueueFile(record.location, record.taskId)
    if (!queue.length) return
    const auditPath = join(record.location, 'lifecycle-cancelled-queue.json')
    const audit = this.readJsonFile<Array<{ operationId: string; cancelledAt: string; queue: QueuedMessage[] }>>(auditPath, [])
    if (!Array.isArray(audit)) throw new Error('Corrupt lifecycle queue cancellation audit')
    if (!audit.some((entry) => entry.operationId === operationId)) {
      audit.push({ operationId, cancelledAt: new Date().toISOString(), queue })
      this.writeJsonAtomic(auditPath, audit)
    }
    this.writeJsonAtomic(join(record.location, 'queue.json'), [])
  }

  /** Idempotent index projection; lifecycle location is the durable authority. */
  projectLifecycleIndex(record: TaskLifecycleRecord): void {
    this.removeFromStandaloneIndex(record.taskId)
    if (record.location === record.originalLocation) {
      const meta = JSON.parse(readFileSync(join(record.location, 'meta.json'), 'utf8')) as ThreadMeta
      if (meta.id !== record.taskId) throw new Error('Lifecycle thread identity mismatch')
      if (!meta.projectId) this.addToStandaloneIndex(meta)
    } else if (this.getActiveThreadId() === record.taskId) {
      this.setActiveThreadId(null)
    }
    this.invalidateListCache()
  }

  loadThreadData(id: string): ThreadData {
    const threadDir = this.getThreadDir(id)
    if (!this.transactionalStoreEnabled()) return this.loadThreadDataFromDir(threadDir, id)
    return withThreadDataMutationLock(threadDir, () => {
      new ThreadRecoveryService(new ThreadGenerationStore(threadDir)).reconcile()
      return this.loadThreadDataFromDir(threadDir, id)
    })
  }

  private loadThreadDataFromDir(threadDir: string, id: string): ThreadData {
    if (this.transactionalStoreEnabled()) {
      const current = new ThreadGenerationStore(threadDir).loadCurrent()
      if (current) {
        const llmContextPath = join(
          threadDir,
          'generations',
          current.descriptor.generationId,
          'llm-context.json'
        )
        const sessionsPath = join(
          threadDir,
          'generations',
          current.descriptor.generationId,
          'mousse-agent-sessions.json'
        )
        const mousseAgentSessions = this.parseSessionCollection(
          current.data.mousseAgentSessions,
          sessionsPath
        )
        return {
          messages: this.validateArray<ChatMessage>(current.data.messages, 'messages', threadDir),
          agents: this.validateArray<Agent>(current.data.agents, 'agents', threadDir),
          tasks: this.validateArray<Task>(current.data.tasks, 'tasks', threadDir),
          llmContext: validateNativeContext(current.data.llmContext, llmContextPath),
          mousseAgentSessions,
          // queue.json remains the one live authority. Generation queue data is
          // only a historical observation used for diagnostics/recovery.
          messageQueue: this.readMessageQueueFile(threadDir, id)
        }
      }
    }
    const conversationStatePath = join(threadDir, 'conversation-state.json')
    const legacyMessagesPath = join(threadDir, 'messages.json')
    const legacyContextPath = join(threadDir, 'llm-context.json')
    const conversationStateFresh = existsSync(conversationStatePath) &&
      statSync(conversationStatePath).mtimeMs >= Math.max(
        existsSync(legacyMessagesPath) ? statSync(legacyMessagesPath).mtimeMs : 0,
        existsSync(legacyContextPath) ? statSync(legacyContextPath).mtimeMs : 0
      )
    const conversationState = conversationStateFresh
      ? this.readJsonFile<unknown>(conversationStatePath, undefined)
      : undefined
    let conversationMessages: ChatMessage[] | undefined
    let conversationContext: NativeLlmContext | undefined
    if (conversationState !== undefined) {
      if (!isRecord(conversationState) || conversationState.schemaVersion !== 1) {
        throw new ThreadDataCorruptionError(conversationStatePath, new Error('unsupported conversation-state schema'))
      }
      conversationMessages = this.validateArray<ChatMessage>(conversationState.messages, 'messages', threadDir)
      conversationContext = validateNativeContext(conversationState.llmContext, conversationStatePath)
    }
    const llmContextPath = join(threadDir, 'llm-context.json')
    return {
      messages: conversationMessages ?? this.validateArray<ChatMessage>(
        this.readJsonFile<unknown>(legacyMessagesPath, []), 'messages', threadDir),
      agents: this.validateArray<Agent>(
        this.readJsonFile<unknown>(join(threadDir, 'agents.json'), []),
        'agents',
        threadDir
      ),
      tasks: this.validateArray<Task>(
        this.readJsonFile<unknown>(join(threadDir, 'tasks.json'), []),
        'tasks',
        threadDir
      ),
      llmContext: conversationContext ?? validateNativeContext(
        this.readJsonFile<unknown>(llmContextPath, undefined),
        llmContextPath
      ),
      mousseAgentSessions: this.loadMousseAgentSessions(threadDir),
      messageQueue: this.readMessageQueueFile(threadDir, id)
    }
  }

  /**
   * Atomic read-modify-write for thread data fields (messages/agents/tasks/llm/mousse).
   * Never writes messageQueue — queue remains exclusively via saveMessageQueue/mutateDurableQueue.
   * Concurrent partial updaters must use this so transcript and agent/task writes cannot clobber.
   */
  mutateThreadData(
    id: string,
    mutator: (current: ThreadData) => ThreadDataPatch
  ): ThreadData {
    const threadDir = this.getThreadDir(id)
    return withThreadDataMutationLock(threadDir, () => {
      if (this.transactionalStoreEnabled()) {
        new ThreadRecoveryService(new ThreadGenerationStore(threadDir)).reconcile()
      }
      const current = this.loadThreadDataFromDir(threadDir, id)
      const patch = mutator(current)
      const next: ThreadData = {
        messages: patch.messages ?? current.messages,
        agents: patch.agents ?? current.agents,
        tasks: patch.tasks ?? current.tasks,
        llmContext:
          patch.llmContext === null
            ? undefined
            : patch.llmContext !== undefined
              ? patch.llmContext
              : current.llmContext,
        mousseAgentSessions:
          patch.mousseAgentSessions === null
            ? undefined
            : patch.mousseAgentSessions !== undefined
              ? patch.mousseAgentSessions
              : current.mousseAgentSessions,
        // Preserve in-memory view of queue for callers; disk queue is not written here.
        messageQueue: current.messageQueue
      }
      this.saveThreadDataUnlocked(id, next)
      return next
    })
  }

  /** Load durable per-thread message queue (queue.json; empty for legacy threads). */
  loadMessageQueue(id: string): QueuedMessage[] {
    const threadDir = this.getThreadDir(id)
    return this.readMessageQueueFile(threadDir, id)
  }

  private readMessageQueueFile(threadDir: string, threadId: string): QueuedMessage[] {
    const raw = this.readJsonFile<unknown>(join(threadDir, 'queue.json'), [])
    if (!Array.isArray(raw)) {
      throw new ThreadDataCorruptionError(
        join(threadDir, 'queue.json'),
        new Error('queue must be an array')
      )
    }
    return normalizeQueuedMessages(raw, threadId)
  }

  /** Atomically persist the message queue for a thread (backwards-compatible queue.json). */
  saveMessageQueue(id: string, queue: QueuedMessage[]): void {
    const threadDir = this.getThreadDir(id)
    this.ensureThreadDir(threadDir)
    const normalized = normalizeQueuedMessages(queue, id)
    this.writeJsonAtomic(join(threadDir, 'queue.json'), normalized)
  }

  /**
   * Full replacement write under the shared mutation lock.
   * Prefer {@link mutateThreadData} for partial updates (messages/agents/tasks/llm/mousse).
   * Callers must pass a complete ThreadData snapshot built under this lock or from live
   * registries at write time — never loadThreadData() outside the lock then save here.
   * Never writes queue.json.
   */
  saveThreadData(
    id: string,
    data: ThreadData,
    terminalScrollbacks?: Record<string, string>
  ): void {
    const threadDir = this.getThreadDir(id)
    withThreadDataMutationLock(threadDir, () => {
      if (this.transactionalStoreEnabled()) {
        new ThreadRecoveryService(new ThreadGenerationStore(threadDir)).reconcile()
      }
      this.saveThreadDataUnlocked(id, data, terminalScrollbacks)
    })
  }

  /**
   * Write thread data files without acquiring the mutation lock.
   * Caller must hold withThreadDataMutationLock (or be the sole writer).
   * Never writes queue.json.
   */
  private saveThreadDataUnlocked(
    id: string,
    data: ThreadData,
    terminalScrollbacks?: Record<string, string>
  ): void {
    const threadDir = this.getThreadDir(id)
    this.ensureThreadDir(threadDir)
    const transactional = this.transactionalStoreEnabled()
    const journal = transactional ? new ThreadJournal(threadDir) : undefined
    const operationId = transactional ? uuidv4() : undefined
    const generationStore = transactional ? new ThreadGenerationStore(threadDir) : undefined
    const expectedManifest = generationStore?.getManifest()
    const intent = journal?.append({
      operationId: operationId!,
      operationType: 'thread-data-save',
      state: 'planned',
      expectedPreState: expectedManifest
    })
    let committed = false

    try {
      if (transactional) {
        journal!.append({
          operationId: operationId!,
          operationType: 'thread-data-save',
          state: 'running',
          details: { intentSequence: intent!.sequence }
        })
        // queue.json is authoritative and is only observed here. Actions,
        // branches and workspace are owned by their domain services, so an
        // unrelated transcript save must carry them forward rather than
        // replacing them with empty placeholders.
        const queue = this.readMessageQueueFile(threadDir, id)
        const generation = generationStore!.createGeneration({
          messages: data.messages,
          agents: data.agents,
          tasks: data.tasks,
          llmContext: data.llmContext,
          queue,
          mousseAgentSessions: data.mousseAgentSessions,
          workspace: this.readJsonFile<unknown>(join(threadDir, 'workspace.json'), undefined),
          conversationBranches: this.validateArray<unknown>(
            this.readJsonFile<unknown>(join(threadDir, 'conversation-branches.json'), []),
            'conversation-branches',
            threadDir
          ),
          actions: this.validateArray<unknown>(
            this.readJsonFile<unknown>(join(threadDir, 'actions.json'), []),
            'actions',
            threadDir
          )
        }, intent!.sequence)
        journal!.append({
          operationId: operationId!,
          operationType: 'thread-data-save',
          state: 'running',
          resultGenerationId: generation.generationId,
          details: { intentSequence: intent!.sequence, generationDurable: true }
        })
        generationStore!.selectExistingGeneration(generation.generationId, {
          expectedCurrentGenerationId: expectedManifest?.currentGenerationId ?? null
        })
        journal!.append({
          operationId: operationId!,
          operationType: 'thread-data-save',
          state: 'completed',
          resultGenerationId: generation.generationId,
          details: { intentSequence: intent!.sequence }
        })
        committed = true

        // Flat files are a compatibility projection, never the transaction
        // authority. A projection failure cannot turn a committed checkpoint
        // into a failed/ambiguous operation.
        try {
          this.writeCompatibilityProjection(threadDir, data)
        } catch (projectionError) {
          journal!.append({
            operationId: operationId!,
            operationType: 'thread-data-save',
            state: 'completed',
            resultGenerationId: generation.generationId,
            details: {
              intentSequence: intent!.sequence,
              compatibilityProjectionError:
                projectionError instanceof Error ? projectionError.message : String(projectionError)
            }
          })
        }
      } else {
        this.writeCompatibilityProjection(threadDir, data)
      }

      if (terminalScrollbacks) {
        const terminalsDir = join(threadDir, 'terminals')
        mkdirSync(terminalsDir, { recursive: true })
        for (const [ptyId, scrollback] of Object.entries(terminalScrollbacks)) {
          writeFileSync(join(terminalsDir, `${ptyId}.txt`), scrollback, 'utf-8')
        }
      }

      const metaPath = join(threadDir, 'meta.json')
      if (existsSync(metaPath)) {
        try {
          const meta = JSON.parse(readFileSync(metaPath, 'utf-8')) as ThreadMeta
          meta.updatedAt = new Date().toISOString()
          if (!meta.startedAt && data.messages.length > 0) {
            meta.startedAt = meta.updatedAt
          }
          this.writeJsonAtomic(metaPath, meta)

          if (!meta.projectId) {
            this.updateStandaloneIndexEntry(meta)
          }
          // Keep warm list cache in sync so startedAt/updatedAt surface without a rescan.
          this.patchListCache(meta)
        } catch {
          // Corrupt meta: do not overwrite with a stale reconstructed fallback.
        }
      }
    } catch (error) {
      if (!committed) {
        journal?.append({
          operationId: operationId!,
          operationType: 'thread-data-save',
          state: 'failed',
          details: {
            intentSequence: intent?.sequence,
            error: error instanceof Error ? error.message : String(error)
          }
        })
      }
      throw error
    }
  }

  private writeCompatibilityProjection(threadDir: string, data: ThreadData): void {
    this.writeJsonAtomic(join(threadDir, 'messages.json'), data.messages)
    this.writeJsonAtomic(join(threadDir, 'agents.json'), data.agents)
    this.writeJsonAtomic(join(threadDir, 'tasks.json'), data.tasks)
    const llmContextPath = join(threadDir, 'llm-context.json')
    if (data.llmContext === undefined) rmSync(llmContextPath, { force: true })
    else this.writeJsonAtomic(llmContextPath, data.llmContext)
    const sessionsPath = join(threadDir, 'mousse-agent-sessions.json')
    if (data.mousseAgentSessions === undefined) rmSync(sessionsPath, { force: true })
    else this.writeJsonAtomic(sessionsPath, data.mousseAgentSessions)
    // Publish the transcript + native context pair last. Readers prefer this
    // single atomic unit; the preceding files remain compatibility projections.
    this.writeJsonAtomic(join(threadDir, 'conversation-state.json'), {
      schemaVersion: 1,
      messages: data.messages,
      llmContext: data.llmContext
    })
    // Intentionally do not write queue.json here.
  }

  /** True once the chat has content (and backfills startedAt for older threads). */
  isThreadStarted(id: string): boolean {
    const thread = this.getThread(id)
    if (!thread) return false
    if (thread.startedAt) return true
    return this.ensureStartedAt(thread)
  }

  /**
   * Mark a draft thread as started so it stays visible in the sidebar.
   * Called when the user commits the first send (before title generation finishes).
   * Idempotent — no-op when `startedAt` is already set.
   */
  markThreadStarted(id: string): { thread: Thread; newlyStarted: boolean } | undefined {
    const thread = this.getThread(id)
    if (!thread) return undefined
    if (thread.startedAt) return { thread, newlyStarted: false }

    const now = new Date().toISOString()
    const updated: ThreadMeta = {
      ...thread,
      startedAt: now,
      updatedAt: now
    }

    const threadDir = this.getThreadDir(id)
    this.writeJsonAtomic(join(threadDir, 'meta.json'), updated)
    if (!updated.projectId) this.updateStandaloneIndexEntry(updated)
    this.patchListCache(updated)
    return { thread: updated, newlyStarted: true }
  }

  /**
   * Move a thread to the top of its sidebar group. User sends only —
   * agent streaming must not change sidebar order.
   */
  bumpThreadToFront(id: string): { thread: Thread; bumped: boolean } | undefined {
    const thread = this.getThread(id)
    if (!thread) return undefined
    if (thread.settledAt) return { thread, bumped: false }

    const siblings = thread.projectId
      ? this.listThreads(thread.projectId)
      : this.readStandaloneIndex()
    const alreadyFront = siblings.every(
      (entry) => entry.id === thread.id || entry.order > thread.order
    )
    if (alreadyFront) return { thread, bumped: false }

    const minOrder = siblings.reduce((min, entry) => Math.min(min, entry.order), thread.order)
    const updated: Thread = { ...thread, order: minOrder - 1 }
    this.writeJsonAtomic(join(this.getThreadDir(id), 'meta.json'), updated)
    if (!updated.projectId) this.updateStandaloneIndexEntry(updated)
    this.invalidateListCache()
    this.emit('updated', updated)
    return { thread: updated, bumped: true }
  }

  /**
   * Record a user send: reveal the draft if needed and pin it to the top of
   * its group. Agent/internal writes must not call this.
   */
  touchThreadUserActivity(id: string): { thread: Thread; newlyStarted: boolean; bumped: boolean } | undefined {
    const started = this.markThreadStarted(id)
    if (!started) return undefined
    const bump = this.bumpThreadToFront(id)
    return {
      thread: bump?.thread ?? started.thread,
      newlyStarted: started.newlyStarted,
      bumped: bump?.bumped ?? false
    }
  }

  /**
   * For threads created before startedAt existed: mark started when messages exist
   * (or when the thread already has a real title).
   * Returns whether the thread is started after backfill.
   */
  ensureStartedAt(thread: Thread, projectPath?: string): boolean {
    if (thread.startedAt) return true

    let hasMessages = false
    let threadDir: string | null = null
    try {
      threadDir = this.resolveThreadDir(thread, projectPath)
      const messages = this.readJsonFile<ChatMessage[]>(join(threadDir, 'messages.json'), [])
      hasMessages = messages.length > 0
    } catch {
      // Project path may be unavailable; fall through to title-based detection.
    }

    // Legacy threads often have a generated title but no startedAt field yet.
    if (!hasMessages && isDefaultThreadName(thread.name)) return false
    if (!hasMessages && !thread.name) return false

    const updated: ThreadMeta = {
      ...thread,
      startedAt: thread.updatedAt || new Date().toISOString()
    }
    if (threadDir) {
      try {
        this.writeJsonAtomic(join(threadDir, 'meta.json'), updated)
      } catch {
        // Still expose startedAt in-memory for this listing.
      }
    }
    if (!updated.projectId) this.writeStandaloneIndexEntryRaw(updated)
    thread.startedAt = updated.startedAt
    this.patchListCache({ ...thread, ...updated })
    return true
  }

  loadTerminalScrollbacks(id: string): Record<string, string> {
    const terminalsDir = join(this.getThreadDir(id), 'terminals')
    if (!existsSync(terminalsDir)) return {}

    const scrollbacks: Record<string, string> = {}
    for (const file of readdirSync(terminalsDir)) {
      if (!file.endsWith('.txt')) continue
      const ptyId = file.slice(0, -4)
      scrollbacks[ptyId] = readFileSync(join(terminalsDir, file), 'utf-8')
    }
    return scrollbacks
  }

  getActiveThreadId(): string | null {
    try {
      if (!existsSync(join(this.homeDir, 'active-thread.json'))) return null
      const state = JSON.parse(readFileSync(join(this.homeDir, 'active-thread.json'), 'utf-8')) as ActiveThreadState
      return state.id ?? null
    } catch {
      return null
    }
  }

  setActiveThreadId(id: string | null): void {
    mkdirSync(this.homeDir, { recursive: true })
    if (!id) {
      if (existsSync(join(this.homeDir, 'active-thread.json'))) {
        rmSync(join(this.homeDir, 'active-thread.json'), { force: true })
      }
      return
    }
    this.writeJsonAtomic(join(this.homeDir, 'active-thread.json'), { id })
  }

  assertThreadAdmission(id: string): void {
    if (!this.lifecycleStore.get(id)) this.getThreadDir(id)
    this.lifecycleStore.captureAdmission(id)
  }

  getThreadDir(id: string): string {
    const thread = this.getThread(id)
    if (!thread) {
      throw new Error(`Thread not found: ${id}`)
    }
    const location = this.resolveThreadDir(thread)
    if (!this.lifecycleStore.get(id)) this.lifecycleStore.registerTask({ taskId: id, location })
    return location
  }

  private resolveThreadDir(meta: ThreadMeta, projectPath?: string): string {
    const managed = this.lifecycleStore.get(meta.id)
    if (managed) {
      this.lifecycleStore.withPathAdmission(managed.location, 'write', () => undefined)
      return managed.location
    }
    if (meta.projectId) {
      const path = projectPath ?? this.projectManager.getProject(meta.projectId)?.path
      if (!path) throw new Error(`Project not found for thread: ${meta.id}`)
      const location = this.storageMigration.migrateRepository(path, meta.projectId, meta.id)
      if (existsSync(join(location, 'meta.json'))) this.lifecycleStore.registerTask({ taskId: meta.id, location })
      return location
    }
    const location = this.storageMigration.migrateStandalone(meta.id)
    if (existsSync(join(location, 'meta.json'))) this.lifecycleStore.registerTask({ taskId: meta.id, location })
    return location
  }

  private ensureThreadDir(threadDir: string): void {
    withThreadLifecyclePath(threadDir, 'write', () => {
      mkdirSync(threadDir, { recursive: true })
      mkdirSync(join(threadDir, 'terminals'), { recursive: true })
    })
  }

  private readStandaloneIndexRaw(): Thread[] {
    return this.readJsonFile<Thread[]>(join(this.homeDir, 'threads-index.json'), [])
  }

  private readStandaloneIndex(): Thread[] {
    const threads = this.readStandaloneIndexRaw().filter((thread) => this.isLifecycleVisible(thread.id))
    for (const thread of threads) this.ensureStartedAt(thread)
    return this.ensureThreadOrders(threads, (ordered) => this.writeStandaloneIndex(ordered))
  }

  private writeStandaloneIndex(threads: Thread[]): void {
    const dir = this.homeDir
    mkdirSync(dir, { recursive: true })
    this.writeJsonAtomic(join(this.homeDir, 'threads-index.json'), threads)
  }

  private addToStandaloneIndex(meta: ThreadMeta): void {
    const index = this.readStandaloneIndexRaw()
    index.push(meta)
    this.writeStandaloneIndex(index)
  }

  private updateStandaloneIndexEntry(thread: Thread): void {
    this.writeStandaloneIndexEntryRaw(thread)
  }

  private writeStandaloneIndexEntryRaw(thread: Thread): void {
    const index = this.readStandaloneIndexRaw()
    const idx = index.findIndex((t) => t.id === thread.id)
    if (idx >= 0) {
      index[idx] = thread
      this.writeStandaloneIndex(index)
    }
  }

  private removeFromStandaloneIndex(id: string): void {
    const index = this.readStandaloneIndexRaw().filter((t) => t.id !== id)
    this.writeStandaloneIndex(index)
  }

  private scanProjectThreads(projectPath: string): Thread[] {
    const project = this.projectManager.listProjects().find((entry) => entry.path === projectPath)
    if (!project) return []

    // Discover legacy directories first; each is atomically migrated before the
    // home-scoped directory is scanned. This keeps reads available on failure.
    const legacyRoot = this.storageLayout.legacyRepositoryRoot(projectPath)
    if (this.storageLayout.allowLegacyProjectData && existsSync(legacyRoot)) {
      for (const entry of readdirSync(legacyRoot, { withFileTypes: true })) {
        if (entry.isDirectory()) this.storageMigration.migrateRepository(projectPath, project.id, entry.name)
      }
    }

    const dataDir = this.storageLayout.repositoryRoot(project.id)
    const threads = this.scanThreadDirectory(dataDir, projectPath)
    return this.ensureThreadOrders(threads, (ordered) => {
      for (const thread of ordered) {
        this.writeJsonAtomic(join(this.resolveThreadDir(thread, projectPath), 'meta.json'), thread)
      }
    })
  }

  private scanThreadDirectory(dataDir: string, projectPath?: string): Thread[] {
    if (!existsSync(dataDir)) return []
    const threads: Thread[] = []
    for (const entry of readdirSync(dataDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const metaPath = join(dataDir, entry.name, 'meta.json')
      if (!existsSync(metaPath)) continue
      try {
        const thread = JSON.parse(readFileSync(metaPath, 'utf-8')) as Thread
        if (!this.isLifecycleVisible(thread.id)) continue
        if (!this.lifecycleStore.get(thread.id)) this.lifecycleStore.registerTask({ taskId: thread.id, location: join(dataDir, entry.name) })
        this.ensureStartedAt(thread, projectPath)
        threads.push(thread)
      } catch {
        /* skip invalid */
      }
    }
    return threads
  }

  private sortThreads(threads: Thread[]): Thread[] {
    return threads.sort((a, b) => a.order - b.order)
  }

  private nextThreadOrder(projectId?: string, projectPath?: string): number {
    const threads = projectId
      ? this.scanProjectThreads(projectPath ?? this.projectManager.getProject(projectId)?.path ?? '')
      : this.readStandaloneIndex()
    return threads.reduce((min, thread) => Math.min(min, thread.order), 0) - 1
  }

  private ensureThreadOrders(threads: Thread[], persist: (threads: Thread[]) => void): Thread[] {
    const missingOrder = threads.some((thread) => !Number.isFinite(thread.order))
    if (missingOrder) {
      const legacyOrder = [...threads].sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())
      legacyOrder.forEach((thread, order) => { thread.order = order })
      persist(threads)
    }
    return this.sortThreads(threads)
  }

  private readJsonFile<T>(filePath: string, fallback: T): T {
    if (!existsSync(filePath)) return fallback
    try {
      return JSON.parse(readFileSync(filePath, 'utf-8')) as T
    } catch (error) {
      throw new ThreadDataCorruptionError(filePath, error)
    }
  }

  private validateArray<T>(value: unknown, collection: string, threadDir: string): T[] {
    if (!Array.isArray(value)) {
      throw new ThreadDataCorruptionError(
        join(threadDir, `${collection}.json`),
        new Error(`${collection} must be an array`)
      )
    }
    return value as T[]
  }

  /**
   * Load durable Mousse subagent sessions for a thread directory.
   * Missing files are legacy-safe. Malformed JSON is fail-closed so a later
   * persist cannot silently replace recovery evidence with an empty list.
   */
  private loadMousseAgentSessions(threadDir: string): MousseAgentSessionSnapshot[] {
    const filePath = join(threadDir, 'mousse-agent-sessions.json')
    try {
      if (!existsSync(filePath)) return []
      const raw = JSON.parse(readFileSync(filePath, 'utf-8')) as unknown
      return this.parseSessionCollection(raw, filePath) ?? []
    } catch (error) {
      if (error instanceof ThreadDataCorruptionError) throw error
      throw new ThreadDataCorruptionError(filePath, error)
    }
  }

  private parseSessionCollection(
    raw: unknown,
    filePath: string
  ): MousseAgentSessionSnapshot[] | undefined {
    if (raw === undefined) return undefined
    if (!Array.isArray(raw)) {
      throw new ThreadDataCorruptionError(filePath, new Error('sessions must be an array'))
    }
    const sessions = parseMousseAgentSessions(raw)
    if (sessions.length !== raw.length) {
      throw new ThreadDataCorruptionError(
        filePath,
        new Error('sessions contain an unsupported record')
      )
    }
    return sessions
  }

  /** Same-directory durable replacement with file and parent-directory fsync. */
  private writeJsonAtomic(filePath: string, value: unknown): void {
    atomicWriteJsonSync(filePath, value)
  }

  searchThreads(query: string, limit = 50): Array<{
    threadId: string
    threadName: string
    projectId?: string
    projectName?: string
    matchType: 'thread' | 'project' | 'message'
    snippet?: string
    messageId?: string
  }> {
    const normalized = query.trim().toLowerCase()
    if (!normalized) return []

    const results: Array<{
      threadId: string
      threadName: string
      projectId?: string
      projectName?: string
      matchType: 'thread' | 'project' | 'message'
      snippet?: string
      messageId?: string
      score: number
    }> = []

    const projects = this.projectManager.listProjects()
    const projectNameById = new Map(projects.map((p) => [p.id, p.name]))
    const threads = this.listAllThreads()

    for (const thread of threads) {
      if (thread.settledAt) continue
      // Skip pure empty drafts; startedAt may be backfilled above via ensureStartedAt.
      if (!thread.startedAt && isDefaultThreadName(thread.name)) continue
      const projectName = thread.projectId ? projectNameById.get(thread.projectId) : undefined

      if (thread.name.toLowerCase().includes(normalized)) {
        results.push({
          threadId: thread.id,
          threadName: thread.name,
          projectId: thread.projectId,
          projectName,
          matchType: 'thread',
          score: 0
        })
      }

      if (projectName && projectName.toLowerCase().includes(normalized)) {
        results.push({
          threadId: thread.id,
          threadName: thread.name,
          projectId: thread.projectId,
          projectName,
          matchType: 'project',
          score: 1
        })
      }

      try {
        const messages = this.readJsonFile<Array<{ id: string; content: string }>>(
          join(this.getThreadDir(thread.id), 'messages.json'),
          []
        )
        for (const message of messages) {
          const content = message.content ?? ''
          const index = content.toLowerCase().indexOf(normalized)
          if (index === -1) continue

          const start = Math.max(0, index - 40)
          const end = Math.min(content.length, index + normalized.length + 40)
          const snippet =
            (start > 0 ? '…' : '') +
            content.slice(start, end).replace(/\s+/g, ' ').trim() +
            (end < content.length ? '…' : '')

          results.push({
            threadId: thread.id,
            threadName: thread.name,
            projectId: thread.projectId,
            projectName,
            matchType: 'message',
            snippet,
            messageId: message.id,
            score: 2
          })
        }
      } catch {
        /* skip invalid thread data */
      }
    }

    const seen = new Set<string>()
    return results
      .sort((a, b) => a.score - b.score || a.threadName.localeCompare(b.threadName))
      .filter((result) => {
        const key = `${result.threadId}:${result.matchType}:${result.messageId ?? ''}:${result.snippet ?? ''}`
        if (seen.has(key)) return false
        seen.add(key)
        return true
      })
      .slice(0, limit)
      .map(({ score: _score, ...rest }) => rest)
  }
}
